// 우리 페이지(위 matches 주소)와 확장 사이의 다리. 페이지 자신이 보낸 요청에만 반응한다.
window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  if (!event.data || event.data.type !== "YUSAEK_EZ_GET_SESSION") return;
  chrome.runtime.sendMessage({ type: "GET_EZ_PHPSESSID" }, (res) => {
    const err = chrome.runtime.lastError;
    window.postMessage(
      { type: "YUSAEK_EZ_SESSION_RESULT", ok: !err && !!res?.ok, phpsessid: res?.phpsessid || "", error: err?.message || res?.error || "" },
      window.location.origin
    );
  });
});
