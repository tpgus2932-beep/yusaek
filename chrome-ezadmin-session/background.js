// ga80.ezadmin.co.kr 의 PHPSESSID 쿠키 하나만 읽는다. 저장하지 않고 요청한 페이지에 돌려주기만 한다.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "GET_EZ_PHPSESSID") return false;
  chrome.cookies.get({ url: "https://ga80.ezadmin.co.kr/", name: "PHPSESSID" }, (cookie) => {
    if (cookie?.value) sendResponse({ ok: true, phpsessid: cookie.value });
    else sendResponse({ ok: false, error: "이지어드민에 로그인된 PHPSESSID가 없습니다." });
  });
  return true; // 비동기 응답
});
