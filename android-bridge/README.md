# 안드로이드 브리지 앱 (YUSAEK TALK, 폰의 카카오톡 자동화)

카카오톡 전송·대화 읽기를 폰에서 대신 하는 접근성 앱입니다. 서버(`backend/services/kakao_phone.py`, `kakao_adb_bridge.py`)가 ADB로 이 앱에 명령을 보냅니다.

## 폴더
- `android-source/` : 앱 소스 (핵심: `src/com/yusaek/talkbridge/FastProbeAccessibilityService.java`)
- `keys/yusaek.jks` : **서명키** (비밀번호 `android`, 별칭 `yusaek-talk`). 폰에 깔린 앱이 이 키로 서명돼 있어서,
  같은 키로 빌드해야 앱을 지우지 않고 `install -r`로 덮어쓸 수 있다. **분실하면 앱을 지우고 다시 설치해야 한다.**
- `backup-apk/` : 폰에 깔려 있던 v2.2.1(versionCode 43) APK 백업 (문제가 생기면 `adb install -r`로 되돌린다)
- 위 두 폴더(`keys`, `backup-apk`)와 `build/`, `dist/`는 `.gitignore`로 제외돼 있다. 저장소가 공개(public)라서 키를 올리면 안 된다.
  OneDrive 말고 다른 곳에도 `keys/yusaek.jks`를 한 부 더 보관해 두세요.

## 빌드 도구 (프로젝트 밖)
`C:\Users\ksh29\AndroidBuild\` 에 JDK 17(`jdk\jdk-17.0.20.1+1`), Android SDK(`sdk`, android-35 / build-tools 35.0.0), adb(`work\platform-tools`)가 있다.
없어지면 다시 받으면 된다 (소스와 키만 있으면 됨).

## 빌드 + 설치
```powershell
$p = 'C:\Users\ksh29\OneDrive\Desktop\yusaek-main - 복사본\yusaek-main\android-bridge'
$b = 'C:\Users\ksh29\AndroidBuild'
& "$p\android-source\build.ps1" -Sdk "$b\sdk" -Jdk "$b\jdk\jdk-17.0.20.1+1" -SigningKey "$p\keys\yusaek.jks"
& "$b\work\platform-tools\adb.exe" -s <기기번호> install -r "$p\android-source\dist\YusaekTalkBridge.apk"
```
- 수정할 때는 `AndroidManifest.xml`의 `versionCode`/`versionName`을 올린다 (현재 44 / 2.3.0).
- 설치 뒤 `settings get secure enabled_accessibility_services`에 앱이 남아 있는지 확인한다. 빠졌으면 폰에서 접근성을 다시 켠다.

## 변경 이력
- 2.3.0 (2026-11-11): 단톡방 전송. `send`/`room_peek`/`share_pick`에 `group` 옵션 추가. 정확히 일치하는 단톡방이 하나일 때만 동작하고, 아니면 `group_room_unavailable`/`share_target_*`로 중단한다 (1:1 친구로 대체하지 않음).
- 2.2.1: 기존 버전 (backup-apk 참고)
