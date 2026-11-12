import { useEffect, useRef, useState } from 'react';
import styles from './CSPage.module.css';
import CSStock from './CSStock';
import CSAddressModal from './CSAddressModal';
import CSPurchaseReturnModal from './CSPurchaseReturnModal';
import CSMisshipModal from './CSMisshipModal';
import CSReturnWithdrawModal from './CSReturnWithdrawModal';
import CSCancelApproveModal from './CSCancelApproveModal';
import CSDeliveryModal from './CSDeliveryModal';
import CSExchangeModal from './CSExchangeModal';
import CSHoldModal from './CSHoldModal';
import CSLogModal from './CSLogModal';
import CSRecallModal from './CSRecallModal';
import CSActionPanel from './CSActionPanel';

const fmtTime = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// 이 문의의 상품·옵션: 목록 정보(preview) → 대화 속 주문/상품 메시지 순으로 찾는다.
const roomProduct = (preview, detail) => {
    const messages = detail?.contact_messages || [];
    const orderItem = preview?.order_item?.goods ? preview.order_item : messages.find((m) => m.order_item?.goods)?.order_item || null;
    const goods = orderItem?.goods || preview?.goods || messages.find((m) => m.goods)?.goods || null;
    if (!goods?.sno) return null;
    const previewOptions = preview?.options?.length ? preview.options : preview?.order_item?.options;
    return {
        goods,
        orderNo: orderItem?.order_sno ?? preview?.order_item?.order_sno ?? null,
        asked: {
            options: previewOptions?.length ? previewOptions : orderItem?.options || [],
            optionNo: orderItem?.goods_option_sno ?? preview?.goods_option_sno ?? null,
            code: preview?.asked_code || '',
        },
    };
};

const tokenKey = (parts) =>
    (parts || [])
        .flatMap((p) => String(p || '').split(/[\s/,]+/))
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean)
        .sort()
        .join('|');

// 재고를 보여줄 상품들: 문의한 주문의 상품 + 고객의 '상품 준비중' 주문 상품 전부 (중복은 한 번만).
const stockProducts = (preview, detail) => {
    const list = [];
    const seen = new Set();
    const statusOf = (orderNo, goodsSno) =>
        (detail?.order_items || []).find((o) => String(o.order_sno) === String(orderNo) && String(o.goods?.sno) === String(goodsSno))?.status || '';
    const add = (entry) => {
        entry = { ...entry, status: statusOf(entry.orderNo, entry.goods.sno) };
        const key = `${entry.orderNo}:${entry.goods.sno}:${tokenKey(entry.asked.options)}`;
        if (seen.has(key)) return;
        seen.add(key);
        list.push({ ...entry, key });
    };
    const primary = detail?.contact_room ? roomProduct(preview, detail) : null;
    if (primary) add(primary);
    for (const item of detail?.order_items || []) {
        if (!/준비/.test(item.status || '') || !item.goods?.sno) continue;
        const options = item.options?.length ? item.options : [item.option1, item.option2].filter(Boolean);
        add({
            goods: { sno: item.goods.sno, name: item.goods.name },
            orderNo: item.order_sno ?? null,
            asked: { options, optionNo: item.goods_option_sno ?? null, code: '' },
        });
    }
    return list;
};

// 주문 상태 글자 → 한눈에 보이는 색 구분 (취소/반품 > 준비중 > 배송중 > 배송·구매 완료 순으로 판별)
const orderTone = (status) => {
    const t = String(status || '');
    if (/취소|환불|반품|교환/.test(t)) return 'toneCancel';
    if (/준비/.test(t)) return 'tonePrepare';
    if (/배송\s*중|출고|발송|송장|집하|이동/.test(t)) return 'toneShipping';
    if (/완료|확정/.test(t)) return 'toneDone';
    return 'toneEtc';
};

const OrderStatus = ({ status }) => (
    <span className={`${styles.orderStatus} ${styles[orderTone(status)]}`}>{status || '상태 미확인'}</span>
);

const optionText = (o) => (o.options || []).join(' / ') || [o.option1, o.option2].filter(Boolean).join(' / ');

const MAX_REPLY_PHOTOS = 10; // 답변에 한 번에 붙일 수 있는 사진 수

// 문의 대화 패널 (문의함 / 상품별 탭 공용)
// splitInfo: 주문·주소·재고 정보를 대화 오른쪽 별도 패널로 분리해서 그린다 (상품별·문의함 탭).
// extraTabs: 오른쪽 패널 끝에 덧붙일 탭 [{key, label, content}] (문의함의 답변 템플릿 등).
const CSConversation = ({ selected, preview, detail, detailLoading, draft = '', setDraft, acting = false, onReply, onReplyImages, onComplete, splitInfo = false, keywordHits = [], extraTabs = [] }) => {
    const [returnOrder, setReturnOrder] = useState(''); // 구매확정 반품 모달에 띄울 주문번호
    const [cancelOrder, setCancelOrder] = useState(''); // 취소 승인 모달에 띄울 주문번호
    const [withdrawOrder, setWithdrawOrder] = useState(''); // 반품 철회 모달에 띄울 주문번호
    const [addressOrder, setAddressOrder] = useState(''); // 주소 변경 모달에 띄울 주문번호
    const [deliveryOpen, setDeliveryOpen] = useState(false); // 배송 확인(전화번호 → 송장번호) 모달
    const [logOpen, setLogOpen] = useState(false); // CS 로그(C/S 이력) 확인 모달
    const [recallOpen, setRecallOpen] = useState(false); // 회수신청(전화번호 → 주문 선택 → 회수접수) 모달
    const [holdOpen, setHoldOpen] = useState(false); // 보류 해제·정상 복귀 모달
    const [exchangeOpen, setExchangeOpen] = useState(false); // 상품 교환(전화번호 → 주문 → 옵션 교환) 모달
    const [misshipOpen, setMisshipOpen] = useState(false); // 오배송 특이사항 등록 + 입출고 모달
    const room = detail?.contact_room;
    const messages = detail?.contact_messages || [];
    const product = room ? roomProduct(preview, detail) : null;
    const stockItems = stockProducts(preview, detail);
    const [lookupAll, setLookupAll] = useState(0); // 값이 바뀔 때마다 모든 상품 재고를 조회
    const [sideTab, setSideTab] = useState('order'); // 상품별·문의함 오른쪽 패널: 'order'(주문 정보+재고) | 'action' | 추가 탭
    // 답변 입력창에서 전송/완료를 하면 처리 후에도(다음 문의로 넘어가 입력창이 새로 그려져도) 커서를 입력창에 둔다.
    const replyRef = useRef(null);
    const keepFocus = useRef(false);
    const rightCtrl = useRef(false);
    const isRightCtrlKey = (e) => e.code === 'ControlRight' || e.code === 'Lang2' || e.key === 'Hanja' || e.key === 'HanjaMode';
    const hasReplyBox = Boolean(room && onReply);
    // 사진 답변: 파일 선택 또는 Ctrl+V(복사한 이미지·스크린샷)로 담고, 전송 버튼/Enter로 글과 함께 보낸다.
    const [photos, setPhotos] = useState([]); // [{key, file, preview}]
    const [photoNote, setPhotoNote] = useState('');
    const fileInput = useRef(null);
    // 다른 문의로 옮기면 담아 둔 사진은 비운다 (엉뚱한 고객에게 가지 않게).
    const [photoRoom, setPhotoRoom] = useState(selected);
    if (photoRoom !== selected) {
        setPhotoRoom(selected);
        setPhotos([]);
        setPhotoNote('');
    }
    const addPhotos = (fileList) => {
        const files = Array.from(fileList || []).filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|gif|webp)$/i.test(f.name));
        if (!files.length) { setPhotoNote('사진 파일(JPG, PNG, GIF, WEBP)만 첨부할 수 있습니다.'); return; }
        const room = MAX_REPLY_PHOTOS - photos.length;
        if (room <= 0) { setPhotoNote(`사진은 한 번에 ${MAX_REPLY_PHOTOS}장까지 보낼 수 있습니다.`); return; }
        setPhotoNote(files.length > room ? `사진은 한 번에 ${MAX_REPLY_PHOTOS}장까지라서 ${room}장만 추가했습니다.` : '');
        setPhotos((list) => [
            ...list,
            ...files.slice(0, room).map((file) => ({
                key: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
                file: file.name && file.name !== 'image.png' ? file : new File([file], `붙여넣은 사진-${Date.now()}.${(file.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: file.type }),
                preview: URL.createObjectURL(file),
            })),
        ]);
    };
    const removePhoto = (key) => setPhotos((list) => {
        const gone = list.find((p) => p.key === key);
        if (gone) URL.revokeObjectURL(gone.preview);
        return list.filter((p) => p.key !== key);
    });
    const onPasteReply = (e) => {
        const data = e.clipboardData;
        if (!data || !onReplyImages) return;
        const found = new Map();
        Array.from(data.files || []).forEach((f) => found.set(`${f.name}|${f.size}|${f.type}`, f));
        Array.from(data.items || []).forEach((item) => {
            if (item.kind !== 'file') return;
            const f = item.getAsFile();
            if (f) found.set(`${f.name}|${f.size}|${f.type}`, f);
        });
        const images = Array.from(found.values()).filter((f) => /^image\//.test(f.type));
        if (!images.length) return; // 글자 붙여넣기는 그대로 둔다
        e.preventDefault();
        addPhotos(images);
    };
    // 글이 있으면 글을 먼저, 이어서 사진을 한 장씩 보낸다. 중간에 실패하면 남은 사진은 그대로 둔다.
    const sendReply = async () => {
        if (acting) return;
        if (draft.trim() && !(await onReply(draft))) return;
        if (photos.length && onReplyImages) {
            const sent = await onReplyImages(photos.map((p) => p.file));
            setPhotos((list) => {
                list.slice(0, sent).forEach((p) => URL.revokeObjectURL(p.preview));
                return list.slice(sent);
            });
        }
    };
    const canSendReply = Boolean(draft.trim()) || photos.length > 0;
    useEffect(() => {
        if (keepFocus.current && !acting && !detailLoading && replyRef.current) replyRef.current.focus();
    }, [acting, detailLoading, selected, hasReplyBox]);
    const orderItems = detail?.order_items || [];
    // 작업 탭 버튼 목록. 주문이 연결된 문의에서만 주문 작업이 포함된다.
    const orderNoStr = product?.orderNo ? String(product.orderNo) : '';
    const actionItems = [
        ...(orderNoStr ? [
            { id: 'address', title: '주소 변경', desc: `주문 ${orderNoStr}의 배송지를 이지어드민에서 변경`, onClick: () => setAddressOrder(orderNoStr) },
            { id: 'purchaseReturn', title: '구매확정 반품', desc: '회수접수 + 회수 문자 + 반품 특이사항 등록', onClick: () => setReturnOrder(orderNoStr) },
            { id: 'cancelApprove', title: '취소 승인', desc: `주문 ${orderNoStr}의 에이블리 구매자 취소요청을 승인`, onClick: () => setCancelOrder(orderNoStr) },
            { id: 'returnWithdraw', title: '반품 철회', desc: `주문 ${orderNoStr}의 진행 중인 에이블리 반품 요청을 철회`, onClick: () => setWithdrawOrder(orderNoStr) },
        ] : []),
        { id: 'delivery', title: '배송 확인', desc: '고객 전화번호로 주문을 검색해 송장번호 확인', onClick: () => setDeliveryOpen(true) },
        { id: 'csLog', title: 'CS 로그 확인', desc: '전화번호로 주문을 검색해 이지어드민 C/S 이력 확인', onClick: () => setLogOpen(true) },
        { id: 'recall', title: '회수신청', desc: '전화번호로 주문을 검색해 선택하고, CS 로그를 보며 이지어드민에 회수접수', onClick: () => setRecallOpen(true) },
        { id: 'hold', title: '보류 해제 · 정상 복귀', desc: '전화번호로 주문을 검색해 보류 해제 및 취소·CS 상태를 정상으로 복귀', onClick: () => setHoldOpen(true) },
        { id: 'misship', title: '오배송 특이사항 등록', desc: '원송장번호를 반품 특이사항에 오배송으로 등록하고, 정상화 통계 확인 후 상품 입출고', onClick: () => setMisshipOpen(true) },
        { id: 'exchange', title: '상품 교환', desc: '전화번호로 주문을 검색해 주문 상품의 옵션을 이지어드민에서 교환', onClick: () => setExchangeOpen(true) },
    ];
    const targetItems = product?.orderNo ? orderItems.filter((o) => String(o.order_sno) === String(product.orderNo)) : [];

    // section: 'all'(기존 한 덩어리) | 'rank'(주문 대기 순번만) | 'stock'(옵션별 재고만)
    const renderStock = (section) => (
        <>
            {section !== 'rank' && stockItems.length > 1 && (
                <div className={styles.stockAllBar}>
                    <strong>준비중 상품 {stockItems.length}개 재고</strong>
                    <button type="button" className={styles.linkBtn} onClick={() => setLookupAll((n) => n + 1)}>
                        전체 재고 조회
                    </button>
                </div>
            )}
            {stockItems.filter((item) => section !== 'rank' || item.orderNo).map((item) => (
                <CSStock
                    section={section}
                    key={item.key}
                    goods={item.goods}
                    asked={item.asked}
                    orderNo={item.orderNo}
                    title={stockItems.length > 1 ? `${item.goods.name}${item.orderNo ? ` · 주문 ${item.orderNo}` : ''}` : ''}
                    lookupSignal={lookupAll}
                    orderStatus={item.status}
                    compact={splitInfo}
                />
            ))}
        </>
    );

    const messagesBlock = room && (
        <>
            <section className={styles.messages}>
                {messages.map((m) => {
                    const mine = m.member_type !== 'USER';
                    return (
                        <div key={m.sno} className={`${styles.msgRow} ${mine ? styles.msgMine : ''}`}>
                            <div className={`${styles.msg} ${m.is_written_by_system ? styles.msgSystem : ''}`}>
                                {m.content && <div className={styles.msgText}>{m.content}</div>}
                                {m.image_url && <img src={m.transformed_image_url || m.image_url} alt="" className={styles.msgImg} />}
                                {!m.content && !m.image_url && m.order_item?.goods && (
                                    <div className={styles.msgText}>[주문] {m.order_item.goods.name}</div>
                                )}
                                <div className={styles.msgTime}>{fmtTime(m.created_at)}</div>
                            </div>
                        </div>
                    );
                })}
            </section>
            {onReply && (
                <section className={styles.replyBox}>
                    {photos.length > 0 && (
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6, alignItems: 'center' }}>
                            {photos.map((p) => (
                                <div key={p.key} style={{ position: 'relative' }} title={p.file.name}>
                                    <img src={p.preview} alt="" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 6, border: '1px solid #d1d5db' }} />
                                    <button
                                        type="button"
                                        onClick={() => removePhoto(p.key)}
                                        disabled={acting}
                                        title="빼기"
                                        style={{ position: 'absolute', top: -6, right: -6, width: 18, height: 18, borderRadius: 9, border: 'none', background: '#374151', color: '#fff', cursor: 'pointer', lineHeight: '18px', padding: 0, fontSize: 12 }}
                                    >
                                        ×
                                    </button>
                                </div>
                            ))}
                            <span style={{ fontSize: 12, color: '#6b7280' }}>{photos.length}/{MAX_REPLY_PHOTOS}장 · 전송하면 글 다음에 사진이 한 장씩 갑니다</span>
                        </div>
                    )}
                    {photoNote && <div style={{ fontSize: 12, color: '#b45309', marginBottom: 4 }}>{photoNote}</div>}
                    <textarea
                        ref={replyRef}
                        rows={4}
                        value={draft}
                        onFocus={() => { keepFocus.current = true; }}
                        onBlur={(e) => {
                            rightCtrl.current = false;
                            if (e.relatedTarget) keepFocus.current = false;
                        }}
                        placeholder="답변 내용을 입력하세요. (Enter 전송 · Shift+Enter 줄바꿈 · Ctrl+Enter 완료 처리)"
                        onChange={(e) => setDraft(e.target.value)}
                        onPaste={onPasteReply}
                        onKeyUp={(e) => {
                            if (isRightCtrlKey(e)) rightCtrl.current = false;
                        }}
                        onKeyDown={(e) => {
                            // 한국어 키보드의 오른쪽 Ctrl은 한자 키로 인식되어 ctrlKey가 false일 수 있음
                            if (isRightCtrlKey(e)) {
                                rightCtrl.current = true;
                                return;
                            }
                            // 한글 조합 중 Enter는 무시, Shift+Enter는 줄바꿈, Ctrl+Enter는 완료 처리
                            if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
                            e.preventDefault();
                            if (e.ctrlKey || e.metaKey || rightCtrl.current) {
                                if (!acting && [1, 2].includes(room.status)) onComplete({ next: true });
                                return;
                            }
                            if (!acting && canSendReply) sendReply();
                        }}
                        readOnly={acting}
                    />
                    <div className={styles.replyActions}>
                        <button
                            type="button"
                            className={styles.btn}
                            onMouseDown={(e) => e.preventDefault()}
                            disabled={acting || !canSendReply}
                            onClick={sendReply}
                        >
                            {acting ? '처리 중...' : '답변 전송'}
                        </button>
                        {onReplyImages && (
                            <>
                                <button
                                    type="button"
                                    className={styles.btn}
                                    onMouseDown={(e) => e.preventDefault()}
                                    disabled={acting}
                                    title={`사진 첨부 (최대 ${MAX_REPLY_PHOTOS}장) · 복사한 이미지는 입력창에서 Ctrl+V`}
                                    onClick={() => fileInput.current?.click()}
                                >
                                    사진 첨부
                                </button>
                                <input
                                    ref={fileInput}
                                    type="file"
                                    hidden
                                    multiple
                                    accept="image/jpeg,image/png,image/gif,image/webp"
                                    onChange={(e) => { addPhotos(e.target.files); e.target.value = ''; }}
                                />
                            </>
                        )}
                        <button
                            type="button"
                            className={styles.btn}
                            onMouseDown={(e) => e.preventDefault()}
                            disabled={acting || ![1, 2].includes(room.status)}
                            onClick={() => onComplete()}
                        >
                            완료 처리
                        </button>
                    </div>
                </section>
            )}
        </>
    );

    const modals = (
        <>
            {returnOrder && (
                <CSPurchaseReturnModal
                    orderNo={returnOrder}
                    buyer={{ name: room?.member?.name || '', tel: room?.member?.mobile || '' }}
                    goodsName={product?.goods?.name || ''}
                    onClose={() => setReturnOrder('')}
                />
            )}
            {cancelOrder && <CSCancelApproveModal orderNo={cancelOrder} onClose={() => setCancelOrder('')} />}
            {withdrawOrder && <CSReturnWithdrawModal orderNo={withdrawOrder} onClose={() => setWithdrawOrder('')} />}
            {addressOrder && <CSAddressModal orderNo={addressOrder} onClose={() => setAddressOrder('')} />}
            {logOpen && (
                <CSLogModal phone={room?.member?.mobile || preview?.member?.mobile || ''} onClose={() => setLogOpen(false)} />
            )}
            {recallOpen && (
                <CSRecallModal phone={room?.member?.mobile || preview?.member?.mobile || ''} onClose={() => setRecallOpen(false)} />
            )}
            {holdOpen && (
                <CSHoldModal phone={room?.member?.mobile || preview?.member?.mobile || ''} onClose={() => setHoldOpen(false)} />
            )}
            {exchangeOpen && (
                <CSExchangeModal phone={room?.member?.mobile || preview?.member?.mobile || ''} onClose={() => setExchangeOpen(false)} />
            )}
            {misshipOpen && (
                <CSMisshipModal orderNo={orderNoStr} goodsName={product?.goods?.name || ''} onClose={() => setMisshipOpen(false)} />
            )}
            {deliveryOpen && (
                <CSDeliveryModal phone={room?.member?.mobile || preview?.member?.mobile || ''} onClose={() => setDeliveryOpen(false)} />
            )}
        </>
    );

    if (splitInfo) {
        const member = room?.member || preview?.member;
        const receiver = room?.order_item?.receiver_address;
        return (
            <>
                <div className={styles.convMain}>
                    {!selected && <div className={styles.empty}>왼쪽에서 문의를 선택하세요.</div>}
                    {selected && member && (
                        <div className={styles.chatHead}>
                            <strong>{member.name || '-'}</strong>
                            {(room || preview) && (
                                <span className={styles.chatHeadTag}>
                                    {(room || preview).parent_category_display} &gt; {(room || preview).child_category_display}
                                </span>
                            )}
                            {room?.get_status_display && <span className={styles.badge}>{room.get_status_display}</span>}
                            {keywordHits.length > 0 && (
                                <span className={styles.hitBadge} title="문의 내용에 포함된 단어">{keywordHits.join('·')}</span>
                            )}
                        </div>
                    )}
                    {selected && detailLoading && <div className={styles.empty}>대화 내용 불러오는 중...</div>}
                    {messagesBlock}
                </div>
                <aside className={styles.convSide}>
                    {!selected && <div className={styles.empty}>문의를 선택하면 주문 정보가 여기에 표시돼요.</div>}
                    {selected && (
                        <div className={styles.sideTabs} role="tablist">
                            {[['order', '주문 정보·재고'], ['action', '작업'], ...extraTabs.map((t) => [t.key, t.label])].map(([key, label]) => (
                                <button
                                    key={key}
                                    type="button"
                                    role="tab"
                                    aria-selected={sideTab === key}
                                    className={`${styles.sideTab} ${sideTab === key ? styles.sideTabOn : ''}`}
                                    onClick={() => setSideTab(key)}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>
                    )}
                    {selected && (
                        <>
                            <div hidden={sideTab !== 'order'} className={styles.orderCols}>
                            <div className={styles.orderColInfo}>
                            {product && (
                                <section className={styles.sideSec}>
                                    <h4>현재 문의 상품</h4>
                                    {product.orderNo && <div className={styles.sideChip}>주문번호 {product.orderNo}</div>}
                                    {targetItems.length > 0 && <div className={styles.sideChip}>상품주문번호 {targetItems.map((o) => o.sno).join(', ')}</div>}
                                    <div className={styles.sideGoods}>{product.goods.name}</div>
                                    {product.asked.options.length > 0 && (
                                        <div className={styles.sideMuted}>{product.asked.options.join(' / ')}</div>
                                    )}
                                    {targetItems.length > 0 && (
                                        <div className={styles.sideStatus}>
                                            {targetItems.map((o) => <OrderStatus key={o.sno} status={o.status} />)}
                                        </div>
                                    )}
                                </section>
                            )}
                            {member && (
                                <section className={styles.sideSec}>
                                    <h4>주문자: {member.name || '-'}</h4>
                                    {member.email && <div className={styles.sideLine}>{member.email}</div>}
                                    {member.mobile && <div className={styles.sideLine}>{member.mobile}</div>}
                                </section>
                            )}
                            {receiver && (
                                <section className={styles.sideSec}>
                                    <h4>수령자: {receiver.receiver_name}</h4>
                                    {receiver.receiver_tel && <div className={styles.sideLine}>{receiver.receiver_tel}</div>}
                                    {receiver.receiver_addr && <div className={styles.sideMuted}>{receiver.receiver_addr}</div>}
                                </section>
                            )}
                            {orderItems.length > 0 && (
                                <section className={styles.sideSec}>
                                    <h4>주문 내역</h4>
                                    <ul className={styles.sideOrders}>
                                        {orderItems.map((o) => (
                                            <li key={o.sno}>
                                                <div className={styles.sideGoods}>{o.goods?.name}</div>
                                                <div className={styles.sideMuted}>
                                                    {optionText(o)} · {o.ea}개 · 주문 {o.order_sno} · 상품주문번호 {o.sno}
                                                </div>
                                                <OrderStatus status={o.status} />
                                            </li>
                                        ))}
                                    </ul>
                                </section>
                            )}
                            </div>
                            <div className={styles.orderColStock}>
                            {room && <section className={styles.sideSec}>{renderStock('rank')}</section>}
                            {room && <section className={styles.sideSec}>{renderStock('stock')}</section>}
                            </div>
                            </div>
                            <div hidden={sideTab !== 'action'}>
                                <section className={styles.sideSec}>
                                    <h4>주문 작업</h4>
                                    {!product?.orderNo && <div className={styles.sideMuted}>이 문의에 연결된 주문이 없어 주문 작업(주소 변경 등)은 할 수 없어요.</div>}
                                    <CSActionPanel actions={actionItems} />
                                </section>
                            </div>
                            {extraTabs.map((t) => (
                                <div key={t.key} hidden={sideTab !== t.key}>{t.content}</div>
                            ))}
                        </>
                    )}
                </aside>
                {modals}
            </>
        );
    }

    return (
        <>
                {!selected && <div className={styles.empty}>왼쪽에서 문의를 선택하세요.</div>}
                {selected && detailLoading && preview && (
                    <section className={styles.info}>
                        <div><b>{preview.member?.name}</b> · {preview.member?.mobile} · {preview.member?.email}</div>
                        <div>
                            {preview.parent_category_display} &gt; {preview.child_category_display} · {preview.get_status_display}
                        </div>
                        <div className={styles.preview}>{preview.latest_message?.content}</div>
                        <div className={styles.time}>대화 내용 불러오는 중...</div>
                    </section>
                )}
                {room && (
                    <>
                        <section className={styles.info}>
                            <div><b>{room.member?.name}</b> · {room.member?.mobile} · {room.member?.email}</div>
                            <div>
                                {room.parent_category_display} &gt; {room.child_category_display} · {room.get_status_display}
                            </div>
                            {product?.orderNo && targetItems.length > 0 && (
                                <div className={styles.orderNow}>
                                    문의 주문 {product.orderNo}: {targetItems.map((o) => <OrderStatus key={o.sno} status={o.status} />)}
                                </div>
                            )}
                            {product?.orderNo && (
                                <button type="button" className={styles.linkBtn} onClick={() => setAddressOrder(String(product.orderNo))}>
                                    이 주문 주소 변경 ({product.orderNo})
                                </button>
                            )}
                            {product?.orderNo && (
                                <button type="button" className={styles.linkBtn} onClick={() => setReturnOrder(String(product.orderNo))}>
                                    구매확정 반품
                                </button>
                            )}
                            {room.order_item?.receiver_address && (
                                <div>
                                    수령: {room.order_item.receiver_address.receiver_name} /{' '}
                                    {room.order_item.receiver_address.receiver_tel} /{' '}
                                    {room.order_item.receiver_address.receiver_addr}
                                </div>
                            )}
                            {orderItems.length > 0 && (
                                <ul className={styles.orders}>
                                    {orderItems.map((o) => (
                                        <li key={o.sno}>
                                            {o.goods?.name} · {optionText(o)} ·{' '}
                                            {o.ea}개 · <OrderStatus status={o.status} /> · 주문 {o.order_sno} · 상품주문번호 {o.sno}
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </section>
                        {renderStock('all')}
                        {messagesBlock}
                    </>
                )}
            {modals}
        </>
    );
};

export default CSConversation;
