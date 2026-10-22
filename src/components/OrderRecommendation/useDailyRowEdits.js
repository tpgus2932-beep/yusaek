import { useCallback, useState } from 'react';
import { LOCAL_API_BASE as API, getAuthHeaders, handleUnauthorized } from '../../lib/api';

function defaultConfirmedQty(item) {
  return item.confirmed_qty ?? '';
}

// 일별 데이터 / 추가된 상품 / 엑셀주문 테이블의 확정수량·사유 편집 상태를 공유하는 훅.
// 값은 부모가 들고 있고(DailyTableRow는 controlled), 개별 "저장" 버튼과
// 상단 "일괄저장" 버튼이 같은 편집 상태를 공유한다.
// initialConfirmedQty: 아직 값을 안 건드린 항목의 확정수량 표시값을 정하는 함수
// (엑셀주문 탭은 확정수량이 비어있으면 추천발주량을 기본값으로 보여준다).
export function useDailyRowEdits(date, initialConfirmedQty = defaultConfirmedQty) {
  const fieldsFromItem = useCallback(
    (item) => ({
      confirmedQty: initialConfirmedQty(item),
      reason: item.override_reason ?? '',
    }),
    [initialConfirmedQty]
  );

  const [values, setValues] = useState({});
  const [saved, setSaved] = useState({});
  const [rowSaving, setRowSaving] = useState(() => new Set());
  const [rowMessages, setRowMessages] = useState({});
  const [savingAll, setSavingAll] = useState(false);
  const [bulkMessage, setBulkMessage] = useState('');

  const getFields = useCallback(
    (item) => values[item.yusas_code] || fieldsFromItem(item),
    [values, fieldsFromItem]
  );

  const setField = useCallback((item, field, value) => {
    setValues((prev) => ({
      ...prev,
      [item.yusas_code]: { ...(prev[item.yusas_code] || fieldsFromItem(item)), [field]: value },
    }));
  }, [fieldsFromItem]);

  // items 전체의 확정수량을 compute(item, 현재 확정수량 필드값)가 돌려준 값으로 한 번에 바꾼다.
  // 서버에 저장하지는 않고 편집 상태만 바꾼다 — 이후 "일괄저장"으로 저장한다.
  const setConfirmedQtyForAll = useCallback((items, compute) => {
    setValues((prev) => {
      const next = { ...prev };
      items.forEach((item) => {
        const current = prev[item.yusas_code] || fieldsFromItem(item);
        const qty = compute(item, current.confirmedQty);
        next[item.yusas_code] = { ...current, confirmedQty: qty == null ? '' : String(qty) };
      });
      return next;
    });
  }, [fieldsFromItem]);

  const isDirty = useCallback(
    (item) => {
      const current = values[item.yusas_code];
      if (!current) return false;
      const baseline = saved[item.yusas_code] || fieldsFromItem(item);
      return String(current.confirmedQty) !== String(baseline.confirmedQty) || current.reason !== baseline.reason;
    },
    [values, saved, fieldsFromItem]
  );

  const markSaved = useCallback(
    (item) => {
      // 확정수량을 비워두고 저장하면 0으로 저장되므로 화면에도 0으로 맞춘다.
      const fields = getFields(item);
      const normalized = fields.confirmedQty === '' ? { ...fields, confirmedQty: '0' } : fields;
      setValues((prev) => ({ ...prev, [item.yusas_code]: normalized }));
      setSaved((prev) => ({ ...prev, [item.yusas_code]: normalized }));
    },
    [getFields]
  );

  const buildPayload = useCallback(
    (item) => {
      const fields = getFields(item);
      return {
        yusas_code: item.yusas_code,
        confirmed_qty: fields.confirmedQty === '' ? 0 : Number(fields.confirmedQty),
        override_reason: fields.reason || null,
      };
    },
    [getFields]
  );

  const saveOne = useCallback(
    async (item) => {
      setRowSaving((prev) => new Set(prev).add(item.yusas_code));
      setRowMessages((prev) => ({ ...prev, [item.yusas_code]: '' }));
      try {
        const payload = buildPayload(item);
        const res = await fetch(`${API}/order-recommendation/${date}/${item.yusas_code}/confirm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          body: JSON.stringify({ confirmed_qty: payload.confirmed_qty, override_reason: payload.override_reason }),
        });
        if (handleUnauthorized(res)) return;
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.ok === false) throw new Error(data?.detail || '저장 실패');
        markSaved(item);
        setRowMessages((prev) => ({ ...prev, [item.yusas_code]: '저장됨' }));
      } catch (err) {
        setRowMessages((prev) => ({ ...prev, [item.yusas_code]: err.message || '저장 실패' }));
      } finally {
        setRowSaving((prev) => {
          const next = new Set(prev);
          next.delete(item.yusas_code);
          return next;
        });
      }
    },
    [buildPayload, date, markSaved]
  );

  const saveAll = useCallback(
    async (items) => {
      const dirtyItems = items.filter(isDirty);
      if (dirtyItems.length === 0) return;
      setSavingAll(true);
      setBulkMessage('');
      try {
        const payloadItems = dirtyItems.map(buildPayload);
        const res = await fetch(`${API}/order-recommendation/${date}/confirm-batch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          body: JSON.stringify({ items: payloadItems }),
        });
        if (handleUnauthorized(res)) return;
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.ok === false) throw new Error(data?.detail || '일괄저장 실패');
        dirtyItems.forEach(markSaved);
        setBulkMessage(`일괄저장 완료 (${dirtyItems.length}건)`);
      } catch (err) {
        setBulkMessage(err.message || '일괄저장 실패');
      } finally {
        setSavingAll(false);
      }
    },
    [buildPayload, date, isDirty, markSaved]
  );

  const dirtyCount = useCallback((items) => items.filter(isDirty).length, [isDirty]);

  return {
    getFields,
    setField,
    setConfirmedQtyForAll,
    isDirty,
    dirtyCount,
    saveOne,
    saveAll,
    isRowSaving: (item) => rowSaving.has(item.yusas_code),
    rowMessage: (item) => rowMessages[item.yusas_code] || '',
    savingAll,
    bulkMessage,
  };
}
