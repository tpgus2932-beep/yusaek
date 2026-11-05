import { useEffect, useMemo, useState } from 'react';
import styles from './CSPage.module.css';

const STORAGE_KEY = 'csActionGroups';

const loadGroups = () => {
    try {
        const v = JSON.parse(localStorage.getItem(STORAGE_KEY));
        if (!Array.isArray(v)) return [];
        return v.filter((g) => g && typeof g.id === 'string' && typeof g.name === 'string' && Array.isArray(g.ids));
    } catch {
        return [];
    }
};

// 작업 탭의 버튼 목록. 버튼을 선택해 그룹으로 묶고, 그룹은 접고 펼칠 수 있다 (브라우저에 저장).
// actions: [{ id, title, desc, onClick }]
const CSActionPanel = ({ actions }) => {
    const [groups, setGroups] = useState(loadGroups);
    const [editing, setEditing] = useState(false);
    const [checked, setChecked] = useState(() => new Set());

    useEffect(() => {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(groups));
        } catch { /* 저장 실패는 무시 */ }
    }, [groups]);

    const byId = useMemo(() => new Map(actions.map((a) => [a.id, a])), [actions]);
    const groupedIds = useMemo(() => new Set(groups.flatMap((g) => g.ids)), [groups]);
    const loose = actions.filter((a) => !groupedIds.has(a.id));

    const toggleCheck = (id) => {
        setChecked((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const stopEditing = () => {
        setEditing(false);
        setChecked(new Set());
    };

    const makeGroup = () => {
        if (checked.size === 0) return;
        const name = window.prompt('그룹 이름을 입력하세요', '');
        if (!name || !name.trim()) return;
        const picked = [...checked];
        setGroups((prev) => [
            // 다른 그룹에 있던 버튼은 새 그룹으로 옮기고, 비어버린 그룹은 없앤다
            ...prev.map((g) => ({ ...g, ids: g.ids.filter((id) => !checked.has(id)) })).filter((g) => g.ids.length > 0),
            { id: `g${Date.now()}`, name: name.trim(), ids: picked, open: true },
        ]);
        stopEditing();
    };

    const ungroup = (gid) => setGroups((prev) => prev.filter((g) => g.id !== gid));
    const toggleOpen = (gid) => setGroups((prev) => prev.map((g) => (g.id === gid ? { ...g, open: g.open === false } : g)));
    const renameGroup = (g) => {
        const name = window.prompt('그룹 이름', g.name);
        if (name && name.trim()) setGroups((prev) => prev.map((x) => (x.id === g.id ? { ...x, name: name.trim() } : x)));
    };

    const renderAction = (a) => {
        const body = (
            <>
                <strong>{a.title}</strong>
                <span>{a.desc}</span>
            </>
        );
        if (!editing) {
            return (
                <button key={a.id} type="button" className={styles.actionBtn} onClick={a.onClick}>
                    {body}
                </button>
            );
        }
        return (
            <label key={a.id} className={`${styles.actionBtn} ${styles.actionPick}`}>
                <input type="checkbox" checked={checked.has(a.id)} onChange={() => toggleCheck(a.id)} />
                <div className={styles.actionPickBody}>{body}</div>
            </label>
        );
    };

    return (
        <>
            <div className={styles.actionToolbar}>
                {editing ? (
                    <>
                        <button type="button" className={styles.keywordAdd} disabled={checked.size === 0} onClick={makeGroup}>
                            그룹으로 묶기 ({checked.size})
                        </button>
                        <button type="button" className={styles.linkBtn} onClick={stopEditing}>완료</button>
                    </>
                ) : (
                    <button type="button" className={styles.linkBtn} onClick={() => setEditing(true)}>그룹 편집</button>
                )}
            </div>
            {editing && <div className={styles.sideMuted}>묶을 작업을 체크하고 &lsquo;그룹으로 묶기&rsquo;를 누르세요.</div>}
            {groups.map((g) => {
                const items = g.ids.map((id) => byId.get(id)).filter(Boolean);
                if (items.length === 0) return null;
                const open = g.open !== false;
                return (
                    <div key={g.id} className={styles.actionGroup}>
                        <div className={styles.actionGroupHead}>
                            <button type="button" className={styles.actionGroupToggle} onClick={() => toggleOpen(g.id)}>
                                <span>{open ? '▾' : '▸'} {g.name}</span>
                                <span className={styles.sideMuted}>{items.length}개</span>
                            </button>
                            {editing && (
                                <>
                                    <button type="button" className={styles.linkBtn} onClick={() => renameGroup(g)}>이름</button>
                                    <button type="button" className={styles.linkBtn} onClick={() => ungroup(g.id)}>해제</button>
                                </>
                            )}
                        </div>
                        {(open || editing) && <div className={styles.actionList}>{items.map(renderAction)}</div>}
                    </div>
                );
            })}
            {loose.length > 0 && <div className={styles.actionList} style={{ marginTop: groups.length ? 8 : 0 }}>{loose.map(renderAction)}</div>}
        </>
    );
};

export default CSActionPanel;
