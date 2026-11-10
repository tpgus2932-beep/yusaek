import React, { useMemo, useState } from 'react';
import styles from './Dashboard.module.css';
import { DEV_UPDATES } from '../../data/devUpdates';

const RECENT = 'recent';
const ALL = 'all';
const PREVIEW_COUNT = 5;

// 개발 업데이트: 어떤 기능이 바뀌었는지 비개발자도 알 수 있게 짧게 보여준다.
// 내역은 devUpdates.js에 계속 쌓이고, 날짜를 골라 과거 내용도 볼 수 있다.
export default function DevUpdateCard() {
    const [month, setMonth] = useState(RECENT);
    const [day, setDay] = useState(ALL);
    const months = useMemo(() => [...new Set(DEV_UPDATES.map((u) => u.date.slice(0, 7)))].sort().reverse(), []);
    const days = useMemo(
        () => [...new Set(DEV_UPDATES.filter((u) => u.date.startsWith(month)).map((u) => u.date))].sort().reverse(),
        [month],
    );

    let visible;
    if (month === RECENT) visible = DEV_UPDATES.slice(0, PREVIEW_COUNT);
    else if (day === ALL) visible = DEV_UPDATES.filter((u) => u.date.startsWith(month));
    else visible = DEV_UPDATES.filter((u) => u.date === day);

    const selectProps = { className: styles.select, style: { width: 'auto', fontSize: 13 } };

    return (
        <div className={styles.card}>
            <div className={styles.cardTitle} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                개발 업데이트
                <span style={{ display: 'flex', gap: 6 }}>
                    <select
                        {...selectProps}
                        value={month}
                        onChange={(e) => { setMonth(e.target.value); setDay(ALL); }}
                    >
                        <option value={RECENT}>최근 {PREVIEW_COUNT}건</option>
                        {months.map((m) => (
                            <option key={m} value={m}>{m}</option>
                        ))}
                    </select>
                    {month !== RECENT && (
                        <select {...selectProps} value={day} onChange={(e) => setDay(e.target.value)}>
                            <option value={ALL}>{month} 전체</option>
                            {days.map((d) => (
                                <option key={d} value={d}>{d}</option>
                            ))}
                        </select>
                    )}
                </span>
            </div>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {visible.map((item, idx) => (
                    <li key={`${item.date}-${idx}`} style={{ display: 'flex', gap: 10, fontSize: 14 }}>
                        <span className={styles.mutedText} style={{ flexShrink: 0 }}>{item.date.slice(5)}</span>
                        <span>{item.text}</span>
                    </li>
                ))}
            </ul>
        </div>
    );
}
