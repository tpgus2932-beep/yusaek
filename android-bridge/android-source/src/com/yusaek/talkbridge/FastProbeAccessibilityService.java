package com.yusaek.talkbridge;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.SharedPreferences;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Bundle;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import org.json.JSONArray;
import org.json.JSONObject;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * On-device Kakao executor. Reads the active window's node tree from memory
 * (getRootInActiveWindow) instead of `uiautomator dump`, so a whole navigate →
 * verify → set text → send → verify sequence runs on the phone and is triggered
 * by one authenticated ADB broadcast. Idle except during an explicit command.
 */
public final class FastProbeAccessibilityService extends AccessibilityService {
    private static volatile FastProbeAccessibilityService active;
    private static final java.util.concurrent.atomic.AtomicBoolean BUSY = new java.util.concurrent.atomic.AtomicBoolean(false);
    private FriendScan friendScan;
    // Partial stage trace for the current command, surfaced even when it throws (so a
    // failed match still reports how far it got: entry/chip/scroll_pages/pin/...).
    private JSONObject stageTrace = new JSONObject();

    private static final class FriendScan {
        final String cursor = java.util.UUID.randomUUID().toString();
        final JSONArray entries = new JSONArray();
        final Set<String> pages = new HashSet<>();
        List<String> observed = new ArrayList<>();
        int viewed;
        int rewound;
        int backtracks;
        String lastRewindSig;
        boolean recent;         // read newest-added first, return entries on every call so the host can stop early
        boolean sortSet;        // 친구추가순 has been applied
        boolean sortChanged;    // we changed the user's sort and must put it back
        boolean sortWasAlpha;   // user's sort was 가나다순
        boolean scanning;
        boolean listStarted;
        int expectedCount;
    }

    static final String PKG = "com.kakao.talk";
    // This Kakao build exposes no resource-ids over accessibility, so nodes are
    // matched by class + content-desc + bounds, not resource-id.
    // 2026-10-05 정정: 위 설명은 flagReportViewIds를 요청하지 않았을 때 얘기였다 — 그 플래그를
    // 켜니 uiautomator처럼 resource-id가 그대로 노출된다(com.kakao.talk:id/message_edit_text
    // 등, 실측 확인). currentOneToOneTitle()의 입력창 판정만 이걸로 바꿨다(키보드 위/아래 모두
    // 같은 id라 위치 기반 휴리스틱보다 안정적). 다른 기존 함수들(isInChat 등, 확정 동작 보존
    // 대상)은 그대로 둔다 — 굳이 건드릴 이유가 없다.
    static final String EDIT_TEXT_RESOURCE_ID = "com.kakao.talk:id/message_edit_text";
    static final String MORE_TAB = "더보기 탭";
    static final String FRIEND_TAB = "친구 탭";
    static final String CHAT_TAB = "채팅 탭";   // 하단 말풍선(채팅목록) 탭 — desc는 "채팅 탭 N개의…"로 시작
    static final String SEARCH = "검색";
    static final String ONE_TO_ONE = "1:1 채팅";
    static final String SEND_LABEL = "전송";
    static final String EDIT_CLASS = "android.widget.EditText";
    // 단톡방/1:1 구분 신호(2026-10-05 실측, talk-group-chat-discriminator):
    // 좌측 버블마다 "OOO 님의 프로필 보기" 발신자 마커가 붙고, 단톡방 toolbar 제목만
    // "...N명" 접미사로 끝난다(1:1 제목엔 접미사가 전혀 없음).
    static final String SENDER_MARKER_SUFFIX = " 님의 프로필 보기";
    private static final java.util.regex.Pattern GROUP_TITLE_SUFFIX = java.util.regex.Pattern.compile(".*[0-9]+명$");
    // 날짜 구분선("2026년 10월 5일 월요일")은 중앙 정렬 칩이지만 좌측 절반 경계에 걸쳐 좌측
    // 버블로 오인될 수 있다(2026-10-05 실측으로 확인) — 발신자 아님, 항상 제외.
    private static final java.util.regex.Pattern DATE_DIVIDER = java.util.regex.Pattern.compile("^\\d{4}년 \\d{1,2}월 \\d{1,2}일 .요일$");

    private static final int STEP_MS = 2500;   // per screen-transition budget
    private static final int POLL_MS = 40;     // in-memory reads are cheap

    // Live Room Scan push (2026-10-05): toolbar band 안의 아이콘 버튼들(뒤로/검색/...)은
    // 제목이 아니므로 currentOneToOneTitle()에서 제외한다.
    private static final Set<String> TOOLBAR_ICON_LABELS = new HashSet<>(java.util.Arrays.asList(
        "뒤로", "이전", "검색", "보이스톡", "메뉴 더보기", "입력된 내용 삭제", "프로필"));
    private volatile long lastLiveScanAt = 0;
    // 2026-10-07 실측(뉴퀸 방, 두 차례 독립 재현): 내가 보낸 메시지가 상대방 발신으로 잘못
    // 캡처되는 버그 — DB 확인 결과 둘 다 "내 전송 완료 60~108ms 뒤"에 돌아간 라이브스캔에서
    // 발생했다(가이드라인 문서 4부의 미해결 버그, 전송 직후 애니메이션 과도기에 scanRoom()의
    // 좌/우 판정이 실패한다는 가설과 일치). BUSY 플래그는 send() 실행 "중"에만 스캔을 막아서,
    // send()가 끝나자마자(그리고 그 직후 내 버블이 렌더되며 발생하는 바로 그 이벤트에서) 아직
    // 화면이 정착 안 된 상태를 스캔해버리는 틈을 못 막는다 — 이 타임스탬프로 그 틈을 메운다.
    private volatile long lastSendCompletedAt = 0;
    private static final long POST_SEND_SCAN_COOLDOWN_MS = 600L;
    // 2026-10-05 실측 확정 원인: screen_off_timeout=60000ms라 화면을 수동으로 깨워도 60초간
    // 터치가 없으면 안드로이드가 자동으로 다시 절전모드(Dozing)에 들어가고, 그 순간부터
    // currentOneToOneTitle()이 null을 반환해 Live Room Scan이 멈춘다(로그로 60.4초 뒤 title=null
    // 확인). 1차 수정(이벤트가 올 때마다 wake lock 갱신)만으로는 부족했다 — 전송 직후부터
    // 상대방 답장까지 화면에 아무 변화도 없는 공백(사람이 타이핑하는 시간)이 60초를 넘으면
    // 이벤트 자체가 안 와서 갱신할 기회가 없다(실측: 답장 전에 이미 Dozing으로 돌아가 not_in_room).
    // 그래서 이벤트에 기대지 않고, 1:1 방에 있다고 확인되면 스스로 20초마다 재확인+재획득하는
    // 타이머를 돌려 방을 벗어날 때까지 화면을 계속 켜 둔다(방을 나가면 타이머가 스스로 멈춤).
    private PowerManager.WakeLock roomWakeLock;
    private static final long ROOM_WAKE_LOCK_MS = 90_000L;
    // 2026-10-05 실측 추가 확인: 이벤트 하나당 한 번만 스캔하면, 연타로 빠르게 여러 메시지가
    // 오는 중 이벤트 하나가 디바운스/타이밍에 묻혀 빠지면 그 메시지는 다음 이벤트가 올 때까지
    // 영영 안 잡힌다(실측: "마지막임"/"뭐요"는 잡혔는데 바로 다음 "뭐"가 다음 이벤트 없이
    // 누락됨). 그래서 타이머가 화면만 깨우는 게 아니라 짧은 주기(2초)로 직접 재스캔도 해서,
    // 이벤트 기반 캐치가 하나 비어도 2초 안에 자체적으로 메꾼다 — "연타로 많이 보내도 전체
    // 정확하게 캐치" 요구사항 대응.
    private static final long ROOM_AWAKE_TICK_MS = 2_000L;
    private final android.os.Handler roomAwakeHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private final java.util.concurrent.atomic.AtomicBoolean roomAwakeArmed = new java.util.concurrent.atomic.AtomicBoolean(false);
    // 2026-10-05 사용자 지시: 문제가 또 생기면 재빌드 없이 바로 어디서 끊기는지 보려고
    // 핵심 분기점(방 재진입/이탈, 스캔 실패 사유, 캐치 건수, 전송 성공여부)은 상시 로그로
    // 남긴다 — 이벤트마다 찍는 verbose 로그(초당 수십 건)는 디버깅 때만 임시로 넣고 뺀다.
    private static final String TAG = "YusaekLiveScan";
    private final Runnable roomAwakeTick = new Runnable() {
        @Override public void run() {
            if (BUSY.get()) { roomAwakeHandler.postDelayed(this, ROOM_AWAKE_TICK_MS); return; }
            try {
                String title = currentOneToOneTitle();
                if (title != null) {
                    ensureRoomAwake();
                    liveScanOnce(title);
                    roomAwakeHandler.postDelayed(this, ROOM_AWAKE_TICK_MS);
                } else {
                    Log.i(TAG, "disarm: room no longer confident (left room / navigated away)");
                    roomAwakeArmed.set(false);
                    roomAwakeHandler.removeCallbacks(lockAfterIdle);   // 이미 손으로 나갔으면 뒤늦게 잠글 필요 없음
                }
            } catch (Exception e) { Log.w(TAG, "disarm: tick exception", e); roomAwakeArmed.set(false); roomAwakeHandler.removeCallbacks(lockAfterIdle); }
        }
    };
    // Manual open-room reading retains live scanning for three idle minutes.
    private static final long KEEP_WARM_IDLE_MS = 180_000L;
    private String commandText="";
    private final Runnable lockAfterIdle = () -> {
        Log.i(TAG, "idle " + KEEP_WARM_IDLE_MS + "ms in manually opened room — locking screen to hand off to notification capture");
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) performGlobalAction(GLOBAL_ACTION_LOCK_SCREEN);
        roomAwakeHandler.removeCallbacks(roomAwakeTick);
        roomAwakeArmed.set(false);
        if (roomWakeLock != null && roomWakeLock.isHeld()) roomWakeLock.release();
    };

    private void ensureRoomAwake() {
        if (roomWakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            roomWakeLock = pm.newWakeLock(PowerManager.SCREEN_DIM_WAKE_LOCK | PowerManager.ON_AFTER_RELEASE, "YusaekTalk:LiveRoomScan");
            roomWakeLock.setReferenceCounted(false);
        }
        roomWakeLock.acquire(ROOM_WAKE_LOCK_MS);
        if (roomAwakeArmed.compareAndSet(false, true)) {
            Log.i(TAG, "arm: confident in 1:1 room, keeping screen awake + scanning every " + ROOM_AWAKE_TICK_MS + "ms");
            roomAwakeHandler.postDelayed(roomAwakeTick, ROOM_AWAKE_TICK_MS);
        }
    }

    /** send()가 isInChat()으로 "같은 방"인지 보기 전에 호출. ensureRoomAwake()의
     *  SCREEN_DIM_WAKE_LOCK은 이미 켜진 화면을 계속 켜두기만 할 뿐 꺼진 화면을 다시 켜지는
     *  못한다(ACQUIRE_CAUSES_WAKEUP 없음) — lockAfterIdle()이 화면을 끈 뒤 다음 전송이 오면
     *  이 메서드가 없어서 isInChat()이 꺼진 화면에서 아무것도 못 읽고 매번 친구탭 콜드경로로
     *  빠졌다(2026-10-06 실측: 같은 방에 몇 분 간격으로 보냈는데도 매번 친구탭 재진입).
     *  화면이 이미 켜져 있으면 그대로 반환(no-op) — 잠금 중일 때만 깨운다. */
    @SuppressWarnings("deprecation")
    private void wakeScreenForSend() {
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        if (pm.isInteractive()) { Log.i(TAG, "wake: already interactive, no-op"); return; }
        long t = SystemClock.elapsedRealtimeNanos();
        Log.i(TAG, "wake: screen not interactive, waking for send");
        PowerManager.WakeLock wake = pm.newWakeLock(
            PowerManager.SCREEN_BRIGHT_WAKE_LOCK | PowerManager.ACQUIRE_CAUSES_WAKEUP | PowerManager.ON_AFTER_RELEASE,
            "YusaekTalk:WakeForSend");
        wake.acquire(5000);
        try {
            boolean ok = waitUntil(() -> {
                AccessibilityNodeInfo root = getRootInActiveWindow();
                return root != null && PKG.contentEquals(String.valueOf(root.getPackageName()));
            }, STEP_MS);
            AccessibilityNodeInfo root = getRootInActiveWindow();
            Log.i(TAG, "wake: kakao_root_found=" + ok + " interactive_now=" + pm.isInteractive()
                + " root_pkg=" + (root == null ? "null" : root.getPackageName()) + " waited_ms=" + ms(t));
        } finally {
            wake.release();
        }
    }

    /** onAccessibilityEvent(이벤트 즉시)와 roomAwakeTick(2초 안전망) 양쪽에서 재사용하는 실제
     *  스캔+push 로직. 이미 검증된 scanRoom()으로 좌측 버블을 읽고, 매번 보이는 전부를 그대로
     *  서버로 보낸다. 2026-10-06: seq는 "영구 카운터"(이전엔 static Map, 프로세스 재시작마다
     *  리셋돼 서버 해시가 재시작 전/후 우연히 겹치면 중복이 조용히 버려지는 버그가 실측됨)가
     *  아니라 **이번 스캔 결과 안에서의 등장 순번**(지역 변수, 상태 없음)이다. 화면이 그대로면
     *  매 스캔 같은 seq가 나와 서버의 insert-or-ignore가 자연히 중복을 흡수하고, 새 문구만
     *  전에 없던 seq를 받아 새 행이 된다 — 프로세스가 몇 번을 재시작해도 영향 없음(상태 자체가
     *  없음). "DB에 이미 저장된 개수"를 더하는 방식은 화면이 그대로인 채 재스캔될 때마다 그
     *  개수가 계속 늘어나 매번 새 행이 쌓이는 폭주를 만들어 기각됨(구현 전 검토로 확인). */
    private void liveScanOnce(String title) throws Exception {
        JSONObject result = scanRoom(title, new JSONObject());
        String state = result.optString("state");
        if (!"verified".equals(state)) {
            // not_in_room/group_chat_detected는 isInChat()이 confident title과 어긋났다는
            // 뜻 — 이전에 두 번 재발한 버그 클래스라 상시 로그로 남긴다(재빌드 없이 바로 확인).
            Log.w(TAG, "scanRoom not verified: title=" + title + " state=" + state + " error=" + result.optString("error"));
            return;
        }
        JSONArray messages = result.optJSONArray("messages");
        if (messages == null || messages.length() == 0) return;
        Map<String, Integer> occurrenceSoFar = new java.util.HashMap<>();
        JSONArray toSend = new JSONArray();
        boolean ownConsumed=false;
        for (int i = 0; i < messages.length(); i++) {
            JSONObject m = messages.getJSONObject(i);
            if(!ownConsumed&&!commandText.isEmpty()&&m.optString("text").replaceAll("\\s+"," ").trim().equals(commandText.replaceAll("\\s+"," ").trim())){ownConsumed=true;continue;}
            String key = m.getString("sender") + "|" + m.getString("text");
            int seq = occurrenceSoFar.merge(key, 1, Integer::sum);
            toSend.put(new JSONObject(m.toString()).put("seq", seq));
        }
        Log.i(TAG, "capture: title=" + title + " sending=" + toSend.length() + " of visible=" + messages.length());
        pushLiveScan(title, toSend);
    }

    @Override protected void onServiceConnected() { super.onServiceConnected(); active = this; }

    // Live Room Scan (2026-10-05 플랜 Phase 3): 안드로이드 OS가 카카오 화면 내용이 바뀔 때마다
    // 호출해주는 접근성 콜백 — 네트워크 요청이 아니라 OS 내부 함수 호출. isInChat()처럼 미리
    // 알고 있는 이름과 비교하는 게 아니라, 지금 화면이 confident하게 1:1 방인지부터 스스로
    // 판단한다(currentOneToOneTitle). 맞으면 이미 검증된 scanRoom()을 그대로 재사용해 좌측
    // 버블만 읽고, 아직 서버에 안 보낸 것만 골라 HTTP POST로 push한다(TalkNotifications.java의
    // 알림 push와 동일한 패턴). BUSY 중(진짜 명령 진행 중)이거나 400ms 안에 또 들어온 이벤트는
    // 건너뛴다 — 입력창 타이핑 등 메시지와 무관한 화면 변화에도 발동하므로 가벼운 디바운스 필요.
    @Override public void onAccessibilityEvent(AccessibilityEvent event) {
        int type = event.getEventType();
        if (type != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED && type != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return;
        if (BUSY.get()) return;
        // 화면이 자동 절전되기 전에(위 ROOM_WAKE_LOCK_MS 주석 참고) 디바운스와 무관하게 매번 갱신한다.
        try { if (currentOneToOneTitle() != null) { ensureRoomAwake(); roomAwakeHandler.removeCallbacks(lockAfterIdle); roomAwakeHandler.postDelayed(lockAfterIdle, KEEP_WARM_IDLE_MS); } } catch (Exception ignored) {}
        if (type != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED) return;
        long now = SystemClock.elapsedRealtime();
        if (now - lastSendCompletedAt < POST_SEND_SCAN_COOLDOWN_MS) return;   // 내 전송 직후 버블 렌더 과도기 — 2초 안전망 틱이 대신 잡는다
        if (now - lastLiveScanAt < 400) return;
        lastLiveScanAt = now;
        try {
            String title = currentOneToOneTitle();
            if (title == null) return;
            liveScanOnce(title);
        } catch (Exception ignored) {}
    }

    /** 지금 화면이 confident하게 1:1 방인지 보고, 맞으면 방 이름(=toolbar 제목)을 돌려준다.
     *  isInChat(name)과 달리 이름을 미리 모르는 상태로 들어와서 toolbar에서 직접 뽑아내야
     *  한다 — 아이콘 라벨 제외, android.widget.TextView 하나만 제목 후보로 인정, 단톡방
     *  ("N명" 접미사)이면 null. 하단 EditText 없으면(= 채팅방 아님) null. */
    private String currentOneToOneTitle() {
        List<AccessibilityNodeInfo> roots = kakaoRoots();
        if (roots.isEmpty()) return null;
        List<AccessibilityNodeInfo> all = new ArrayList<>();
        for (AccessibilityNodeInfo root : roots) all.addAll(walk(root, null));
        if (all.isEmpty()) return null;
        // 2026-10-05 실측 확정 버그: roots.get(0)의 자체 bounds로 "화면 높이"를 구했었는데, 이
        // 기기는 물리 해상도 1080x2400, 앱 콘텐츠 영역 1080x2195(wm size 확인)이고 카카오 창이
        // 키보드 전환 등으로 가끔 edge-to-edge bounds(2400)를 보고하는 순간이 있어 "하단 절반"
        // 판정 기준이 흔들렸다(로그로 title=장효재인데 input=false만 반복되는 걸로 확인). 창
        // 메타데이터 대신 실제로 걸린 노드들의 렌더링 범위(top~bottom)로 높이를 구해 안정화한다.
        int top = Integer.MAX_VALUE, bottom = 0;
        for (AccessibilityNodeInfo n : all) {
            Rect r = new Rect(); n.getBoundsInScreen(r);
            if (r.width() <= 0 || r.height() <= 0) continue;
            if (r.top < top) top = r.top;
            if (r.bottom > bottom) bottom = r.bottom;
        }
        int h = bottom > top ? bottom - top : 2340;
        // 실측 추가 확인: 키보드가 떠 있을 때는 입력창이 화면 중간 바로 위(top=1156)에 위치해서
        // h=2195일 땐 52.7%로 통과하지만 h=2400일 땐 48.2%로 실패 — 키보드 위/아래 두 상태를
        // 위치만으로는 안정적으로 구분할 수 없다("입력창이 올라올 때 안 올라올 때 둘 다 호환"
        // 요구사항). flagReportViewIds를 켜서 resource-id로 직접 매칭하면 키보드 상태와 무관하게
        // 항상 같은 id라 위치 휴리스티크 없이 확정 가능 — 그걸 우선 쓰고, 혹시 id가 안 잡히는
        // 예외 상황 대비로 기존 위치 기반(30%) 판정을 fallback으로 남긴다.
        boolean input = false;
        String title = null;
        for (AccessibilityNodeInfo n : all) {
            Rect r = new Rect(); n.getBoundsInScreen(r);
            if (r.width() <= 0 || r.height() <= 0) continue;
            if (!input && EDIT_CLASS.contentEquals(String.valueOf(n.getClassName()))) {
                if (EDIT_TEXT_RESOURCE_ID.contentEquals(String.valueOf(n.getViewIdResourceName()))
                        || r.top > top + h * 3 / 10) input = true;
            }
            if (title == null && r.top < top + h * 20 / 100
                    && "android.widget.TextView".contentEquals(String.valueOf(n.getClassName()))) {
                String d = descOf(n), t = textOf(n);
                String candidate = !d.isEmpty() ? d : t;
                if (!candidate.isEmpty() && !TOOLBAR_ICON_LABELS.contains(candidate)) title = candidate;
            }
        }
        if (title == null || !input) return null;
        if (GROUP_TITLE_SUFFIX.matcher(title).matches()) return null;
        return title;
    }

    /** TalkNotifications.java의 알림 push와 동일한 HTTP 패턴(같은 "talk" SharedPreferences,
     *  같은 X-Talk-Device-Token 헤더) — 다른 트리거(화면 변화)로 같은 서버 엔드포인트 계열에
     *  쏘는 것뿐이라 그대로 재사용. 실패해도 조용히 무시(다음 content-changed 때 재시도됨). */
    private void pushLiveScan(String roomName, JSONArray messages) {
        TalkNotifications.enqueueLive(this,roomName,messages);
    }
    @Override public void onInterrupt() { }
    @Override public void onDestroy() { if (active == this) active = null; super.onDestroy(); }

    // ---- Read-only latency probe (unchanged contract) ----------------------
    static JSONObject probe() throws Exception {
        JSONObject result = new JSONObject();
        FastProbeAccessibilityService service = active;
        if (service == null) return result.put("state", "accessibility_disabled");
        long started = SystemClock.elapsedRealtimeNanos();
        AccessibilityNodeInfo root = service.getRootInActiveWindow();
        if (root == null) return result.put("state", "window_unavailable");
        CharSequence pkg = root.getPackageName();
        if (pkg == null || !PKG.contentEquals(pkg)) return result.put("state", "kakao_not_foreground");
        int count = service.walk(root, null).size();
        return result.put("state", "ok").put("node_count", count)
            .put("main_tab_visible", service.first(root, n -> startsWith(descOf(n), MORE_TAB) && visible(n)) != null)
            .put("friend_tab_visible", service.first(root, n -> startsWith(descOf(n), FRIEND_TAB) && visible(n)) != null)
            .put("search_visible", service.first(root, n -> SEARCH.contentEquals(descOf(n)) && visible(n)) != null)
            .put("elapsed_ms", (SystemClock.elapsedRealtimeNanos() - started) / 1000000.0);
    }

    // ---- Command entry point (called from FastProbeReceiver on a worker) ----
    /** payload: {action:'send'|'inspect', name, fingerprint?, text?, dry_run?} */
    static JSONObject run(JSONObject payload) {
        JSONObject out = new JSONObject();
        FastProbeAccessibilityService s = active;
        if (s == null) { try { out.put("state", "accessibility_disabled"); } catch (Exception ignored) {} return out; }
        // Serialize a real command against background parking so the two never
        // drive the Kakao UI at the same time.
        long deadline = SystemClock.uptimeMillis() + 4000;
        while (!BUSY.compareAndSet(false, true)) {
            if (SystemClock.uptimeMillis() > deadline) { try { out.put("state", "failed").put("error", "executor_busy"); } catch (Exception ignored) {} return out; }
            waitMs(50);
        }
        s.stageTrace = new JSONObject();
        try {
            String action = payload.optString("action", "send");
            s.commandText=payload.optString("text","");
            if ("inspect".equals(action)) return s.inspect(payload.getString("name"), out);
            if ("account".equals(action)) return s.account(out);
            if ("onboard_friends".equals(action)) return s.onboardFriends(payload, out);
            if ("friends_done".equals(action)) return s.friendsDone(out);
            if ("room_history".equals(action)) return s.roomHistory(payload, out);
            if ("room_peek".equals(action)) return s.roomPeek(payload, out);
            if ("share_pick".equals(action)) return s.sharePick(payload, out);
            if ("add_contact".equals(action)) return s.addContact(payload, out);
            if ("add_by_id".equals(action)) return s.addById(payload, out);
            if ("rename_friend".equals(action)) return s.renameFriend(payload, out);
            if ("rename_room".equals(action)) return s.renameRoom(payload, out);
            if ("chat_list".equals(action)) return s.chatList(payload, out);
            if ("chat_list_done".equals(action)) return s.chatListDone(out);
            if ("init_room".equals(action)) return s.initRoom(payload, out);
            if ("warmup".equals(action)) return s.warmup(out);
            if ("prepare_idle".equals(action)) {
                s.wakeScreenForSend();
                s.launchKakao();
                return s.warmup(out);
            }
            if ("batch_finish".equals(action)) return s.finishBatch(out);
            if ("finish_send".equals(action)) {
                s.releaseRoom();
                return payload.optBoolean("hold",false)?out.put("state","verified"):s.finishBatch(out);
            }
            if ("scan_room".equals(action)) return s.scanRoom(payload.getString("name"), out);
            if ("dump_tree".equals(action)) return s.dumpTree(out);   // 진단 전용(읽기): 현재 화면의 접근성 노드 트리를 그대로 반환
            return s.send(payload, out);
        } catch (Blocked b) {
            try { out.put("state", "send_attempted".equals(b.getMessage()) ? "needs_check" : "failed").put("error", b.getMessage()).put("stages", s.stageTrace); } catch (Exception ignored) {}
            s.restoreFriendSort(s.friendScan); s.friendScan = null;   // never leave the user's sort changed
            s.toMain();
            return out;
        } catch (Exception e) {
            try { out.put("state", "failed").put("error", "executor_failed").put("stages", s.stageTrace); } catch (Exception ignored) {}
            s.restoreFriendSort(s.friendScan); s.friendScan = null;
            s.toMain();
            return out;
        } finally { s.commandText="";BUSY.set(false); }
    }


    static final class Blocked extends RuntimeException { Blocked(String m) { super(m); } }

    // ---- inspect: create/refresh a locator on the on-device tree -----------
    private JSONObject inspect(String name, JSONObject out) throws Exception {
        long t0 = SystemClock.elapsedRealtimeNanos();
        AccessibilityNodeInfo profile = openFriendProfile(name, out);
        out.put("state", "verified").put("name", name);
        out.put("fingerprint", fingerprint(profile));
        out.put("elapsed_ms", (SystemClock.elapsedRealtimeNanos() - t0) / 1000000.0);
        toMain();
        return out;
    }

    // Single-contact path. No full friend-list traversal, and no phone number
    // is returned to the host. A submitted form is never retried automatically.
    private JSONObject addContact(JSONObject payload, JSONObject out) throws Exception {
        String name = payload.getString("name").trim();
        String phone = payload.getString("phone");
        if (name.isEmpty() || name.length() > 20 || !phone.matches("(?:0[0-9]{8,10}|82[0-9]{8,10})"))
            throw new Blocked("contact_input_invalid");
        // Phone contact addition starts directly on Kakao's Friends home.
        // Name search belongs to chat/profile lookup, never to this entry path.
        toMain();
        selectFriendsHome();
        // Both screens animate in; tapping a position read mid-transition misses the button (the
        // 친구 추가 screen then stays on its default QR tab). Tap only after the button holds still,
        // and click the button view itself rather than a coordinate. Nothing is typed yet, so a
        // second try on the 연락처 tab can never add anything twice.
        AccessibilityNodeInfo add = waitStableNode(n -> "친구 추가".contentEquals(descOf(n)) && n.isClickable() && visible(n), STEP_MS, 400);
        if (add == null || !tapNode(add)) throw new Blocked("contact_add_entry_unavailable");
        boolean formOpen = false;
        for (int attempt = 0; attempt < 2 && !formOpen; attempt++) {
            AccessibilityNodeInfo contact = waitStableNode(n -> "연락처".contentEquals(descOf(n)) && n.isClickable() && visible(n), STEP_MS, 400);
            if (contact == null) break;
            boolean tapped = attempt == 0 ? tapNode(contact) : click(contact);   // 2nd try: plain coordinate tap
            if (!tapped) continue;
            formOpen = waitNode(n -> EDIT_CLASS.contentEquals(String.valueOf(n.getClassName())) && visible(n), 2200) != null;
        }
        if (!formOpen) {
            AccessibilityNodeInfo now = getRootInActiveWindow();
            if (now != null && !PKG.contentEquals(String.valueOf(now.getPackageName()))) throw new Blocked("contact_permission_needed");
            throw new Blocked("contact_add_form_unavailable");
        }
        if (!setContactField(0, phone)) throw new Blocked("contact_input_unverified");
        if (!setContactField(1, name)) throw new Blocked("contact_input_unverified");
        if (payload.optBoolean("dry_run", false)) {
            out.put("state", "ready").put("name", name);
            toMain();
            return out;
        }
        // The top-right 확인 stays DISABLED while Kakao validates the typed number/name, and a tap on a
        // disabled button does nothing (the form was filled but never submitted). Wait until it is
        // enabled and still, then click the button itself.
        AccessibilityNodeInfo confirm = waitStableNode(n -> "확인".contentEquals(textOf(n)) && n.isClickable() && n.isEnabled() && visible(n), STEP_MS + 2000, 300);
        if (confirm == null || !tapNode(confirm)) throw new Blocked("contact_submit_unavailable");
        // A real submit closes the form (or raises a dialog). If the screen did not change at all the
        // click was not taken: click once more. This is the only repeat, and only when nothing happened.
        if (!waitUntil(() -> !contactFormShown(), 2500)) {
            AccessibilityNodeInfo again = waitNode(n -> "확인".contentEquals(textOf(n)) && n.isClickable() && n.isEnabled() && visible(n), 600);
            if (again != null) {
                tapNode(again);
                waitUntil(() -> !contactFormShown(), 2500);
            }
        }
        try {
            waitMs(350);
            // Verify from Friends home after leaving the add form; do not search on the form.
            AccessibilityNodeInfo profile = openFriendProfile(name, new JSONObject(), true, true);
            out.put("state", "verified").put("name", name).put("fingerprint", fingerprint(profile));
        } catch (Exception error) {
            out.put("state", "needs_check").put("error", "contact_add_unverified");
        }
        toMain();
        return out;
    }

    private static final class ChatListScan {
        final String cursor = java.util.UUID.randomUUID().toString();
        final List<JSONObject> rows = new ArrayList<>();
        String lastSig = "";
        int pages, backtracks, same;
        boolean end;
    }
    private ChatListScan chatListScan;

    private static String chatRowKey(JSONObject r) {
        return r.optString("name") + "\u0001" + r.optString("preview") + "\u0001" + r.optString("time");
    }

    /** The fully visible room rows of KakaoTalk's chat tab, top to bottom: {name, preview, time, unread, group}.
     *  A row is a Button inside the list (recycler_view) holding name / message / time TextViews. Rows cut off at
     *  the list edge are skipped (their bounds are clipped, so they are shorter than a full row). */
    private List<JSONObject> readChatRows() throws Exception {
        List<JSONObject> out = new ArrayList<>();
        java.util.regex.Pattern unreadPattern = java.util.regex.Pattern.compile("새로운 메시지 (\\d+)개");
        for (AccessibilityNodeInfo root : kakaoRoots()) {
            AccessibilityNodeInfo host = first(root, n -> "com.kakao.talk:id/recycler_view".equals(n.getViewIdResourceName()) && visible(n));
            if (host == null) continue;
            Rect hb = new Rect(); host.getBoundsInScreen(hb);
            java.util.TreeMap<Integer, JSONObject> byTop = new java.util.TreeMap<>();
            for (AccessibilityNodeInfo b : walk(root, n -> "android.widget.Button".contentEquals(String.valueOf(n.getClassName()))
                    && n.isClickable() && n.getViewIdResourceName() == null && descOf(n).contains(",") && visible(n))) {
                Rect r = new Rect(); b.getBoundsInScreen(r);
                if (r.height() < 150 || r.top < hb.top - 2) continue;
                AccessibilityNodeInfo name = first(b, n -> "com.kakao.talk:id/name".equals(n.getViewIdResourceName()));
                if (name == null || textOf(name).trim().isEmpty()) continue;
                AccessibilityNodeInfo msg = first(b, n -> "com.kakao.talk:id/message".equals(n.getViewIdResourceName()));
                AccessibilityNodeInfo time = first(b, n -> "com.kakao.talk:id/time".equals(n.getViewIdResourceName()));
                boolean group = first(b, n -> n.getViewIdResourceName() != null && n.getViewIdResourceName().contains("member")) != null;
                int unread = 0;
                java.util.regex.Matcher m = unreadPattern.matcher(descOf(b));
                if (m.find()) unread = Integer.parseInt(m.group(1));
                String preview = msg == null ? "" : (!textOf(msg).isEmpty() ? textOf(msg) : descOf(msg));
                byTop.put(r.top, new JSONObject().put("name", textOf(name).trim()).put("preview", preview.trim())
                    .put("time", time == null ? "" : textOf(time).trim()).put("unread", unread).put("group", group));
            }
            out.addAll(byTop.values());
            break;
        }
        return out;
    }

    private String chatRowsSig(List<JSONObject> rows) {
        StringBuilder sb = new StringBuilder();
        for (JSONObject r : rows) sb.append(chatRowKey(r)).append('\n');
        return sb.toString();
    }

    private void swipeChatListUp() {       // chat list: about 4 rows forward, no fling
        scrollForward(0.30);
    }

    /** Read KakaoTalk's chat list a few pages at a time (cursor protocol like the friend scan). Read-only: it only
     *  switches to the chat tab and scrolls. Returns every row read so far; the host decides when to stop. */
    private JSONObject chatList(JSONObject payload, JSONObject out) throws Exception {
        String cursor = payload.optString("cursor", "");
        if (cursor.isEmpty()) {
            wakeScreenForSend();
            toMain();
            for (int attempt = 0; attempt < 3; attempt++) {
                AccessibilityNodeInfo root = getRootInActiveWindow();
                if (root != null && first(root, n -> startsWith(descOf(n), CHAT_TAB) && n.isSelected()) != null) break;
                AccessibilityNodeInfo tab = waitNode(n -> startsWith(descOf(n), CHAT_TAB) && visible(n), 4000);
                if (tab != null) tapNode(tab);
                if (waitNode(n -> startsWith(descOf(n), CHAT_TAB) && n.isSelected(), 2500) != null) break;
            }
            if (waitNode(n -> "com.kakao.talk:id/recycler_view".equals(n.getViewIdResourceName()), 4000) == null) throw new Blocked("chat_list_unavailable");
            // Back to the very top (the list keeps its scroll position): swipe down until nothing moves.
            String before = "";
            for (int i = 0; i < 60; i++) {
                String sig = chatRowsSig(readChatRows());
                if (sig.equals(before) && !sig.isEmpty()) break;
                before = sig;
                swipeDown();
                waitMs(220);
            }
            chatListScan = new ChatListScan();
        } else if (chatListScan == null || !cursor.equals(chatListScan.cursor)) {
            throw new Blocked("chat_list_expired");
        }
        ChatListScan scan = chatListScan;
        for (int step = 0; step < 3 && !scan.end; step++) {
            if (!scan.rows.isEmpty() || step > 0) {
                swipeChatListUp();
                waitMs(250);
            }
            List<JSONObject> page = readChatRows();
            String sig = chatRowsSig(page);
            if (scan.rows.isEmpty()) {
                scan.rows.addAll(page);
                scan.lastSig = sig; scan.pages++;
                continue;
            }
            if (sig.equals(scan.lastSig)) {   // nothing moved: the bottom (or still settling)
                if (++scan.same >= 2) scan.end = true;
                continue;
            }
            scan.same = 0;
            int overlap = 0;
            for (int m = Math.min(page.size(), scan.rows.size()); m >= 1 && overlap == 0; m--) {
                boolean all = true;
                for (int k = 0; k < m && all; k++)
                    all = chatRowKey(page.get(k)).equals(chatRowKey(scan.rows.get(scan.rows.size() - m + k)));
                if (all) overlap = m;
            }
            if (overlap == 0 && !page.isEmpty()) {
                // jumped past rows: step back a little and read again
                if (++scan.backtracks > 25) throw new Blocked("chat_list_gap");
                scrollBackward(0.12); waitMs(250);
                continue;
            }
            for (int k = overlap; k < page.size(); k++) scan.rows.add(page.get(k));
            scan.lastSig = sig; scan.pages++;
        }
        JSONArray rows = new JSONArray();
        for (JSONObject r : scan.rows) rows.put(r);
        out.put("state", "partial").put("cursor", scan.cursor).put("rows", rows).put("end", scan.end).put("pages", scan.pages);
        return out;
    }

    /** Leave the chat tab the way a person would find it: list back at the top, header visible. */
    private JSONObject chatListDone(JSONObject out) throws Exception {
        chatListScan = null;
        String before = "";
        for (int i = 0; i < 60; i++) {
            String sig = chatRowsSig(readChatRows());
            if (sig.equals(before) && !sig.isEmpty()) break;
            before = sig;
            swipeDown();
            waitMs(220);
        }
        out.put("state", "verified");
        return out;
    }

    private boolean renameScreenShown() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        return root != null && PKG.contentEquals(String.valueOf(root.getPackageName()))
            && first(root, n -> "친구 정보".contentEquals(descOf(n)) && visible(n)) != null;
    }

    /** The EditText under the "이름" label of the rename screen: the upper of the two edit_text fields
     *  (the lower one is the memo). */
    private AccessibilityNodeInfo renameNameField() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return null;
        AccessibilityNodeInfo best = null; int bestTop = Integer.MAX_VALUE;
        for (AccessibilityNodeInfo e : walk(root, n -> EDIT_CLASS.contentEquals(String.valueOf(n.getClassName()))
                && "com.kakao.talk:id/edit_text".equals(n.getViewIdResourceName()) && visible(n))) {
            Rect r = new Rect(); e.getBoundsInScreen(r);
            if (r.top < bestTop) { bestTop = r.top; best = e; }
        }
        return best;
    }

    /** Rename a friend (only on this phone, as KakaoTalk's 친구 설정 does): friend profile -> ⋮ -> 친구 설정 ->
     *  이름 row -> type -> 확인. The 숨기기/차단/삭제 rows sit right below and are never tapped. Before touching
     *  anything the current name shown on the settings and rename screens must equal {old}. dry_run stops on
     *  the rename screen without changing the name. A saved rename is verified by searching the NEW name. */
    private JSONObject renameFriend(JSONObject payload, JSONObject out) throws Exception {
        final String oldName = payload.getString("old").trim();
        final String newName = payload.getString("new").trim();
        final boolean dry = payload.optBoolean("dry_run", false);
        if (oldName.isEmpty() || newName.isEmpty() || newName.length() > 20 || oldName.equals(newName)) throw new Blocked("rename_input_invalid");
        JSONObject stages = new JSONObject(); stageTrace = stages;
        openFriendProfile(oldName, stages);
        // ⋮ menu: the visible icon has desc "더보기"; its clickable parent is the real button.
        AccessibilityNodeInfo more = waitStableNode(n -> "더보기".contentEquals(descOf(n)) && visible(n), STEP_MS, 400);
        if (more == null || !(clickViaAncestor(more) || click(more))) throw new Blocked("rename_menu_unavailable");
        AccessibilityNodeInfo settings = waitStableNode(n -> "친구 설정".contentEquals(descOf(n)) && n.isClickable() && visible(n), STEP_MS, 300);
        if (settings == null || !tapNode(settings)) throw new Blocked("rename_menu_unavailable");
        // Settings screen: label "이름", its current value just below it.
        AccessibilityNodeInfo label = waitStableNode(n -> "이름".contentEquals(textOf(n)) && !n.isClickable() && visible(n), STEP_MS + 1000, 400);
        if (label == null) throw new Blocked("rename_menu_unavailable");
        Rect lb = new Rect(); label.getBoundsInScreen(lb);
        String shown = "";
        AccessibilityNodeInfo rootNow = getRootInActiveWindow();
        if (rootNow != null) {
            int bestGap = Integer.MAX_VALUE;
            for (AccessibilityNodeInfo t : walk(rootNow, n -> "android.widget.TextView".contentEquals(String.valueOf(n.getClassName())) && visible(n))) {
                Rect r = new Rect(); t.getBoundsInScreen(r);
                int gap = r.top - lb.bottom;
                if (gap >= 0 && gap < 160 && gap < bestGap) { bestGap = gap; shown = textOf(t).trim(); }
            }
        }
        stages.put("settings_name", shown);
        if (!oldName.equals(shown)) throw new Blocked("rename_wrong_friend");
        AccessibilityNodeInfo row = label;
        for (int depth = 0; depth < 4 && row != null && !row.isClickable(); depth++) row = row.getParent();
        if (row == null || !row.isClickable() || !tapNode(row)) throw new Blocked("rename_menu_unavailable");
        if (!waitUntil(this::renameScreenShown, STEP_MS + 1000)) throw new Blocked("rename_menu_unavailable");
        AccessibilityNodeInfo field = renameNameField();
        if (field == null || !oldName.equals(textOf(field).trim())) throw new Blocked("rename_wrong_friend");
        if (dry) {
            out.put("state", "ready").put("old", oldName);
            for (int i = 0; i < 3 && renameScreenShown(); i++) { performGlobalAction(GLOBAL_ACTION_BACK); waitMs(400); }
            toMain();
            return out;
        }
        if (!setText(field, newName)) throw new Blocked("rename_input_failed");
        if (!waitUntil(() -> { AccessibilityNodeInfo f = renameNameField(); return f != null && newName.equals(textOf(f).trim()); }, 1800))
            throw new Blocked("rename_input_failed");
        AccessibilityNodeInfo confirm = waitStableNode(n -> "확인".contentEquals(textOf(n)) && n.isClickable() && n.isEnabled() && visible(n), STEP_MS + 1500, 300);
        if (confirm == null || !tapNode(confirm)) throw new Blocked("rename_save_unavailable");
        // Saved. Never press 확인 again.
        waitUntil(() -> !renameScreenShown(), 3000);
        toMain();
        boolean verified = false;
        try { openFriendProfile(newName, new JSONObject()); verified = true; } catch (Exception ignored) { /* checked below */ }
        out.put("state", verified ? "verified" : "needs_check").put("old", oldName).put("name", newName);
        if (!verified) out.put("error", "rename_unverified");
        toMain();
        return out;
    }

    /** The chat-list row (Button) of the room titled exactly {name} whose group flag equals {group}, among the fully
     *  visible rows; null if it is not on screen. Same row rules as readChatRows(). */
    private AccessibilityNodeInfo chatRowNode(String name, boolean group) {
        for (AccessibilityNodeInfo root : kakaoRoots()) {
            AccessibilityNodeInfo host = first(root, n -> "com.kakao.talk:id/recycler_view".equals(n.getViewIdResourceName()) && visible(n));
            if (host == null) continue;
            Rect hb = new Rect(); host.getBoundsInScreen(hb);
            for (AccessibilityNodeInfo b : walk(root, n -> "android.widget.Button".contentEquals(String.valueOf(n.getClassName()))
                    && n.isClickable() && n.getViewIdResourceName() == null && descOf(n).contains(",") && visible(n))) {
                Rect r = new Rect(); b.getBoundsInScreen(r);
                if (r.height() < 150 || r.top < hb.top - 2) continue;
                AccessibilityNodeInfo nm = first(b, n -> "com.kakao.talk:id/name".equals(n.getViewIdResourceName()));
                if (nm == null || !name.equals(textOf(nm).trim())) continue;
                boolean g = first(b, n -> n.getViewIdResourceName() != null && n.getViewIdResourceName().contains("member")) != null;
                if (g == group) return b;
            }
        }
        return null;
    }

    /** Chat tab selected and its list scrolled back to the top. */
    private void openChatListTop() throws Exception {
        toMain();
        for (int attempt = 0; attempt < 3; attempt++) {
            AccessibilityNodeInfo root = getRootInActiveWindow();
            if (root != null && first(root, n -> startsWith(descOf(n), CHAT_TAB) && n.isSelected()) != null) break;
            AccessibilityNodeInfo tab = waitNode(n -> startsWith(descOf(n), CHAT_TAB) && visible(n), 4000);
            if (tab != null) tapNode(tab);
            if (waitNode(n -> startsWith(descOf(n), CHAT_TAB) && n.isSelected(), 2500) != null) break;
        }
        if (waitNode(n -> "com.kakao.talk:id/recycler_view".equals(n.getViewIdResourceName()), 4000) == null) throw new Blocked("chat_list_unavailable");
        String before = "";
        for (int i = 0; i < 60; i++) {
            String sig = chatRowsSig(readChatRows());
            if (sig.equals(before) && !sig.isEmpty()) break;
            before = sig;
            swipeDown();
            waitMs(220);
        }
    }

    /** Scroll the chat list from the top until the row for {name} is fully visible (null if the end is reached). */
    private AccessibilityNodeInfo findChatRow(String name, boolean group) throws Exception {
        openChatListTop();
        String before = ""; int same = 0;
        for (int page = 0; page < 80; page++) {
            AccessibilityNodeInfo row = chatRowNode(name, group);
            if (row != null) return row;
            String sig = chatRowsSig(readChatRows());
            if (sig.equals(before)) { if (++same >= 2) return null; } else same = 0;
            before = sig;
            swipeChatListUp();
            waitMs(250);
        }
        return null;
    }

    private boolean roomInfoScreenShown() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        return root != null && PKG.contentEquals(String.valueOf(root.getPackageName()))
            && first(root, n -> "채팅방 정보".contentEquals(descOf(n)) && "com.kakao.talk:id/toolbar_default_title_text".equals(n.getViewIdResourceName())) != null;
    }

    private AccessibilityNodeInfo roomNameField() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return null;
        return first(root, n -> EDIT_CLASS.contentEquals(String.valueOf(n.getClassName()))
            && "com.kakao.talk:id/edit_text".equals(n.getViewIdResourceName()) && visible(n));
    }

    /** Rename a GROUP chat room (only on this phone; the screen says "내가 설정한 사진과 이름은 나에게만 보입니다"):
     *  chat list -> long-press the room's row -> 채팅방 정보 설정 -> name field -> 확인. The long-press menu has
     *  나가기 and 채팅방 알림 끄기 right below: only the button described exactly "채팅방 정보 설정" is ever tapped, and
     *  only after the menu header and then the name field both equal {old}. dry_run stops on that screen without
     *  changing anything. A saved rename is verified by finding the NEW name in the chat list. */
    private JSONObject renameRoom(JSONObject payload, JSONObject out) throws Exception {
        final String oldName = payload.getString("old").trim();
        final String newName = payload.getString("new").trim();
        final boolean dry = payload.optBoolean("dry_run", false);
        if (oldName.isEmpty() || newName.isEmpty() || newName.length() > 50 || oldName.equals(newName)) throw new Blocked("rename_input_invalid");
        JSONObject stages = new JSONObject(); stageTrace = stages;
        wakeScreenForSend();
        AccessibilityNodeInfo row = findChatRow(oldName, true);
        if (row == null) throw new Blocked("rename_room_not_found");
        if (!row.performAction(AccessibilityNodeInfo.ACTION_LONG_CLICK)) throw new Blocked("rename_menu_unavailable");
        AccessibilityNodeInfo head = waitNode(n -> "com.kakao.talk:id/txt_title".equals(n.getViewIdResourceName()) && oldName.equals(textOf(n).trim()), STEP_MS);
        stages.put("menu_header", head != null);
        if (head == null) throw new Blocked("rename_wrong_friend");
        AccessibilityNodeInfo item = waitStableNode(n -> "채팅방 정보 설정".contentEquals(descOf(n)) && n.isClickable() && visible(n), STEP_MS, 300);
        if (item == null || !tapNode(item)) throw new Blocked("rename_menu_unavailable");
        if (!waitUntil(this::roomInfoScreenShown, STEP_MS + 1000)) throw new Blocked("rename_menu_unavailable");
        AccessibilityNodeInfo field = roomNameField();
        if (field == null || !oldName.equals(textOf(field).trim())) throw new Blocked("rename_wrong_friend");
        if (dry) {
            out.put("state", "ready").put("old", oldName);
            for (int i = 0; i < 3 && roomInfoScreenShown(); i++) { performGlobalAction(GLOBAL_ACTION_BACK); waitMs(400); }
            toMain();
            return out;
        }
        if (!setText(field, newName)) throw new Blocked("rename_input_failed");
        if (!waitUntil(() -> { AccessibilityNodeInfo f = roomNameField(); return f != null && newName.equals(textOf(f).trim()); }, 1800))
            throw new Blocked("rename_input_failed");
        AccessibilityNodeInfo confirm = waitStableNode(n -> "확인".contentEquals(textOf(n)) && n.isClickable() && n.isEnabled() && visible(n), STEP_MS + 1500, 300);
        if (confirm == null || !tapNode(confirm)) throw new Blocked("rename_save_unavailable");
        // Saved. Never press 확인 again.
        waitUntil(() -> !roomInfoScreenShown(), 3000);
        toMain();
        boolean verified = false;
        try { verified = findChatRow(newName, true) != null; } catch (Exception ignored) { /* checked below */ }
        out.put("state", verified ? "verified" : "needs_check").put("old", oldName).put("name", newName);
        if (!verified) out.put("error", "rename_unverified");
        toMain();
        return out;
    }

    private static final String ID_RESULT_ADD = "com.kakao.talk:id/btn_add_friend";
    private static final String ID_RESULT_NICK = "com.kakao.talk:id/nickname";

    /** Add a friend by Kakao ID: 친구 추가 -> "카카오톡 ID" tab -> type ID -> 확인 (search) -> the result shows
     *  the profile with a 친구 추가 button (right next to 차단: ONLY the view id btn_add_friend is ever
     *  tapped). An already-added friend shows no such button. dry_run stops after the search. A submitted
     *  add is never repeated automatically. */
    private JSONObject addById(JSONObject payload, JSONObject out) throws Exception {
        final String id = payload.getString("id").trim();
        if (!id.matches("[A-Za-z0-9._-]{1,20}")) throw new Blocked("contact_input_invalid");
        toMain();
        selectFriendsHome();
        AccessibilityNodeInfo add = waitStableNode(n -> "친구 추가".contentEquals(descOf(n)) && n.isClickable() && visible(n), STEP_MS, 400);
        if (add == null || !tapNode(add)) throw new Blocked("contact_add_entry_unavailable");
        boolean formOpen = false;
        for (int attempt = 0; attempt < 2 && !formOpen; attempt++) {
            AccessibilityNodeInfo tab = waitStableNode(n -> "카카오톡 ID".contentEquals(descOf(n)) && n.isClickable() && visible(n), STEP_MS, 400);
            if (tab == null) break;
            boolean tapped = attempt == 0 ? tapNode(tab) : click(tab);
            if (!tapped) continue;
            formOpen = waitUntil(this::idFormShown, 2200);
        }
        if (!formOpen) {
            AccessibilityNodeInfo now = getRootInActiveWindow();
            if (now != null && !PKG.contentEquals(String.valueOf(now.getPackageName()))) throw new Blocked("contact_permission_needed");
            throw new Blocked("contact_add_form_unavailable");
        }
        if (!setIdField(id)) throw new Blocked("contact_input_unverified");
        AccessibilityNodeInfo search = waitStableNode(n -> "확인".contentEquals(textOf(n)) && n.isClickable() && n.isEnabled() && visible(n), STEP_MS + 1500, 300);
        if (search == null || !tapNode(search)) throw new Blocked("contact_submit_unavailable");
        // The result renders under the field. Not found -> no add button and no 1:1 chat button.
        AccessibilityNodeInfo addBtn = waitNode(n -> ID_RESULT_ADD.equals(n.getViewIdResourceName()) && visible(n), 4500);
        boolean already = false;
        if (addBtn == null) {
            AccessibilityNodeInfo root = getRootInActiveWindow();
            already = root != null && first(root, n -> "1:1 채팅".contentEquals(textOf(n)) && visible(n)) != null;
            if (!already) throw new Blocked("kakao_id_not_found");
        }
        AccessibilityNodeInfo nick = null;
        AccessibilityNodeInfo rootNow = getRootInActiveWindow();
        if (rootNow != null) nick = first(rootNow, n -> ID_RESULT_NICK.equals(n.getViewIdResourceName()) && visible(n));
        String nickname = nick == null ? "" : textOf(nick).trim();
        if (nickname.isEmpty()) throw new Blocked("kakao_id_not_found");
        out.put("name", nickname).put("already_friend", already);
        if (already || payload.optBoolean("dry_run", false)) {
            out.put("state", already ? "verified" : "ready");
            toMain();
            return out;
        }
        if (!tapNode(addBtn)) throw new Blocked("contact_submit_unavailable");
        // Added: the add button goes away (the screen offers 1:1 chat instead). Never click it twice.
        boolean done = waitUntil(() -> {
            AccessibilityNodeInfo r = getRootInActiveWindow();
            if (r == null || !PKG.contentEquals(String.valueOf(r.getPackageName()))) return true;   // left the screen
            return first(r, n -> ID_RESULT_ADD.equals(n.getViewIdResourceName()) && visible(n)) == null;
        }, 4500);
        out.put("state", done ? "verified" : "needs_check");
        if (!done) out.put("error", "contact_add_unverified");
        toMain();
        return out;
    }

    private boolean idFormShown() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        return root != null && PKG.contentEquals(String.valueOf(root.getPackageName()))
            && first(root, n -> "카카오톡 ID로 추가".contentEquals(descOf(n)) && visible(n)) != null
            && first(root, n -> EDIT_CLASS.contentEquals(String.valueOf(n.getClassName())) && visible(n)) != null;
    }

    private boolean setIdField(String id) {
        for (int attempt = 0; attempt < 2; attempt++) {
            AccessibilityNodeInfo root = getRootInActiveWindow();
            AccessibilityNodeInfo field = root == null ? null
                : first(root, n -> EDIT_CLASS.contentEquals(String.valueOf(n.getClassName())) && visible(n));
            if (field == null) return false;
            boolean ok = setText(field, id);
            if (!ok) {
                if (!click(field)) continue;
                waitMs(150);
                ok = waitUntil(BridgeInputMethod::ready, STEP_MS) && BridgeInputMethod.input(id);
            }
            if (ok && waitUntil(() -> {
                AccessibilityNodeInfo r = getRootInActiveWindow();
                return r != null && first(r, n -> EDIT_CLASS.contentEquals(String.valueOf(n.getClassName())) && id.equals(textOf(n))) != null;
            }, 1500)) return true;
        }
        return false;
    }

    /** True while the "연락처로 추가" form is on screen. */
    private boolean contactFormShown() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        return root != null && PKG.contentEquals(String.valueOf(root.getPackageName()))
            && first(root, n -> "연락처로 추가".contentEquals(descOf(n)) && visible(n)) != null;
    }

    /** A node matching {match} whose bounds stayed identical for {quietMs}; null if none settles. */
    private AccessibilityNodeInfo waitStableNode(java.util.function.Predicate<AccessibilityNodeInfo> match, int timeoutMs, int quietMs) {
        long deadline = SystemClock.uptimeMillis() + timeoutMs + quietMs;
        Rect last = null;
        long since = 0;
        while (SystemClock.uptimeMillis() < deadline) {
            AccessibilityNodeInfo root = getRootInActiveWindow();
            AccessibilityNodeInfo n = (root != null && PKG.contentEquals(String.valueOf(root.getPackageName()))) ? first(root, match) : null;
            long now = SystemClock.uptimeMillis();
            if (n != null) {
                Rect r = new Rect(); n.getBoundsInScreen(r);
                if (last != null && last.equals(r)) { if (now - since >= quietMs) return n; }
                else { last = r; since = now; }
            } else { last = null; }
            waitMs(80);
        }
        return null;
    }

    /** Click the node itself when it is clickable (immune to layout shifts); else tap its centre. */
    private boolean tapNode(AccessibilityNodeInfo n) {
        return (n.isClickable() && n.performAction(AccessibilityNodeInfo.ACTION_CLICK)) || click(n);
    }

    private boolean setContactField(int position, String value) {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return false;
        List<AccessibilityNodeInfo> fields = walk(root, n -> EDIT_CLASS.contentEquals(String.valueOf(n.getClassName())) && visible(n));
        fields.sort((a, b) -> {
            Rect x = new Rect(), y = new Rect(); a.getBoundsInScreen(x); b.getBoundsInScreen(y);
            return Integer.compare(x.top, y.top);
        });
        int firstTop = -1, secondTop = -1;
        for (AccessibilityNodeInfo field : fields) {
            Rect bounds = new Rect(); field.getBoundsInScreen(bounds);
            if (bounds.width() < 200 || bounds.height() < 40) continue;
            if (firstTop < 0) firstTop = bounds.top;
            else if (bounds.top > firstTop + 40) { secondTop = bounds.top; break; }
        }
        int target = position == 0 ? firstTop : secondTop;
        if (target < 0) return false;
        for (AccessibilityNodeInfo field : fields) {
            Rect bounds = new Rect(); field.getBoundsInScreen(bounds);
            if (Math.abs(bounds.top - target) > 15) continue;
            if (setText(field, value) && contactValueVisible(position, value)) return true;
            if (!click(field)) continue;
            waitMs(150);
            if (!waitUntil(BridgeInputMethod::ready, STEP_MS) || !BridgeInputMethod.input(value)) continue;
            if (contactValueVisible(position, value)) return true;
        }
        return false;
    }

    private boolean contactValueVisible(int position, String value) {
        AccessibilityNodeInfo current = getRootInActiveWindow();
        return current != null && first(current, n -> EDIT_CLASS.contentEquals(String.valueOf(n.getClassName()))
            && (position == 0 ? value.equals(textOf(n).replaceAll("[^0-9]", "")) : value.equals(textOf(n)))) != null;
    }

    // Explicit, read-only friend onboarding. Kakao's current friend rows expose
    // a clickable parent with separate "profile photo" and name TextView children.
    // The old host XML scraper expected a combined description and missed rows.
    private JSONObject onboardFriends(JSONObject payload, JSONObject out) throws Exception {
        long t0 = SystemClock.elapsedRealtimeNanos();
        String cursor = payload.optString("cursor", "");
        if (cursor.isEmpty()) {
            toMain();
            // The bottom Friends tab remembers its last top chip (소식/News). Select the top
            // "친구" chip too and verify its "친구 추가" action, or the scan would page through News.
            selectFriendsHome();
            friendScan = new FriendScan();
            friendScan.recent = payload.optBoolean("recent", false);
        } else if (friendScan == null || !cursor.equals(friendScan.cursor)) {
            throw new Blocked("friends_scan_expired");
        }
        FriendScan scan = friendScan;
        if (!scan.scanning) {
            for (int i = 0; i < 3; i++) {
                AccessibilityNodeInfo root = getRootInActiveWindow();
                if (root == null || !PKG.contentEquals(String.valueOf(root.getPackageName())))
                    throw new Blocked("friends_window_unavailable");
                // Top = a swipe toward the top no longer changes the list. (Older Kakao builds
                // also showed an "업데이트 프로필" row at the very top; this build does not.)
                String sig = friendPageSignature(root);
                if (sig.equals(scan.lastRewindSig)
                        || first(root, n -> "업데이트 프로필".contentEquals(textOf(n)) && visible(n)) != null) {
                    if (scan.recent && !scan.sortSet) {
                        // At the top the sort toggle is on screen. Switch to 친구추가순, then
                        // rewind once more because the list is reordered.
                        applyRecentSort(scan);
                        scan.sortSet = true;
                        scan.lastRewindSig = null;
                        break;
                    }
                    scan.scanning = true; break;
                }
                scan.lastRewindSig = sig;
                swipeDown();
                scan.rewound++;
                if (scan.rewound > 400) throw new Blocked("friends_top_unavailable");   // ~866 rows can be far down
                waitMs(150);
            }
            if (!scan.scanning) {
                out.put("state", "partial").put("cursor", scan.cursor)
                    .put("phase", "rewind").put("rewound", scan.rewound).put("count", 0).put("pages", 0);
                return out;
            }
        }
        boolean traversalFinished = false;
        for (int i = 0; i < 6; i++) {
            AccessibilityNodeInfo root = getRootInActiveWindow();
            if (root == null || !PKG.contentEquals(String.valueOf(root.getPackageName())))
                throw new Blocked("friends_window_unavailable");
            if (first(root, n -> startsWith(descOf(n), FRIEND_TAB) && n.isSelected()) == null)
                throw new Blocked("friends_screen_changed");
            // Compare only the list itself: ads/banners outside it change on their own and would
            // make the unchanged last page look new forever.
            String page = friendPageSignature(root);
            if (!scan.pages.add(page)) { traversalFinished = true; break; }
            scan.viewed++;
            if (scan.viewed > 900) throw new Blocked("friends_scan_limit");
            int minimumTop = 0;
            int[] section = friendSection(root);
            if (section != null) {
                if (scan.listStarted && section[1] != scan.expectedCount)
                    throw new Blocked("friend_count_changed");
                scan.listStarted = true;
                scan.expectedCount = section[1];
                minimumTop = section[0];
            }
            // Never read the 추천친구 / 채널 group rows: start below their headers when visible.
            if (scan.listStarted) minimumTop = Math.max(minimumTop, nonFriendGroupBottom(root));
            List<String> names = scan.listStarted ? friendNames(root, minimumTop) : new ArrayList<>();
            // A partially visible row at the bottom can disappear on the next
            // accessibility frame. Match the new page against any recent
            // contiguous segment, not only the preceding page's exact tail.
            int overlap = 0;
            int start = Math.max(0, scan.observed.size() - 24);
            for (int offset = start; offset < scan.observed.size(); offset++) {
                int count = 0;
                while (count < names.size() && offset + count < scan.observed.size()
                        && scan.observed.get(offset + count).equals(names.get(count))) count++;
                if (count > overlap) overlap = count;
            }
            if (overlap == 0 && !scan.observed.isEmpty() && !names.isEmpty()) {
                // The swipe (plus fling) jumped past rows we never saw. Step back a little and
                // read again instead of recording a gap; the final count check would reject it.
                if (++scan.backtracks > 80) throw new Blocked("friends_scan_gap");
                scan.pages.remove(page);
                scan.viewed--;
                swipeFriendsBack();
                waitMs(150);
                continue;
            }
            for (int j = overlap; j < names.size(); j++) {
                scan.entries.put(new JSONObject().put("name", names.get(j)).put("kind", "friend").put("ambiguous", true));
                scan.observed.add(names.get(j));
            }
            swipeFriends();
            waitMs(30);
        }
        if (traversalFinished) {
            if (!scan.listStarted || scan.expectedCount <= 0 || scan.entries.length() != scan.expectedCount) {
                out.put("count", scan.entries.length()).put("expected_count", scan.expectedCount)
                    .put("pages", scan.viewed);
                friendScan = null;
                throw new Blocked("friend_count_mismatch");
            }
            out.put("state", "verified").put("scope", "friend").put("entries", scan.entries)
                .put("complete", true).put("traversal_finished", true)
                .put("pages", scan.viewed).put("expected_count", scan.expectedCount).put("elapsed_ms", ms(t0));
            restoreFriendSort(scan);
            friendScan = null;
            toMain();
        } else {
            out.put("state", "partial").put("cursor", scan.cursor)
                .put("pages", scan.viewed).put("count", scan.entries.length()).put("elapsed_ms", ms(t0));
            if (scan.recent) out.put("entries", scan.entries).put("expected_count", scan.expectedCount);
        }
        return out;
    }

    private AccessibilityNodeInfo sortRadio(String label) {
        for (AccessibilityNodeInfo root : kakaoRoots()) {
            AccessibilityNodeInfo n = first(root, x -> label.contentEquals(textOf(x))
                && "android.widget.RadioButton".contentEquals(String.valueOf(x.getClassName())) && visible(x));
            if (n != null) return n;
        }
        return null;
    }

    /** The selected radio is the one that is checked / not clickable. */
    private static boolean radioSelected(AccessibilityNodeInfo n) {
        return n != null && (n.isChecked() || !n.isClickable());
    }

    private void applyRecentSort(FriendScan scan) {
        AccessibilityNodeInfo recentBtn = waitNode(n -> "친구추가순".contentEquals(textOf(n)) && visible(n), STEP_MS);
        AccessibilityNodeInfo alphaBtn = sortRadio("가나다순");
        if (recentBtn == null || alphaBtn == null) throw new Blocked("friends_sort_unavailable");
        scan.sortWasAlpha = radioSelected(alphaBtn);
        if (radioSelected(recentBtn)) return;                      // already 친구추가순: nothing to restore
        if (!click(recentBtn)) throw new Blocked("friends_sort_unavailable");
        scan.sortChanged = true;
        if (!waitUntil(() -> radioSelected(sortRadio("친구추가순")), STEP_MS)) throw new Blocked("friends_sort_unavailable");
        waitMs(300);                                               // let the list re-render
    }

    /** Put the user's own sort order (가나다순) back. Best effort; scrolls up until the toggle shows. */
    private void restoreFriendSort(FriendScan scan) {
        if (scan == null || !scan.recent || !scan.sortChanged || !scan.sortWasAlpha) return;
        try {
            AccessibilityNodeInfo alpha = sortRadio("가나다순");
            for (int i = 0; alpha == null && i < 150; i++) {
                swipeDown(); waitMs(100);
                alpha = sortRadio("가나다순");
            }
            if (alpha != null && !radioSelected(alpha)) {
                click(alpha);
                waitUntil(() -> radioSelected(sortRadio("가나다순")), STEP_MS);
            }
            scan.sortChanged = false;
        } catch (Exception ignored) { /* best effort */ }
    }

    private JSONObject friendsDone(JSONObject out) {
        restoreFriendSort(friendScan);
        friendScan = null;
        toMain();
        try { out.put("state", "verified"); } catch (Exception ignored) {}
        return out;
    }

    private int[] friendSection(AccessibilityNodeInfo root) {
        for (AccessibilityNodeInfo label : walk(root, n -> "친구".contentEquals(textOf(n)) && visible(n))) {
            Rect bounds = new Rect(); label.getBoundsInScreen(bounds);
            AccessibilityNodeInfo parent = label.getParent();
            if (parent == null) continue;
            for (int i = 0; i < parent.getChildCount(); i++) {
                AccessibilityNodeInfo child = parent.getChild(i);
                if (child != null && textOf(child).matches("[0-9]{1,4}"))
                    return new int[]{bounds.bottom, Integer.parseInt(textOf(child))};
            }
        }
        return null;
    }

    /** Bottom edge of the lowest visible "추천친구 N" / "채널 N" group header (0 if none visible).
     *  These groups are not part of the 친구 list; their header rows must never be read as friends. */
    private int nonFriendGroupBottom(AccessibilityNodeInfo root) {
        int bottom = 0;
        for (AccessibilityNodeInfo label : walk(root, n -> visible(n)
                && ("추천친구".contentEquals(textOf(n)) || "채널".contentEquals(textOf(n))))) {
            AccessibilityNodeInfo parent = label.getParent();
            if (parent == null) continue;
            boolean hasCount = false;
            for (int i = 0; i < parent.getChildCount(); i++) {
                AccessibilityNodeInfo child = parent.getChild(i);
                if (child != null && textOf(child).matches("[0-9]{1,4}")) { hasCount = true; break; }
            }
            if (!hasCount) continue;
            Rect b = new Rect(); label.getBoundsInScreen(b);
            if (b.bottom > bottom) bottom = b.bottom;
        }
        return bottom;
    }

    private List<String> friendNames(AccessibilityNodeInfo root, int minimumTop) {
        List<String> names = new ArrayList<>();
        for (AccessibilityNodeInfo row : walk(root, n -> n.isClickable() && visible(n))) {
            Rect rowBounds = new Rect(); row.getBoundsInScreen(rowBounds);
            if (rowBounds.top < minimumTop) continue;
            boolean photo = false;
            String name = "";
            for (int i = 0; i < row.getChildCount(); i++) {
                AccessibilityNodeInfo child = row.getChild(i);
                if (child == null || !visible(child)) continue;
                if ("프로필 사진".contentEquals(descOf(child))) photo = true;
                if (name.isEmpty() && "android.widget.TextView".contentEquals(String.valueOf(child.getClassName())))
                    name = textOf(child).trim();
            }
            if (photo && !name.isEmpty()) names.add(name);
        }
        return names;
    }

    // ---- account: read the logged-in Kakao email hash on-device (fast) -------
    private static final java.util.regex.Pattern EMAIL = java.util.regex.Pattern.compile("[^\\s@]+@[^\\s@]+\\.[^\\s@]+");
    private JSONObject account(JSONObject out) throws Exception {
        long t0 = SystemClock.elapsedRealtimeNanos();
        toMain();
        AccessibilityNodeInfo more = waitNode(n -> startsWith(descOf(n), MORE_TAB), STEP_MS);
        if (more == null) throw new Blocked("kakao_main_unavailable");
        click(more);
        AccessibilityNodeInfo settings = waitNode(n -> startsWith(descOf(n), "전체 설정"), STEP_MS);
        if (settings == null) throw new Blocked("settings_unavailable");
        click(settings);
        AccessibilityNodeInfo found = waitNode(n -> EMAIL.matcher(textOf(n)).matches() && visible(n), STEP_MS);
        if (found == null) throw new Blocked("account_identity_unavailable");
        AccessibilityNodeInfo root = getRootInActiveWindow();
        List<AccessibilityNodeInfo> emails = walk(root, n -> EMAIL.matcher(textOf(n)).matches() && visible(n));
        if (emails.size() != 1) throw new Blocked("account_identity_unavailable");
        String hash = sha256hex(textOf(emails.get(0)));
        out.put("state", "verified").put("account", hash).put("elapsed_ms", ms(t0));
        toMain();
        return out;
    }

    /** Server-start warmup: open the finder and run ONE throwaway search so Kakao's
     *  search backend is initialized. After a cold launch the FIRST search is slow and
     *  can even miss a folded room; doing that throwaway search here (unattended, at
     *  server start) means the first REAL send hits a warm backend and behaves like a
     *  normal ~2s send. Leaves the phone parked on the finder. */
    private JSONObject warmup(JSONObject out) throws Exception {
        long t0 = SystemClock.elapsedRealtimeNanos();
        JSONObject stages = new JSONObject();
        AccessibilityNodeInfo field = openSearch(stages);
        click(field);
        setText(field, "1");
        field.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.getId());
        waitMs(2500);
        out.put("state", "verified").put("stages", stages).put("total_ms", ms(t0));
        return finishBatch(out);
    }

    private JSONObject finishBatch(JSONObject out) throws Exception {
        releaseRoom(); // notification delivery must not depend on an open chat's live scan
        roomAwakeHandler.removeCallbacks(lockAfterIdle);
        roomAwakeHandler.removeCallbacks(roomAwakeTick);
        roomAwakeArmed.set(false);
        if (roomWakeLock != null && roomWakeLock.isHeld()) roomWakeLock.release();
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P)
            out.put("state", performGlobalAction(GLOBAL_ACTION_LOCK_SCREEN) ? "verified" : "failed");
        else out.put("state", "failed").put("error", "screen_lock_unsupported");
        return out;
    }

    // ---- send: navigate, verify identity, set text, send, verify bubble ------
    private JSONObject send(JSONObject payload, JSONObject out) throws Exception {
        String name = payload.getString("name");            // resolved kakao name (from matching table)
        String text = payload.getString("text");
        boolean dryRun = payload.optBoolean("dry_run", false);
        // 단톡방 전송(2026-11-11): group=true면 단톡방 검색 결과에서 "정확히 한 개"만 찾아 들어가고,
        // 제목이 정확히 일치하는 단톡방(isInGroupChat)일 때만 입력한다. 1:1 친구 프로필로는 절대 넘어가지 않는다.
        final boolean group = payload.optBoolean("group", false);
        // Hold defers only the final screen lock while another batch item follows.
        boolean hold = payload.optBoolean("hold", false);
        JSONObject stages = new JSONObject(); stageTrace = stages;
        long t0 = SystemClock.elapsedRealtimeNanos();

        // 2026-10-06: lockAfterIdle()이 화면을 꺼버린 뒤에도 그 방의 Activity는 그대로 살아있다
        // (실측 확인: 이 기기는 잠금화면 자체가 없음 — CredentialType: None, KEYCODE_WAKEUP
        // 한 번만으로 스와이프 없이 ChatRoomHolderActivity 그대로 복귀). isInChat()은 화면을
        // 직접 읽으므로 화면이 꺼진 채로 호출하면 당연히 아무것도 못 찾아 매번 친구탭 콜드경로로
        // 빠진다 — 깨우는 단계 자체가 없었던 게 원인. 여기서 깨우기만 하면 바로 아래 isInChat()이
        // 같은 방을 그대로 재확인하므로, 어떤 방을 들고 있었는지 따로 기억할 필요가 없다(화면
        // 자체가 진실의 원천이라는 기존 ROOM_HOLD 원칙 그대로 유지).
        wakeScreenForSend();

        // ROOM_HOLD 상태머신(사용자 확정, 2026-10-02): 같은 매장(targetStore==currentStore)이면
        // isInChat()이 현재 화면을 실시간 재확인해 SAME_ROOM으로 입력창을 바로 재사용한다(저장된
        // 상태 변수 없이 화면 자체가 진실의 원천이라 더 안전). 다른 매장이면 친구탭 경로
        // (openViaFriendProfile)로만 전환 — 채팅방 탭 직접 클릭은 기본 경로에서 제거.
        boolean held = group ? isInGroupChat(name) : isInChat(name);
        if (!held) {
            // 2026-10-06 실측: lockAfterIdle()로 잠긴 뒤 "상대방 답장 알림"이 화면만 깨우는
            // 경우가 있다(알림 peek로 interactive=true가 되지만 카톡 방 자체는 포그라운드로
            // 안 돌아옴 — wakeScreenForSend()는 이미 interactive라 아무것도 안 하고 넘어감).
            // 이럴 때 바로 친구탭 콜드경로(약 7초)로 가지 않고, 이미 살아있는 카톡 태스크를
            // 인텐트로 그냥 앞으로 불러오기만 하는(친구탭 검색 전혀 없음) 훨씬 싼 복구를 먼저
            // 시도한다. 태스크가 실제로 죽어있었다면 launchKakao()는 메인/스플래시로
            // 콜드스타트하므로 isInChat은 여전히 false — 그대로 기존 친구탭 안전망으로
            // 떨어진다(추가 리스크 없음, 상태 저장 없이 화면만 다시 확인).
            // 2026-10-06 2차 실측: 이 기기는 40초 이상 비우면 거의 매번 액티비티가 이미 죽어있어
            // 이 복구가 거의 항상 실패한다 — 살아있으면 인텐트 전환은 수백ms 안에 끝나므로, 긴
            // STEP_MS(2.5초)를 다 기다리지 않고 짧게(600ms)만 보고 실패 시 빠르게 콜드경로로
            // 넘어가 불필요한 대기를 없앤다.
            launchKakao();
            waitUntil(() -> group ? isInGroupChat(name) : isInChat(name), 600);
            held = group ? isInGroupChat(name) : isInChat(name);
        }
        Log.i(TAG, "send: name=" + name + " group=" + group + " isInChat=" + held + " hold=" + hold);
        if (held) {
            stages.put("entry", "held").put("navigate_ms", 0);
        } else {
            // "entry" 키는 openSearch()가 이미 semi/finder_back/cold로 기록해뒀으므로 덮어쓰지 않고
            // "nav_mode"로 상위 전환 종류만 별도 기록 — 로그만 보고 실제 몇 hop으로 친구탭에
            // 진입했는지(최소 hop 여부) 구분 가능하게 한다.
            // Existing 1:1 room first (skips the profile hop); on any doubt fall back to the
            // friend-profile path. PROFILE_NOT_FOUND/PROFILE_AMBIGUOUS still abort without guessing.
            boolean viaRoom = openViaChatRoom(name, stages, group);
            if (!viaRoom) {
                if (group) throw new Blocked("group_room_unavailable");   // 단톡방은 추측하지 않고 중단 (친구 프로필로 대체 금지)
                openViaFriendProfile(name, stages);
            }
            stages.put("navigate_ms", ms(t0)).put("nav_mode", viaRoom ? "chat_row" : "friend_switch");
        }

        // Read-only: the last few bubbles of this room (mine and theirs) so the web chat can be
        // brought in line with what the phone actually shows. Never fails the send.
        JSONArray recentBubbles = new JSONArray();
        long rr0 = SystemClock.uptimeMillis();
        try { recentBubbles = readRecentBubbles(3); out.put("recent", recentBubbles); } catch (Exception ignored) { /* best effort */ }
        stages.put("read_recent_ms", SystemClock.uptimeMillis() - rr0);
        // The web chat sent its last messages ("tail"). If this room shows messages the web does not
        // have, stop BEFORE typing anything: the host imports them and sends again afterwards.
        JSONArray tail = payload.optJSONArray("tail");
        if (tail != null && !dryRun && !conversationInSync(recentBubbles, tail)) {
            out.put("state", "sync_needed").put("stages", stages).put("total_ms", ms(t0));
            return out;
        }

        if (dryRun) {
            out.put("state", "verified").put("dry_run", true).put("stages", stages).put("total_ms", ms(t0));
            return out;
        }

        // Minimal send: SET_TEXT -> click 전송 -> input clears. Never wait for the
        // outgoing bubble to render or count messages (that caused needs_check +
        // 10s stalls). needs_check only if the tap fails or the input stays filled.
        long t2 = SystemClock.elapsedRealtimeNanos();
        AccessibilityNodeInfo edit = waitChatInput(STEP_MS);
        if (edit == null) throw new Blocked("not_in_chat_input");
        click(edit);                                   // focus / raise keyboard (enables 전송)
        edit = waitChatInput(STEP_MS);                 // re-acquire post-relayout (any window)
        if (edit == null) { clearDraft(); throw new Blocked("not_in_chat_input"); }
        if (!setText(edit, text)) { clearDraft(); throw new Blocked("input_set_failed"); }
        final String want = text;
        if (!waitUntil(() -> { AccessibilityNodeInfo e = findChatInput(); return e != null && want.contentEquals(textOf(e)); }, 1500)) { clearDraft(); throw new Blocked("input_set_failed"); }
        // The keyboard slides up and re-lays-out the composer; a tap at a position read before it
        // settled hits a neighbouring button. Wait for the 전송 button to hold still (and the
        // keyboard to be up), then click the button view itself rather than a coordinate.
        AccessibilityNodeInfo button = waitStableSendButton(STEP_MS + 2500);
        if (button == null) { clearDraft(); throw new Blocked("send_button_missing"); }   // typed but no 전송 -> definitely unsent, clear it
        out.put("send_attempted", true);
        long attempt = SystemClock.elapsedRealtimeNanos();
        // No retry after this point: a click that may have gone through is never repeated.
        if (!(clickViaAncestor(button) || click(button))) throw new Blocked("send_attempted");
        boolean cleared = inputCleared(1500);
        stages.put("send_ms", ms(t2)).put("send_confirm_ms", ms(attempt));
        if (!cleared) throw new Blocked("send_attempted");
        // Every completed send exits the room so replies produce notifications.
        // A batch defers only screen locking; CPU and Wi-Fi retention are independent.
        roomAwakeHandler.removeCallbacks(lockAfterIdle);
        // keep_room: the next queued message goes to the same person, so stay in the room instead of
        // leaving and searching again. The host leaves the room after the last message of the batch.
        if (!payload.optBoolean("keep_room", false)) releaseRoom();
        if (!hold) {
            finishBatch(out);
            if (!"verified".equals(out.optString("state"))) return out;
        }
        stages.put("hold", hold);   // 2026-10-12: 실제 hold 값 기록(이전엔 항상 true 하드코딩이라 배치 콜드전환 진단 불가였음)
        out.put("state", "verified").put("stages", stages).put("total_ms", ms(t0));
        return out;
    }

    /** Wipe any text we put in the chat input so an aborted send never leaves a
     *  stray draft in the customer's room (text typed but not sent). */
    private void clearDraft() {
        AccessibilityNodeInfo e = findChatInput();
        if (e != null) setText(e, "");
    }

    /** After a send, step out of the customer's room back to the finder so KakaoTalk
     *  stops treating that room as "open" and posts notifications for its replies
     *  again (immediate receipt whether or not a send just happened). Landing on the
     *  finder also keeps the next send semi-cold-fast. Never leaves the phone sitting
     *  inside a chat room: if BACK didn't reach the finder but we're still in a chat,
     *  fall back to Kakao main. */
    private void releaseRoom() {
        if (!getSystemService(PowerManager.class).isInteractive()) return;
        for (int i=0;i<3;i++) {
            if (!hasChatComposer()) return;
            // (The old dashboard swept replies here and pushed them to its server. This standalone setup has
            // no such server and syncs the conversation on its own, so that scan only cost time.)
            performGlobalAction(GLOBAL_ACTION_BACK);
            if (waitUntil(()->!hasChatComposer(),300)) return;
        }
        toMain();
        if (hasChatComposer()) throw new Blocked("chat_exit_unverified");
    }

    private boolean hasChatComposer() {
        for (AccessibilityNodeInfo root:kakaoRoots())
            if (first(root,n->EDIT_TEXT_RESOURCE_ID.equals(n.getViewIdResourceName()) || isChatInput(n))!=null) return true;
        return false;
    }

    /** SUCCESS signal: the chat input became empty shortly after tapping 전송. */
    private boolean inputCleared(int timeoutMs) {
        return waitUntil(() -> {
            AccessibilityNodeInfo e = findChatInput();
            return e != null && (e.getText() == null || e.getText().length() == 0);
        }, timeoutMs);
    }


    /** 사용자 확정 설계(2026-10-02): 다른 매장으로 전환할 때 기본 경로 = 친구 프로필을 통한 1:1
     *  진입. 채팅방 탭 직접 클릭(구 openChatDirect/findRoomRowViaChatTab 기반)은 더 이상 send()의
     *  기본 경로가 아니다 — 단톡방에서 같은 사람이 마지막 발신자일 때 검색결과가 혼입될 수 있고,
     *  접근성 트리만으로는 1:1/단톡방을 클릭 전에 안정적으로 구분할 discriminator가 없다고 실측
     *  확인됐다(desc/selected/actions/viewId 전부 동일, text=미리보기+시간 외 신호 없음). 대신
     *  resolvedKakaoName(=locator.name, 매칭 시점에 확정된 정확한 카카오 친구 프로필명)으로 친구
     *  탭에서 EXACT 1개만 매칭되는 프로필을 찾아 그 프로필의 "1:1 채팅" 버튼으로만 들어간다.
     *  openFriendProfile()은 손대지 않고 그대로 재사용(0개/2개 이상이면 추측 없이 즉시 실패 —
     *  target_not_found/target_missing_or_ambiguous를 PROFILE_NOT_FOUND/PROFILE_AMBIGUOUS로
     *  번역만 함). openSearch()가 이미 "현재 채팅방에 있으면 BACK 1번으로 검색창 재사용"을 하므로
     *  (전송 후 방을 나가지 않게 된 지금) 매 매장 전환이 자연히 최소 hop 경로를 탄다. */
    /** Enter an EXISTING 1:1 room straight from the 채팅방 search results. Returns false (after
     *  backing out, nothing typed) whenever there is any doubt, so the caller falls back to
     *  the friend-profile path. A row is only a candidate when its text starts with
     *  "<name> " (a group "<name>, other" starts with a comma and never matches) and it is the
     *  ONLY candidate. After opening, the toolbar title must equal <name> exactly, must not be
     *  a group title (…N명 / a member-count node) and the message input must exist. */
    private boolean openViaChatRoom(String name, JSONObject stages) { return openViaChatRoom(name, stages, false); }

    private boolean openViaChatRoom(String name, JSONObject stages, boolean group) {
        try {
            // Read the 전체 (All) results directly: no filter chip, no scrolling, never tap
            // "더보기". Only the band between the 채팅방 header and the next section header is
            // read (roomRows), so 메시지/친구/프로필 cards are never candidates.
            long c0 = SystemClock.uptimeMillis();
            AccessibilityNodeInfo field = openSearch(stages);
            stages.put("cr_open_search_ms", SystemClock.uptimeMillis() - c0); c0 = SystemClock.uptimeMillis();
            click(field);
            setText(field, "");
            if (!setText(field, name)) { stages.put("chat_row", "search_input_failed"); return false; }
            field.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.getId());
            stages.put("cr_type_ms", SystemClock.uptimeMillis() - c0); c0 = SystemClock.uptimeMillis();
            // Wait until the result sections render (any section header below the chip row).
            if (!waitUntil(this::resultSectionsRendered, 3000)) { stages.put("chat_row", "no_results_ui"); return false; }
            stages.put("cr_results_ms", SystemClock.uptimeMillis() - c0); c0 = SystemClock.uptimeMillis();
            // The 채팅방 section must exist; without its header the band would be open-ended.
            boolean sawChatSection = false;
            for (AccessibilityNodeInfo root : kakaoRoots()) if (sectionTop(root, "채팅방") != Integer.MAX_VALUE) sawChatSection = true;
            if (!group && !sawChatSection) { stages.put("chat_row", "none"); return false; }
            // Let the rows settle: exactly one candidate with identical bounds on two reads.
            List<AccessibilityNodeInfo> again = new ArrayList<>();
            Rect prev = null;
            long settleBy = SystemClock.uptimeMillis() + 1500;
            while (SystemClock.uptimeMillis() < settleBy) {
                again = group ? groupRows(name) : roomRows(name);
                if (again.size() == 1) {
                    Rect r = new Rect(); again.get(0).getBoundsInScreen(r);
                    if (prev != null && prev.equals(r)) break;
                    prev = r;
                } else prev = null;
                waitMs(70);
            }
            stages.put("cr_settle_ms", SystemClock.uptimeMillis() - c0); c0 = SystemClock.uptimeMillis();
            if (again.size() != 1) {
                stages.put("chat_row", again.isEmpty() ? "none" : "ambiguous");
                if (group) stages.put("odd_screen", screenBrief());   // diagnostic: what the results actually look like
                return false;
            }
            if (!click(again.get(0))) { stages.put("chat_row", "click_failed"); return false; }
            if (waitNode(this::isChatInput, STEP_MS) == null) { stages.put("chat_row", "no_input"); stages.put("odd_screen", screenBrief()); toMain(); stages.put("after_back", screenBrief()); return false; }
            stages.put("cr_enter_ms", SystemClock.uptimeMillis() - c0); c0 = SystemClock.uptimeMillis();
            if (group) {
                if (!isInGroupChat(name)) { stages.put("chat_row", "not_group"); stages.put("odd_screen", screenBrief()); toMain(); return false; }
            } else if (!name.equals(currentOneToOneTitle()) || !isInChat(name) || topBandHasMemberCount()) {
                stages.put("chat_row", "not_1to1"); toMain(); return false;
            }
            stages.put("cr_verify_ms", SystemClock.uptimeMillis() - c0);
            stages.put("chat_row", "ok");
            return true;
        } catch (Blocked b) {
            // chip absent / ambiguous / search failure: never guess, use the profile path.
            try { stages.put("chat_row", "fallback:" + b.getMessage()); } catch (Exception ignored) {}
            return false;
        } catch (Exception e) {
            return false;
        }
    }

    /** True once the 전체 results show at least one section header (채팅방/친구/메시지). */
    private boolean resultSectionsRendered() {
        for (AccessibilityNodeInfo root : kakaoRoots())
            for (String label : new String[]{"채팅방", "친구", "메시지"})
                if (sectionTop(root, label) != Integer.MAX_VALUE) return true;
        return false;
    }

    /** A group room shows its member count as its own node next to the title. */
    private boolean topBandHasMemberCount() {
        List<AccessibilityNodeInfo> roots = kakaoRoots();
        if (roots.isEmpty()) return false;
        int top = Integer.MAX_VALUE, bottom = 0;
        List<AccessibilityNodeInfo> all = new ArrayList<>();
        for (AccessibilityNodeInfo root : roots) all.addAll(walk(root, null));
        for (AccessibilityNodeInfo n : all) {
            Rect r = new Rect(); n.getBoundsInScreen(r);
            if (r.width() <= 0 || r.height() <= 0) continue;
            if (r.top < top) top = r.top;
            if (r.bottom > bottom) bottom = r.bottom;
        }
        int h = bottom > top ? bottom - top : 2340;
        for (AccessibilityNodeInfo n : all) {
            Rect r = new Rect(); n.getBoundsInScreen(r);
            // Toolbar only (first ~10%): the message list starts right below it, and a
            // message such as "6115" must not look like a member count.
            if (r.width() <= 0 || r.height() <= 0 || r.top >= top + h * 10 / 100) continue;
            String t = !descOf(n).isEmpty() ? descOf(n) : textOf(n);
            if (t.matches("[0-9]+명?")) return true;
        }
        return false;
    }

    private boolean openViaFriendProfile(String name, JSONObject stages) throws Exception {
        AccessibilityNodeInfo profile;
        try {
            profile = openFriendProfile(name, stages);
        } catch (Blocked b) {
            if ("target_not_found".equals(b.getMessage())) throw new Blocked("PROFILE_NOT_FOUND");
            if ("target_missing_or_ambiguous".equals(b.getMessage())) throw new Blocked("PROFILE_AMBIGUOUS");
            throw b;
        }
        // The profile slides in; tapping the button while it is still moving misses it
        // (Galaxy Note 20 / Kakao 26.9.2). Wait for stable bounds, and if the profile is
        // still showing after the tap, tap once more. Nothing is typed yet, so a retry
        // here can never duplicate a send.
        for (int attempt = 0; attempt < 2; attempt++) {
            AccessibilityNodeInfo one = waitStableOneToOne(4000);
            if (one == null) throw new Blocked("chat_open_button_missing");
            // 1st try: click the button VIEW itself (immune to a late layout shift that would
            // put a coordinate tap on the profile photo). 2nd try: coordinate tap.
            boolean tapped = (attempt == 0 && clickViaAncestor(one)) || click(one);
            if (!tapped) throw new Blocked("chat_open_failed");
            if (waitNode(this::isChatInput, STEP_MS) != null) return true;
            if (waitNode(n -> ONE_TO_ONE.contentEquals(textOf(n)), 300) == null) break;   // left profile: do not tap again
        }
        throw new Blocked("chat_open_unverified");
    }

    /** "1:1 채팅" button, returned only after the WHOLE profile page (its node signature) and the
     *  button position stayed unchanged for 700ms. The profile keeps loading (status text, music,
     *  background) and shifts the buttons down; tapping earlier lands on the profile photo.
     *  If the page never settles within the timeout, return null (abort; nothing typed yet). */
    private AccessibilityNodeInfo waitStableOneToOne(int timeoutMs) {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        Rect lastBounds = null;
        String lastSig = null;
        long stableSince = 0;
        AccessibilityNodeInfo node = null;
        while (SystemClock.uptimeMillis() < deadline) {
            AccessibilityNodeInfo root = getRootInActiveWindow();
            AccessibilityNodeInfo n = root == null ? null : first(root, x -> ONE_TO_ONE.contentEquals(textOf(x)));
            if (n != null) {
                Rect r = new Rect(); n.getBoundsInScreen(r);
                String sig = signature(root);
                if (lastBounds != null && lastBounds.equals(r) && sig.equals(lastSig)) {
                    node = n;
                    if (SystemClock.uptimeMillis() - stableSince >= 700) return node;
                } else {
                    lastBounds = r; lastSig = sig; stableSince = SystemClock.uptimeMillis();
                }
            } else { lastBounds = null; lastSig = null; }
            waitMs(100);
        }
        return null;
    }

    /** Click the nearest clickable ancestor of a (non-clickable) label node via ACTION_CLICK. */
    private boolean clickViaAncestor(AccessibilityNodeInfo label) {
        AccessibilityNodeInfo n = label;
        for (int depth = 0; n != null && depth < 5; depth++, n = n.getParent()) {
            if (n.isClickable()) return n.performAction(AccessibilityNodeInfo.ACTION_CLICK);
        }
        return false;
    }

    /** Find the 1:1 room row for <name>: 검색 → 채팅방 탭 칩 → scroll to bottom. Returns the
     *  row Button, or null when no 1:1 room exists (caller then creates it from the friend
     *  profile). Enters ONLY allowed surfaces (검색창/채팅방탭). */
    private AccessibilityNodeInfo findRoomRowViaChatTab(String name, JSONObject stages) throws Exception {
        AccessibilityNodeInfo field = openSearch(stages);
        click(field);
        setText(field, "");                                 // clear so an unchanged query still re-runs
        if (!setText(field, name)) throw new Blocked("search_input_failed");
        field.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.getId());
        // Enter the 채팅방 result tab (filter chip). The chat tab lists every room for the
        // query, so scrolling to the bottom reveals even a deeply-buried 1:1 — no fold.
        // MUST enter the 채팅방 tab — never scan/scroll the 전체(All) results (a similar/wrong
        // account can surface there). If the chip never renders, fail loudly instead.
        if (!tapResultChip("채팅방", 2000)) { stages.put("chip", "chip_absent"); throw new Blocked("chat_tab_unavailable"); }
        stages.put("chip", "채팅방");
        waitMs(250);   // let the 채팅방-filtered list render
        // Scroll WITHIN the 채팅방 tab until the room row shows or the list stops changing.
        // User cap: 채팅방 스크롤 탐색 최대 2초 (단톡이 많아야 한계가 있어 렌더링 포함 2초면 충분).
        long deadline = SystemClock.uptimeMillis() + 2000;
        String last = ""; int same = 0; int pages = 0;
        while (SystemClock.uptimeMillis() < deadline) {
            List<AccessibilityNodeInfo> rows = roomRows(name);
            if (!rows.isEmpty()) {
                stages.put("scroll_pages", pages).put("chat_rows", rows.size());
                if (rows.size() > 1) throw new Blocked("target_missing_or_ambiguous");
                return rows.get(0);
            }
            AccessibilityNodeInfo root = getRootInActiveWindow();
            String sig = (root == null) ? "" : signature(root);
            if (sig.equals(last)) { if (++same >= 2) break; } else same = 0;
            last = sig;
            swipeUp();
            pages++;
            waitMs(120);
        }
        List<AccessibilityNodeInfo> rows = roomRows(name);   // final scan after the list settles
        stages.put("scroll_pages", pages).put("chat_rows", rows.size());
        if (rows.size() > 1) throw new Blocked("target_missing_or_ambiguous");
        return rows.isEmpty() ? null : rows.get(0);
    }

    /** Tap a finder result FILTER CHIP (전체/친구/채팅방/…) by label. The chip row sits ABOVE
     *  the results (top < 400); the same-text section header sits below (top > 400, see
     *  sectionTop). Chip text nodes are not clickable, so tap by coordinates — the chip with
     *  the smallest top. Returns false if no such chip is visible. */
    private boolean tapResultChip(String label, int timeoutMs) {
        // The result filter chips (전체/친구/채팅방/메시지/기타) render a beat AFTER the query is
        // submitted, so WAIT for them (the old single scan fired too early -> chip_absent). The
        // chip is a CLICKABLE node near the top (top<400); the same-text section header lower
        // down is NOT clickable, so require clickable to pick the chip, never the header.
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        do {
            AccessibilityNodeInfo best = null; int bestTop = Integer.MAX_VALUE;
            for (AccessibilityNodeInfo root : kakaoRoots())
                for (AccessibilityNodeInfo n : walk(root, x -> label.contentEquals(textOf(x)) && Boolean.TRUE.equals(x.isClickable()) && visible(x))) {
                    Rect r = new Rect(); n.getBoundsInScreen(r);
                    if (r.top < 400 && r.top < bestTop) { bestTop = r.top; best = n; }
                }
            if (best != null) { Rect r = new Rect(); best.getBoundsInScreen(r); return tapAt(r.centerX(), r.centerY()); }
            waitMs(POLL_MS);
        } while (SystemClock.uptimeMillis() < deadline);
        return false;
    }

    /** 1:1 room rows for <name> in the 전체 search results, across all Kakao windows:
     *  clickable Buttons whose text is exactly <name> or starts with "<name> " (name
     *  + preview), **restricted to the 채팅방 section** (above the 친구/메시지 section
     *  headers). CRITICAL: a message FROM <name> also renders as a "<name> …" Button in
     *  the 메시지 section — matching that opened the message/그룹 instead of the 1:1 (the
     *  "메시지 탭" bug). So we accept only rows above whichever of 친구/메시지 comes first.
     *  The friend row (a View, not a Button) never matches; group rows start with
     *  another name/comma. After the fold expands to a pure 채팅방 list there are no
     *  친구/메시지 headers, so the bound is open and all matching rooms are accepted. */
    private List<AccessibilityNodeInfo> roomRows(String name) {
        List<AccessibilityNodeInfo> hits = new ArrayList<>();
        for (AccessibilityNodeInfo root : kakaoRoots()) {
            // Strict 채팅방-section band: BELOW the 채팅방 header and ABOVE whichever of
            // 친구/메시지 comes next. A message from <name> sits in the 메시지 section
            // (below this band) and is therefore never matched. When the fold has
            // expanded to a pure 채팅방 list there is no 채팅방/친구/메시지 header, so the
            // band is fully open (lower=0, upper=MAX) and all matching rooms pass.
            int chatTop = sectionTop(root, "채팅방");
            int lower = (chatTop == Integer.MAX_VALUE) ? 0 : chatTop;
            int upper = Math.min(sectionTop(root, "친구"), sectionTop(root, "메시지"));
            for (AccessibilityNodeInfo n : walk(root, x -> "android.widget.Button".contentEquals(String.valueOf(x.getClassName()))
                    && Boolean.TRUE.equals(x.isClickable()))) {
                String t = textOf(n);
                if (!(name.contentEquals(t) || t.startsWith(name + " "))) continue;
                Rect r = new Rect(); n.getBoundsInScreen(r);
                if (r.width() > 0 && r.height() > 0 && r.top > lower && r.top < upper) hits.add(n);
            }
        }
        return hits;
    }

    /** Group-room rows for <name> in the 전체 search results. A group row reads "<종류> <name> <인원수> <미리보기>"
     *  (e.g. "팀채팅 재고관리방 10 …", "그룹채팅 …"): the member count right after the exact name is what tells it
     *  from a message, an open-chat community or a 1:1 room that merely contains the name. */
    private List<AccessibilityNodeInfo> groupRows(String name) {
        List<AccessibilityNodeInfo> hits = new ArrayList<>();
        java.util.regex.Pattern row = java.util.regex.Pattern.compile("^(?:[^ 0-9]*채팅 )?" + java.util.regex.Pattern.quote(name) + " [0-9]+(?: .*)?$", java.util.regex.Pattern.DOTALL);
        for (AccessibilityNodeInfo root : kakaoRoots()) {
            for (AccessibilityNodeInfo n : walk(root, x -> "android.widget.Button".contentEquals(String.valueOf(x.getClassName()))
                    && Boolean.TRUE.equals(x.isClickable()))) {
                Rect r = new Rect(); n.getBoundsInScreen(r);
                if (r.width() > 0 && r.height() > 0 && row.matcher(textOf(n)).matches()) hits.add(n);
            }
        }
        return hits;
    }

    /** Top Y of a finder section header whose text is exactly <label>, in the results
     *  area (top > 400 skips the identical top filter-chip of the same text). Integer
     *  MAX_VALUE if the section is absent (e.g. a pure 채팅방 list after expanding). */
    private int sectionTop(AccessibilityNodeInfo root, String label) {
        int best = Integer.MAX_VALUE;
        for (AccessibilityNodeInfo n : walk(root, x -> label.contentEquals(textOf(x)))) {
            Rect r = new Rect(); n.getBoundsInScreen(r);
            if (r.top > 400 && r.top < best) best = r.top;
        }
        return best;
    }

    // (Removed) 채팅방 더보기 fold helpers — superseded by 채팅방 탭 + scroll
    // (findRoomRowViaChatTab): entering the chat tab lists every room, so scrolling to the
    // bottom reveals even a deeply-buried 1:1 without ever expanding a fold.

    /** ensureRoomReady (matching init only). Entry is ALWAYS, unconditionally via the friend
     *  profile's "1:1 채팅" button — never via a 채팅방 탭 search result (2026-10-06: a 채팅방
     *  탭 row cannot be told apart from a same-named group chat before it is clicked, and the
     *  user explicitly confirmed group-chat matching is separate future work, so NO pre-check
     *  of any kind touches 채팅방/메시지 search results here anymore — straight to 친구 탭,
     *  every time). The server's /rooms/match already short-circuits (DB-only, no device
     *  interaction) when a room is already ROOM_READY, but whether to GREET is decided
     *  SEPARATELY here, after landing inside the opened room, by roomHasAnyMessage() — a
     *  genuinely empty room (no bubble at all, either side) gets the one-time greeting; any
     *  existing history never gets re-greeted (2026-10-06, 사용자 지적으로 "친구탭 진입"과
     *  "인사말 여부"를 하나로 묶었던 버그 수정 — 진입 경로를 무조건 친구탭으로 고정한 것과
     *  별개로, 인사말은 여전히 실제 과거기록 유무로만 판단해야 한다). On success the room is
     *  HELD and the server promotes it to ROOM_READY. Never used for regular work sends. */
    private JSONObject initRoom(JSONObject payload, JSONObject out) throws Exception {
        String name = payload.getString("name");
        String text = payload.getString("text");
        boolean dryRun = payload.optBoolean("dry_run", false);   // test: do everything EXCEPT the greeting send
        long t0 = SystemClock.elapsedRealtimeNanos();
        JSONObject stages = new JSONObject(); stageTrace = stages;
        // 2026-10-06: 배치 발송 사전예열(dry_run init_room)이 이 경로를 타는데, 예열 시점에
        // 화면이 꺼져있으면 send()와 똑같이 깨워야 친구탭 탐색이 된다.
        wakeScreenForSend();
        AccessibilityNodeInfo profile = openFriendProfile(name, stages);
        out.put("fingerprint", fingerprint(profile));
        AccessibilityNodeInfo one = waitNode(n -> ONE_TO_ONE.contentEquals(textOf(n)), STEP_MS);
        if (one == null) throw new Blocked("chat_open_button_missing");
        if (!click(one)) throw new Blocked("chat_open_failed");
        AccessibilityNodeInfo edit = waitNode(this::isChatInput, STEP_MS);
        boolean inputOk = edit != null;
        if (edit == null) throw new Blocked("chat_open_unverified");
        // room_existed는 참고용으로만 남긴다(진단). 2026-10-12 사용자 확정: 안내문자(greeting) 발송은
        // 더 이상 "방이 비었나"(roomHasAnyMessage, 버블 렌더 지연 시 false 오판정→재인사 버그) 판정에
        // 걸지 않는다. 오직 서버가 명시적으로 greet=true를 줄 때만 보낸다 — 그 경로는 "친구탭에도 없어
        // 전화번호로 연락처추가(add_contact)해 새 친구를 막 만든" 1:1뿐이라, 정의상 비어있어 안전하다.
        out.put("room_existed", roomHasAnyMessage());
        boolean greet = payload.optBoolean("greet", false);
        out.put("greeting_sent", false);
        if (greet && !dryRun) {                          // greet ONLY on explicit request (add-contact new-friend path)
            if (text == null || text.isEmpty()) throw new Blocked("first_message_unset");
            click(edit);
            if (!setText(edit, text)) throw new Blocked("input_set_failed");
            AccessibilityNodeInfo button = waitNode(n -> SEND_LABEL.contentEquals(descOf(n)) && "android.widget.Button".contentEquals(String.valueOf(n.getClassName())) && visible(n), STEP_MS);
            if (button == null) throw new Blocked("send_button_missing");
            out.put("send_attempted", true);
            if (!click(button)) throw new Blocked("send_attempted");
            if (!inputCleared(1500)) throw new Blocked("send_attempted");
            out.put("greeting_sent", true);
        }
        out.put("room_created", greet && !dryRun);
        // openFriendProfile()이 이미 정확히 1개 매칭된 프로필에서만 진입하므로(0개/2개 이상이면
        // target_not_found/target_missing_or_ambiguous로 즉시 실패), 여기 도달했다면 title은
        // 항상 일치 — 채팅방 탭 경로일 때만 필요했던 titlePresent() 재확인이 더 이상 필요 없다.
        out.put("chat_input_present", inputOk).put("dry_run", dryRun);
        out.put("state", inputOk ? "verified" : "needs_check").put("stages", stages).put("total_ms", ms(t0));
        toMain();
        return out;
    }

    private boolean longPressAt(int x, int y) {
        Path path = new Path();
        path.moveTo(x, y);
        GestureDescription gesture = new GestureDescription.Builder()
            .addStroke(new GestureDescription.StrokeDescription(path, 0, 650)).build();
        return dispatchBlocking(gesture);
    }

    /** A clickable Button with an EXACT content-desc, searched across every Kakao
     *  window (the long-press context menu can be a separate popup window). */
    private AccessibilityNodeInfo waitButtonDesc(String desc, int timeoutMs) {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        do {
            for (AccessibilityNodeInfo root : kakaoRoots()) {
                AccessibilityNodeInfo b = first(root, n -> "android.widget.Button".contentEquals(String.valueOf(n.getClassName())) && desc.contentEquals(descOf(n)));
                if (b != null) return b;
            }
            waitMs(POLL_MS);
        } while (SystemClock.uptimeMillis() < deadline);
        return null;
    }

    /** Pin the 1:1 room to the top of the chat list so it is the first search hit.
     *  Long-presses the room row in the search results and taps "채팅방 상단 고정".
     *  Idempotent: if the room is already pinned (the toggle reads "…고정 해제") it is
     *  left as-is (never unpinned). Returns false only when no 1:1 room row exists
     *  yet (caller then creates it). */
    private boolean pinRoom(String name, JSONObject stages) throws Exception {
        AccessibilityNodeInfo row = findRoomRowViaChatTab(name, stages);   // 검색→채팅방 탭→스크롤
        if (row == null) return false;                       // genuinely no 1:1 room yet
        pinFoundRow(row, name, stages);
        return true;
    }

    /** Pin a room to the top via its (already-found) 채팅방-results row. Idempotent: if it is
     *  already pinned (unpin toggle shown) leave it. One long-press retry for a missed menu. */
    private void pinFoundRow(AccessibilityNodeInfo row, String name, JSONObject stages) throws Exception {
        for (int attempt = 0; attempt < 2; attempt++) {
            Rect r = new Rect(); row.getBoundsInScreen(r);
            longPressAt(r.centerX(), r.centerY());
            AccessibilityNodeInfo pin = waitButtonDesc("채팅방 상단 고정", 1800);
            if (pin != null) { click(pin); stages.put("pin", "pinned"); return; }
            if (waitButtonDesc("채팅방 상단 고정 해제", 400) != null) { performGlobalAction(GLOBAL_ACTION_BACK); stages.put("pin", "already"); return; }
            performGlobalAction(GLOBAL_ACTION_BACK);          // close whatever opened, then retry once
            List<AccessibilityNodeInfo> rows = roomRows(name);
            if (rows.isEmpty()) break;
            row = rows.get(0);
            waitMs(150);
        }
        stages.put("pin", "menu_absent");
    }

    /** Click the (already-pinned) room's row FRESH: re-scan for CURRENT bounds immediately before
     *  tapping instead of reusing bounds captured during the earlier scroll-scan. Kakao's result
     *  list can reflow a beat after it first renders (preview text/async content), so a stale
     *  coordinate can land on a different element that is now at that position — this is exactly
     *  how a search for "장효재" ended up opening a CALL instead of the chat. If the tap doesn't
     *  land on the chat input, check for a call screen and hang up (never trust BACK alone to
     *  dismiss an active call — it can just background it while the call keeps ringing/connects).
     *  One retry before giving up. */
    private boolean openPinnedRow(String name, JSONObject stages) throws Exception {
        for (int attempt = 0; attempt < 2; attempt++) {
            List<AccessibilityNodeInfo> rows = roomRows(name);   // fresh bounds, assuming still positioned
            AccessibilityNodeInfo target;
            if (!rows.isEmpty()) {
                if (rows.size() > 1) throw new Blocked("target_missing_or_ambiguous");
                target = rows.get(0);
            } else {
                // pinFoundRow's long-press menu + BACK can land us OFF the search results entirely
                // (not just closing the menu) — re-establish 검색→채팅방 탭→스크롤 rather than assume
                // we're still on the same screen. This is what silently failed for "장효재": a bare
                // re-scan found nothing because the search had been dismissed, not because the room
                // disappeared.
                target = findRoomRowViaChatTab(name, stages);
                if (target == null) { if (attempt == 0) { waitMs(150); continue; } throw new Blocked("chat_open_failed"); }
            }
            if (!click(target)) throw new Blocked("chat_open_failed");
            if (waitNode(this::isChatInput, STEP_MS) != null) return true;
            if (callScreenOpened()) { endCallIfOpen(); stages.put("call_screen_detected", true); throw new Blocked("call_screen_opened"); }
            performGlobalAction(GLOBAL_ACTION_BACK);   // wasn't the chat; close it and retry once
            waitMs(150);
        }
        return false;
    }

    /** Heuristic: we ended up on an in-call screen instead of the chat (a running-call timer or
     *  call-control labels are visible), rather than just a slow chat-input render. */
    private boolean callScreenOpened() {
        // Defensive: right after a tap the screen can still be transitioning, so a node fetched
        // an instant earlier can go stale mid-walk (IllegalStateException) — observed as a bare
        // executor_failed crash for "리자드스탠다드-유색" with no retry (the loop in openPinnedRow
        // never got a chance to run again). Treat "couldn't tell" as "not a call screen" instead
        // of letting the whole init_room command crash on an uncertain reflow.
        try {
            AccessibilityNodeInfo root = getRootInActiveWindow();
            if (root == null || !PKG.contentEquals(String.valueOf(root.getPackageName()))) return false;
            for (AccessibilityNodeInfo n : walk(root, null)) {
                if ("android.widget.Chronometer".contentEquals(String.valueOf(n.getClassName()))) return true;
                String d = descOf(n), t = textOf(n);
                if (d.contains("통화 거절") || d.contains("스피커") || d.contains("통화 중") || d.contains("마이크 음소거")
                    || t.contains("통화 거절") || t.contains("통화 중")) return true;
            }
        } catch (Exception ignored) { /* stale node mid-transition — treat as "not a call" */ }
        return false;
    }

    /** Safety: if we accidentally triggered a call, end it immediately rather than leaving it
     *  ringing/connected in the background — never rely on BACK alone for this. */
    private void endCallIfOpen() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return;
        AccessibilityNodeInfo end = first(root, n -> {
            String d = descOf(n), t = textOf(n);
            return d.contains("통화 종료") || d.contains("끊기") || t.contains("통화 종료") || t.contains("끊기");
        });
        if (end != null) { click(end); waitMs(300); }
        performGlobalAction(GLOBAL_ACTION_BACK);
    }

    /** The chat message input sits in the lower half of the screen; the finder's
     *  search field is at the top. Distinguishes the two (both EditText) so a
     *  message is never typed into the search box. */
    private boolean isChatInput(AccessibilityNodeInfo n) {
        if (!isEditField(n)) return false;
        AccessibilityNodeInfo root = getRootInActiveWindow();
        Rect screen = new Rect(); if (root != null) root.getBoundsInScreen(screen);
        int h = screen.height() > 0 ? screen.height() : 2340;
        Rect r = new Rect(); n.getBoundsInScreen(r);
        return r.top > screen.top + h / 2;
    }

    /** A group room: the message input is there and the toolbar title is exactly <name> (optionally followed by the
     *  member count, which this Kakao build shows either in its own node or as a "N명" suffix). */
    private boolean isInGroupChat(String name) {
        List<AccessibilityNodeInfo> roots = kakaoRoots();
        if (roots.isEmpty()) return false;
        Rect screen = new Rect(); roots.get(0).getBoundsInScreen(screen);
        int h = screen.height() > 0 ? screen.height() : 2340;
        boolean input = false, title = false, plain = false;
        for (AccessibilityNodeInfo root : roots) {
            for (AccessibilityNodeInfo n : walk(root, null)) {
                Rect r = new Rect(); n.getBoundsInScreen(r);
                if (r.width() <= 0 || r.height() <= 0) continue;
                if (!input && EDIT_CLASS.contentEquals(String.valueOf(n.getClassName()))
                        && (EDIT_TEXT_RESOURCE_ID.contentEquals(String.valueOf(n.getViewIdResourceName())) || r.top > screen.top + h / 2)) input = true;
                if (!title && r.top < screen.top + h * 20 / 100) {
                    for (String c : new String[]{descOf(n), textOf(n)})
                        if (c.equals(name)) plain = true;
                        else if ((c.startsWith(name) && c.substring(name.length()).matches("\\s*[0-9]+명?"))) title = true;
                }
            }
            if (input && title) break;
        }
        return input && (title || (plain && topBandHasMemberCount()));
    }

    private boolean isInChat(String name) {
        List<AccessibilityNodeInfo> roots = kakaoRoots();
        if (roots.isEmpty()) return false;
        // Bounds-based (do NOT rely on isVisibleToUser, which can flip false for a
        // moment right after a send). Need: a chat input box in the lower half AND
        // the room name EXACTLY in the top toolbar band (not a bubble/member lower
        // down) — so a group merely containing <name> is never taken for the 1:1.
        // Scan every Kakao window via kakaoRoots(), not just getRootInActiveWindow():
        // right after a send the keyboard is still up, which splits the toolbar and
        // the input field across different windows (same reason findChatInput()/
        // waitSendButton() already scan kakaoRoots() instead of a single active root).
        Rect screen = new Rect(); roots.get(0).getBoundsInScreen(screen);
        int h = screen.height() > 0 ? screen.height() : 2340;
        // 2026-10-05: 리소스-id 우선 매칭(키보드 위/아래 모두 같은 id라 위치 흔들림에 안전),
        // 혹시 id가 안 잡히면 기존 위치 기반(h/2) 판정 그대로 fallback — 동작 계약 불변.
        boolean input = false, title = false;
        for (AccessibilityNodeInfo root : roots) {
            for (AccessibilityNodeInfo n : walk(root, null)) {
                Rect r = new Rect(); n.getBoundsInScreen(r);
                if (r.width() <= 0 || r.height() <= 0) continue;
                if (!input && EDIT_CLASS.contentEquals(String.valueOf(n.getClassName()))
                        && (EDIT_TEXT_RESOURCE_ID.contentEquals(String.valueOf(n.getViewIdResourceName()))
                            || r.top > screen.top + h / 2)) input = true;
                if (!title && r.top < screen.top + h * 20 / 100
                    && (name.contentEquals(descOf(n)) || name.contentEquals(textOf(n)))) title = true;
            }
            if (input && title) break;
        }
        return input && title;
    }

    /** Live Room Scan (읽기전용, 2026-10-05 플랜): HOLD 중인 방에서 상대방 버블을 직접 읽어
     *  답변 캡처 폴링에 쓴다. 절대 네비게이션하지 않는다 — isInChat(name)이 아니면 즉시
     *  not_in_room으로 끝낸다(검색/친구탭 이동 전혀 없음, 혼입 가능성이 구조적으로 0).
     *  좌측 버블(상대방)만 모으고, 각 버블은 바로 위 "OOO 님의 프로필 보기" 마커로 발신자를
     *  재확인해 <name>과 다르면 버린다(절대 추측하지 않음). 우측(본인 발신)은 서버가 이미
     *  알고 있으므로 수집하지 않는다. toolbar가 "N명"으로 끝나면 단톡방으로 보고 중단
     *  (isInChat의 exact title match로 이미 걸러지지만 이중 방어). 타임스탬프/resource-id가
     *  없어(2026-10-05 실측) dedup은 호출자가 (sender,text) 내용 기반 커서로 해야 한다. */
    private JSONObject scanRoom(String name, JSONObject out) throws Exception {
        if (!isInChat(name)) { out.put("state", "failed").put("error", "not_in_room"); return out; }
        List<AccessibilityNodeInfo> roots = kakaoRoots();
        Rect screen = new Rect(); roots.get(0).getBoundsInScreen(screen);
        int h = screen.height() > 0 ? screen.height() : 2340;
        int w = screen.width() > 0 ? screen.width() : 1080;
        java.util.TreeMap<Integer, String> markers = new java.util.TreeMap<>();
        List<int[]> bubbleYs = new ArrayList<>();
        List<String> bubbleTexts = new ArrayList<>();
        for (AccessibilityNodeInfo root : roots) {
            for (AccessibilityNodeInfo n : walk(root, null)) {
                Rect r = new Rect(); n.getBoundsInScreen(r);
                if (r.width() <= 0 || r.height() <= 0) continue;
                String d = descOf(n);
                if (r.top < screen.top + h * 20 / 100
                        && GROUP_TITLE_SUFFIX.matcher(!d.isEmpty() ? d : textOf(n)).matches()) {
                    out.put("state", "failed").put("error", "group_chat_detected"); return out;
                }
                if (d.endsWith(SENDER_MARKER_SUFFIX)) {
                    markers.put(r.top, d.substring(0, d.length() - SENDER_MARKER_SUFFIX.length()));
                    continue;
                }
                if (!"android.widget.Button".contentEquals(String.valueOf(n.getClassName()))) continue;
                String t = textOf(n);
                if (t.isEmpty() || r.left >= screen.left + w / 2) continue;   // empty or 본인(우측) 발신 — 제외
                if (DATE_DIVIDER.matcher(t).matches()) continue;   // 날짜 구분선 — 메시지 아님
                bubbleYs.add(new int[]{r.top});
                bubbleTexts.add(t);
            }
        }
        JSONArray messages = new JSONArray();
        for (int i = 0; i < bubbleYs.size(); i++) {
            java.util.Map.Entry<Integer, String> marker = markers.floorEntry(bubbleYs.get(i)[0]);
            if (marker == null || !name.equals(marker.getValue())) continue;   // 마커 없음/다른 발신자 — 버림, 추측 금지
            messages.put(new JSONObject().put("sender", marker.getValue()).put("text", bubbleTexts.get(i)));
        }
        out.put("state", "verified").put("name", name).put("messages", messages);
        return out;
    }

    /** Comparison key of a message: whitespace collapsed, first 40 UTF-16 units (long bubbles are
     *  shown truncated, so only the beginning is compared). Must match kakao_routes._key(). */
    private static String msgKey(String text) {
        String t = text == null ? "" : text.trim().replaceAll("\\s+", " ");
        return t.length() > 40 ? t.substring(0, 40) : t;
    }

    /** True when the phone's recent bubbles appear, in order, inside the web chat's tail
     *  (the web may legitimately hold extra messages the phone view no longer shows). */
    private static boolean conversationInSync(JSONArray phone, JSONArray tail) {
        int n = phone.length(), m = tail.length();
        if (n == 0) return true;
        if (m < n) return false;
        for (int i = 0; i + n <= m; i++) {
            boolean all = true;
            for (int j = 0; j < n && all; j++) {
                JSONObject a = phone.optJSONObject(j), b = tail.optJSONObject(i + j);
                all = a != null && b != null
                    && a.optString("side").equals(b.optString("side"))
                    && msgKey(a.optString("text")).equals(b.optString("key"));
            }
            if (all) return true;
        }
        return false;
    }

    /** KakaoTalk's reply feature makes screen readers prepend "답장 메시지" to the bubble text. It is not part of the
     *  message, so drop it (a bubble that is only that label is kept as is). */
    private static String stripReplyLabel(String text) {
        String stripped = text.replaceFirst("^답장 메시지\\s+", "").trim();
        return stripped.isEmpty() ? text : stripped;
    }

    private static final java.util.regex.Pattern DATE_PARTS = java.util.regex.Pattern.compile("^(\\d{4})년 (\\d{1,2})월 (\\d{1,2})일");

    /** Last <max> message bubbles of the open room, oldest first: {side:"me"|"them", text, date}.
     *  This Kakao build exposes bubbles as id "bubble" (text inside a "message" TextView, photos as an
     *  "image"), date dividers as "time_line" buttons, and NO per-message time. Side comes from the
     *  bubble's horizontal position (mine = right half). date is the nearest divider above the bubble
     *  that is on screen, or "" when its divider has scrolled off. Photos/other bubbles become "(사진)". */
    private JSONArray readRecentBubbles(int max) throws Exception {
        JSONArray result = new JSONArray();
        waitUntil(() -> {
            for (AccessibilityNodeInfo root : kakaoRoots())
                if (first(root, n -> "com.kakao.talk:id/bubble".equals(n.getViewIdResourceName())) != null) return true;
            return false;
        }, 1200);
        List<AccessibilityNodeInfo> roots = kakaoRoots();
        if (roots.isEmpty()) return result;
        Rect screen = new Rect(); roots.get(0).getBoundsInScreen(screen);
        int w = screen.width() > 0 ? screen.width() : 1080;
        int h = screen.height() > 0 ? screen.height() : 2400;
        java.util.TreeMap<Integer, String> dates = new java.util.TreeMap<>();
        java.util.TreeMap<Integer, String[]> bubbles = new java.util.TreeMap<>();   // top -> {side, text}
        for (AccessibilityNodeInfo root : roots) {
            for (AccessibilityNodeInfo n : walk(root, null)) {
                Rect r = new Rect(); n.getBoundsInScreen(r);
                if (r.width() <= 0 || r.height() <= 0) continue;
                String id = n.getViewIdResourceName();
                if ("android.widget.Button".contentEquals(String.valueOf(n.getClassName())) && DATE_DIVIDER.matcher(textOf(n)).matches()) {
                    java.util.regex.Matcher m = DATE_PARTS.matcher(textOf(n));
                    if (m.find()) dates.put(r.top, String.format(java.util.Locale.US, "%s-%02d-%02d", m.group(1), Integer.parseInt(m.group(2)), Integer.parseInt(m.group(3))));
                    continue;
                }
                if (!"com.kakao.talk:id/bubble".equals(id)) continue;
                if (r.top < screen.top + h * 8 / 100) continue;          // under the toolbar
                String text = "";
                for (AccessibilityNodeInfo c : walk(n, x -> "com.kakao.talk:id/message".equals(x.getViewIdResourceName()))) {
                    text = stripReplyLabel(textOf(c).trim()); if (!text.isEmpty()) break;
                }
                if (text.isEmpty()) {
                    boolean photo = !walk(n, x -> "com.kakao.talk:id/image".equals(x.getViewIdResourceName())).isEmpty();
                    if (!photo) continue;
                    text = "(사진)";
                }
                bubbles.put(r.top, new String[]{ r.centerX() > screen.left + w / 2 ? "me" : "them", text });
            }
        }
        List<Integer> tops = new ArrayList<>(bubbles.keySet());
        for (int i = Math.max(0, tops.size() - max); i < tops.size(); i++) {
            int top = tops.get(i);
            String[] b = bubbles.get(top);
            java.util.Map.Entry<Integer, String> d = dates.floorEntry(top);
            result.put(new JSONObject().put("side", b[0]).put("text", b[1]).put("date", d == null ? "" : d.getValue()));
        }
        return result;
    }

    private static final class HistoryScan {
        final String cursor = java.util.UUID.randomUUID().toString();
        final String name, since;
        boolean group;
        final List<String[]> seq = new ArrayList<>();   // oldest first: {"d", date} | {"m", side, text, sender}
        String lastSig;
        int pages, same, backtracks;
        boolean finished;
        HistoryScan(String name, String since) { this.name = name; this.since = since; }
    }
    private HistoryScan historyScan;

    /** Date dividers and message bubbles currently on screen, top to bottom. Read-only. */
    private List<String[]> readRoomTokens() {
        List<String[]> out = new ArrayList<>();
        List<AccessibilityNodeInfo> roots = kakaoRoots();
        if (roots.isEmpty()) return out;
        Rect screen = new Rect(); roots.get(0).getBoundsInScreen(screen);
        int w = screen.width() > 0 ? screen.width() : 1080;
        int h = screen.height() > 0 ? screen.height() : 2400;
        java.util.TreeMap<Long, String[]> found = new java.util.TreeMap<>();
        long counter = 0;
        java.util.TreeMap<Integer, String> senderMarks = new java.util.TreeMap<>();   // top -> sender name (group rooms)
        for (AccessibilityNodeInfo root : roots) {
            for (AccessibilityNodeInfo n : walk(root, null)) {
                Rect r = new Rect(); n.getBoundsInScreen(r);
                String dd = descOf(n);
                if (r.width() > 0 && r.height() > 0 && dd.endsWith(SENDER_MARKER_SUFFIX))
                    senderMarks.put(r.top, dd.substring(0, dd.length() - SENDER_MARKER_SUFFIX.length()));
            }
        }
        for (AccessibilityNodeInfo root : roots) {
            for (AccessibilityNodeInfo n : walk(root, null)) {
                Rect r = new Rect(); n.getBoundsInScreen(r);
                if (r.width() <= 0 || r.height() <= 0 || r.top < screen.top + h * 8 / 100) continue;
                long key = (long) r.top * 1000 + (counter++ % 1000);
                if ("android.widget.Button".contentEquals(String.valueOf(n.getClassName())) && DATE_DIVIDER.matcher(textOf(n)).matches()) {
                    java.util.regex.Matcher m = DATE_PARTS.matcher(textOf(n));
                    if (m.find()) found.put(key, new String[]{"d", String.format(java.util.Locale.US, "%s-%02d-%02d", m.group(1), Integer.parseInt(m.group(2)), Integer.parseInt(m.group(3)))});
                    continue;
                }
                if (!"com.kakao.talk:id/bubble".equals(n.getViewIdResourceName())) continue;
                String text = "";
                for (AccessibilityNodeInfo c : walk(n, x -> "com.kakao.talk:id/message".equals(x.getViewIdResourceName()))) {
                    text = stripReplyLabel(textOf(c).trim()); if (!text.isEmpty()) break;
                }
                if (text.isEmpty()) {
                    if (walk(n, x -> "com.kakao.talk:id/image".equals(x.getViewIdResourceName())).isEmpty()) continue;
                    text = "(사진)";
                }
                boolean mine = r.centerX() > screen.left + w / 2;
                String sender = "";
                if (!mine) {   // the marker sits on the first bubble of a run, level with the bubble's top
                    int best = Integer.MAX_VALUE;
                    for (java.util.Map.Entry<Integer, String> mk : senderMarks.entrySet()) {
                        int gap = Math.abs(mk.getKey() - r.top);
                        if (gap < 160 && gap < best) { best = gap; sender = mk.getValue(); }
                    }
                }
                found.put(key, new String[]{"m", mine ? "me" : "them", text, sender});
            }
        }
        // the same bubble can appear in two windows: drop exact duplicates at the same top
        String[] prev = null; long prevTop = -1;
        for (java.util.Map.Entry<Long, String[]> e : found.entrySet()) {
            long top = e.getKey() / 1000;
            if (prev != null && top == prevTop && java.util.Arrays.equals(prev, e.getValue())) continue;
            out.add(e.getValue()); prev = e.getValue(); prevTop = top;
        }
        return out;
    }

    private static boolean sameToken(String[] a, String[] b) {
        if (!a[0].equals(b[0])) return false;
        if ("d".equals(a[0])) return a[1].equals(b[1]);
        return a[1].equals(b[1]) && msgKey(a[2]).equals(msgKey(b[2]));
    }

    private void swipeChatOlder() {        // older messages: about half a screen back, no fling
        scrollBackward(0.34);
    }

    private void swipeChatNewerSmall() {   // small step toward newer messages
        scrollForward(0.12);
    }

    /** Scroll the 1:1 room up and collect messages from {since} (YYYY-MM-DD) to now. Read-only: nothing
     *  is typed or sent. Chunked like the friend scan (several pages per call, cursor between calls). */
    private JSONObject roomHistory(JSONObject payload, JSONObject out) throws Exception {
        String cursor = payload.optString("cursor", "");
        if (cursor.isEmpty()) {
            final String name = payload.getString("name");
            String since = payload.optString("since", "");
            if (!since.matches("\\d{4}-\\d{2}-\\d{2}")) throw new Blocked("history_since_invalid");
            JSONObject stages = new JSONObject(); stageTrace = stages;
            final boolean group = payload.optBoolean("group", false);
            wakeScreenForSend();
            boolean held = group ? isInGroupChat(name) : isInChat(name);
            if (!held) { launchKakao(); waitUntil(() -> group ? isInGroupChat(name) : isInChat(name), 600); held = group ? isInGroupChat(name) : isInChat(name); }
            if (!held) {
                boolean viaRoom = openViaChatRoom(name, stages, group);
                if (!viaRoom) {
                    if (group) throw new Blocked("group_room_unavailable");   // never fall back to a friend profile for a group
                    openViaFriendProfile(name, stages);
                }
            }
            if (!(group ? isInGroupChat(name) : isInChat(name))) throw new Blocked("not_in_room");
            historyScan = new HistoryScan(name, since);
            historyScan.group = group;
        } else if (historyScan == null || !cursor.equals(historyScan.cursor)) {
            throw new Blocked("history_scan_expired");
        }
        HistoryScan scan = historyScan;
        for (int i = 0; i < 8 && !scan.finished; i++) {
            if (!(scan.group ? isInGroupChat(scan.name) : isInChat(scan.name))) throw new Blocked("not_in_room");
            List<String[]> page = readRoomTokens();
            StringBuilder sig = new StringBuilder();
            for (String[] t : page) sig.append(String.join("\u0001", t)).append('\n');
            String signature = sig.toString();
            if (signature.equals(scan.lastSig)) {
                // Unchanged after a swipe: either the top of the room or older messages still loading.
                if (++scan.same >= 3) { scan.finished = true; break; }
                swipeChatOlder(); waitMs(600);
                continue;
            }
            scan.same = 0;
            if (scan.seq.isEmpty()) {
                scan.seq.addAll(page);
            } else if (!page.isEmpty()) {
                int best = 0;
                for (int m = Math.min(page.size(), scan.seq.size()); m >= 1 && best == 0; m--) {
                    boolean all = true;
                    for (int k = 0; k < m && all; k++) all = sameToken(page.get(page.size() - m + k), scan.seq.get(k));
                    if (all) best = m;
                }
                if (best == 0) {
                    // Scrolled past rows we never saw: step back a little and read again.
                    if (++scan.backtracks > 60) throw new Blocked("history_scan_gap");
                    swipeChatNewerSmall(); waitMs(250);
                    continue;
                }
                for (int k = 0; k < best; k++) {   // seen before: fill in a sender that was scrolled out of view back then
                    String[] old = scan.seq.get(k), now = page.get(page.size() - best + k);
                    if ("m".equals(old[0]) && old.length > 3 && now.length > 3 && old[3].isEmpty() && !now[3].isEmpty()) old[3] = now[3];
                }
                scan.seq.addAll(0, page.subList(0, page.size() - best));
            }
            scan.lastSig = signature;
            scan.pages++;
            if (scan.pages > 400) throw new Blocked("history_scan_limit");
            // Enough once the oldest date divider we hold is before {since}.
            for (String[] t : scan.seq) {
                if ("d".equals(t[0])) { if (t[1].compareTo(scan.since) < 0) scan.finished = true; break; }
            }
            if (scan.finished) break;
            swipeChatOlder();
            waitMs(250);
        }
        if (!scan.finished) {
            out.put("state", "partial").put("cursor", scan.cursor).put("pages", scan.pages)
                .put("oldest", oldestDate(scan.seq));
            return out;
        }
        JSONArray messages = new JSONArray();
        String date = null, runSender = "";
        for (String[] t : scan.seq) {
            if ("d".equals(t[0])) { date = t[1]; runSender = ""; continue; }
            String sender = t.length > 3 ? t[3] : "";
            if ("me".equals(t[1])) runSender = "";
            else if (!sender.isEmpty()) runSender = sender;
            else sender = runSender;   // later bubbles of the same sender carry no marker
            if (date == null || date.compareTo(scan.since) < 0) continue;   // unknown or before the range
            JSONObject msg = new JSONObject().put("side", t[1]).put("text", t[2]).put("date", date);
            if (scan.group && "them".equals(t[1])) msg.put("sender", sender);
            messages.put(msg);
        }
        historyScan = null;
        out.put("state", "verified").put("messages", messages).put("pages", scan.pages);
        return out;
    }

    /** Enter the 1:1 room (no typing) and report its last bubbles. With "tail" it also says whether the
     *  web chat is missing something (state sync_needed). Leaves the room open. Read-only. */
    private JSONObject roomPeek(JSONObject payload, JSONObject out) throws Exception {
        final String name = payload.getString("name");
        final boolean group = payload.optBoolean("group", false);   // 단톡방(2026-11-11): 정확히 일치하는 단톡방 한 곳만
        JSONObject stages = new JSONObject(); stageTrace = stages;
        wakeScreenForSend();
        boolean held = group ? isInGroupChat(name) : isInChat(name);
        if (!held) { launchKakao(); waitUntil(() -> group ? isInGroupChat(name) : isInChat(name), 600); held = group ? isInGroupChat(name) : isInChat(name); }
        if (!held) {
            boolean viaRoom = openViaChatRoom(name, stages, group);
            if (!viaRoom) {
                if (group) throw new Blocked("group_room_unavailable");
                openViaFriendProfile(name, stages);
            }
        }
        if (!(group ? isInGroupChat(name) : isInChat(name))) throw new Blocked("not_in_room");
        JSONArray recent = readRecentBubbles(3);
        out.put("state", "verified").put("recent", recent).put("stages", stages);
        JSONArray tail = payload.optJSONArray("tail");
        if (tail != null && !conversationInSync(recent, tail)) out.put("state", "sync_needed");
        return out;
    }

    private static final String SHEET_ID = "com.kakao.talk:id/design_bottom_sheet";

    private AccessibilityNodeInfo shareSheetNode(String viewId) {
        for (AccessibilityNodeInfo root : kakaoRoots()) {
            AccessibilityNodeInfo n = first(root, x -> viewId.equals(x.getViewIdResourceName()) && visible(x));
            if (n != null) return n;
        }
        return null;
    }

    private boolean shareSheetShown() { return shareSheetNode(SHEET_ID) != null; }

    /** Names of the currently selected recipients (the chips above the list). */
    private List<String> shareChips() {
        List<String> chips = new ArrayList<>();
        for (AccessibilityNodeInfo root : kakaoRoots())
            for (AccessibilityNodeInfo t : walk(root, x -> "com.kakao.talk:id/name_text".equals(x.getViewIdResourceName()) && visible(x))) chips.add(textOf(t).trim());
        return chips;
    }

    /** Rows of the share sheet's "친구" SECTION whose name is exactly {name}. A search result is split into
     *  sections ("친구", "채팅", ...): a friend always appears under 친구 (with or without chat history), while
     *  group rooms and existing rooms live under 채팅. Reading only the 친구 section means group rooms can never
     *  match and a friend who is also in 채팅 is not counted twice. The row is the clickable ancestor of the name. */
    private List<AccessibilityNodeInfo> shareRows(String name) { return shareRows(name, "친구"); }

    /** section: 1:1 친구는 "친구", 단톡방(및 기존 채팅방)은 "채팅" 섹션에 나온다. */
    private List<AccessibilityNodeInfo> shareRows(String name, final String section) {
        List<AccessibilityNodeInfo> rows = new ArrayList<>();
        for (AccessibilityNodeInfo root : kakaoRoots()) {
            List<AccessibilityNodeInfo> titles = walk(root, x -> "com.kakao.talk:id/title".equals(x.getViewIdResourceName()) && visible(x));
            int top = -1;
            for (AccessibilityNodeInfo t : titles) {
                Rect r = new Rect(); t.getBoundsInScreen(r);
                if (section.equals(textOf(t).trim())) top = r.bottom;
            }
            if (top < 0) continue;
            int bottom = Integer.MAX_VALUE;
            for (AccessibilityNodeInfo t : titles) {
                Rect r = new Rect(); t.getBoundsInScreen(r);
                if (r.top >= top && !section.equals(textOf(t).trim()) && r.top < bottom) bottom = r.top;
            }
            for (AccessibilityNodeInfo nm : walk(root, x -> "com.kakao.talk:id/name".equals(x.getViewIdResourceName())
                    && name.equals(textOf(x).trim()) && visible(x))) {
                Rect r = new Rect(); nm.getBoundsInScreen(r);
                if (r.top < top || r.top >= bottom) continue;
                AccessibilityNodeInfo row = nm;
                for (int depth = 0; depth < 4 && row != null && !row.isClickable(); depth++) row = row.getParent();
                if (row != null && row.isClickable() && !rows.contains(row)) rows.add(row);
            }
        }
        return rows;
    }

    /** Operate KakaoTalk's share sheet that ShareActivity opened: friends filter -> search {name} ->
     *  select the ONE exact 1:1 row -> verify the recipient chips are exactly [{name}] -> "1 보내기".
     *  dry_run stops after verifying (and closes the sheet). After 보내기 is tapped nothing is retried. */
    private JSONObject sharePick(JSONObject payload, JSONObject out) throws Exception {
        final String name = payload.getString("name");
        final boolean dry = payload.optBoolean("dry_run", false);
        final boolean group = payload.optBoolean("group", false);   // 단톡방(2026-11-11): "채팅" 섹션에서 정확히 일치하는 한 곳만
        JSONObject stages = new JSONObject(); stageTrace = stages;
        AccessibilityNodeInfo field = waitStableNode(n -> EDIT_CLASS.contentEquals(String.valueOf(n.getClassName()))
            && "com.kakao.talk:id/edit_text".equals(n.getViewIdResourceName()) && visible(n), 8000, 500);
        if (field == null || !shareSheetShown()) throw new Blocked("share_sheet_unavailable");
        // Friends only: keeps group rooms out of the results altogether.
        AccessibilityNodeInfo chip = group ? null : waitStableNode(n -> "친구".contentEquals(textOf(n)) && "com.kakao.talk:id/chip".equals(n.getViewIdResourceName()) && visible(n), 2500, 300);
        if (chip != null && !chip.isChecked()) {
            tapNode(chip);
            waitUntil(() -> { AccessibilityNodeInfo c = shareSheetNode("com.kakao.talk:id/chip"); return true; }, 200);
            waitMs(400);
        }
        field = shareSheetNode("com.kakao.talk:id/edit_text");
        if (field == null || !setText(field, name)) throw new Blocked("search_input_failed");
        // Let the filtered list settle, then require exactly one exact match.
        List<AccessibilityNodeInfo> rows = new ArrayList<>();
        String lastSig = ""; long stableSince = SystemClock.uptimeMillis(); long deadline = stableSince + 6000;
        while (SystemClock.uptimeMillis() < deadline) {
            rows = shareRows(name, group ? "채팅" : "친구");
            StringBuilder sig = new StringBuilder();
            for (AccessibilityNodeInfo r : rows) { Rect b = new Rect(); r.getBoundsInScreen(b); sig.append(b.flattenToString()).append(descOf(r)); }
            String now = sig.toString();
            if (!now.equals(lastSig)) { lastSig = now; stableSince = SystemClock.uptimeMillis(); }
            else if (!rows.isEmpty() && SystemClock.uptimeMillis() - stableSince >= 700) break;
            waitMs(120);
        }
        if (rows.isEmpty()) throw new Blocked("share_target_not_found");
        if (rows.size() > 1) throw new Blocked("share_target_ambiguous");
        AccessibilityNodeInfo row = rows.get(0);
        stages.put("row_desc_before", descOf(row));
        if (!shareChips().equals(java.util.Collections.singletonList(name))) {   // a tap toggles: never tap a selected row
            if (!tapNode(row)) throw new Blocked("share_select_failed");
        }
        // After a selection the list area shrinks (an input box and 보내기 appear), so the selected row
        // can scroll out of the tree. The recipient CHIPS are the authority: exactly [{name}].
        final List<String> chips = new ArrayList<>();
        boolean chipOk = waitUntil(() -> {
            chips.clear();
            chips.addAll(shareChips());
            return chips.size() == 1 && name.equals(chips.get(0));
        }, 3500);
        stages.put("chips", new JSONArray(chips));
        List<AccessibilityNodeInfo> after = shareRows(name, group ? "채팅" : "친구");
        stages.put("row_found_after", after.size()).put("row_desc_after", after.isEmpty() ? "" : descOf(after.get(0)));
        if (!chipOk) {
            // A different recipient got selected: nothing was sent; the host closes the sheet.
            throw new Blocked(chips.isEmpty() ? "share_select_unverified" : "share_recipient_mismatch");
        }
        AccessibilityNodeInfo submit = waitStableNode(n -> "com.kakao.talk:id/submit_button".equals(n.getViewIdResourceName())
            && "1 보내기".contentEquals(textOf(n)) && n.isEnabled() && visible(n), 3000, 300);
        if (submit == null) throw new Blocked("share_submit_unavailable");
        if (dry) {
            out.put("state", "ready");
            for (int i = 0; i < 3 && shareSheetShown(); i++) { performGlobalAction(GLOBAL_ACTION_BACK); waitMs(400); }
            toMain();
            return out;
        }
        out.put("send_attempted", true);
        if (!tapNode(submit)) throw new Blocked("send_attempted");
        // After 보내기 the sheet closes (some builds ask once more). Never tap 보내기 twice.
        boolean closed = waitUntil(() -> !shareSheetShown(), 6000);
        if (!closed) {
            AccessibilityNodeInfo ok = waitNode(n -> "android:id/button1".equals(n.getViewIdResourceName()) && n.isClickable(), 800);
            if (ok != null) { tapNode(ok); closed = waitUntil(() -> !shareSheetShown(), 4000); }
        }
        out.put("state", closed ? "verified" : "needs_check");
        if (!closed) out.put("error", "send_attempted");
        return out;
    }

    private static String oldestDate(List<String[]> seq) {
        for (String[] t : seq) if ("d".equals(t[0])) return t[1];
        return "";
    }

    /** True if the currently-open 1:1 room already has ANY rendered message bubble, mine or
     *  the counterpart's (unlike scanRoom(), which only collects the counterpart's side —
     *  here a single prior message from EITHER side means "not a brand-new chat"). Used only
     *  by initRoom() right after entering via the friend profile's "1:1 채팅" button, to decide
     *  whether this is genuinely the very first message ever (greet) or an existing
     *  conversation (never re-greet) — replaces the old 채팅방 탭 pre-check (2026-10-06,
     *  사용자 지적: 과거기록 있는데도 인사말이 계속 나가던 버그). Reuses scanRoom()'s proven
     *  exclusions (상단 20% 툴바 영역 제외, 날짜 구분선·전송 버튼 제외) so no new unverified
     *  text pattern is introduced — NEEDS LIVE DEVICE CONFIRMATION on a room with real history
     *  before being trusted. */
    private boolean roomHasAnyMessage() {
        List<AccessibilityNodeInfo> roots = kakaoRoots();
        if (roots.isEmpty()) return false;
        Rect screen = new Rect(); roots.get(0).getBoundsInScreen(screen);
        int h = screen.height() > 0 ? screen.height() : 2340;
        int top = screen.top + h * 20 / 100;
        for (AccessibilityNodeInfo root : roots) {
            for (AccessibilityNodeInfo n : walk(root, null)) {
                if (!"android.widget.Button".contentEquals(String.valueOf(n.getClassName()))) continue;
                Rect r = new Rect(); n.getBoundsInScreen(r);
                if (r.width() <= 0 || r.height() <= 0 || r.top < top) continue;
                String t = textOf(n);
                if (t.isEmpty() || DATE_DIVIDER.matcher(t).matches() || SEND_LABEL.contentEquals(t)) continue;
                return true;
            }
        }
        return false;
    }

    /** 진단 전용(읽기전용, 2026-10-12): 현재 카카오 화면의 접근성 노드 트리를 그대로 반환한다.
     *  FLAG_SECURE로 PC uiautomator/스크린샷이 막힌 대화방 UI를 "식별자 추측 없이" 확인하기 위한
     *  것 — 빈 첫 대화방의 중앙 이모티콘 기능 노드(최초 판정 조건)나 대화내용 검색 UI(앵커 복구)를
     *  실측으로 특정한 뒤 정식 로직을 구현하려는 용도. 아무것도 조작하지 않고, text/desc/id/class/
     *  bounds/clickable만 모아 돌려준다(최대 400개). */
    private JSONObject dumpTree(JSONObject out) {
        JSONArray nodes = new JSONArray();
        try {
            List<AccessibilityNodeInfo> roots = kakaoRoots();
            Rect screen = new Rect(); if (!roots.isEmpty()) roots.get(0).getBoundsInScreen(screen);
            for (AccessibilityNodeInfo root : roots) {
                for (AccessibilityNodeInfo n : walk(root, null)) {
                    Rect r = new Rect(); n.getBoundsInScreen(r);
                    if (r.width() <= 0 || r.height() <= 0) continue;
                    String text = textOf(n), desc = descOf(n);
                    String vid = String.valueOf(n.getViewIdResourceName());
                    if (text.isEmpty() && desc.isEmpty() && ("null".equals(vid)) && !n.isClickable()) continue;
                    nodes.put(new JSONObject()
                        .put("cls", String.valueOf(n.getClassName()))
                        .put("text", text).put("desc", desc)
                        .put("id", "null".equals(vid) ? "" : vid)
                        .put("clickable", n.isClickable())
                        .put("b", r.left + "," + r.top + "," + r.right + "," + r.bottom));
                    if (nodes.length() >= 400) break;
                }
                if (nodes.length() >= 400) break;
            }
            out.put("state", "verified").put("screen", screen.width() + "x" + screen.height()).put("nodes", nodes);
        } catch (Exception e) {
            try { out.put("state", "failed").put("error", "dump_failed").put("nodes", nodes); } catch (Exception ignored) {}
        }
        return out;
    }

    /** Open search from an explicitly selected Kakao main tab. */
    private AccessibilityNodeInfo openSearch(JSONObject stages) throws Exception { return openSearch(stages, false); }
    // add_contact verification explicitly requests Friends home; send/init_room use Chat tab.
    private AccessibilityNodeInfo openSearch(JSONObject stages, boolean fresh) throws Exception { return openSearch(stages, fresh, false); }
    private AccessibilityNodeInfo openSearch(JSONObject stages, boolean fresh, boolean friendsHome) throws Exception {
        long m = SystemClock.elapsedRealtimeNanos();
        // Explicitly select and verify the requested main tab before opening search.
        // Profile lookup for sends uses Chat; post-add verification uses Friends home.
        toMain();
        AccessibilityNodeInfo chatSelected = null;
        if (friendsHome) {
            selectFriendsHome();
        } else {
            for (int attempt = 0; attempt < 3 && chatSelected == null; attempt++) {
                // Already on the chat tab (the usual case after leaving a room): do not click it again and
                // do not wait a fixed 300ms - just go on.
                AccessibilityNodeInfo rootNow = getRootInActiveWindow();
                AccessibilityNodeInfo already = rootNow == null ? null
                    : first(rootNow, n -> startsWith(descOf(n), CHAT_TAB) && n.isSelected());
                if (already != null) { chatSelected = already; break; }
                AccessibilityNodeInfo chatTab = waitNode(n -> startsWith(descOf(n), CHAT_TAB) && visible(n), 4000);
                if (chatTab != null) click(chatTab);
                chatSelected = waitNode(n -> startsWith(descOf(n), CHAT_TAB) && n.isSelected(), 2000);
                if (chatSelected == null) toMain();
            }
        }
        if (!friendsHome && chatSelected == null) throw new Blocked("kakao_main_unavailable");
        stages.put("entry", friendsHome ? "friends_home" : "chat_tab");
        AccessibilityNodeInfo searchBtn = waitNode(n -> SEARCH.contentEquals(descOf(n)) && visible(n), 1500);
        // The chat tab hides its header (제목 / 검색 / 새로운 채팅) once its list is scrolled down. If the search
        // button is not there, scroll the list back to the top to bring the header back before giving up.
        for (int i = 0; searchBtn == null && i < 12; i++) {
            swipeDown();
            waitMs(250);
            searchBtn = waitNode(n -> SEARCH.contentEquals(descOf(n)) && visible(n), 600);
        }
        if (searchBtn == null) throw new Blocked("kakao_main_unavailable");
        stages.put("to_main_ms", ms(m));
        click(searchBtn);
        AccessibilityNodeInfo field = waitNode(this::isSearchField, STEP_MS);
        if (field == null) throw new Blocked("search_field_missing");
        return field;
    }

    /** The bottom Friends tab retains the News subtab across visits. Select the
     *  top Friends chip and verify its distinct add-contact action before use. */
    private void selectFriendsHome() {
        AccessibilityNodeInfo tab = waitNode(n -> startsWith(descOf(n), FRIEND_TAB) && visible(n), STEP_MS);
        if (tab == null || !click(tab)) throw new Blocked("friends_tab_unavailable");
        if (waitNode(n -> startsWith(descOf(n), FRIEND_TAB) && n.isSelected(), STEP_MS) == null)
            throw new Blocked("friends_tab_unavailable");
        for (int attempt = 0; attempt < 3; attempt++) {
            AccessibilityNodeInfo chip = waitNode(n -> {
                Rect r = new Rect(); n.getBoundsInScreen(r);
                return "친구".contentEquals(textOf(n)) && n.isClickable() && visible(n)
                    && r.top < 500 && r.bottom < 600;
            }, STEP_MS);
            if (chip == null || !click(chip)) break;
            if (waitNode(n -> "친구 추가".contentEquals(descOf(n)) && visible(n), STEP_MS) != null) return;
        }
        throw new Blocked("friends_home_unavailable");
    }

    /** The finder is "parked" when a search-style EditText sits at the very top
     *  of the screen. A chat's message EditText is at the bottom, so top position
     *  cleanly distinguishes the two without relying on resource-ids. */
    private AccessibilityNodeInfo onFinder() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null || !PKG.contentEquals(String.valueOf(root.getPackageName()))) return null;
        Rect screen = new Rect(); root.getBoundsInScreen(screen);
        int h = screen.height() > 0 ? screen.height() : 2340;
        for (AccessibilityNodeInfo n : walk(root, this::isSearchField)) {
            Rect r = new Rect(); n.getBoundsInScreen(r);
            if (r.top < screen.top + h * 0.25) return n;
        }
        return null;
    }

    // ---- navigation --------------------------------------------------------
    /** Bring Kakao to its requested main tab, search `name`, and open
     *  the unique matching friend's profile. Returns the profile page root. */
    private AccessibilityNodeInfo openFriendProfile(String name, JSONObject stages) throws Exception { return openFriendProfile(name, stages, false); }
    private AccessibilityNodeInfo openFriendProfile(String name, JSONObject stages, boolean fresh) throws Exception { return openFriendProfile(name, stages, fresh, false); }
    private AccessibilityNodeInfo openFriendProfile(String name, JSONObject stages, boolean fresh, boolean friendsHome) throws Exception {
        long m = SystemClock.elapsedRealtimeNanos();
        AccessibilityNodeInfo field = openSearch(stages, fresh, friendsHome);
        click(field);
        if (!setText(field, name)) throw new Blocked("search_input_failed");
        waitMs(400);
        stages.put("search_ms", ms(m)); m = SystemClock.elapsedRealtimeNanos();
        // Chat-tab search must enter its Friends result filter. Friends-home search
        // is already scoped to friends and may not render a separate filter chip.
        if (!friendsHome && !tapResultChip("친구", 2000)) throw new Blocked("friend_tab_unavailable");
        waitMs(300);

        AccessibilityNodeInfo hit = null;
        String lastSignature = "";
        long fdeadline = SystemClock.uptimeMillis() + 6000;   // cold search may render after the first empty tree
        while (SystemClock.uptimeMillis() < fdeadline) {
            AccessibilityNodeInfo root = getRootInActiveWindow();
            if (root == null) break;
            List<AccessibilityNodeInfo> found = friendRows(root, name);
            if (found.size() > 1) throw ambiguousFriends(found);
            if (found.size() == 1) { hit = settleSingleFriendRow(name, found.get(0), root); break; }
            String signature = signature(root);
            if (!signature.equals(lastSignature)) { lastSignature = signature; swipeUp(); }
            waitMs(200);
        }
        if (hit == null) {
            AccessibilityNodeInfo root = getRootInActiveWindow();
            int exactText = 0, exactDesc = 0, clickableParent = 0, visibleName = 0;
            if (root != null) for (AccessibilityNodeInfo n : walk(root, null)) {
                if (name.contentEquals(textOf(n))) exactText++;
                if (name.contentEquals(descOf(n))) exactDesc++;
                if (name.contentEquals(textOf(n)) || name.contentEquals(descOf(n))) {
                    if (visible(n)) visibleName++;
                    AccessibilityNodeInfo p = n.getParent();
                    if (p != null && p.isClickable()) clickableParent++;
                }
            }
            stageTrace.put("friend_exact_text", exactText).put("friend_exact_desc", exactDesc)
                .put("friend_visible_name", visibleName).put("friend_clickable_parent", clickableParent);
            throw new Blocked("target_not_found");
        }
        stages.put("results_ms", ms(m)); m = SystemClock.elapsedRealtimeNanos();
        if (!click(hit)) throw new Blocked("target_open_failed");
        AccessibilityNodeInfo profile = waitNode(n -> ONE_TO_ONE.contentEquals(textOf(n)), STEP_MS);
        if (profile == null) throw new Blocked("profile_unavailable");
        stages.put("profile_ms", ms(m));
        return getRootInActiveWindow();
    }

    private Blocked ambiguousFriends(List<AccessibilityNodeInfo> found) throws Exception {
        JSONArray candidates = new JSONArray();
        for (AccessibilityNodeInfo candidate : found) {
            Rect r = new Rect(); candidate.getBoundsInScreen(r);
            candidates.put(new JSONObject().put("class", String.valueOf(candidate.getClassName()))
                .put("top", r.top).put("bottom", r.bottom).put("width", r.width())
                .put("photo", !walk(candidate, x -> "프로필 사진".contentEquals(descOf(x))).isEmpty()));
        }
        stageTrace.put("friend_candidates", candidates);
        return new Blocked("target_missing_or_ambiguous");
    }

    /** Search results render progressively. Never tap the first exact match the moment it
     *  appears: require the result page (signature) and the match position to stay identical
     *  for ~600ms and still be the ONLY exact match. A second match appearing meanwhile aborts
     *  as ambiguous; a page that never settles aborts too. Nothing is typed or sent yet. */
    private AccessibilityNodeInfo settleSingleFriendRow(String name, AccessibilityNodeInfo first, AccessibilityNodeInfo firstRoot) throws Exception {
        Rect lastBounds = new Rect(); first.getBoundsInScreen(lastBounds);
        String lastSig = signature(firstRoot);
        AccessibilityNodeInfo current = first;
        long stableSince = SystemClock.uptimeMillis();
        long deadline = stableSince + 3000;
        while (SystemClock.uptimeMillis() < deadline) {
            if (SystemClock.uptimeMillis() - stableSince >= 600) return current;
            waitMs(150);
            AccessibilityNodeInfo root = getRootInActiveWindow();
            if (root == null) break;
            List<AccessibilityNodeInfo> found = friendRows(root, name);
            if (found.size() > 1) throw ambiguousFriends(found);
            String sig = signature(root);
            if (found.size() == 1) {
                Rect b = new Rect(); found.get(0).getBoundsInScreen(b);
                if (b.equals(lastBounds) && sig.equals(lastSig)) { current = found.get(0); continue; }
                lastBounds = b; lastSig = sig; current = found.get(0);
            } else { lastSig = sig; }
            stableSince = SystemClock.uptimeMillis();   // page still changing: restart the quiet period
        }
        throw new Blocked("results_unstable");
    }

    /** The friend-result name is an exact TextView, but Kakao may place the photo
     * in a different subtree. Ascend only from that exact visible name to its
     * nearest clickable row; never select a similar name or another result tab. */
    private List<AccessibilityNodeInfo> friendRows(AccessibilityNodeInfo root, String name) {
        List<AccessibilityNodeInfo> found = new ArrayList<>();
        for (AccessibilityNodeInfo n : walk(root, x -> visible(x)
                && (name.contentEquals(textOf(x)) || name.contentEquals(descOf(x))))) {
            // The search EditText contains the exact query too; it is not a friend.
            if (isEditField(n)) continue;
            AccessibilityNodeInfo row = n;
            for (int depth = 0; row != null && depth < 5; depth++, row = row.getParent()) {
                if (isEditField(row)) break;
                if (!row.isClickable() || !visible(row)) continue;
                Rect bounds = new Rect(); row.getBoundsInScreen(bounds);
                if (bounds.width() <= 0 || bounds.height() <= 0) break;
                boolean duplicate = false;
                for (AccessibilityNodeInfo prior : found) {
                    Rect other = new Rect(); prior.getBoundsInScreen(other);
                    if (other.equals(bounds)) { duplicate = true; break; }
                }
                if (!duplicate) found.add(row);
                break;
            }
        }
        return found;
    }

    /** Bring Kakao to the foreground, launching it if it is dead/backgrounded. Does
     *  NOT press BACK or touch 더보기/설정 — the caller then goes straight to 검색 on the
     *  main screen. If already showing a Kakao window, leaves it as-is. */
    private void launchKakao() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root != null && PKG.contentEquals(String.valueOf(root.getPackageName()))) return;
        android.content.Intent launch = getPackageManager().getLaunchIntentForPackage(PKG);
        if (launch != null) { launch.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK); startActivity(launch); }
    }

    /** Diagnostic: package and the first few labels of the foreground window. */
    private String screenBrief() {
        try {
            AccessibilityNodeInfo root = getRootInActiveWindow();
            if (root == null) return "no_root";
            StringBuilder b = new StringBuilder(String.valueOf(root.getPackageName())).append(" |");
            int n = 0;
            for (AccessibilityNodeInfo x : walk(root, null)) {
                String t = !textOf(x).isEmpty() ? textOf(x) : descOf(x);
                if (t.isEmpty()) continue;
                b.append(' ').append(t.length() > 24 ? t.substring(0, 24) : t).append(';');
                if (++n >= 40) break;
            }
            return b.toString();
        } catch (Exception e) { return "brief_failed"; }
    }

    /** Back out of any chat/overlay until the Kakao main tabs are visible. */
    private void toMain() {
        boolean pressedBack = false;
        int backs = 0;
        StringBuilder trace = new StringBuilder();
        try { if (stageTrace != null) stageTrace.put("to_main_trace", ""); } catch (Exception ignored) {}
        for (int i = 0; i < 12; i++) {
            try { if (stageTrace != null) stageTrace.put("to_main_trace", trace.toString()); } catch (Exception ignored) {}
            AccessibilityNodeInfo root = getRootInActiveWindow();
            if (root != null && PKG.contentEquals(String.valueOf(root.getPackageName()))
                && !walk(root, n -> startsWith(descOf(n), MORE_TAB)).isEmpty()) return;
            // BACK is not getting us anywhere (an odd screen such as a Kakao Channel room swallows it, or the app was left):
            // after a few presses restart Kakao on a clean stack rather than pressing BACK until the phone is on its home screen.
            boolean stuck = backs >= 4;
            if (stuck || root == null || !PKG.contentEquals(String.valueOf(root.getPackageName()))) {
                android.content.Intent launch = getPackageManager().getLaunchIntentForPackage(PKG);
                if (launch != null) {
                    launch.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                    // BACK took us out of Kakao and a plain launch just resumed the same odd screen
                    // (e.g. a Kakao Channel room opened from search, where BACK exits the app): start from a clean stack
                    // so we land on the main tabs instead of looping BACK/relaunch until the phone is on its home screen.
                    if (pressedBack || stuck) launch.addFlags(android.content.Intent.FLAG_ACTIVITY_CLEAR_TASK);
                    pressedBack = false; backs = 0; trace.append("R");
                    startActivity(launch);
                    // Cold start (phone idle/backgrounded): Kakao's splash can take
                    // several seconds. Poll for the main tabs — returns the instant
                    // they render — instead of a fixed short wait, so the very first
                    // send after idle still reaches main (was kakao_main_unavailable).
                    if (waitNode(n -> startsWith(descOf(n), MORE_TAB), 6000) != null) return;
                    continue;
                }
            }
            performGlobalAction(GLOBAL_ACTION_BACK);
            pressedBack = true; backs++; trace.append("B");
            // One BACK can already land on the main tabs (e.g. a Kakao Channel room); a second BACK there would leave the
            // app. So give the tabs a moment to show up and stop the instant they do instead of pressing BACK again.
            if (waitNode(n -> startsWith(descOf(n), MORE_TAB), backs >= 2 ? 900 : 450) != null) return;
        }
        try { if (stageTrace != null) stageTrace.put("to_main_trace", trace.toString() + "|end"); } catch (Exception ignored) {}
    }

    // ---- identity / fingerprint (on-device, self-consistent) ---------------
    /** Mirrors adb_bridge.py profile_fingerprint(): every text/content-desc that
     *  is not a bare UUID, in traversal order, hashed. Computed on-device for
     *  both inspect and send so the two always agree. */
    private String fingerprint(AccessibilityNodeInfo root) throws Exception {
        JSONArray evidence = new JSONArray();
        for (AccessibilityNodeInfo n : walk(root, null)) {
            CharSequence cs = n.getText() != null ? n.getText() : n.getContentDescription();
            if (cs == null) continue;
            String text = cs.toString();
            if (text.isEmpty() || text.matches("[0-9a-f-]{36}")) continue;
            evidence.put(text);
        }
        return sha256hex(evidence.toString());
    }

    private static String sha256hex(String value) throws Exception {
        byte[] d = MessageDigest.getInstance("SHA-256").digest(value.getBytes("UTF-8"));
        StringBuilder out = new StringBuilder();
        for (byte b : d) out.append(String.format("%02x", b & 255));
        return out.toString();
    }

    // ---- node primitives ---------------------------------------------------
    private List<AccessibilityNodeInfo> walk(AccessibilityNodeInfo root, java.util.function.Predicate<AccessibilityNodeInfo> match) {
        List<AccessibilityNodeInfo> out = new ArrayList<>();
        ArrayDeque<AccessibilityNodeInfo> todo = new ArrayDeque<>();
        todo.add(root);
        int guard = 0;
        while (!todo.isEmpty() && guard < 5000) {
            AccessibilityNodeInfo node = todo.removeFirst();
            guard++;
            if (node == null) continue;
            if (match == null || match.test(node)) out.add(node);
            for (int i = 0; i < node.getChildCount(); i++) {
                AccessibilityNodeInfo child = node.getChild(i);
                if (child != null) todo.addLast(child);
            }
        }
        return out;
    }

    private AccessibilityNodeInfo first(AccessibilityNodeInfo root, java.util.function.Predicate<AccessibilityNodeInfo> match) {
        List<AccessibilityNodeInfo> hits = walk(root, match);
        return hits.isEmpty() ? null : hits.get(0);
    }

    private AccessibilityNodeInfo waitNode(java.util.function.Predicate<AccessibilityNodeInfo> match, int timeoutMs) {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        do {
            AccessibilityNodeInfo root = getRootInActiveWindow();
            if (root != null && PKG.contentEquals(String.valueOf(root.getPackageName()))) {
                AccessibilityNodeInfo hit = first(root, match);
                if (hit != null) return hit;
            }
            waitMs(POLL_MS);
        } while (SystemClock.uptimeMillis() < deadline);
        return null;
    }

    private boolean waitUntil(java.util.function.BooleanSupplier condition, int timeoutMs) {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        do {
            if (condition.getAsBoolean()) return true;
            waitMs(POLL_MS);
        } while (SystemClock.uptimeMillis() < deadline);
        return false;
    }

    // Kakao's custom views often report clickable=true but ignore the
    // accessibility ACTION_CLICK; only a real touch drives them. Tap by
    // coordinates via a short gesture, mirroring the adb_bridge `input tap`.
    private boolean click(AccessibilityNodeInfo node) {
        Rect r = new Rect();
        node.getBoundsInScreen(r);
        if (r.width() <= 0 || r.height() <= 0) return false;
        return tapAt(r.centerX(), r.centerY());
    }

    private boolean tapAt(int x, int y) {
        Path path = new Path();
        path.moveTo(x, y);
        GestureDescription gesture = new GestureDescription.Builder()
            .addStroke(new GestureDescription.StrokeDescription(path, 0, 50)).build();
        return dispatchBlocking(gesture);
    }

    private boolean setText(AccessibilityNodeInfo node, String text) {
        Bundle args = new Bundle();
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
        node.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
        return node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
    }

    /** Scroll a list by an exact distance WITHOUT the post-release fling: drag, hold still for a moment, release.
     *  A plain swipe keeps gliding after release, which made page-by-page reads skip rows. */
    private void dragNoFling(int x, int fromY, int toY) {
        Path move = new Path();
        move.moveTo(x, fromY);
        move.lineTo(x, toY);
        GestureDescription.StrokeDescription first = new GestureDescription.StrokeDescription(move, 0, 420, true);
        if (!dispatchBlocking(new GestureDescription.Builder().addStroke(first).build())) return;
        Path stay = new Path();
        stay.moveTo(x, toY);
        dispatchBlocking(new GestureDescription.Builder().addStroke(first.continueStroke(stay, 0, 160, false)).build());
    }

    /** Finger moves UP by {fraction} of the screen height (list content scrolls forward). */
    private void scrollForward(double fraction) {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        Rect r = new Rect();
        if (root != null) root.getBoundsInScreen(r);
        int h = r.height() > 0 ? r.height() : 2400;
        int x = r.width() > 0 ? r.centerX() : 540;
        int from = r.top + (int) (h * 0.78);
        dragNoFling(x, from, from - (int) (h * fraction));
    }

    /** Finger moves DOWN by {fraction} of the screen height (list content scrolls back toward the top). */
    private void scrollBackward(double fraction) {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        Rect r = new Rect();
        if (root != null) root.getBoundsInScreen(r);
        int h = r.height() > 0 ? r.height() : 2400;
        int x = r.width() > 0 ? r.centerX() : 540;
        int from = r.top + (int) (h * 0.32);
        dragNoFling(x, from, from + (int) (h * fraction));
    }

    private void swipeUp() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        Rect r = new Rect();
        if (root != null) root.getBoundsInScreen(r);
        int w = r.width() > 0 ? r.centerX() : 540;
        int top = r.height() > 0 ? r.top + (int) (r.height() * 0.30) : 500;
        int bottom = r.height() > 0 ? r.top + (int) (r.height() * 0.78) : 1800;
        Path path = new Path();
        path.moveTo(w, bottom);
        path.lineTo(w, top);
        GestureDescription gesture = new GestureDescription.Builder()
            .addStroke(new GestureDescription.StrokeDescription(path, 0, 250)).build();
        dispatchBlocking(gesture);
    }

    private void swipeDown() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        Rect r = new Rect();
        if (root != null) root.getBoundsInScreen(r);
        int x = r.width() > 0 ? r.centerX() : 540;
        int top = r.height() > 0 ? r.top + (int) (r.height() * 0.30) : 500;
        int bottom = r.height() > 0 ? r.top + (int) (r.height() * 0.78) : 1800;
        Path path = new Path();
        path.moveTo(x, top);
        path.lineTo(x, bottom);
        GestureDescription gesture = new GestureDescription.Builder()
            .addStroke(new GestureDescription.StrokeDescription(path, 0, 180)).build();
        dispatchBlocking(gesture);
    }

    private void swipeFriends() {          // friend list: about 5 rows forward, no fling
        scrollForward(0.40);
    }

    /** Small step back toward the top after a swipe overshot and skipped rows. */
    private void swipeFriendsBack() {      // small step back after an overshoot
        scrollBackward(0.10);
    }

    /** Signature of the friend LIST only (recycler_view), ignoring banners/ads around it. */
    private String friendPageSignature(AccessibilityNodeInfo root) {
        AccessibilityNodeInfo list = first(root, n -> "com.kakao.talk:id/recycler_view".equals(n.getViewIdResourceName()));
        return signature(list != null ? list : root);
    }

    /** ABSOLUTE SAFETY GUARD (사용자 지시: 통화 오는 거 절대 받으면 안 됨): every gesture this
     *  service ever dispatches — tap, long-press, AND swipe — funnels through here, so this is
     *  the one place that can guarantee none of them ever touch a live incoming call. A real
     *  phone call (carrier/dialer — a DIFFERENT package: com.android.server.telecom /
     *  com.samsung.android.incallui / com.google.android.dialer / etc., not com.kakao.talk) can
     *  take over the foreground as a full-screen activity at any moment, including one that
     *  answers via a SWIPE (slide-to-answer), not just a tap — so taps alone weren't enough.
     *  If the foreground is confirmed non-Kakao, refuse the gesture outright: never tap, never
     *  swipe, never attempt to answer OR reject it automatically — freeze and let a human handle
     *  the phone. A transient null root (mid Kakao-transition) is allowed through; only a
     *  DEFINITELY non-Kakao foreground blocks every gesture. */
    private void refuseIfNotKakaoForeground() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        CharSequence pkg = root == null ? null : root.getPackageName();
        if (pkg != null && !PKG.contentEquals(pkg)) throw new Blocked("foreign_foreground_tap_refused");
    }

    private boolean dispatchBlocking(GestureDescription gesture) {
        refuseIfNotKakaoForeground();
        final CountDownLatch latch = new CountDownLatch(1);
        final boolean[] ok = {false};
        boolean dispatched = dispatchGesture(gesture, new GestureResultCallback() {
            @Override public void onCompleted(GestureDescription g) { ok[0] = true; latch.countDown(); }
            @Override public void onCancelled(GestureDescription g) { latch.countDown(); }
        }, null);
        if (!dispatched) return false;
        try { latch.await(1500, TimeUnit.MILLISECONDS); } catch (InterruptedException ignored) {}
        return ok[0];
    }

    // ---- all-window finders ------------------------------------------------
    // When the soft keyboard is up Kakao splits the activity so getRootInActiveWindow
    // no longer contains the chat toolbar + message input. Scanning every Kakao
    // window with getWindows() finds the input/전송 regardless of keyboard state.
    // During a send we are always inside a chat (no finder search field present),
    // so the chat's EditText is the message input.
    private List<AccessibilityNodeInfo> kakaoRoots() {
        List<AccessibilityNodeInfo> roots = new ArrayList<>();
        // 2026-10-05 실측 확정 버그: 패키지 검증 없이 getRootInActiveWindow()를 그대로 roots.get(0)에
        // 넣고 있었는데, 가끔 "활성 창"이 카카오가 아닌 다른 창(예: 전체 디스플레이 높이를 그대로
        // 보고하는 시스템 창, 실측 h=2400 vs 정상 카카오 창 h=2195)이 되는 경우가 있다.
        // currentOneToOneTitle()이 roots.get(0)의 bounds로 "화면 높이"를 계산해 하단 절반 여부를
        // 판정하는데, 이 잘못된 높이 때문에 분명히 하단에 있는 EditText도 input=false로 틀리게
        // 판정되어 title=장효재인데도 null을 반환하는 실패가 재현됨(로그로 확인).
        AccessibilityNodeInfo active = getRootInActiveWindow();
        if (active != null && PKG.contentEquals(String.valueOf(active.getPackageName()))) roots.add(active);
        try {
            List<AccessibilityWindowInfo> ws = getWindows();
            if (ws != null) for (AccessibilityWindowInfo w : ws) {
                AccessibilityNodeInfo r = w.getRoot();
                if (r != null && PKG.contentEquals(String.valueOf(r.getPackageName())) && !roots.contains(r)) roots.add(r);
            }
        } catch (Exception ignored) {}
        return roots;
    }

    private AccessibilityNodeInfo findChatInput() {
        AccessibilityNodeInfo a = first(getRootInActiveWindow(), this::isChatInput);   // keyboard-down (fresh room)
        if (a != null) return a;
        for (AccessibilityNodeInfo r : kakaoRoots()) {                                  // keyboard-up (held room)
            AccessibilityNodeInfo e = first(r, this::isEditField);
            if (e != null) return e;
        }
        return null;
    }

    private AccessibilityNodeInfo waitChatInput(int timeoutMs) {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        do { AccessibilityNodeInfo e = findChatInput(); if (e != null) return e; waitMs(POLL_MS); }
        while (SystemClock.uptimeMillis() < deadline);
        return null;
    }

    private boolean imeVisible() {
        try {
            List<AccessibilityWindowInfo> ws = getWindows();
            if (ws != null) for (AccessibilityWindowInfo w : ws)
                if (w.getType() == AccessibilityWindowInfo.TYPE_INPUT_METHOD) return true;
        } catch (Exception ignored) {}
        return false;
    }

    /** 전송 button whose bounds stayed identical for 500ms with the keyboard showing (or, when no
     *  keyboard window is reported, for 1.2s). Null if it never settles; the caller then clears
     *  the draft and aborts without tapping anything. */
    private AccessibilityNodeInfo waitStableSendButton(int timeoutMs) {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        Rect last = null;
        long since = 0;
        while (SystemClock.uptimeMillis() < deadline) {
            AccessibilityNodeInfo b = null;
            for (AccessibilityNodeInfo r : kakaoRoots()) {
                b = first(r, n -> SEND_LABEL.contentEquals(descOf(n))
                    && "android.widget.Button".contentEquals(String.valueOf(n.getClassName())) && visible(n));
                if (b != null) break;
            }
            long now = SystemClock.uptimeMillis();
            if (b != null) {
                Rect rect = new Rect(); b.getBoundsInScreen(rect);
                if (last != null && last.equals(rect)) {
                    long quiet = now - since;
                    if (quiet >= 500 && (imeVisible() || quiet >= 1200)) return b;
                } else { last = rect; since = now; }
            } else { last = null; }
            waitMs(100);
        }
        return null;
    }

    private AccessibilityNodeInfo waitSendButton(int timeoutMs) {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        do {
            for (AccessibilityNodeInfo r : kakaoRoots()) {
                AccessibilityNodeInfo b = first(r, n -> SEND_LABEL.contentEquals(descOf(n))
                    && "android.widget.Button".contentEquals(String.valueOf(n.getClassName())) && visible(n));
                if (b != null) return b;
            }
            waitMs(POLL_MS);
        } while (SystemClock.uptimeMillis() < deadline);
        return null;
    }

    // ---- bubble / field helpers -------------------------------------------
    private boolean isSearchField(AccessibilityNodeInfo n) {
        // The finder's search EditText is initially an off-screen focus proxy, so
        // isVisibleToUser can be false intermittently — do NOT require it. Match a
        // wide EditText in the UPPER half (the finder search box, never the chat
        // message input which sits in the lower half). ACTION_SET_TEXT works even
        // when the node is a proxy.
        if (!EDIT_CLASS.contentEquals(String.valueOf(n.getClassName()))) return false;
        AccessibilityNodeInfo root = getRootInActiveWindow();
        Rect screen = new Rect(); if (root != null) root.getBoundsInScreen(screen);
        int h = screen.height() > 0 ? screen.height() : 2340;
        Rect r = new Rect(); n.getBoundsInScreen(r);
        return r.width() >= 200 && r.top < screen.top + h / 2;
    }

    private boolean isEditField(AccessibilityNodeInfo n) {
        return EDIT_CLASS.contentEquals(String.valueOf(n.getClassName())) && visible(n);
    }

    /** The chat toolbar shows the room name as a TextView content-desc. Identity
     *  was already proven by the profile fingerprint before opening the chat;
     *  this is a defense-in-depth check that we are in the right room. */
    private boolean titlePresent(String name) {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        return root != null && first(root, n -> name.contentEquals(descOf(n)) && visible(n)) != null;
    }

    private int maxRight(AccessibilityNodeInfo root) {
        int max = 0;
        if (root == null) return 1;
        for (AccessibilityNodeInfo n : walk(root, null)) {
            Rect r = new Rect(); n.getBoundsInScreen(r);
            if (r.right > max) max = r.right;
        }
        return max > 0 ? max : 1;
    }

    private int countOutgoing(AccessibilityNodeInfo root, String text, int width) {
        if (root == null) return 0;
        int count = 0;
        for (AccessibilityNodeInfo n : walk(root, null)) {
            if (isEditField(n)) continue;                       // the input, not a bubble
            if (n.getText() == null || !text.contentEquals(n.getText())) continue;
            Rect r = new Rect(); n.getBoundsInScreen(r);
            if (r.width() > 0 && r.centerX() > width / 2) count++;   // right side = outgoing
        }
        return count;
    }

    private boolean hasFailure(AccessibilityNodeInfo root) {
        for (AccessibilityNodeInfo n : walk(root, null)) {
            String d = descOf(n);
            if (d != null && (d.contains("재전송") || d.contains("전송 실패"))) return true;
        }
        return false;
    }

    // ---- small utilities ---------------------------------------------------
    private static String textOf(AccessibilityNodeInfo n) { CharSequence c = n.getText(); return c == null ? "" : c.toString(); }
    private static String descOf(AccessibilityNodeInfo n) { CharSequence c = n.getContentDescription(); return c == null ? "" : c.toString(); }
    private static boolean startsWith(String value, String prefix) { return value != null && value.startsWith(prefix); }
    private static boolean visible(AccessibilityNodeInfo n) {
        if (!Boolean.TRUE.equals(n.isVisibleToUser())) return false;
        Rect r = new Rect(); n.getBoundsInScreen(r);
        return r.width() > 0 && r.height() > 0;
    }
    private String signature(AccessibilityNodeInfo root) {
        StringBuilder sb = new StringBuilder();
        for (AccessibilityNodeInfo n : walk(root, FastProbeAccessibilityService::visible)) sb.append(descOf(n)).append('').append(textOf(n)).append('\n');
        return sb.toString();
    }
    private static double ms(long startNanos) { return (SystemClock.elapsedRealtimeNanos() - startNanos) / 1000000.0; }
    private static void waitMs(long millis) { try { Thread.sleep(millis); } catch (InterruptedException ignored) {} }
}
