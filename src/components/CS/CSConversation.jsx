import { useState } from 'react';
import styles from './CSPage.module.css';
import CSStock from './CSStock';
import CSAddressModal from './CSAddressModal';

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
    const add = (entry) => {
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

// 문의 대화 패널 (문의함 / 상품별 탭 공용)
const CSConversation = ({ selected, preview, detail, detailLoading }) => {
    const [addressOrder, setAddressOrder] = useState(''); // 주소 변경 모달에 띄울 주문번호
    const room = detail?.contact_room;
    const messages = detail?.contact_messages || [];
    const product = room ? roomProduct(preview, detail) : null;
    const stockItems = stockProducts(preview, detail);
    const [lookupAll, setLookupAll] = useState(0); // 값이 바뀔 때마다 모든 상품 재고를 조회

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
                            {product?.orderNo && (
                                <button type="button" className={styles.linkBtn} onClick={() => setAddressOrder(String(product.orderNo))}>
                                    이 주문 주소 변경 ({product.orderNo})
                                </button>
                            )}
                            {room.order_item?.receiver_address && (
                                <div>
                                    수령: {room.order_item.receiver_address.receiver_name} /{' '}
                                    {room.order_item.receiver_address.receiver_tel} /{' '}
                                    {room.order_item.receiver_address.receiver_addr}
                                </div>
                            )}
                            {(detail.order_items || []).length > 0 && (
                                <ul className={styles.orders}>
                                    {detail.order_items.map((o) => (
                                        <li key={o.sno}>
                                            {o.goods?.name} · {(o.options || []).join(' / ') || [o.option1, o.option2].filter(Boolean).join(' / ')} ·{' '}
                                            {o.ea}개 · {o.status} · 주문 {o.order_sno}
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </section>
                        {stockItems.length > 1 && (
                            <div className={styles.stockAllBar}>
                                <strong>준비중 상품 {stockItems.length}개 재고</strong>
                                <button type="button" className={styles.linkBtn} onClick={() => setLookupAll((n) => n + 1)}>
                                    전체 재고 조회
                                </button>
                            </div>
                        )}
                        {stockItems.map((item) => (
                            <CSStock
                                key={item.key}
                                goods={item.goods}
                                asked={item.asked}
                                orderNo={item.orderNo}
                                title={stockItems.length > 1 ? `${item.goods.name}${item.orderNo ? ` · 주문 ${item.orderNo}` : ''}` : ''}
                                lookupSignal={lookupAll}
                            />
                        ))}
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
                    </>
                )}
            {addressOrder && <CSAddressModal orderNo={addressOrder} onClose={() => setAddressOrder('')} />}
        </>
    );
};

export default CSConversation;
