import { LOCAL_API_BASE, getAuthHeaders } from './api';

// 라벨 거래처 관리(간단입고)에 등록된 접두어(R/K/L 등)와 (거래처상품명)을 상품코드 기준으로 라벨에 붙인다.
// 라벨을 출력하는 모든 화면이 같은 규칙을 쓰도록 출력 직전에 한 번 거치게 한다.
// 조회에 실패하면 원본 라벨 그대로 돌려줘서 출력 자체는 막지 않는다.
// 대형 번호(1~5)가 있는 상품은 라벨 상품명 맨 앞에 "2 상품명"처럼 번호를 붙인다.
// 이미 같은 번호로 시작하는 이름(이지어드민 상품명 그대로)이면 중복해서 붙이지 않는다.
export function withBigNumber(title, number) {
  const n = Number(number) || 0;
  const t = String(title || '');
  if (!n || /^\d+\s/.test(t)) return t;
  return `${n} ${t}`;
}

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
      // EZAdmin 상품명을 그대로 쓰는 라벨은 이미 일괄변경 접두어(AA 등)가 붙어 있을 수 있어 중복해서 붙이지 않는다.
      const hasPrefix = l.alreadyPrefixed || String(l.title || '').startsWith(`${dec.prefix} `);
      const prefixed = dec.prefix && !hasPrefix ? `${dec.prefix} ${l.title}` : l.title;
      const title = withBigNumber(prefixed, dec.bigNumber);
      return { ...l, title, clientLine: l.clientLine || dec.clientLine || '' };
    });
  } catch {
    return labels;
  }
}
