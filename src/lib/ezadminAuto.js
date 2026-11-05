// 크롬 확장(chrome-ezadmin-session)이 설치돼 있으면 로그인된 이지어드민의 PHPSESSID를 받아온다.
// 확장이 없거나 응답이 없으면 null (조용히 무시 → 기존 수동 입력 방식 그대로).
export function requestEzadminSessionFromExtension(timeoutMs = 1500) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; window.removeEventListener("message", onMsg); clearTimeout(timer); resolve(v); };
    const onMsg = (event) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      if (event.data?.type !== "YUSAEK_EZ_SESSION_RESULT") return;
      finish(event.data.ok && event.data.phpsessid ? event.data.phpsessid : { error: event.data.error || "" });
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    window.addEventListener("message", onMsg);
    window.postMessage({ type: "YUSAEK_EZ_GET_SESSION" }, window.location.origin);
  });
}
