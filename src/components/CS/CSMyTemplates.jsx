import { useCallback, useEffect, useState } from 'react';
import { Copy, Pencil, Plus, Trash2 } from 'lucide-react';
import styles from './CSPage.module.css';

// 상품별 탭 전용 답변 템플릿. 에이블리 템플릿과 별개로 서버 DB에 저장돼 모두가 같이 쓰고, 추가·수정·삭제가 가능하다.
// api(path, params, method, body): CSPage 의 /cs 호출 함수
const CSMyTemplates = ({ api, onPick }) => {
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [editing, setEditing] = useState(null); // { id, title, content } — id가 null 이면 새 템플릿
    const [error, setError] = useState('');

    const load = useCallback(async () => {
        try {
            const d = await api('/my-templates');
            setItems(d.templates || []);
            setError('');
        } catch (e) {
            setError(e.message || '템플릿을 불러오지 못했어요.');
        } finally {
            setLoading(false);
        }
    }, [api]);

    useEffect(() => {
        load();
    }, [load]);

    const startAdd = () => {
        setError('');
        setEditing({ id: null, title: '', content: '' });
    };

    const save = async () => {
        const title = editing.title.trim();
        const content = editing.content.trim();
        if (!title || !content) {
            setError('이름과 내용을 모두 입력하세요.');
            return;
        }
        setSaving(true);
        try {
            if (editing.id) await api(`/my-templates/${editing.id}`, null, 'PUT', { title, content });
            else await api('/my-templates', null, 'POST', { title, content });
            setEditing(null);
            await load();
        } catch (e) {
            setError(e.message || '저장하지 못했어요.');
        } finally {
            setSaving(false);
        }
    };

    const remove = async (t) => {
        if (!window.confirm(`'${t.title}' 템플릿을 삭제할까요?`)) return;
        try {
            await api(`/my-templates/${t.id}`, null, 'DELETE');
            await load();
        } catch (e) {
            setError(e.message || '삭제하지 못했어요.');
        }
    };

    const editor = editing && (
        <div className={styles.tplEditor}>
            <input
                value={editing.title}
                placeholder="템플릿 이름"
                onChange={(e) => setEditing({ ...editing, title: e.target.value })}
            />
            <textarea
                rows={6}
                value={editing.content}
                placeholder="답변 내용"
                onChange={(e) => setEditing({ ...editing, content: e.target.value })}
            />
            {error && <div className={styles.tplError}>{error}</div>}
            <div className={styles.tplEditorBtns}>
                <button type="button" className={styles.btn} onClick={save} disabled={saving}>저장</button>
                <button type="button" className={styles.btn} onClick={() => { setEditing(null); setError(''); }}>취소</button>
            </div>
        </div>
    );

    return (
        <section className={styles.sideSec}>
            <div className={styles.tplHeadRow}>
                <h4>내 답변 템플릿</h4>
                {!editing && (
                    <button type="button" className={styles.keywordAdd} onClick={startAdd}>
                        <Plus size={11} /> 추가
                    </button>
                )}
            </div>
            <p className={styles.hint}>클릭하면 복사되고 답변 입력창에 들어갑니다. (모든 직원이 같이 써요)</p>
            {!editing && error && <div className={styles.tplError}>{error}</div>}
            {editing && !editing.id && editor}
            {loading && <div className={styles.empty}>불러오는 중...</div>}
            {!loading && items.length === 0 && !editing && <div className={styles.empty}>템플릿이 없어요. 추가 버튼으로 만들어 보세요.</div>}
            {items.map((t) => (
                editing?.id === t.id ? (
                    <div key={t.id}>{editor}</div>
                ) : (
                    <div key={t.id} className={styles.tplRow}>
                        <button type="button" className={styles.tpl} onClick={() => onPick(t.content)}>
                            <div className={styles.tplTitle}><Copy size={12} /> {t.title}</div>
                            <div className={styles.tplBody}>{t.content}</div>
                        </button>
                        <div className={styles.tplActions}>
                            <button type="button" aria-label={`${t.title} 수정`} onClick={() => { setError(''); setEditing({ ...t }); }}><Pencil size={13} /></button>
                            <button type="button" aria-label={`${t.title} 삭제`} onClick={() => remove(t)}><Trash2 size={13} /></button>
                        </div>
                    </div>
                )
            ))}
        </section>
    );
};

export default CSMyTemplates;
