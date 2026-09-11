import { Fragment, memo, useCallback, useEffect, useMemo, useState } from 'react';
import styles from './OrderRecommendationDashboardPage.module.css';
import { LOCAL_API_BASE as API, getAuthHeaders } from '../../lib/api';
import { useEzadminSession } from '../../lib/EzadminSessionContext';

function yesterdayDateStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

// 현재고는 "그 시점의 실제 재고" 스냅샷이라 날짜 범위(판매기간)와 무관하다 —
// 새로고침하거나 기간을 바꿔도 사라지지 않고, 사용자가 다시 "현재고확인"을
// 눌러 명시적으로 갱신하기 전까지는 브라우저에 그대로 남아있게 localStorage에 둔다.
const STOCK_STORAGE_KEY = 'orderRecommendationSalesStatsStock';

function loadStoredStock() {
  try {
    const raw = localStorage.getItem(STOCK_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && parsed.stock ? parsed : null;
  } catch {
    return null;
  }
}

function saveStoredStock(stock, checkedAt) {
  try {
    localStorage.setItem(STOCK_STORAGE_KEY, JSON.stringify({ stock, checkedAt }));
  } catch {
    // 저장 실패(프라이빗 모드 등)해도 화면 표시엔 지장 없으니 무시
  }
}

// 판매기간이 길면 상품이 수천 건까지 나올 수 있는데, 그만큼 <tr>을 전부 DOM에
// 깔아두면 상품 하나 펼치는 클릭마다(React.memo로 막아도) 브라우저가 그 많은
// 행을 다시 훑어보느라 버벅인다 — 한 번에 이 개수만 그려서 DOM 크기를 고정한다.
const PAGE_SIZE = 100;

// 상품 하나(+펼쳐진 옵션 표)를 담당 — expanded/stockMap이 바뀌어도 이 상품과
// 무관하면 리렌더되지 않도록 memo로 감싼다. 상품 수가 많을 때 행 하나 펼치려고
// 클릭할 때마다 테이블 전체가 다시 그려지며 버벅이던 걸 막기 위함.
const SalesStatsRow = memo(function SalesStatsRow({ item, isOpen, stockByCode, onToggle }) {
  return (
    <Fragment>
      <tr className={styles.sortableTh} onClick={() => onToggle(item.product_name)}>
        <td>{item.rank}</td>
        <td>{isOpen ? '▼ ' : '▶ '}{item.product_name || '-'}</td>
        <td>{item.sales_qty}</td>
        <td>{item.cart_count}</td>
        <td>{item.options.length}</td>
      </tr>
      {isOpen && (
        <tr>
          <td></td>
          <td colSpan={4}>
            <table className={styles.dailyTable}>
              <thead>
                <tr>
                  <th>상품코드</th>
                  <th>옵션(상품명)</th>
                  <th>판매수량</th>
                  <th>장바구니수</th>
                  <th>현재고</th>
                </tr>
              </thead>
              <tbody>
                {item.options.map((opt) => (
                  <tr key={opt.yusas_code}>
                    <td>{opt.yusas_code}</td>
                    <td>{opt.option_name || '-'}</td>
                    <td>{opt.sales_qty}</td>
                    <td>{opt.cart_count}</td>
                    <td>
                      {stockByCode == null ? '미조회' : stockByCode[opt.yusas_code] ?? '조회안됨'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </Fragment>
  );
});

export default function OrderRecommendationSalesStatsSection() {
  const [startDate, setStartDate] = useState(yesterdayDateStr());
  const [endDate, setEndDate] = useState(yesterdayDateStr());
  const [dateRange, setDateRange] = useState(null); // {min_date, max_date} | null(로딩 전) — 실제 판매량이 수집된 날짜 범위
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState(null); // 펼쳐진 상품명 (1개만 펼침)
  const [page, setPage] = useState(1);
  const [stockMap, setStockMap] = useState(() => loadStoredStock()?.stock ?? null); // {상품코드: 재고수량} | null(아직 조회 안 함)
  const [stockCheckedAt, setStockCheckedAt] = useState(() => loadStoredStock()?.checkedAt ?? null);
  const [stockLoading, setStockLoading] = useState(false);
  const [stockError, setStockError] = useState('');
  const { openModal } = useEzadminSession();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API}/order-recommendation/sales-stats/date-range`, {
          headers: getAuthHeaders(),
        });
        const data = await res.json().catch(() => ({}));
        if (cancelled || !res.ok || !data.ok) return;
        setDateRange({ min_date: data.min_date, max_date: data.max_date });
        // 초기값(어제)이 실제 수집 범위 밖이면(백필 미완료/최근 수집 지연 등) 범위 안으로 당겨온다.
        const clamp = (d) => {
          if (data.min_date && d < data.min_date) return data.min_date;
          if (data.max_date && d > data.max_date) return data.max_date;
          return d;
        };
        setStartDate(clamp);
        setEndDate(clamp);
      } catch {
        // 조회 실패 시 날짜 제한 없이 진행
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (dateRange != null && !dateRange.min_date) return undefined;
    if (startDate > endDate) return undefined;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const params = new URLSearchParams({ start_date: startDate, end_date: endDate });
        const res = await fetch(`${API}/order-recommendation/sales-stats?${params}`, {
          headers: getAuthHeaders(),
        });
        const data = await res.json().catch(() => ({}));
        if (!cancelled && res.ok && data.ok) {
          setResult(data);
        }
      } catch {
        // 조회 실패 시 이전 결과 유지
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [startDate, endDate, dateRange]);

  const handleStartChange = (value) => {
    setStartDate(value);
    if (value > endDate) setEndDate(value);
  };

  const handleEndChange = (value) => {
    setEndDate(value);
    if (value < startDate) setStartDate(value);
  };

  const checkStock = useCallback(async () => {
    const codes = (result?.items || []).flatMap((item) => item.options.map((o) => o.yusas_code));
    if (codes.length === 0) return;
    setStockLoading(true);
    setStockError('');
    try {
      const res = await fetch(`${API}/order-recommendation/sales-stats/stock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ codes }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.need_session) {
        openModal(checkStock);
        setStockError('이지어드민 세션이 없습니다. 설정 후 다시 시도해주세요.');
        return;
      }
      if (!res.ok || data.ok === false) throw new Error(data?.detail || '재고 조회 실패');
      const stock = data.stock || {};
      const checkedAt = new Date().toISOString();
      setStockMap(stock);
      setStockCheckedAt(checkedAt);
      saveStoredStock(stock, checkedAt);
    } catch (err) {
      setStockError(err.message || '재고 조회 실패');
    } finally {
      setStockLoading(false);
    }
  }, [result, openModal]);

  const toggleExpanded = useCallback((name) => {
    setExpanded((prev) => (prev === name ? null : name));
  }, []);

  const term = search.trim();
  const items = useMemo(
    () => (result?.items || []).filter((i) => !term || (i.product_name || '').includes(term)),
    [result, term]
  );

  // 검색어/기간이 바뀌어 목록 자체가 달라지면 이전 페이지 번호가 범위 밖일 수 있으니 1페이지로.
  useEffect(() => {
    setPage(1);
  }, [items]);

  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const pageItems = useMemo(
    () => items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [items, page]
  );

  return (
    <div>
      <div className={styles.backtestControls}>
        <div className={styles.backtestField}>
          <label>시작일</label>
          <input
            type="date"
            className={styles.backtestDateInput}
            value={startDate}
            min={dateRange?.min_date || undefined}
            max={dateRange?.max_date || yesterdayDateStr()}
            disabled={dateRange != null && !dateRange.min_date}
            onChange={(e) => handleStartChange(e.target.value)}
          />
        </div>
        <div className={styles.backtestField}>
          <label>종료일</label>
          <input
            type="date"
            className={styles.backtestDateInput}
            value={endDate}
            min={dateRange?.min_date || undefined}
            max={dateRange?.max_date || yesterdayDateStr()}
            disabled={dateRange != null && !dateRange.min_date}
            onChange={(e) => handleEndChange(e.target.value)}
          />
          {dateRange != null && !dateRange.min_date && (
            <span className={styles.backtestSaveMsg}>
              선택 가능한 날짜가 없습니다 (판매량이 아직 수집되지 않았습니다)
            </span>
          )}
        </div>
        <div className={styles.backtestField}>
          <label>상품명 검색</label>
          <input
            type="text"
            className={styles.dailySearchInput}
            placeholder="상품명 검색"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className={styles.backtestField}>
          <label>&nbsp;</label>
          <button
            type="button"
            className={styles.backtestSaveBtn}
            onClick={checkStock}
            disabled={stockLoading || !result?.items?.length}
          >
            {stockLoading ? '재고 확인 중...' : '현재고확인'}
          </button>
          {stockError ? (
            <span className={styles.backtestSaveMsg}>{stockError}</span>
          ) : (
            stockCheckedAt && (
              <span className={styles.backtestSaveMsg}>
                마지막 확인: {new Date(stockCheckedAt).toLocaleString('ko-KR')} ({Object.keys(stockMap || {}).length}건)
              </span>
            )
          )}
        </div>
      </div>

      <div className={styles.dailyTableToolbar}>
        <span className={styles.dailyTableCount}>총 {items.length.toLocaleString()}건</span>
        <button
          type="button"
          className={styles.rowSaveBtn}
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          disabled={page <= 1}
        >
          이전
        </button>
        <span className={styles.dailyTableCount}>{page} / {totalPages} 페이지</span>
        <button
          type="button"
          className={styles.rowSaveBtn}
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          disabled={page >= totalPages}
        >
          다음
        </button>
      </div>

      <div className={styles.dailyTableScroll}>
        <table className={styles.dailyTable}>
          <thead>
            <tr>
              <th>순위</th>
              <th>상품명</th>
              <th>판매수량</th>
              <th>장바구니수</th>
              <th>옵션 수(상품코드)</th>
            </tr>
          </thead>
          <tbody>
            {pageItems.map((item) => (
              <SalesStatsRow
                key={item.product_name}
                item={item}
                isOpen={expanded === item.product_name}
                stockByCode={stockMap}
                onToggle={toggleExpanded}
              />
            ))}
            {!loading && items.length === 0 && (
              <tr>
                <td colSpan={5} className={styles.actionMessage}>
                  {result ? '데이터가 없습니다' : '불러오는 중...'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
