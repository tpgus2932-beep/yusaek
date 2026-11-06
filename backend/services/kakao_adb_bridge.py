"""ADB-only Kakao adapter. JSON stdin/stdout; no host mouse, no app DB access."""
import base64
import hashlib
import json
import os
import pathlib
import re
import subprocess
import shutil
import sys
import tempfile
import time
import uuid
import xml.etree.ElementTree as ET

PKG = 'com.kakao.talk'
PREFIX = PKG + ':id/'
IME = 'com.yusaek.talkbridge/.BridgeInputMethod'
SETTINGS_MARKER = '/data/local/tmp/yusaek-talk-runtime-settings.json'
# On-device accessibility executor (fast path). Reads the node tree in memory
# instead of `uiautomator dump`, so a whole send runs on the phone via one
# authenticated broadcast. See android-talk-bridge FastProbeAccessibilityService.
ACCESS_SERVICE = 'com.yusaek.talkbridge/.FastProbeAccessibilityService'
SEND_RECEIVER = 'com.yusaek.talkbridge/.FastProbeReceiver'

class Blocked(Exception):
    pass

def center(node):
    values = [int(x) for x in re.findall(r'\d+', node.get('bounds', ''))]
    if len(values) != 4 or values[2] <= values[0] or values[3] <= values[1]:
        raise ValueError('invisible_element')
    return (values[0] + values[2]) // 2, (values[1] + values[3]) // 2

def visible(node):
    try:
        center(node)
        return True
    except ValueError:
        return False

def unique(nodes):
    nodes = [n for n in nodes if visible(n)]
    if len(nodes) != 1:
        raise Blocked('target_missing_or_ambiguous')
    return nodes[0]

def profile_fingerprint(root):
    evidence = []
    for node in root.iter('node'):
        text = node.get('text') or node.get('content-desc')
        if text and not re.fullmatch(r'[0-9a-f-]{36}', text):
            evidence.append(text)
    return hashlib.sha256(json.dumps(evidence, ensure_ascii=False).encode()).hexdigest()

def search_field(root):
    candidates=[]
    for node in root.iter('node'):
        if node.get('class')!='android.widget.EditText' or not visible(node) or node.get('resource-id')==PREFIX+'message_edit_text':continue
        left,top,right,bottom=[int(x) for x in re.findall(r'\d+',node.get('bounds',''))]
        if right-left>=200:candidates.append(node)
    return unique(candidates)

def visible_contact_names(root,kind,self_name=None):
    names=[]
    for node in root.iter('node'):
        if not visible(node):continue
        if kind=='friend':
            desc=node.get('content-desc','')
            if not desc.endswith(', 프로필 사진'):continue
            name=desc[:-len(', 프로필 사진')].strip()
            if name and name!=self_name:names.append(name)
        elif kind=='room' and node.get('resource-id')==PREFIX+'name' and node.get('text'):
            names.append(node.get('text'))
    return names

def connection_candidates(text):
    values=[]
    for line in text.splitlines():
        fields=line.split()
        if len(fields)>=3 and fields[1].rstrip('.')=='_adb-tls-connect._tcp' and is_endpoint(fields[2]):
            if fields[2] not in values:values.append(fields[2])
    return values

def is_endpoint(value):
    return re.fullmatch(r'(?:[0-9.]+|\[[0-9a-fA-F:]+\]):\d+',value) is not None

class Adb:
    def __init__(self, settings):
        self.path = settings.get('adb') or 'adb'
        if self.path=='adb' and not shutil.which('adb'):
            roots=[pathlib.Path(os.environ.get('ANDROID_HOME','')),pathlib.Path(os.environ.get('ANDROID_SDK_ROOT','')),pathlib.Path.home()/'AppData/Local/Android/Sdk',pathlib.Path.home()/'Downloads/유색_운영백업/android_probe_tools']
            for root in roots:
                candidate=root/'platform-tools'/('adb.exe' if os.name=='nt' else 'adb')
                if candidate.is_file():self.path=str(candidate);break
        self.serial = settings.get('serial', '')
        self.expected = settings.get('account')
        self.old_ime = None
        self.send_attempted = False
        self.old_timeout = None
        self.expected_hardware = settings.get('hardware_id')
        self.own_name = settings.get('self_name')
        self.verified_hardware = None
        self.allow_initial_discovery = settings.get('allow_initial_discovery') is True

    def run(self, *args, binary=False, timeout=25):
        result = subprocess.run([self.path, '-s', self.serial, *map(str,args)], capture_output=True, timeout=timeout,
                                creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        if result.returncode:
            raise Blocked('adb_command_failed')
        return result.stdout if binary else result.stdout.decode('utf-8', errors='replace')

    def global_run(self,*args,timeout=30):
        result=subprocess.run([self.path,*map(str,args)],capture_output=True,timeout=timeout,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        if result.returncode:raise Blocked('adb_connection_failed')
        return result.stdout.decode('utf-8',errors='replace')

    def hardware_id(self):
        for prop in ['ro.serialno','ro.boot.serialno']:
            value=self.run('shell','getprop',prop,timeout=5).strip()
            if re.fullmatch(r'[a-zA-Z0-9_-]{6,128}',value) and value.lower() not in ['unknown','null']:return hashlib.sha256(value.encode()).hexdigest()
        value=self.run('shell','settings','get','secure','android_id',timeout=5).strip()
        if re.fullmatch(r'[0-9a-fA-F]{16}',value):return hashlib.sha256(('android_id:'+value.lower()).encode()).hexdigest()
        raise Blocked('device_identity_unavailable')

    def try_transport(self,serial):
        self.serial=serial
        if is_endpoint(serial):
            self.global_run('connect',serial,timeout=5)
        if self.run('get-state',timeout=5).strip()!='device':raise Blocked('adb_connection_failed')
        identity=self.hardware_id()
        if self.expected_hardware and identity!=self.expected_hardware:raise Blocked('device_identity_mismatch')
        self.verified_hardware=identity

    def connect_transport(self):
        original=self.serial
        try:self.try_transport(original);return
        except (Blocked,subprocess.TimeoutExpired):pass
        if not self.expected_hardware:
            # Explicit administrator inspection only. A single already-
            # authorized transport can bootstrap old registrations without
            # typing a port; multiple phones require an explicit selection.
            if self.allow_initial_discovery:
                connected=[]
                for line in self.global_run('devices',timeout=10).splitlines():
                    fields=line.split()
                    if len(fields)==2 and fields[1]=='device' and re.fullmatch(r'[a-zA-Z0-9._:\[\]-]+',fields[0]):connected.append(fields[0])
                if len(connected)==1:self.try_transport(connected[0]);return
                raise Blocked('initial_device_missing_or_ambiguous')
            raise Blocked('adb_connection_failed')
        candidates=[]
        try:candidates=connection_candidates(self.global_run('mdns','services',timeout=10))
        except (Blocked,subprocess.TimeoutExpired):pass
        try:
            for line in self.global_run('devices',timeout=10).splitlines():
                fields=line.split()
                if len(fields)==2 and fields[1]=='device' and re.fullmatch(r'[a-zA-Z0-9._:\[\]-]+',fields[0]) and fields[0] not in candidates:candidates.append(fields[0])
        except (Blocked,subprocess.TimeoutExpired):pass
        for serial in candidates[:8]:
            if serial==original:continue
            try:self.try_transport(serial);return
            except (Blocked,subprocess.TimeoutExpired):pass
        self.serial=original
        raise Blocked('adb_connection_failed')

    def keep_warm(self):
        # Package-scoped exemptions, never disable device-wide Doze or unlock an
        # already-running Kakao. The bound listener holds CPU/Wi-Fi while locked.
        allowed=self.run('shell','cmd','deviceidle','whitelist',timeout=5)
        listed=lambda package:any(line.split(',')[1:2]==[package] for line in allowed.splitlines())
        missing=[package for package in (PKG,'com.yusaek.talkbridge') if not listed(package)]
        for package in missing:
            self.run('shell','cmd','deviceidle','whitelist','+'+package,timeout=5)
            self.run('shell','am','set-inactive',package,'false',timeout=5)
        if missing:allowed=self.run('shell','cmd','deviceidle','whitelist',timeout=5)
        exempt=all(any(line.split(',')[1:2]==[package] for line in allowed.splitlines()) for package in (PKG,'com.yusaek.talkbridge'))
        if not exempt:raise Blocked('battery_optimization_exemption_failed')
        alive=bool(self.run('shell','pidof com.kakao.talk || true',timeout=5).strip())
        if not alive:
            # Actual process loss only: launch, prepare the finder, then lock.
            # Never run a merchant-matching preflight or leave a room foreground.
            result=self.fast_broadcast({'action':'prepare_idle'},timeout=45)
            if result.get('state')!='verified':return result
        return {'state':'verified','process_alive':True,'recovered':not alive,'battery_exempt':True}

    def connect(self):
        self.connect_transport()
        self.recover_settings()
        self.old_ime=self.run('shell','settings','get','secure','default_input_method').strip()
        self.old_timeout=self.run('shell','settings','get','system','screen_off_timeout').strip()
        encoded=base64.b64encode(json.dumps({'ime':self.old_ime,'timeout':self.old_timeout}).encode()).decode()
        self.run('shell',f'umask 077; printf %s {encoded} | base64 -d > {SETTINGS_MARKER}')
        self.run('shell','settings','put','system','screen_off_timeout','600000')

    def recover_settings(self):
        try:self.run('shell','test','-f',SETTINGS_MARKER)
        except Blocked:return
        raw=self.run('exec-out','cat',SETTINGS_MARKER)
        saved=json.loads(raw)
        if not re.fullmatch(r'[a-zA-Z0-9._/]+',saved.get('ime','')) or not str(saved.get('timeout','')).isdigit():raise Blocked('keyboard_recovery_invalid')
        self.run('shell','ime','set',saved['ime'])
        if saved['ime']!=IME:self.run('shell','ime','disable',IME)
        self.run('shell','settings','put','system','screen_off_timeout',saved['timeout'])
        self.run('shell','rm','-f',SETTINGS_MARKER)

    def ui(self):
        path='/data/local/tmp/yusaek-talk-ui-'+uuid.uuid4().hex+'.xml'
        for _ in range(3):
            self.run('shell','input','keyevent','KEYCODE_WAKEUP')
            result=self.run('shell','uiautomator','dump',path)
            if 'dumped to:' in result:
                try:return ET.fromstring(self.run('exec-out','cat',path))
                finally:self.run('shell','rm','-f',path)
            time.sleep(.5)
        raise Blocked('uia_tree_unavailable')

    def tap(self,node):
        self.run('shell','input','tap',*center(node))

    def find(self,root, text=None, desc=None, rid=None):
        return unique([n for n in root.iter('node') if
                       (text is None or n.get('text')==text) and
                       (desc is None or n.get('content-desc')==desc) and
                       (rid is None or n.get('resource-id')==PREFIX+rid)])

    def click(self, text=None, desc=None, rid=None):
        self.tap(self.find(self.ui(),text,desc,rid))

    def home(self):
        self.run('shell','input','keyevent','KEYCODE_WAKEUP')
        self.run('shell','wm','dismiss-keyguard')
        self.run('shell','monkey','-p',PKG,'-c','android.intent.category.LAUNCHER','1')
        for _ in range(9):
            root=self.ui()
            if any(n.get('content-desc','').startswith('더보기 탭') for n in root.iter('node')):
                return root
            self.run('shell','input','keyevent','4')
        raise Blocked('unlock_or_main_screen_required')

    def leave_chat(self):
        # Back out inside KakaoTalk. This does not leave/delete the Kakao room.
        # The first Back may merely hide the IME or close the profile overlay.
        for _ in range(4):
            self.run('shell','input','keyevent','KEYCODE_BACK')
            root=self.ui()
            if any(n.get('content-desc','').startswith('더보기 탭') for n in root.iter('node')):
                return
        raise Blocked('chat_exit_unverified')

    def account(self):
        root=self.home()
        self.tap(unique([n for n in root.iter('node') if n.get('content-desc','').startswith('더보기 탭')]))
        root=self.ui()
        self.tap(unique([n for n in root.iter('node') if n.get('content-desc','').startswith('전체 설정')]))
        root=self.ui()
        emails=[n.get('text','') for n in root.iter('node') if re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+',n.get('text',''))]
        if len(emails)!=1:
            raise Blocked('account_identity_unavailable')
        actual=hashlib.sha256(emails[0].encode()).hexdigest()
        if self.expected and self.expected!='unverified' and actual!=self.expected:
            raise Blocked('account_changed')
        self.run('shell','input','keyevent','4')
        return actual

    def self_name(self):
        root=self.home()
        self.tap(unique([n for n in root.iter('node') if n.get('content-desc','').startswith('친구 탭')]))
        names=[n.get('content-desc','')[:-len(', 프로필 사진')] for n in self.ui().iter('node') if n.get('content-desc','').endswith(', 프로필 사진') and visible(n)]
        return names[0] if len(names)==1 else None

    def setup_helper(self,payload):
        actual=self.account();name=self.self_name()
        package=self.run('shell','dumpsys','package','com.yusaek.talkbridge')
        version=re.search(r'versionCode=(\d+)',package)
        if not version or int(version.group(1))<4:
            apk=pathlib.Path(payload['apk']).resolve()
            if not apk.is_file():raise Blocked('bridge_apk_missing')
            self.run('install','-r',str(apk),timeout=90)
        config=base64.b64encode(json.dumps({'server':payload['server'],'token':payload['token'],'account':actual}).encode()).decode()
        result=self.run('shell','am','broadcast','-n','com.yusaek.talkbridge/.ConfigReceiver','-a','com.yusaek.talkbridge.CONFIGURE','--es','config',config)
        if 'result=1' not in result:raise Blocked('helper_configuration_failed')
        component='com.yusaek.talkbridge/.TalkNotifications'
        try:self.run('shell','cmd','notification','allow_listener',component)
        except Blocked:pass
        listeners=self.run('shell','settings','get','secure','enabled_notification_listeners')
        allowed='com.yusaek.talkbridge/' in listeners
        if not allowed:self.run('shell','am','start','-a','android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS')
        return {'state':'verified','account':actual,'self_name':name,'helper_version':4,'notification_access':allowed}

    def input_text(self,text,sleep=time.sleep):
        if not self.old_ime:
            self.old_ime=self.run('shell','settings','get','secure','default_input_method').strip()
        methods=self.run('shell','ime','list','-a','-s')
        if IME not in methods:
            raise Blocked('korean_input_helper_required')
        self.run('shell','ime','enable',IME)
        self.run('shell','ime','set',IME)
        # Android binds the newly selected IME asynchronously. Wait for a fresh
        # accessibility snapshot before committing, never retry a commit.
        self.ui()
        for _ in range(30):
            ready=self.run('shell','am','broadcast','-n','com.yusaek.talkbridge/.InputReceiver','-a','com.yusaek.talkbridge.INPUT_READY')
            if 'result=1' in ready:break
            sleep(.1)
        else:raise Blocked('input_helper_not_ready')
        # Input is base64 so adb's remote shell cannot interpret user text.
        encoded=base64.b64encode(text.encode()).decode()
        result=self.run('shell','am','broadcast','-n','com.yusaek.talkbridge/.InputReceiver','-a','com.yusaek.talkbridge.INPUT_B64','--es','msg',encoded)
        if 'result=1' not in result:raise Blocked('input_helper_not_ready')

    def restore_keyboard(self):
        ok=True
        if self.old_ime:
            try:
                self.run('shell','ime','set',self.old_ime)
                if self.old_ime!=IME:
                    self.run('shell','ime','disable',IME)
            except Exception:ok=False
        if self.old_timeout and self.old_timeout.isdigit():
            try:self.run('shell','settings','put','system','screen_off_timeout',self.old_timeout)
            except Exception:ok=False
        if ok and self.old_timeout:
            try:self.run('shell','rm','-f',SETTINGS_MARKER)
            except Exception:ok=False
        return ok

    def friend(self,name):
        root=self.home()
        self.tap(unique([n for n in root.iter('node') if n.get('content-desc','').startswith('친구 탭')]))
        self.click(desc='검색')
        root=self.ui()
        # Finder's search field is initially an off-screen focus proxy. Use its
        # visible search container if available; otherwise the native toolbar.
        self.tap(search_field(root))
        self.input_text(name)
        self.run('shell','input','keyevent','66')
        root=self.ui()
        # The global search contains group chats as well; select the Friends tab.
        friend_tabs=[n for n in root.iter('node') if n.get('text')=='친구' and n.get('clickable')=='true' and visible(n)]
        if friend_tabs:
            self.tap(unique(friend_tabs));root=self.ui()
        results=[]; seen_pages=set()
        for _ in range(20):
            found=[n for n in root.iter('node') if n.get('content-desc')==name and visible(n)]
            page=ET.tostring(root)
            if page in seen_pages:break
            seen_pages.add(page)
            if len(found)>1:raise Blocked('target_missing_or_ambiguous')
            if found:
                results.append(root)
                # A page with a unique result cannot prove a hidden duplicate.
                # Search UI includes result count when available; extra pages
                # are scanned before opening the first result again.
            self.run('shell','input','swipe','540','1800','540','500','450')
            next_root=self.ui()
            if ET.tostring(next_root)==page:break
            root=next_root
        else:raise Blocked('friend_search_scan_incomplete')
        if len(results)!=1:raise Blocked('target_missing_or_ambiguous')
        # Navigate back to the result if a scan moved the viewport.
        root=self.ui()
        for _ in range(20):
            candidates=[n for n in root.iter('node') if n.get('content-desc')==name and visible(n)]
            if candidates:
                self.tap(unique(candidates));return self.ui()
            self.run('shell','input','swipe','540','500','540','1800','450');root=self.ui()
        raise Blocked('target_missing_or_ambiguous')

    def open_room(self,room):
        locator=room['locator']
        if locator.get('kind')!='friend':raise Blocked('locator_unsupported')
        profile=self.friend(locator['name'])
        if profile_fingerprint(profile)!=locator['fingerprint']:
            raise Blocked('profile_identity_changed')
        self.click(text='1:1 채팅')
        root=self.ui()
        title=self.find(root,rid='toolbar_default_title_text')
        if (title.get('content-desc') or title.get('text'))!=room['name']:
            raise Blocked('room_title_mismatch')
        self.chat_open=True
        return root

    def inspect_friend(self,name):
        actual=self.account()
        profile=self.friend(name)
        return {'account':actual,'name':name,'kakao_room_id':None,'locator':{'kind':'friend','name':name,'fingerprint':profile_fingerprint(profile)}}

    def send(self,room,text):
        root=self.open_room(room)
        edit=self.find(root,rid='message_edit_text')
        width=max(int(re.findall(r'\d+',n.get('bounds','[0,0][0,0]'))[2]) for n in root.iter('node'))
        before=sum(n.get('text')==text and n.get('resource-id')==PREFIX+'message' and center(n)[0]>width/2 for n in root.iter('node'))
        self.tap(edit);self.input_text(text)
        root=self.ui()
        if self.find(root,rid='message_edit_text').get('text')!=text:
            raise Blocked('input_verification_failed')
        title=self.find(root,rid='toolbar_default_title_text')
        if (title.get('content-desc') or title.get('text'))!=room['name']:
            raise Blocked('room_title_mismatch')
        button=self.find(root,rid='send_button_layout')
        self.send_attempted=True
        self.tap(button)
        root=self.ui()
        matches=[n for n in root.iter('node') if n.get('resource-id')==PREFIX+'message' and n.get('text')==text and center(n)[0]>width/2]
        failed=any(re.search('재전송|전송 실패',n.get('content-desc','')) for n in root.iter('node'))
        if len(matches)<=before or self.find(root,rid='message_edit_text').get('text') or failed:
            raise Blocked('send_result_unverified')
        return {'state':'verified','sent_at':time.strftime('%Y-%m-%dT%H:%M:%S',time.gmtime())+'.000Z'}

    # --- Fast path: on-device accessibility executor ----------------------
    def accessibility_enabled(self):
        try:enabled=self.run('shell','settings','get','secure','enabled_accessibility_services',timeout=5)
        except Blocked:return False
        return 'com.yusaek.talkbridge/' in enabled

    def fast_broadcast(self,payload,timeout=40):
        # The accessibility service cannot reliably launch Kakao from another
        # foreground app on Android 12. The ADB shell can, so establish the
        # foreground before the one on-device command. Do not spend the service's
        # whole navigation timeout repeatedly backing through another app.
        self.run('shell','input','keyevent','KEYCODE_WAKEUP')
        self.run('shell','wm','dismiss-keyguard')
        foreground=self.run('shell','dumpsys','activity','activities',timeout=5)
        if not re.search(r'mResumedActivity:[^\n]*\bcom\.kakao\.talk/',foreground):
            self.run('shell','monkey','-p',PKG,'-c','android.intent.category.LAUNCHER','1',timeout=5)
        encoded=base64.b64encode(json.dumps(payload,ensure_ascii=False).encode()).decode()
        result=self.run('shell','am','broadcast','-n',SEND_RECEIVER,'-a','com.yusaek.talkbridge.SEND','--es','payload',encoded,timeout=timeout)
        # Receiver returns base64(JSON) so `am broadcast` prints one clean token.
        match=re.search(r'data="([A-Za-z0-9+/=]*)"',result)
        if not match or not match.group(1):raise Blocked('executor_no_result')
        try:return json.loads(base64.b64decode(match.group(1)).decode('utf-8'))
        except Exception:raise Blocked('executor_bad_result')

    def inspect_fast(self,name):
        if not self.accessibility_enabled():raise Blocked('accessibility_disabled')
        data=self.fast_broadcast({'action':'inspect','name':name})
        if data.get('state')!='verified' or not data.get('fingerprint'):raise Blocked(data.get('error','profile_unavailable'))
        return {'name':name,'kakao_room_id':None,'locator':{'kind':'friend','name':name,'fingerprint':data['fingerprint'],'source':'on_device'}}

    def add_contact_fast(self,name,phone):
        if not self.accessibility_enabled():raise Blocked('accessibility_disabled')
        self.old_ime=self.run('shell','settings','get','secure','default_input_method').strip()
        if IME not in self.run('shell','ime','list','-a','-s'):raise Blocked('korean_input_helper_required')
        self.run('shell','ime','enable',IME)
        self.run('shell','ime','set',IME)
        data=self.fast_broadcast({'action':'add_contact','name':name,'phone':phone})
        if data.get('state')!='verified' or data.get('name')!=name or not data.get('fingerprint'):
            raise Blocked(data.get('error','contact_add_unverified'))
        return {'state':'verified','name':name,'kakao_room_id':None,
                'locator':{'kind':'friend','name':name,'fingerprint':data['fingerprint'],'source':'on_device'}}

    def account_fast(self):
        if not self.accessibility_enabled():raise Blocked('accessibility_disabled')
        data=self.fast_broadcast({'action':'account'})
        if data.get('state')!='verified' or not data.get('account'):raise Blocked(data.get('error','account_identity_unavailable'))
        return data['account']

    def onboard_fast(self):
        if not self.accessibility_enabled():raise Blocked('accessibility_disabled')
        started=time.monotonic();cursor=''
        for _ in range(200):  # 6 pages per call; ~866 friends need well over 120 pages
            data=self.fast_broadcast({'action':'onboard_friends',**({'cursor':cursor} if cursor else {})},timeout=25)
            if data.get('state')=='verified':break
            if data.get('state')!='partial' or not isinstance(data.get('cursor'),str) or not data['cursor']:
                if data.get('error')=='friend_count_mismatch':
                    raise Blocked('friend_count_mismatch:%s/%s' % (data.get('count'),data.get('expected_count')))
                raise Blocked(data.get('error','friend_onboarding_invalid'))
            cursor=data['cursor']
        else:raise Blocked('friend_onboarding_incomplete')
        entries=data.get('entries')
        if data.get('scope')!='friend' or data.get('traversal_finished') is not True or not isinstance(entries,list) or len(entries)>5000:
            raise Blocked(data.get('error','friend_onboarding_invalid'))
        if any(not isinstance(e,dict) or e.get('kind')!='friend' or not isinstance(e.get('name'),str) or not e['name'] for e in entries):
            raise Blocked('friend_onboarding_invalid')
        data['host_ms']=round((time.monotonic()-started)*1000)
        return data

    def send_fast(self,room,text,dry_run=False,hold=False):
        if not self.accessibility_enabled():raise Blocked('accessibility_disabled')
        locator=room.get('locator') or {}
        if locator.get('kind')!='friend':raise Blocked('locator_unsupported')
        # Pass a prior on-device fingerprint if we have one (the executor then
        # verifies it). If not, the first send is title-only and the executor
        # returns the on-device fingerprint it computed, which the worker stores
        # for subsequent verified sends — no separate inspect pass / double nav.
        fingerprint=locator.get('fingerprint','') if locator.get('source')=='on_device' else ''
        # store = HOLD key so the executor can reuse the room for same-store sends.
        payload={'action':'send','name':room['name'],'store':room.get('store',''),'fingerprint':fingerprint,'text':text,'dry_run':bool(dry_run),'hold':bool(hold)}
        data=self.fast_broadcast(payload)
        # Only mark send_attempted when the on-device executor actually tapped
        # send. Pre-send failures (navigation, identity, chat not open) leave it
        # False so the worker can safely fall back to the slow path without any
        # risk of a double send; a post-tap uncertain result stays needs_check.
        self.send_attempted=bool(data.get('send_attempted'))
        if data.get('state')!='verified':
            # Keep stages on the exception (see init_room_fast) — a real send failure (e.g. 장효재,
            # chat_open_unverified) with stages=null left "서버가 본다" blind on exactly the thing
            # that needed explaining. Without this the log only had the error code, no WHERE.
            blocked=Blocked(data.get('error','send_result_unverified'));blocked.stages=data.get('stages')
            raise blocked
        return {'state':'verified','stages':data.get('stages'),'total_ms':data.get('total_ms'),
                'recent':data.get('recent'),'fingerprint':data.get('fingerprint'),
                'sent_at':time.strftime('%Y-%m-%dT%H:%M:%S',time.gmtime())+'.000Z'}

    def scan_room_fast(self,name):
        # Live Room Scan (2026-10-05): read-only poll of the open room's counterpart
        # bubbles. not_in_room/group_chat_detected are routine, expected outcomes (the
        # held room changed, or isInChat's exact-title gate rejected it) — NOT raised
        # as Blocked, so a miss here never trips the worker's error handling
        # (device_error/auto-disable) the way a real send failure would.
        if not self.accessibility_enabled():raise Blocked('accessibility_disabled')
        data=self.fast_broadcast({'action':'scan_room','name':name})
        if data.get('state')!='verified':return {'state':data.get('state','failed'),'error':data.get('error')}
        return {'state':'verified','messages':data.get('messages',[])}

    def init_room_fast(self,room,text,dry_run=False,greet=False):
        # Matching initialization only: create a 1:1 room (friend -> profile ->
        # 1:1 채팅 -> first message). Never used for regular work sends.
        # dry_run: find and enter the room but DO NOT send the greeting.
        if not self.accessibility_enabled():raise Blocked('accessibility_disabled')
        payload={'action':'init_room','name':room['name'],'store':room.get('store',''),'text':text,'dry_run':bool(dry_run),'greet':bool(greet)}
        data=self.fast_broadcast(payload,timeout=60)
        self.send_attempted=bool(data.get('send_attempted'))
        if data.get('state')!='verified':
            # Keep stages on the exception so the caller (main()) can still surface WHERE it
            # failed — losing this on every failure made "서버가 로그를 보고 책임진다" blind
            # exactly when it mattered (debugging 장효재 took a blind re-run to find the cause).
            blocked=Blocked(data.get('error','init_room_unverified'));blocked.stages=data.get('stages')
            raise blocked
        return {'state':'verified','total_ms':data.get('total_ms'),'fingerprint':data.get('fingerprint'),
                'stages':data.get('stages'),'chat_input_present':data.get('chat_input_present'),
                'room_existed':data.get('room_existed'),'room_created':data.get('room_created'),'greeting_sent':data.get('greeting_sent'),'send_attempted':self.send_attempted,'dry_run':data.get('dry_run'),
                'sent_at':time.strftime('%Y-%m-%dT%H:%M:%S',time.gmtime())+'.000Z'}

    def export(self,room):
        self.open_room(room)
        tmp='/sdcard/Android/data/com.kakao.talk/tmp'
        try:self.run('shell','test','-d',tmp);old=set(self.run('shell','find',tmp,'-name','KakaoTalkChats.txt').splitlines())
        except Blocked:old=set()
        self.click(desc='메뉴 더보기');self.click(desc='채팅방 설정')
        self.click(text='대화 내용 내보내기');self.click(text='텍스트 메시지만 저장')
        root=self.ui()
        if not any(n.get('text')=='KakaoTalkChats.txt' for n in root.iter('node')):
            raise Blocked('export_share_not_ready')
        paths=set(self.run('shell','find','/sdcard/Android/data/com.kakao.talk/tmp','-name','KakaoTalkChats.txt').splitlines())-old
        if len(paths)!=1:raise Blocked('export_file_ambiguous')
        path=next(iter(paths))
        if not re.fullmatch(r'/sdcard/Android/data/com\.kakao\.talk/tmp/\d+/KakaoTalkChats\.txt',path):
            raise Blocked('export_path_invalid')
        raw=self.run('exec-out','cat',path,binary=True)
        if len(raw)>20*1024*1024:raise Blocked('export_too_large')
        self.run('shell','input','keyevent','4')
        text=raw.decode('utf-8-sig')
        # Defense in depth (mirrors media export): a 1:1 chat export starts with
        # "<name> 님과 카카오톡 대화". If we somehow exported a different/group room,
        # reject it so a wrong room's history never becomes this room's snapshot.
        if text.splitlines()[0]!=room['name']+' 님과 카카오톡 대화':raise Blocked('export_room_mismatch')
        return {'text':text,'state':'verified'}

    def media_export_signature(self,folder):
        # TXT and all present originals must stop changing before import.
        raw=self.run('exec-out','cat',folder+'/KakaoTalkChats.txt',binary=True)
        if not raw or len(raw)>10*1024*1024:raise Blocked('media_export_incomplete')
        listing=self.run('shell','ls','-ln',folder)
        if 'KakaoTalkChats.txt' not in listing:raise Blocked('media_export_incomplete')
        return raw,listing

    def wait_media_export(self,folder,sleep=time.sleep,attempts=40):
        previous=None;stable=0
        for _ in range(attempts):
            try:current=self.media_export_signature(folder)
            except Blocked:current=None
            if current is not None and current==previous:stable+=1
            else:stable=0
            if stable>=3:return current
            previous=current;sleep(1)
        raise Blocked('media_export_incomplete')

    def collect_media(self,room,known,export_path=None):
        self.open_room(room)
        root='/sdcard/Documents/KakaoTalk/Chats'
        def folders():
            try:return set(self.run('shell','find',root,'-mindepth','1','-maxdepth','1','-type','d').splitlines())
            except Blocked:return set()
        if export_path:folder=export_path
        else:
            before=folders()
            self.click(desc='메뉴 더보기');self.click(desc='채팅방 설정');self.click(text='대화 내용 내보내기');self.click(text='모든 메시지 내부저장소에 저장')
            created=set()
            for _ in range(30):
                created=folders()-before
                if created:break
                time.sleep(1)
            if len(created)!=1:raise Blocked('media_export_directory_ambiguous')
            folder=next(iter(created))
        if not re.fullmatch(root+r'/KakaoTalk_Chats_\d{4}-\d{2}-\d{2}_\d{2}\.\d{2}\.\d{2}_-?\d+',folder):raise Blocked('media_export_path_invalid')
        raw,listing=self.wait_media_export(folder)
        text=raw.decode('utf-8-sig')
        if text.splitlines()[0]!=room['name']+' 님과 카카오톡 대화':raise Blocked('media_export_room_mismatch')
        available=self.run('shell','find',folder,'-maxdepth','1','-type','f').splitlines()
        names=[pathlib.PurePosixPath(p).name for p in available if re.fullmatch(re.escape(folder)+r'/[a-zA-Z0-9._-]+\.(?:png|jpe?g|webp|gif|pdf|xlsx|xls|docx|csv|zip)',p,re.I)]
        referenced=[]
        for line in text.splitlines():
            if re.match(r'^\d{4}년 .*?, .*? : ',line):
                body=line.split(' : ',1)[1]
                for name in names:
                    if name in body.split() and name not in referenced:referenced.append(name)
        known_by_name={k['name']:k['sha256'] for k in known if isinstance(k,dict) and re.fullmatch(r'[a-f0-9]{64}',k.get('sha256',''))}
        files=[];remaining=0;large=0;total=0;manifest=[]
        for name in reversed(referenced):
            path=folder+'/'+name
            try:size=int(self.run('shell','stat','-c','%s',path).strip())
            except (Blocked,ValueError):continue
            if size>20*1024*1024:large+=1;continue
            digest=self.run('shell','sha256sum',path).split()[0]
            manifest.append({'name':name,'sha256':digest})
            if name in known_by_name and digest==known_by_name[name]:continue
            if len(files)>=50 or total+size>20*1024*1024:remaining+=1;continue
            data=self.run('exec-out','cat',path,binary=True)
            if len(data)!=size:raise Blocked('media_export_file_incomplete')
            total+=size;files.append({'name':name,'data':base64.b64encode(data).decode()})
        references=set(re.findall(r'(?<![a-zA-Z0-9])[a-f0-9]{64}\.(?:png|jpe?g|webp|gif|pdf|xlsx|xls|docx|csv|zip)\b',text,re.I))
        if self.media_export_signature(folder)!=(raw,listing):raise Blocked('media_export_incomplete')
        return {'state':'verified','text':text,'files':files,'manifest':manifest,'remaining':remaining,'missing':large+len(references-set(names)),'export_path':folder}

    def send_media(self,room,media,preview_only=False):
        path=pathlib.Path(media.get('path',''))
        if not path.is_file():raise Blocked('media_file_missing')
        data=path.read_bytes()
        if not 0<len(data)<=20*1024*1024 or hashlib.sha256(data).hexdigest()!=media.get('sha256'):raise Blocked('media_integrity_failed')
        if not re.fullmatch(r'[a-f0-9-]{36}',media.get('id','')):raise Blocked('media_id_invalid')
        root=self.open_room(room)
        edit=self.find(root,rid='message_edit_text')
        if edit.get('text'):
            self.tap(edit);self.input_text('')
            root=self.ui();edit=self.find(root,rid='message_edit_text')
            if edit.get('text'):raise Blocked('draft_clear_unverified')
        def count(root):
            width=max(int(re.findall(r'\d+',n.get('bounds','[0,0][0,0]'))[2]) for n in root.iter('node'))
            return sum(visible(n) and center(n)[0]>width/2 and ((media['kind']=='image' and n.get('resource-id')==PREFIX+'image') or (media['kind']=='file' and n.get('resource-id')==PREFIX+'bubble' and media['name'] in n.get('content-desc',''))) for n in root.iter('node'))
        before=count(root)
        folder='/sdcard/Android/data/com.yusaek.talkbridge/files/outgoing/'+media['id']
        self.run('shell','mkdir','-p',folder);self.run('push',str(path.resolve()),folder+'/data',timeout=90)
        if self.run('shell','sha256sum',folder+'/data').split()[0]!=media['sha256']:raise Blocked('media_transfer_integrity_failed')
        item={k:media[k] for k in ['id','name','mime','bytes','sha256']}
        encoded=base64.b64encode(json.dumps(item).encode()).decode()
        reply=self.run('shell','am','start','-n','com.yusaek.talkbridge/.ShareActivity','--es','item',encoded)
        if 'Error' in reply:raise Blocked('media_share_helper_required')
        root=self.ui();field=self.find(root,rid='edit_text');self.tap(field);self.input_text(room['name']);self.run('shell','input','keyevent','4')
        root=self.ui()
        if self.find(root,rid='edit_text').get('text')!=room['name']:raise Blocked('media_search_verification_failed')
        self.tap(self.share_target(root,room));root=self.ui()
        recipients=[n.get('text') for n in root.iter('node') if n.get('resource-id')==PREFIX+'name_text' and visible(n)]
        submit=self.find(root,rid='submit_button')
        if recipients!=[room['name']] or submit.get('text')!='1 보내기':raise Blocked('media_recipient_verification_failed')
        if preview_only:return {'state':'verified','preview_only':True,'messages_sent':0}
        self.send_attempted=True;self.tap(submit)
        root=self.ui()
        # Some Kakao versions show a final confirmation. Do not accept a generic
        # positive button without an explicit sharing/sending confirmation.
        positives=[n for n in root.iter('node') if n.get('resource-id')=='android:id/button1' and n.get('text') in ['확인','보내기']]
        if positives:
            messages=' '.join(n.get('text','') for n in root.iter('node') if n.get('resource-id')=='android:id/message')
            if not re.search('전송|보내',messages):raise Blocked('media_confirmation_unverified')
            self.tap(unique(positives));root=self.ui()
        for _ in range(3):
            titles=[n for n in root.iter('node') if n.get('resource-id')==PREFIX+'toolbar_default_title_text' and visible(n)]
            if len(titles)==1 and (titles[0].get('text') or titles[0].get('content-desc'))==room['name']:break
            time.sleep(1);root=self.ui()
        else:root=self.open_room(room)
        failed=any(re.search('재전송|전송 실패|업로드 중',n.get('content-desc','')) for n in root.iter('node'))
        if count(root)<=before or failed:raise Blocked('send_result_unverified')
        return {'state':'verified','sent_at':time.strftime('%Y-%m-%dT%H:%M:%S',time.gmtime())+'.000Z'}

    def share_target(self,root,room):
        # Search results distinguish Friends (name accessibility description)
        # from Chats (blank name description). A same-named group never wins.
        return unique([n for n in root.iter('node') if n.get('resource-id')==PREFIX+'name' and n.get('text')==room['name'] and n.get('content-desc')==room['name']])

    def onboard(self):
        entries=[]; complete=True
        for kind,tab in [('friend','친구 탭'),('room','채팅 탭')]:
            root=self.home()
            self.tap(unique([n for n in root.iter('node') if n.get('content-desc','').startswith(tab)]))
            seen=set();last_names=[]
            for _ in range(100):
                root=self.ui()
                names=visible_contact_names(root,kind,self.own_name)
                signature=tuple(names)
                if signature in seen:break
                seen.add(signature)
                # Preserve occurrences within a page; remove only an ordered
                # viewport overlap. Names alone are not destination identities.
                overlap=0
                for count in range(1,min(len(last_names),len(names))+1):
                    if last_names[-count:]==names[:count]:overlap=count
                entries.extend({'name':name,'kind':kind,'fingerprint':None,'ambiguous':True} for name in names[overlap:])
                last_names=names
                self.run('shell','input','swipe','540','1800','540','500','450')
            else:complete=False
            if not seen or not any(entries[-1:] if entries else []):complete=False
        # UI enumeration cannot establish hidden/collapsed friends completeness.
        return {'entries':entries,'complete':False,'traversal_finished':complete,'state':'verified'}

def main():
    sys.stdin.reconfigure(encoding='utf-8')
    payload=json.load(sys.stdin);device=Adb(payload['device']);action=payload['action']
    if action in ['bind','setup']:device.allow_initial_discovery=not device.expected_hardware
    try:
        if action=='restore':device.recover_settings();result={'state':'verified'}
        elif action=='discover':result={'state':'verified','services':device.global_run('mdns','services')}
        elif action=='pair':
            address=str(payload.get('address',''));code=str(payload.get('code',''))
            if not re.fullmatch(r'[0-9.]+:\d+',address) or not re.fullmatch(r'\d{6}',code):raise Blocked('pairing_input_invalid')
            result={'state':'verified'} if 'Successfully paired' in device.global_run('pair',address,code) else {'state':'failed','error':'pairing_failed'}
        elif action=='reconnect':device.connect_transport();result={'state':'verified'}
        elif action=='warmup':
            # Server-start warmup: wake the screen, bring Kakao to main, and run ONE
            # throwaway on-device search so the search backend is initialized. The cold
            # first search (slow, can even miss a folded room) is paid here at startup,
            # so the first REAL web send hits a warm backend. No 더보기/settings nav.
            device.connect_transport();device.keep_warm();device.home()
            result=device.fast_broadcast({'action':'warmup'})
        elif action=='helper_ping':
            device.connect_transport()
            reply=device.run('shell','am','broadcast','-n','com.yusaek.talkbridge/.ConfigReceiver','-a','com.yusaek.talkbridge.HELLO')
            result={'state':'verified' if 'result=1' in reply else 'failed'}
        elif action=='keep_warm':
            device.connect_transport()
            result=device.keep_warm()
        elif action=='onboard':
            device.connect_transport()
            version=re.search(r'versionCode=(\d+)\b',device.run('shell','dumpsys','package','com.yusaek.talkbridge'))
            if version and int(version.group(1))>=8 and device.accessibility_enabled():
                actual=device.account_fast()
                if actual!=payload['device'].get('account'):raise Blocked('account_changed')
                result=device.onboard_fast()
            else:
                device.connect()
                actual=device.account()
                if actual!=payload['device'].get('account'):raise Blocked('account_changed')
                result=device.onboard()
        elif action in ('send','probe','account','add_contact','init_room','scan_room','batch_finish') and payload.get('fast') is True:
            # Fast path stays lean: transport only (no IME swap / settings marker).
            # Account is verified once per session by the worker via the on-device
            # reader (account_fast, ~seconds) instead of the slow uiautomator path.
            device.connect_transport()
            if action=='add_contact':
                version=re.search(r'versionCode=(\d+)\b',device.run('shell','dumpsys','package','com.yusaek.talkbridge'))
                if not version or int(version.group(1))<9:raise Blocked('bridge_update_required')
            if action=='account':
                actual=device.account_fast()
                if actual!=payload['device'].get('account'):raise Blocked('account_changed')
                result={'account':actual,'state':'verified'}
            else:
                actual=device.expected
                if payload.get('verified_account') is not True:
                    actual=device.account_fast()
                    if actual!=payload['device'].get('account'):raise Blocked('account_changed')
                if action=='batch_finish':
                    result=device.fast_broadcast({'action':'batch_finish'})
                elif action=='add_contact':
                    result=device.add_contact_fast(payload['name'],payload['phone'])
                    result['account']=actual
                elif action=='send':
                    result=device.send_fast(payload['room'],payload['text'],dry_run=payload.get('dry_run') is True,hold=payload.get('hold') is True)
                elif action=='init_room':
                    result=device.init_room_fast(payload['room'],payload['text'],dry_run=payload.get('dry_run') is True,greet=payload.get('greet') is True);result['account']=actual
                elif action=='scan_room':
                    result=device.scan_room_fast(payload['name'])
                else:
                    result={'account':actual,'state':'verified',**device.inspect_fast(payload['name'])}
        else:
            device.connect()
            if action=='setup':result=device.setup_helper(payload)
            elif action=='install':
                apk=pathlib.Path(payload['apk']).resolve()
                if not apk.is_file():raise Blocked('bridge_apk_missing')
                device.run('install','-r',str(apk),timeout=90)
                result={'state':'verified'}
            elif action=='inspect':result={'account':device.account(),'self_name':device.self_name(),'state':'verified'}
            elif action=='bind':
                actual=device.account()
                if actual!=payload['device'].get('account'):raise Blocked('account_changed')
                result={'account':actual,'state':'verified'}
            elif action=='probe':result=device.inspect_friend(payload['name'])
            else:
                actual=device.account()
                if actual!=payload['device'].get('account'):raise Blocked('account_changed')
                if action=='send':result=device.send(payload['room'],payload['text'])
                elif action=='send_media':result=device.send_media(payload['room'],payload['media'])
                elif action=='refresh':result=device.export(payload['room'])
                elif action=='collect_media':result=device.collect_media(payload['room'],payload.get('known_media',[]),payload.get('export_path'))
                else:raise Blocked('action_unsupported')
    except Exception as exc:
        error=str(exc) if isinstance(exc,Blocked) else 'adb_adapter_failed'
        result={'state':'needs_check' if device.send_attempted else 'failed','error':error,'detail':type(exc).__name__}
        stages=getattr(exc,'stages',None)
        if stages is not None:result['stages']=stages
    finally:
        if action in ('send','send_media') and getattr(device,'chat_open',False):
            # Return to Kakao's main screen as soon as the send attempt is
            # checked, so later replies can raise a notification.
            try:
                finished=device.fast_broadcast({'action':'finish_send','hold':payload.get('hold') is True})
                if finished.get('state')!='verified':result['restore_error']='send_finish_failed'
            except Exception:result['restore_error']='send_finish_failed'
        if not device.restore_keyboard():result['restore_error']='keyboard_restore_failed'
    if device.verified_hardware:result.update({'serial':device.serial,'hardware_id':device.verified_hardware})
    sys.stdout.reconfigure(encoding='utf-8')
    print(json.dumps(result,ensure_ascii=False))

if __name__=='__main__':main()
