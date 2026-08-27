import { useCallback, useState } from 'react';
import { LOCAL_API_BASE as API, getAuthHeaders } from '../../lib/api';

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
      setSaved((prev) => ({ ...prev, [item.yusas_code]: getFields(item) }));
    },
    [getFields]
  );

  const buildPayload = useCallback(
    (item) => {
      const fields = getFields(item);
      return {
        yusas_code: item.yusas_code,
        confirmed_qty: fields.confirmedQty === '' ? null : Number(fields.confirmedQty),
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
