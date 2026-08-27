// 표 하단 합계 행에서 쓰는 숫자 합산/포맷 유틸.
export function sumValues(items, getValue) {
  return (items || []).reduce((acc, item) => {
    const v = getValue(item);
    const n = Number(v);
    return v == null || v === '' || Number.isNaN(n) ? acc : acc + n;
  }, 0);
}

export function formatSum(sum, decimals = 0) {
  return sum.toLocaleString('ko-KR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}
