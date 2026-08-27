export const DAILY_TABLE_COLUMNS = [
  { key: 'product_name', label: '상품명' },
  { key: 'client', label: '거래처' },
  { key: 'client_product_name', label: '거래처상품명' },
  { key: 'yusas_code', label: '상품코드' },
  { key: 'stock_qty', label: '재고', numeric: true },
  { key: 'expected_sales_today', label: '예상판매량', numeric: true, decimals: 1 },
  { key: 'incoming_qty', label: '미송', numeric: true },
  { key: 'ezadmin_lack_qty', label: '요청수량', numeric: true },
  { key: 'ezadmin_real_lack_qty', label: '부족수량', numeric: true },
  { key: 'coverage_days_used', label: '커버리지' },
  { key: 'recommended_qty', label: '추천발주량', numeric: true },
];

// 텍스트 열(상품명~상품코드) 개수. 합계 행에서 첫 셀을 이만큼 colSpan으로 합친다.
export const DAILY_TABLE_LABEL_COLUMN_COUNT = 4;
