import { useEffect, useState } from 'react';
import styles from './OrderRecommendationDashboardPage.module.css';
import { LOCAL_API_BASE as API, getAuthHeaders } from '../../lib/api';

// 루나앤솔 양식(C열 상품명 + D열 옵션명)에서 행을 검색해 고르는 입력 + 결과 목록.
function TemplateRowPicker({ onPick }) {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState([]);
  const [message, setMessage] = useState('');

  const search = async () => {
    setMessage('');
    try {
      const params = new URLSearchParams({ q: query, limit: '100' });
      const res = await fetch(`${API}/luna-order/template-rows?${params}`, { headers: getAuthHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data?.detail || '검색 실패');
      setRows(data.rows || []);
      if (!data.rows?.length) setMessage('검색 결과가 없습니다.');
    } catch (err) {
      setMessage(err.message || '검색 실패');
    }
  };

  return (
    <div>
      <form
        className={styles.backtestControls}
        onSubmit={(e) => { e.preventDefault(); search(); }}
      >
        <input
          type="text"
          className={styles.dailySearchInput}
          placeholder="양식 검색 (예: 8015 브라운 - 띄어쓰기로 여러 단어)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit" className={styles.backtestSaveBtn}>검색</button>
      </form>
      {message && <div className={styles.actionMessage}>{message}</div>}
      {rows.length >= 100 && <div className={styles.actionMessage}>100건까지만 표시됩니다. 단어를 더 넣어 좁혀주세요.</div>}
      {rows.length > 0 && (
        <div className={styles.dailyTableScroll} style={{ marginBottom: '0.5rem', maxHeight: '320px', overflowY: 'auto' }}>
          <table className={styles.dailyTable}>
            <thead>
              <tr><th>품목코드</th><th>상품명</th><th>옵션명</th><th></th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.row}>
                  <td>{r.code}</td>
                  <td>{r.name}</td>
                  <td>{r.option}</td>
                  <td>
                    <button type="button" className={styles.rowSaveBtn} onClick={() => onPick(r)}>선택</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

async function putMapping(yusasCode, row) {
  const res = await fetch(`${API}/luna-order/mappings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({
      yusas_code: yusasCode,
      template_code: row.code,
      template_name: row.name,
      template_option: row.option,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data?.detail || '매칭 저장 실패');
}

// unmatchedItems: 다운로드 시도 중 저장된 매칭이 없던 발주 항목. 하나씩 양식 행을 골라 저장하면
// 다음부터는 같은 yusas_code가 자동으로 그 행에 들어간다. onResolved(code)로 목록에서 빼고,
// 모두 끝나면 onRetry로 다운로드를 다시 시도한다.
export default function LunaMappingPanel({ unmatchedItems, nameByCode, onResolved, onRetry }) {
  const [message, setMessage] = useState('');
  const [mappings, setMappings] = useState([]);
  const [showManage, setShowManage] = useState(false);
  const [editingCode, setEditingCode] = useState(null);

  const loadMappings = async () => {
    try {
      const res = await fetch(`${API}/luna-order/mappings`, { headers: getAuthHeaders() });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) setMappings(data.mappings || []);
    } catch {
      // 관리 목록 조회 실패는 무시 - 매칭 자체에는 영향 없음
    }
  };

  useEffect(() => {
    if (showManage) loadMappings();
  }, [showManage]);

  const pickForUnmatched = async (item, row) => {
    setMessage('');
    try {
      await putMapping(item.yusas_code, row);
      onResolved(item.yusas_code);
    } catch (err) {
      setMessage(err.message || '매칭 저장 실패');
    }
  };

  const pickForEdit = async (code, row) => {
    setMessage('');
    try {
      await putMapping(code, row);
      setEditingCode(null);
      loadMappings();
    } catch (err) {
      setMessage(err.message || '매칭 수정 실패');
    }
  };

  const removeMapping = async (code) => {
    if (!window.confirm('이 매칭을 삭제할까요? 다음 다운로드부터 다시 수동 매칭이 필요합니다.')) return;
    setMessage('');
    try {
      const res = await fetch(`${API}/luna-order/mappings/${encodeURIComponent(code)}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data?.detail || '삭제 실패');
      loadMappings();
    } catch (err) {
      setMessage(err.message || '삭제 실패');
    }
  };

  return (
    <div style={{ marginBottom: '0.75rem' }}>
      {unmatchedItems.length > 0 && (
        <>
          <div className={styles.actionMessage}>
            양식과 매칭되지 않은 상품 {unmatchedItems.length}건입니다. 양식에서 해당 행을 골라 매칭하면
            다음부터 자동으로 같은 행에 들어갑니다.
          </div>
          {unmatchedItems.map((item) => (
            <div key={item.yusas_code} style={{ marginBottom: '0.75rem' }}>
              <strong>{item.name || item.yusas_code}</strong>
              {item.options ? ` / ${item.options}` : ''} (수량 {item.qty})
              <TemplateRowPicker onPick={(row) => pickForUnmatched(item, row)} />
            </div>
          ))}
        </>
      )}
      {unmatchedItems.length === 0 && onRetry && (
        <div className={styles.backtestControls}>
          <span className={styles.dailyTableCount}>모두 매칭됐습니다.</span>
          <button type="button" className={styles.backtestSaveBtn} onClick={onRetry}>엑셀 다운로드</button>
        </div>
      )}

      <div className={styles.backtestControls}>
        <button type="button" className={styles.rowSaveBtn} onClick={() => setShowManage((v) => !v)}>
          {showManage ? '저장된 매칭 닫기' : '저장된 매칭 관리'}
        </button>
      </div>
      {message && <div className={styles.actionMessage}>{message}</div>}

      {showManage && (
        mappings.length === 0 ? (
          <div className={styles.actionMessage}>저장된 매칭이 없습니다.</div>
        ) : (
          <div className={styles.dailyTableScroll}>
            <table className={styles.dailyTable}>
              <thead>
                <tr><th>발주 상품</th><th>양식 품목코드</th><th>양식 상품명</th><th>양식 옵션명</th><th></th></tr>
              </thead>
              <tbody>
                {mappings.map((m) => (
                  <tr key={m.yusas_code}>
                    <td>{nameByCode[m.yusas_code] || m.yusas_code}</td>
                    <td>{m.template_code}</td>
                    <td>{m.template_name}</td>
                    <td>{m.template_option}</td>
                    <td>
                      <button type="button" className={styles.rowSaveBtn}
                        onClick={() => setEditingCode(editingCode === m.yusas_code ? null : m.yusas_code)}>
                        수정
                      </button>
                      <button type="button" className={styles.rowSaveBtn} onClick={() => removeMapping(m.yusas_code)}>
                        삭제
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
      {showManage && editingCode && (
        <div style={{ marginTop: '0.5rem' }}>
          <strong>{nameByCode[editingCode] || editingCode}</strong> 새 매칭 선택
          <TemplateRowPicker onPick={(row) => pickForEdit(editingCode, row)} />
        </div>
      )}
    </div>
  );
}
