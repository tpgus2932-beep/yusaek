import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  MessageSquare, Send, Wallet, History, RefreshCw,
  X, ChevronLeft, ChevronRight, CheckCircle, XCircle,
  Clock, AlertCircle, Trash2, Download,
} from 'lucide-react';
import styles from './SMSPage.module.css';
import { LOCAL_API_BASE as API, getAuthHeaders, handleUnauthorized } from '../../lib/api';

// EUC-KR 기준 바이트 수 (한글 2byte, 그 외 1byte)
const getByteLength = (str) => {
  let bytes = 0;
  for (const ch of str) {
    bytes += ch.charCodeAt(0) > 127 ? 2 : 1;
  }
  return bytes;
};

const SMS_MAX = 90;
const LMS_MAX = 2000;

const STATUS_MAP = {
  '전송완료': 'green', '발송완료': 'green',
  '예약대기중': 'blue', '전송중': 'orange',
  '전송실패': 'red', '가입자없음': 'red', '수신거부': 'red',
  '취소완료': 'gray',
};

const BadgeColor = ({ status }) => {
  const color = STATUS_MAP[status] || 'gray';
  const cls = {
    green: styles.badgeGreen, blue: styles.badgeBlue,
    orange: styles.badgeOrange, red: styles.badgeRed, gray: styles.badgeGray,
  }[color];
  const Icon = {
    green: CheckCircle, blue: Clock, orange: AlertCircle,
    red: XCircle, gray: XCircle,
  }[color];
  return (
    <span className={`${styles.badge} ${cls}`}>
      <Icon size={11} />
      {status || '-'}
    </span>
  );
};

const MsgTypeBadge = ({ bytes }) => {
  const type = bytes <= SMS_MAX ? 'SMS' : 'LMS';
  return (
    <span className={`${styles.msgTypeBadge} ${type === 'SMS' ? styles.msgTypeSMS : styles.msgTypeLMS}`}>
      {type}
    </span>
  );
};

export default function SMSPage() {
  const [templates, setTemplates] = useState([]);
  const [templateName, setTemplateName] = useState('');
  const [hiddenHistoryMids, setHiddenHistoryMids] = useState(() => {
    try {
      const raw = localStorage.getItem('sms-hidden-history-mids');
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });
  const [receiverCache, setReceiverCache] = useState(() => {
    try {
      const raw = localStorage.getItem('sms-receiver-cache');
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });
  const [activeTab, setActiveTab] = useState('send');

  // ─── 문자보내기 상태 ───
  const [receivers, setReceivers] = useState([]);
  const [receiverInput, setReceiverInput] = useState('');
  const [msg, setMsg] = useState('');
  const [msgType, setMsgType] = useState('');
  const [title, setTitle] = useState('');
  const [rdate, setRdate] = useState('');
  const [rtime, setRtime] = useState('');
  const [testMode, setTestMode] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState(null);

  // ─── 잔여건수 상태 ───
  const [remain, setRemain] = useState(null);
  const [remainLoading, setRemainLoading] = useState(false);
  const [remainUpdated, setRemainUpdated] = useState('');

  // ─── 전송내역 상태 ───
  const [historyList, setHistoryList] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyNextYn, setHistoryNextYn] = useState('N');
  const [startDate, setStartDate] = useState('');
  const [limitDay, setLimitDay] = useState('7');
  const [historyReceiverQuery, setHistoryReceiverQuery] = useState('');

  // ─── 상세 모달 상태 ───
  const [detailMid, setDetailMid] = useState(null);
  const [detailItem, setDetailItem] = useState(null);
  const [detailList, setDetailList] = useState([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailPage, setDetailPage] = useState(1);
  const [detailNextYn, setDetailNextYn] = useState('N');
  const [cancelLoading, setCancelLoading] = useState(false);
  const [cancelMsg, setCancelMsg] = useState('');

  // ─── 마이그레이션 상태 ───
  const [migrateLoading, setMigrateLoading] = useState(false);
  const [migrateResult, setMigrateResult] = useState(null);
  const [monthsBack, setMonthsBack] = useState('3');
  const [draggingTemplateId, setDraggingTemplateId] = useState(null);
  const [dragOverTemplateId, setDragOverTemplateId] = useState(null);
  const [templatesLoading, setTemplatesLoading] = useState(false);

  const receiverInputRef = useRef(null);
  const bytes = getByteLength(msg);

  // ─── 수신번호 태그 입력 ───
  const addReceiver = (raw) => {
    const nums = raw.split(/[,\s]+/).map((s) => s.replace(/[^0-9]/g, '')).filter(Boolean);
    if (!nums.length) return;
    setReceivers((prev) => {
      const set = new Set(prev);
      nums.forEach((n) => set.add(n));
      return [...set];
    });
    setReceiverInput('');
  };

  const handleReceiverKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
      e.preventDefault();
      addReceiver(receiverInput);
    } else if (e.key === 'Backspace' && !receiverInput && receivers.length > 0) {
      setReceivers((prev) => prev.slice(0, -1));
    }
  };

  const removeReceiver = (num) => setReceivers((prev) => prev.filter((r) => r !== num));

  const fetchTemplates = useCallback(async () => {
    setTemplatesLoading(true);
    try {
      const res = await fetch(`${API}/sms/templates`, {
        headers: getAuthHeaders(),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data?.detail || '템플릿을 불러오지 못했습니다.');
      setTemplates(Array.isArray(data.templates) ? data.templates : []);
    } catch (err) {
      setSendResult({ ok: false, msg: err.message || '템플릿을 불러오지 못했습니다.' });
    } finally {
      setTemplatesLoading(false);
    }
  }, []);

  const saveTemplates = useCallback(async (nextTemplates, successMessage = '') => {
    const res = await fetch(`${API}/sms/templates`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ templates: nextTemplates }),
    });
    if (handleUnauthorized(res)) return false;
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(data?.detail || '템플릿 저장에 실패했습니다.');
    }
    setTemplates(Array.isArray(data.templates) ? data.templates : []);
    if (successMessage) {
      setSendResult({ ok: true, msg: successMessage });
    }
    return true;
  }, []);

  useEffect(() => {
    fetchTemplates();
  }, [fetchTemplates]);

  const handleSaveTemplate = async () => {
    const name = templateName.trim();
    if (!name) {
      setSendResult({ ok: false, msg: '??? ??? ??? ???.' });
      return;
    }
    if (!msg.trim()) {
      setSendResult({ ok: false, msg: '??? ??? ??? ??? ???.' });
      return;
    }

    const nextItem = {
      id: `${Date.now()}`,
      name,
      msg,
      title,
      msgType,
    };

    const existingIndex = templates.findIndex((item) => item.name === name);
    const nextTemplates = [...templates];
    if (existingIndex >= 0) {
      nextTemplates[existingIndex] = { ...templates[existingIndex], ...nextItem, id: templates[existingIndex].id };
    } else {
      nextTemplates.unshift(nextItem);
    }

    try {
      const saved = await saveTemplates(nextTemplates, `??? "${name}" ?? ??`);
      if (!saved) return;
      setTemplateName('');
    } catch (err) {
      setSendResult({ ok: false, msg: err.message || '??? ??? ??????.' });
    }
  };

  const applyTemplate = (template) => {
    setMsg(template.msg || '');
    setTitle(template.title || '');
    setMsgType(template.msgType || '');
    setSendResult({ ok: true, msg: `??? "${template.name}" ?? ??` });
  };

  const deleteTemplate = async (templateId) => {
    try {
      await saveTemplates(
        templates.filter((item) => item.id !== templateId),
        '???? ??????.',
      );
    } catch (err) {
      setSendResult({ ok: false, msg: err.message || '??? ??? ??????.' });
    }
  };

  const moveTemplateToIndex = async (templateId, targetTemplateId) => {
    const index = templates.findIndex((item) => item.id === templateId);
    const targetIndex = templates.findIndex((item) => item.id === targetTemplateId);
    if (index < 0 || targetIndex < 0 || index === targetIndex) return;
    const next = [...templates];
    const [moved] = next.splice(index, 1);
    next.splice(targetIndex, 0, moved);
    try {
      await saveTemplates(next);
    } catch (err) {
      setSendResult({ ok: false, msg: err.message || '??? ?? ??? ??????.' });
    }
  };

  const moveTemplate = async (templateId, direction) => {
    const index = templates.findIndex((item) => item.id === templateId);
    if (index < 0) return;
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= templates.length) return;
    const next = [...templates];
    const [moved] = next.splice(index, 1);
    next.splice(targetIndex, 0, moved);
    try {
      await saveTemplates(next);
    } catch (err) {
      setSendResult({ ok: false, msg: err.message || '??? ?? ??? ??????.' });
    }
  };

  // ─── 문자 보내기 ───
  const handleSend = async () => {
    if (!receivers.length) { setSendResult({ ok: false, msg: '수신번호를 입력하세요.' }); return; }
    if (!msg.trim()) { setSendResult({ ok: false, msg: '메시지 내용을 입력하세요.' }); return; }
    setSending(true);
    setSendResult(null);
    try {
      const body = {
        receiver: receivers.join(','),
        msg,
        msg_type: effectiveMsgType,
        ...(title && { title }),
        ...(rdate && { rdate: rdate.replace(/-/g, '') }),
        ...(rtime && { rtime: rtime.replace(':', '') }),
        ...(testMode && { testmode_yn: 'Y' }),
      };
      const res = await fetch(`${API}/sms/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify(body),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json();
      if (data.result_code > 0) {
        const hasError = Number(data.error_cnt) > 0;
        const queued = !!data.queued;
        setSendResult({
          ok: !hasError,
          warn: hasError,
          msg: hasError
            ? `${data.success_cnt}건 성공 / ${data.error_cnt}건 실패 - 실패 번호는 상세보기에서 확인하세요`
            : queued
              ? `${data.success_cnt}건 전송 대기열 저장 완료 (${data.msg_type})`
              : `${data.success_cnt}건 전송 완료 (${data.msg_type})`,
          msgId: data.msg_id || data.queue_id,
        });
        // 발송 즉시 수신번호 캐싱 (msg_id → 미리보기)
        if (data.msg_id && receivers.length > 0) {
          const preview = receivers.length === 1
            ? receivers[0]
            : `${receivers[0]} 외 ${receivers.length - 1}명`;
          setReceiverCache((prev) => {
            const next = { ...prev, [data.msg_id]: preview };
            localStorage.setItem('sms-receiver-cache', JSON.stringify(next));
            return next;
          });
        }
        setReceivers([]);
        setMsg('');
        setTitle('');
        setRdate('');
        setRtime('');
      } else {
        setSendResult({
          ok: false,
          msg: data.message
            ? `${data.message} (코드: ${data.result_code})`
            : `전송 실패 (코드: ${data.result_code})`,
        });
      }
    } catch (err) {
      setSendResult({ ok: false, msg: err.message ? `오류: ${err.message}` : '알 수 없는 오류' });
    } finally {
      setSending(false);
    }
  };

  // ─── 잔여건수 조회 ───
  const fetchRemain = useCallback(async () => {
    setRemainLoading(true);
    try {
      const res = await fetch(`${API}/sms/remain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({}),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json();
      if (data.result_code > 0) {
        setRemain(data);
        setRemainUpdated(new Date().toLocaleTimeString('ko-KR'));
      }
    } catch {
      // ignore
    } finally {
      setRemainLoading(false);
    }
  }, []);

  // ─── 전송내역 조회 ───
  const fetchHistory = useCallback(async (page = 1) => {
    setHistoryLoading(true);
    try {
      const body = { page, page_size: 30 };
      if (startDate) body.start_date = startDate; // YYYY-MM-DD 그대로 전송 (로컬 DB용)
      if (limitDay) body.limit_day = Number(limitDay);
      if (historyReceiverQuery.trim()) body.receiver_query = historyReceiverQuery.trim();
      const res = await fetch(`${API}/sms/list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify(body),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json();
      if (data.result_code > 0) {
        const filtered = (data.list || []).filter((item) => !hiddenHistoryMids.includes(item.mid));
        setHistoryList(filtered);
        setHistoryNextYn(data.next_yn || 'N');
        setHistoryPage(page);
      }
    } catch {
      // ignore
    } finally {
      setHistoryLoading(false);
    }
  }, [hiddenHistoryMids, historyReceiverQuery, startDate, limitDay]);

  // ─── 상세 조회 ───
  const fetchDetail = useCallback(async (mid, page = 1) => {
    setDetailLoading(true);
    setCancelMsg('');
    try {
      const res = await fetch(`${API}/sms/detail`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ mid, page, page_size: 50 }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json();
      if (data.result_code > 0) {
        setDetailList(data.list || []);
        setDetailNextYn(data.next_yn || 'N');
        setDetailPage(page);
      }
    } catch {
      // ignore
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const openDetail = (item) => {
    setDetailItem(item);
    setDetailMid(item.mid);
    setDetailList([]);
    setDetailPage(1);
    setDetailNextYn('N');
    setCancelMsg('');
    fetchDetail(item.mid, 1);
  };

  const closeDetail = () => {
    setDetailMid(null);
    setDetailItem(null);
  };

  const handleHideHistoryItem = (mid) => {
    if (!mid) return;
    setHiddenHistoryMids((prev) => {
      if (prev.includes(mid)) return prev;
      const next = [...prev, mid];
      localStorage.setItem('sms-hidden-history-mids', JSON.stringify(next));
      return next;
    });
    setHistoryList((prev) => prev.filter((item) => item.mid !== mid));
    if (detailMid === mid) {
      closeDetail();
    }
  };

  // ─── 예약취소 ───
  const handleCancel = async () => {
    if (!detailMid) return;
    setCancelLoading(true);
    setCancelMsg('');
    try {
      const res = await fetch(`${API}/sms/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ mid: detailMid }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json();
      if (data.result_code > 0) {
        setCancelMsg(`취소 완료 (${data.cancel_date})`);
        fetchHistory(historyPage);
        fetchDetail(detailMid, detailPage);
      } else {
        setCancelMsg(data.message || '취소 실패');
      }
    } catch (err) {
      setCancelMsg(err.message || '오류 발생');
    } finally {
      setCancelLoading(false);
    }
  };

  // ─── 마이그레이션 ───
  const handleMigrate = async () => {
    setMigrateLoading(true);
    setMigrateResult(null);
    try {
      const res = await fetch(`${API}/sms/migrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ months_back: Number(monthsBack) }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json();
      setMigrateResult(data);
      if (data.ok) fetchHistory(1);
    } catch (err) {
      setMigrateResult({ ok: false, error: err.message });
    } finally {
      setMigrateLoading(false);
    }
  };

  // 탭 진입 시 자동 조회
  useEffect(() => {
    if (activeTab === 'remain') fetchRemain();
    if (activeTab === 'history') fetchHistory(1);
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== 'history') return;
    const timer = setTimeout(() => {
      fetchHistory(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [activeTab, historyReceiverQuery, startDate, limitDay, fetchHistory]);

  const isReserved = detailItem?.reserve_state === '예약대기중';
  const byteClass = bytes > LMS_MAX ? styles.byteCountOver : bytes > SMS_MAX ? styles.byteCountWarn : styles.byteCount;
  const effectiveMsgType = msgType || (bytes > SMS_MAX ? 'LMS' : 'SMS');

  return (
    <div className={styles.page}>
      {/* ── 헤더 ── */}
      <div className={styles.pageHeader}>
        <div>
          <h2 className={styles.title}>문자 발송</h2>
          <p className={styles.subtitle}>알리고 SMS API 연동 · 문자보내기 / 잔여건수 / 전송내역</p>
        </div>
      </div>

      {/* ── 탭 ── */}
      <div className={styles.tabRow}>
        {[
          { key: 'send',    label: '문자 보내기',  icon: <Send size={14} /> },
          { key: 'remain',  label: '잔여건수',      icon: <Wallet size={14} /> },
          { key: 'history', label: '전송내역',      icon: <History size={14} /> },
        ].map(({ key, label, icon }) => (
          <button
            key={key}
            className={`${styles.tabBtn} ${activeTab === key ? styles.tabActive : ''}`}
            onClick={() => setActiveTab(key)}
          >
            {icon}&nbsp;{label}
          </button>
        ))}
      </div>

      {/* ══════════════ 문자 보내기 탭 ══════════════ */}
      {activeTab === 'send' && (
        <>
          <div className={styles.card}>
            <div className={styles.cardTitle}><MessageSquare size={16} /> 수신번호</div>

            {/* 태그 입력 */}
            <div className={styles.templatePanel}>
              <div className={styles.templateHeader}>
                <div>
                  <div className={styles.label}>답변 템플릿</div>
                  <div className={styles.hint}>현재 제목과 본문을 저장해두고 바로 적용할 수 있습니다.</div>
                  <div className={styles.dragHint}>템플릿 카드를 길게 누르듯 끌어서 순서를 바꿀 수 있습니다.</div>
                </div>
                <div className={styles.templateSaveRow}>
                  <input
                    className={styles.input}
                    value={templateName}
                    onChange={(e) => setTemplateName(e.target.value)}
                    placeholder="템플릿 이름"
                  />
                  <button className={styles.secondaryBtn} type="button" onClick={handleSaveTemplate} disabled={templatesLoading}>
                    저장
                  </button>
                </div>
              </div>

              {templatesLoading ? (
                <div className={styles.emptyTemplate}>템플릿 불러오는 중...</div>
              ) : templates.length > 0 ? (
                <div className={styles.templateList}>
                  {templates.map((template, index) => (
                    <div
                      key={template.id}
                      className={`${styles.templateItem} ${draggingTemplateId === template.id ? styles.templateItemDragging : ''} ${dragOverTemplateId === template.id && draggingTemplateId !== template.id ? styles.templateItemDropTarget : ''}`}
                      draggable
                      onDragStart={() => setDraggingTemplateId(template.id)}
                      onDragEnd={() => {
                        setDraggingTemplateId(null);
                        setDragOverTemplateId(null);
                      }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        if (draggingTemplateId && draggingTemplateId !== template.id) {
                          setDragOverTemplateId(template.id);
                        }
                      }}
                      onDragLeave={() => {
                        if (dragOverTemplateId === template.id) {
                          setDragOverTemplateId(null);
                        }
                      }}
                      onDrop={() => {
                        if (draggingTemplateId) {
                          moveTemplateToIndex(draggingTemplateId, template.id);
                        }
                        setDraggingTemplateId(null);
                        setDragOverTemplateId(null);
                      }}
                    >
                      <button
                        type="button"
                        className={styles.templateApplyBtn}
                        onClick={() => applyTemplate(template)}
                      >
                        <strong>{template.name}</strong>
                        <span className={styles.templatePreview}>
                          {(template.msg || '').replace(/\s+/g, ' ').trim().slice(0, 70) || '내용 없음'}
                        </span>
                      </button>
                      <div className={styles.templateActions}>
                        <button
                          type="button"
                          className={styles.secondaryBtn}
                          onClick={() => moveTemplate(template.id, 'up')}
                          disabled={index === 0}
                        >
                          위로
                        </button>
                        <button
                          type="button"
                          className={styles.secondaryBtn}
                          onClick={() => moveTemplate(template.id, 'down')}
                          disabled={index === templates.length - 1}
                        >
                          아래로
                        </button>
                      </div>
                      <button
                        type="button"
                        className={styles.dangerBtn}
                        onClick={() => deleteTemplate(template.id)}
                      >
                        <Trash2 size={13} />
                        삭제
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className={styles.emptyTemplate}>저장된 템플릿이 없습니다.</div>
              )}
            </div>

            <div className={styles.fieldGroup}>
              <div className={styles.receiverBox} onClick={() => receiverInputRef.current?.focus()}>
                {receivers.map((num) => (
                  <span key={num} className={styles.tag}>
                    {num}
                    <button className={styles.tagRemove} onClick={(e) => { e.stopPropagation(); removeReceiver(num); }}>
                      <X size={11} />
                    </button>
                  </span>
                ))}
                <input
                  ref={receiverInputRef}
                  className={styles.receiverInput}
                  value={receiverInput}
                  onChange={(e) => setReceiverInput(e.target.value)}
                  onKeyDown={handleReceiverKeyDown}
                  onBlur={() => receiverInput && addReceiver(receiverInput)}
                  placeholder={receivers.length === 0 ? '번호 입력 후 Enter 또는 콤마 구분 (최대 1,000명)' : ''}
                />
              </div>
              <span className={styles.hint}>숫자만 입력 · Enter / , / 공백으로 구분 · Backspace로 마지막 번호 삭제</span>
            </div>

            {receivers.length > 0 && (
              <div className={styles.actionRow}>
                <span className={styles.hint}>{receivers.length}명 입력됨</span>
                <button className={styles.secondaryBtn} onClick={() => setReceivers([])}>
                  <X size={13} /> 전체 삭제
                </button>
              </div>
            )}
          </div>

          <div className={styles.card}>
            <div className={styles.cardTitle}><MessageSquare size={16} /> 메시지</div>

            <div className={styles.fieldGroup}>
              <textarea
                className={styles.textarea}
                style={{ minHeight: 160 }}
                value={msg}
                onChange={(e) => setMsg(e.target.value)}
                placeholder="메시지 내용을 입력하세요"
                maxLength={2000}
              />
              <div className={styles.byteBar}>
                <span className={byteClass}>{bytes} byte</span>
                <MsgTypeBadge bytes={bytes} />
              </div>
              {bytes > SMS_MAX && (
                <span className={styles.hint}>90 byte 초과 → LMS(장문)으로 자동 전환됩니다</span>
              )}
            </div>

            {/* 옵션 */}
            <div className={styles.optionGrid}>
              <div className={styles.fieldGroup}>
                <div className={styles.label}>문자 유형</div>
                <select className={styles.select} value={msgType} onChange={(e) => setMsgType(e.target.value)}>
                  <option value="">자동 (90byte 기준)</option>
                  <option value="SMS">SMS (단문)</option>
                  <option value="LMS">LMS (장문)</option>
                </select>
              </div>

              {(msgType === 'LMS' || (msgType === '' && bytes > SMS_MAX)) && (
                <div className={styles.fieldGroup}>
                  <div className={styles.label}>제목 (LMS)</div>
                  <input
                    className={styles.input}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="제목 (선택, 최대 44byte)"
                    maxLength={44}
                  />
                </div>
              )}
            </div>

            <div className={styles.optionGrid}>
              <div className={styles.fieldGroup}>
                <div className={styles.label}>예약 날짜</div>
                <input
                  type="date"
                  className={styles.input}
                  value={rdate}
                  onChange={(e) => setRdate(e.target.value)}
                />
              </div>
              <div className={styles.fieldGroup}>
                <div className={styles.label}>예약 시간</div>
                <input
                  type="time"
                  className={styles.input}
                  value={rtime}
                  onChange={(e) => setRtime(e.target.value)}
                />
              </div>
            </div>

            <label className={styles.toggleRow}>
              <div>
                <div className={styles.toggleLabel}>테스트 모드</div>
                <div className={styles.toggleDesc}>실제 발송·과금 없이 API 동작을 확인합니다</div>
              </div>
              <label className={styles.toggle}>
                <input type="checkbox" checked={testMode} onChange={(e) => setTestMode(e.target.checked)} />
                <span className={styles.toggleSlider} />
              </label>
            </label>

            <div className={styles.actionRow}>
              <button className={styles.primaryBtn} onClick={handleSend} disabled={sending}>
                <Send size={15} />
                {sending ? '전송 중...' : (rdate ? '예약 발송' : '발송')}
              </button>
              {testMode && <span className={styles.hint}>테스트 모드 ON</span>}
            </div>

            {sendResult && (
              <div className={`${styles.resultBanner} ${
                sendResult.ok ? styles.resultSuccess
                : sendResult.warn ? styles.resultWarn
                : styles.resultError
              }`}>
                <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flex: 1 }}>
                  {sendResult.ok ? <CheckCircle size={16} /> : sendResult.warn ? <AlertCircle size={16} /> : <XCircle size={16} />}
                  {sendResult.msg}
                </span>
                {sendResult.warn && sendResult.msgId && (
                  <button
                    className={styles.secondaryBtn}
                    style={{ flexShrink: 0, fontSize: '0.78rem', padding: '0.25rem 0.6rem' }}
                    onClick={() => {
                      setActiveTab('history');
                    }}
                  >
                    전송내역 확인
                  </button>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {/* ══════════════ 잔여건수 탭 ══════════════ */}
      {activeTab === 'remain' && (
        <div className={styles.card}>
          <div className={styles.cardHeader}>
            <div className={styles.cardTitle}><Wallet size={16} /> 발송 가능 잔여건수</div>
            <button className={styles.secondaryBtn} onClick={fetchRemain} disabled={remainLoading}>
              <RefreshCw size={14} className={remainLoading ? styles.spinning : ''} />
              새로고침
            </button>
          </div>

          {remainLoading && !remain && (
            <div className={styles.loadingSpinner}><div className={styles.spinner} /> 조회 중...</div>
          )}

          {remain && (
            <>
              <div className={styles.remainGrid}>
                <div className={styles.remainCard}>
                  <div className={`${styles.remainIcon} ${styles.remainIconSMS}`}>
                    <MessageSquare size={20} />
                  </div>
                  <div className={styles.remainLabel}>SMS · 단문</div>
                  <div className={styles.remainValue}>{(remain.SMS_CNT ?? 0).toLocaleString()}</div>
                  <div className={styles.remainDesc}>90byte 이하</div>
                </div>
                <div className={styles.remainCard}>
                  <div className={`${styles.remainIcon} ${styles.remainIconLMS}`}>
                    <MessageSquare size={20} />
                  </div>
                  <div className={styles.remainLabel}>LMS · 장문</div>
                  <div className={styles.remainValue}>{(remain.LMS_CNT ?? 0).toLocaleString()}</div>
                  <div className={styles.remainDesc}>90byte 초과 ~ 2,000byte</div>
                </div>
                <div className={styles.remainCard}>
                  <div className={`${styles.remainIcon} ${styles.remainIconMMS}`}>
                    <MessageSquare size={20} />
                  </div>
                  <div className={styles.remainLabel}>MMS · 그림</div>
                  <div className={styles.remainValue}>{(remain.MMS_CNT ?? 0).toLocaleString()}</div>
                  <div className={styles.remainDesc}>이미지 첨부</div>
                </div>
              </div>
              {remainUpdated && (
                <div className={styles.remainUpdated}>마지막 조회: {remainUpdated}</div>
              )}
            </>
          )}
        </div>
      )}

      {/* ══════════════ 전송내역 탭 ══════════════ */}
      {activeTab === 'history' && (
        <div className={styles.card}>
          <div className={styles.cardHeader}>
            <div className={styles.cardTitle}><History size={16} /> 전송내역</div>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <button className={styles.secondaryBtn} onClick={() => fetchHistory(1)} disabled={historyLoading}>
                <RefreshCw size={14} className={historyLoading ? styles.spinning : ''} /> 새로고침
              </button>
              <select
                className={styles.select}
                style={{ fontSize: '0.8rem', padding: '0.25rem 0.5rem' }}
                value={monthsBack}
                onChange={(e) => setMonthsBack(e.target.value)}
                disabled={migrateLoading}
              >
                <option value="1">최근 1개월</option>
                <option value="3">최근 3개월</option>
                <option value="6">최근 6개월</option>
                <option value="12">최근 12개월</option>
              </select>
              <button className={styles.secondaryBtn} onClick={handleMigrate} disabled={migrateLoading}>
                <Download size={14} className={migrateLoading ? styles.spinning : ''} />
                {migrateLoading ? '가져오는 중...' : 'Aligo 내역 가져오기'}
              </button>
            </div>
          </div>
          {migrateResult && (
            <div className={`${styles.resultBanner} ${migrateResult.ok ? styles.resultSuccess : styles.resultError}`} style={{ marginBottom: '0.75rem' }}>
              {migrateResult.ok
                ? <><CheckCircle size={15} /> {migrateResult.saved}건 저장 완료</>
                : <><XCircle size={15} /> 오류: {migrateResult.error || '마이그레이션 실패'}</>}
            </div>
          )}

          <div className={styles.filterRow}>
            <div className={styles.fieldGroup} style={{ flex: '1', minWidth: 160 }}>
              <div className={styles.label}>조회 시작일</div>
              <input type="date" className={styles.input} value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div className={styles.fieldGroup} style={{ flex: '1', minWidth: 180 }}>
              <div className={styles.label}>수신번호 검색</div>
              <input
                className={styles.input}
                value={historyReceiverQuery}
                onChange={(e) => setHistoryReceiverQuery(e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="번호 일부 입력"
                inputMode="numeric"
              />
            </div>
            <div className={styles.fieldGroup} style={{ minWidth: 120 }}>
              <div className={styles.label}>조회 기간(일)</div>
              <select className={styles.select} value={limitDay} onChange={(e) => setLimitDay(e.target.value)}>
                <option value="1">1일</option>
                <option value="3">3일</option>
                <option value="7">7일</option>
                <option value="14">14일</option>
                <option value="30">30일</option>
              </select>
            </div>
          </div>

          {historyLoading ? (
            <div className={styles.loadingSpinner}><div className={styles.spinner} /> 조회 중...</div>
          ) : historyList.length === 0 ? (
            <div className={styles.empty}>전송내역이 없습니다.</div>
          ) : (
            <>
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>유형</th>
                      <th>수신번호</th>
                      <th>전송수</th>
                      <th>상태</th>
                      <th>내용</th>
                      <th>등록일</th>
                      <th>관리</th>
                    </tr>
                  </thead>
                  <tbody>
                    {historyList.map((item, idx) => (
                      <tr key={item.mid ?? idx} onClick={() => openDetail(item)}>
                        <td><span className={`${styles.badge} ${styles.badgeGray}`}>{item.type}</span></td>
                        <td style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{item.receiver_preview || receiverCache[item.mid] || '-'}</td>
                        <td>{item.sms_count}명</td>
                        <td><BadgeColor status={item.reserve_state} /></td>
                        <td><div className={styles.msgPreview}>{item.msg}</div></td>
                        <td style={{ fontSize: '0.8rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{item.reg_date}</td>
                        <td>
                          {!item.receiver_preview && (
                            <button
                              className={styles.dangerBtn}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleHideHistoryItem(item.mid);
                              }}
                            >
                              <Trash2 size={12} />
                              삭제
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className={styles.pager}>
                <button className={styles.secondaryBtn} onClick={() => fetchHistory(historyPage - 1)} disabled={historyPage <= 1}>
                  <ChevronLeft size={15} /> 이전
                </button>
                <span className={styles.pagerInfo}>페이지 {historyPage}</span>
                <button className={styles.secondaryBtn} onClick={() => fetchHistory(historyPage + 1)} disabled={historyNextYn !== 'Y'}>
                  다음 <ChevronRight size={15} />
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ══════════════ 상세 모달 ══════════════ */}
      {detailMid && (
        <div className={styles.modalOverlay} onClick={closeDetail}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <div className={styles.modalTitle}>전송결과 상세</div>
              <button className={styles.iconBtn} onClick={closeDetail}><X size={18} /></button>
            </div>

            <div className={styles.modalBody}>
              {detailItem && (
                <div className={styles.modalInfo}>
                  <div><strong>MSG ID:</strong> {detailItem.mid}</div>
                  <div><strong>유형:</strong> {detailItem.type} &nbsp;|&nbsp; <strong>상태:</strong> {detailItem.reserve_state}</div>
                  <div><strong>전송수:</strong> {detailItem.sms_count}명 &nbsp;|&nbsp; <strong>실패:</strong> {detailItem.fail_count}건</div>
                  <div style={{ marginTop: '0.5rem', whiteSpace: 'pre-wrap', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                    {detailItem.msg}
                  </div>
                </div>
              )}

              {cancelMsg && (
                <div className={`${styles.resultBanner} ${cancelMsg.includes('완료') ? styles.resultSuccess : styles.resultError}`}>
                  {cancelMsg.includes('완료') ? <CheckCircle size={15} /> : <XCircle size={15} />}
                  {cancelMsg}
                </div>
              )}

              {detailLoading ? (
                <div className={styles.loadingSpinner}><div className={styles.spinner} /> 조회 중...</div>
              ) : detailList.length === 0 ? (
                <div className={styles.empty}>수신번호별 상세 결과가 없습니다.</div>
              ) : (
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>수신번호</th>
                        <th>전송상태</th>
                        <th>전송일시</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detailList.map((d, i) => (
                        <tr key={d.mdid ?? i} style={{ cursor: 'default' }}>
                          <td>{d.receiver}</td>
                          <td><BadgeColor status={d.sms_state} /></td>
                          <td style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{d.send_date || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className={styles.modalFooter}>
              <div className={styles.actionRow}>
                {detailPage > 1 && (
                  <button className={styles.secondaryBtn} onClick={() => fetchDetail(detailMid, detailPage - 1)} disabled={detailLoading}>
                    <ChevronLeft size={14} /> 이전
                  </button>
                )}
                {detailNextYn === 'Y' && (
                  <button className={styles.secondaryBtn} onClick={() => fetchDetail(detailMid, detailPage + 1)} disabled={detailLoading}>
                    다음 <ChevronRight size={14} />
                  </button>
                )}
              </div>
              <div className={styles.actionRow}>
                {isReserved && (
                  <button className={styles.dangerBtn} onClick={handleCancel} disabled={cancelLoading}>
                    {cancelLoading ? '취소 중...' : '예약 취소'}
                  </button>
                )}
                <button className={styles.secondaryBtn} onClick={closeDetail}><X size={14} /> 닫기</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
