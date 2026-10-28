import { useState } from 'react';
import styles from './CSPage.module.css';
import CSStock from './CSStock';
import CSAddressModal from './CSAddressModal';
import CSPurchaseReturnModal from './CSPurchaseReturnModal';
import CSDeliveryModal from './CSDeliveryModal';
import CSExchangeModal from './CSExchangeModal';
import CSHoldModal from './CSHoldModal';
import CSLogModal from './CSLogModal';

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

// 문의 대화 패널 (문의함 / 상품별 탭 공용)
// splitInfo: 주문·주소·재고 정보를 대화 오른쪽 별도 패널로 분리해서 그린다 (상품별·문의함 탭).
// extraTabs: 오른쪽 패널 끝에 덧붙일 탭 [{key, label, content}] (문의함의 답변 템플릿 등).
const CSConversation = ({ selected, preview, detail, detailLoading, draft = '', setDraft, acting = false, onReply, onComplete, splitInfo = false, keywordHits = [], extraTabs = [] }) => {
    const [returnOrder, setReturnOrder] = useState(''); // 구매확정 반품 모달에 띄울 주문번호
    const [addressOrder, setAddressOrder] = useState(''); // 주소 변경 모달에 띄울 주문번호
    const [deliveryOpen, setDeliveryOpen] = useState(false); // 배송 확인(전화번호 → 송장번호) 모달
    const [logOpen, setLogOpen] = useState(false); // CS 로그(C/S 이력) 확인 모달
    const [holdOpen, setHoldOpen] = useState(false); // 보류 해제·정상 복귀 모달
    const [exchangeOpen, setExchangeOpen] = useState(false); // 상품 교환(전화번호 → 주문 → 옵션 교환) 모달
    const room = detail?.contact_room;
    const messages = detail?.contact_messages || [];
    const product = room ? roomProduct(preview, detail) : null;
    const stockItems = stockProducts(preview, detail);
    const [lookupAll, setLookupAll] = useState(0); // 값이 바뀔 때마다 모든 상품 재고를 조회
    const [sideTab, setSideTab] = useState('order'); // 상품별 탭 오른쪽 패널: 'order' | 'stock'
    const orderItems = detail?.order_items || [];
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
                    <textarea
                        rows={4}
                        value={draft}
                        placeholder="답변 내용을 입력하세요. (Enter 전송 · Shift+Enter 줄바꿈)"
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                            // 한글 조합 중 Enter는 무시, Shift+Enter는 줄바꿈
                            if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
                            e.preventDefault();
                            if (!acting && draft.trim()) onReply(draft);
                        }}
                        disabled={acting}
                    />
                    <div className={styles.replyActions}>
                        <button
                            type="button"
                            className={styles.btn}
                            disabled={acting || !draft.trim()}
                            onClick={() => onReply(draft)}
                        >
                            {acting ? '처리 중...' : '답변 전송'}
                        </button>
                        <button
                            type="button"
                            className={styles.btn}
                            disabled={acting || ![1, 2].includes(room.status)}
                            onClick={onComplete}
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
            {addressOrder && <CSAddressModal orderNo={addressOrder} onClose={() => setAddressOrder('')} />}
            {logOpen && (
                <CSLogModal phone={room?.member?.mobile || preview?.member?.mobile || ''} onClose={() => setLogOpen(false)} />
            )}
            {holdOpen && (
                <CSHoldModal phone={room?.member?.mobile || preview?.member?.mobile || ''} onClose={() => setHoldOpen(false)} />
            )}
            {exchangeOpen && (
                <CSExchangeModal phone={room?.member?.mobile || preview?.member?.mobile || ''} onClose={() => setExchangeOpen(false)} />
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
                            {[['order', '주문 정보'], ['stock', '재고'], ['action', '작업'], ...extraTabs.map((t) => [t.key, t.label])].map(([key, label]) => (
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
                            <div hidden={sideTab !== 'order'}>
                            {product && (
                                <section className={styles.sideSec}>
                                    <h4>현재 문의 상품</h4>
                                    {product.orderNo && <div className={styles.sideChip}>주문번호 {product.orderNo}</div>}
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
                                                    {optionText(o)} · {o.ea}개 · 주문 {o.order_sno}
                                                </div>
                                                <OrderStatus status={o.status} />
                                            </li>
                                        ))}
                                    </ul>
                                </section>
                            )}
                            {room && <section className={styles.sideSec}>{renderStock('rank')}</section>}
                            </div>
                            <div hidden={sideTab !== 'stock'}>
                                {room && <section className={styles.sideSec}>{renderStock('stock')}</section>}
                            </div>
                            <div hidden={sideTab !== 'action'}>
                                <section className={styles.sideSec}>
                                    <h4>주문 작업</h4>
                                    {product?.orderNo ? (
                                        <div className={styles.actionList}>
                                            <button type="button" className={styles.actionBtn} onClick={() => setAddressOrder(String(product.orderNo))}>
                                                <strong>주소 변경</strong>
                                                <span>주문 {product.orderNo}의 배송지를 이지어드민에서 변경</span>
                                            </button>
                                            <button type="button" className={styles.actionBtn} onClick={() => setReturnOrder(String(product.orderNo))}>
                                                <strong>구매확정 반품</strong>
                                                <span>회수접수 + 회수 문자 + 반품 특이사항 등록</span>
                                            </button>
                                        </div>
                                    ) : (
                                        <div className={styles.sideMuted}>이 문의에 연결된 주문이 없어 작업할 수 없어요.</div>
                                    )}
                                    <div className={styles.actionList} style={{ marginTop: 8 }}>
                                        <button type="button" className={styles.actionBtn} onClick={() => setDeliveryOpen(true)}>
                                            <strong>배송 확인</strong>
                                            <span>고객 전화번호로 주문을 검색해 송장번호 확인</span>
                                        </button>
                                        <button type="button" className={styles.actionBtn} onClick={() => setLogOpen(true)}>
                                            <strong>CS 로그 확인</strong>
                                            <span>전화번호로 주문을 검색해 이지어드민 C/S 이력 확인</span>
                                        </button>
                                        <button type="button" className={styles.actionBtn} onClick={() => setHoldOpen(true)}>
                                            <strong>보류 해제 · 정상 복귀</strong>
                                            <span>전화번호로 주문을 검색해 보류 해제 및 취소·CS 상태를 정상으로 복귀</span>
                                        </button>
                                        <button type="button" className={styles.actionBtn} onClick={() => setExchangeOpen(true)}>
                                            <strong>상품 교환</strong>
                                            <span>전화번호로 주문을 검색해 주문 상품의 옵션을 이지어드민에서 교환</span>
                                        </button>
                                    </div>
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
                                            {o.ea}개 · <OrderStatus status={o.status} /> · 주문 {o.order_sno}
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
