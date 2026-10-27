import { LOCAL_API_BASE, getAuthHeaders } from './api';

// 라벨 거래처 관리(간단입고)에 등록된 접두어(R/K/L 등)와 (거래처상품명)을 상품코드 기준으로 라벨에 붙인다.
// 라벨을 출력하는 모든 화면이 같은 규칙을 쓰도록 출력 직전에 한 번 거치게 한다.
// 조회에 실패하면 원본 라벨 그대로 돌려줘서 출력 자체는 막지 않는다.
export async function decorateLabels(labels) {
  const codes = [...new Set(labels.map((l) => l.code).filter(Boolean))];
  if (!codes.length) return labels;
  try {
    const res = await fetch(`${LOCAL_API_BASE}/order/label-decorations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ codes }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.ok) return labels;
    const decorations = data.decorations || {};
    return labels.map((l) => {
      const dec = decorations[l.code];
      if (!dec) return l;
      const title = dec.prefix && !l.alreadyPrefixed ? `${dec.prefix} ${l.title}` : l.title;
      return { ...l, title, clientLine: l.clientLine || dec.clientLine || '' };
    });
  } catch {
    return labels;
  }
}
