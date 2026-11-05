// SO+ 매입차감 계산 (노예김승일 applyPurchaseDeductionCap 과 같은 규칙)
// 입고요청전표의 요청메모가 음수 숫자(-50050)면 매입차감 금액. 거래처 상품금액(+부가세)을 넘는 차감은 잘라내고 남는 금액을 따로 둔다.
export const VAT_RATE = 0.1;

// supplyAmt: 거래처 공급가(입고+미송 금액 합), vat: 부가세 거래처 여부, items: 항목들(deduct 는 음수)
export function clientDeduction(items, supplyAmt, vat) {
  const raw = -(items || []).reduce((s, i) => s + (Number(i.deduct) || 0), 0); // 양수
  const vatAmt = vat ? Math.round(supplyAmt * VAT_RATE) : 0;
  const budget = Math.max(0, supplyAmt + vatAmt);
  const applied = Math.min(Math.max(raw, 0), budget);
  return { raw, applied, leftover: Math.max(raw, 0) - applied, vatAmt };
}
