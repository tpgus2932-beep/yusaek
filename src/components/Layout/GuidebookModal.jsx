import { useState, useEffect, useRef, useCallback } from 'react';
import { X, Plus, Trash2, Edit2, Search, FolderPlus, Image, ChevronRight, ChevronDown, Save, BookOpen } from 'lucide-react';
import { COLLAB_API_BASE, getAuthHeaders } from '../../lib/api';
import styles from './GuidebookModal.module.css';

const GuidebookModal = ({ onClose }) => {
    const [categories, setCategories] = useState([]);
    const [selectedPageId, setSelectedPageId] = useState(null);
    const [pageContent, setPageContent] = useState(null);
    const [loading, setLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState(null);
    const [expandedCats, setExpandedCats] = useState({});
    const [editMode, setEditMode] = useState(false);
    const [editTitle, setEditTitle] = useState('');
    const [editContent, setEditContent] = useState('');
    const [saving, setSaving] = useState(false);

    // 카테고리 편집
    const [showCatInput, setShowCatInput] = useState(false);
    const [newCatTitle, setNewCatTitle] = useState('');
    const [editingCatId, setEditingCatId] = useState(null);
    const [editingCatTitle, setEditingCatTitle] = useState('');

    // 페이지 추가
    const [addingPageCatId, setAddingPageCatId] = useState(null);
    const [newPageTitle, setNewPageTitle] = useState('');

    const editorRef = useRef(null);
    const fileInputRef = useRef(null);
    const searchTimerRef = useRef(null);

    const fetchCategories = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch(`${COLLAB_API_BASE}/guidebook/categories`, {
                headers: getAuthHeaders(),
            });
            if (!res.ok) throw new Error();
            const data = await res.json();
            setCategories(data);
            // 처음 로드할 때만 전체 펼치기 (이후에는 사용자 설정 유지)
            setExpandedCats((prev) => {
                if (Object.keys(prev).length > 0) return prev;
                const init = {};
                data.forEach((c) => { if (c.id) init[c.id] = true; });
                return init;
            });
        } catch {
            // ignore
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchCategories();
    }, [fetchCategories]);

    const loadPage = async (id) => {
        if (!id) return;
        setEditMode(false);
        try {
            const res = await fetch(`${COLLAB_API_BASE}/guidebook/pages/${id}`, {
                headers: getAuthHeaders(),
            });
            if (!res.ok) throw new Error();
            const data = await res.json();
            setPageContent(data);
            setSelectedPageId(id);
        } catch {
            // ignore
        }
    };

    const handleSearch = (q) => {
        setSearchQuery(q);
        clearTimeout(searchTimerRef.current);
        if (!q.trim()) {
            setSearchResults(null);
            return;
        }
        searchTimerRef.current = setTimeout(async () => {
            try {
                const res = await fetch(
                    `${COLLAB_API_BASE}/guidebook/search?q=${encodeURIComponent(q)}`,
                    { headers: getAuthHeaders() }
                );
                if (!res.ok) throw new Error();
                setSearchResults(await res.json());
            } catch {
                setSearchResults([]);
            }
        }, 300);
    };

    const toggleCat = (id) => {
        setExpandedCats((prev) => ({ ...prev, [id]: !prev[id] }));
    };

    // ── 카테고리 CRUD ──────────────────────────────────────────────────────

    const createCategory = async () => {
        const title = newCatTitle.trim();
        if (!title) return;
        try {
            const res = await fetch(`${COLLAB_API_BASE}/guidebook/categories`, {
                method: 'POST',
                headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ title }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data?.detail || `HTTP ${res.status} — ${res.url}`);
            }
            const created = await res.json();
            setNewCatTitle('');
            setShowCatInput(false);
            // 새 카테고리 즉시 펼침
            setExpandedCats((prev) => ({ ...prev, [created.id]: true }));
            await fetchCategories();
        } catch (err) {
            alert(`카테고리 추가 실패: ${err.message}`);
        }
    };

    const saveCategory = async (id) => {
        const title = editingCatTitle.trim();
        if (!title) return;
        await fetch(`${COLLAB_API_BASE}/guidebook/categories/${id}`, {
            method: 'PATCH',
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ title }),
        });
        setEditingCatId(null);
        fetchCategories();
    };

    const deleteCategory = async (id) => {
        if (!confirm('카테고리를 삭제하면 소속 페이지가 미분류로 이동합니다. 계속할까요?')) return;
        await fetch(`${COLLAB_API_BASE}/guidebook/categories/${id}`, {
            method: 'DELETE',
            headers: getAuthHeaders(),
        });
        fetchCategories();
    };

    // ── 페이지 CRUD ──────────────────────────────────────────────────────────

    const createPage = async (catId) => {
        const title = newPageTitle.trim();
        if (!title) return;
        const res = await fetch(`${COLLAB_API_BASE}/guidebook/pages`, {
            method: 'POST',
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, category_id: catId || null, content: '' }),
        });
        const data = await res.json();
        setNewPageTitle('');
        setAddingPageCatId(null);
        await fetchCategories();
        loadPage(data.id);
    };

    const savePage = async () => {
        if (!pageContent) return;
        setSaving(true);
        try {
            await fetch(`${COLLAB_API_BASE}/guidebook/pages/${pageContent.id}`, {
                method: 'PATCH',
                headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: editTitle, content: editContent }),
            });
            await fetchCategories();
            await loadPage(pageContent.id);
            setEditMode(false);
        } finally {
            setSaving(false);
        }
    };

    const deletePage = async (id) => {
        if (!confirm('페이지를 삭제할까요?')) return;
        await fetch(`${COLLAB_API_BASE}/guidebook/pages/${id}`, {
            method: 'DELETE',
            headers: getAuthHeaders(),
        });
        setPageContent(null);
        setSelectedPageId(null);
        fetchCategories();
    };

    const enterEdit = () => {
        setEditTitle(pageContent.title);
        setEditContent(pageContent.content || '');
        setEditMode(true);
    };

    // ── 이미지 업로드 ────────────────────────────────────────────────────────

    const insertImage = async (file) => {
        const form = new FormData();
        form.append('file', file);
        try {
            const res = await fetch(`${COLLAB_API_BASE}/guidebook/images`, {
                method: 'POST',
                headers: getAuthHeaders(),
                body: form,
            });
            const data = await res.json();
            const imgTag = `\n![${file.name}](${COLLAB_API_BASE}${data.url})\n`;
            setEditContent((prev) => prev + imgTag);
        } catch {
            alert('이미지 업로드 실패');
        }
    };

    const handleImagePaste = (e) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        for (const item of items) {
            if (item.type.startsWith('image/')) {
                e.preventDefault();
                const file = item.getAsFile();
                if (file) insertImage(file);
                return;
            }
        }
    };

    // ── 마크다운 렌더 (간단) ─────────────────────────────────────────────────

    const renderMarkdown = (text) => {
        if (!text) return '';
        let html = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

        // 이미지 ![]()
        html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) =>
            `<img src="${src}" alt="${alt}" style="max-width:100%;border-radius:6px;margin:8px 0;" />`
        );
        // 링크
        html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
        // 제목
        html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
        html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
        html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
        // 굵게, 이탤릭
        html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
        // 인라인 코드
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
        // 코드 블록
        html = html.replace(/```[\s\S]*?```/g, (m) => {
            const inner = m.slice(3, -3).replace(/^\n/, '');
            return `<pre><code>${inner}</code></pre>`;
        });
        // 줄바꿈
        html = html.replace(/\n/g, '<br />');
        return html;
    };

    // ── 사이드바 렌더 ────────────────────────────────────────────────────────

    const renderSidebar = () => {
        const list = searchResults
            ? searchResults.map((r) => (
                <div
                    key={r.id}
                    className={`${styles.pageItem} ${selectedPageId === r.id ? styles.active : ''}`}
                    onClick={() => { setSearchResults(null); setSearchQuery(''); loadPage(r.id); }}
                >
                    <span className={styles.pageTitle}>{r.title}</span>
                    {r.category_title && <span className={styles.catTag}>{r.category_title}</span>}
                </div>
            ))
            : null;

        if (list) {
            return (
                <div className={styles.searchResultList}>
                    <div className={styles.searchResultHeader}>검색 결과 {list.length}건</div>
                    {list.length === 0 ? <div className={styles.empty}>결과 없음</div> : list}
                </div>
            );
        }

        return categories.map((cat) => (
            <div key={cat.id ?? 'uncategorized'} className={styles.catBlock}>
                <div className={styles.catRow}>
                    {cat.id ? (
                        <button className={styles.catToggle} onClick={() => toggleCat(cat.id)}>
                            {expandedCats[cat.id] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                    ) : (
                        <span className={styles.catTogglePlaceholder} />
                    )}

                    {editingCatId === cat.id ? (
                        <input
                            className={styles.catEditInput}
                            value={editingCatTitle}
                            autoFocus
                            onChange={(e) => setEditingCatTitle(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') saveCategory(cat.id);
                                if (e.key === 'Escape') setEditingCatId(null);
                            }}
                            onBlur={() => saveCategory(cat.id)}
                        />
                    ) : (
                        <span className={styles.catTitle}>{cat.title}</span>
                    )}

                    <div className={styles.catActions}>
                        <button
                            className={styles.iconBtn}
                            title="페이지 추가"
                            onClick={() => { setAddingPageCatId(cat.id); setExpandedCats((p) => ({ ...p, [cat.id]: true })); }}
                        >
                            <Plus size={13} />
                        </button>
                        {cat.id && (
                            <>
                                <button
                                    className={styles.iconBtn}
                                    title="카테고리 이름 수정"
                                    onClick={() => { setEditingCatId(cat.id); setEditingCatTitle(cat.title); }}
                                >
                                    <Edit2 size={13} />
                                </button>
                                <button
                                    className={styles.iconBtn}
                                    title="카테고리 삭제"
                                    onClick={() => deleteCategory(cat.id)}
                                >
                                    <Trash2 size={13} />
                                </button>
                            </>
                        )}
                    </div>
                </div>

                {(cat.id == null || expandedCats[cat.id]) && (
                    <div className={styles.pageList}>
                        {addingPageCatId === cat.id && (
                            <div className={styles.newPageRow}>
                                <input
                                    autoFocus
                                    placeholder="페이지 제목"
                                    value={newPageTitle}
                                    onChange={(e) => setNewPageTitle(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') createPage(cat.id);
                                        if (e.key === 'Escape') { setAddingPageCatId(null); setNewPageTitle(''); }
                                    }}
                                    onBlur={() => { if (!newPageTitle.trim()) { setAddingPageCatId(null); setNewPageTitle(''); } }}
                                />
                            </div>
                        )}
                        {cat.pages.map((p) => (
                            <div
                                key={p.id}
                                className={`${styles.pageItem} ${selectedPageId === p.id ? styles.active : ''}`}
                                onClick={() => loadPage(p.id)}
                            >
                                <span className={styles.pageTitle}>{p.title}</span>
                            </div>
                        ))}
                        {cat.pages.length === 0 && addingPageCatId !== cat.id && (
                            <div className={styles.emptyPages}>페이지 없음</div>
                        )}
                    </div>
                )}
            </div>
        ));
    };

    return (
        <div className={styles.overlay} onClick={onClose}>
            <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
                {/* Header */}
                <div className={styles.modalHeader}>
                    <div className={styles.modalHeaderLeft}>
                        <BookOpen size={20} />
                        <span className={styles.modalTitle}>가이드북</span>
                    </div>
                    <button className={styles.closeBtn} onClick={onClose}><X size={20} /></button>
                </div>

                <div className={styles.body}>
                    {/* Sidebar */}
                    <aside className={styles.sidebar}>
                        {/* Search */}
                        <div className={styles.searchWrap}>
                            <Search size={14} className={styles.searchIcon} />
                            <input
                                className={styles.searchInput}
                                placeholder="페이지 검색..."
                                value={searchQuery}
                                onChange={(e) => handleSearch(e.target.value)}
                            />
                            {searchQuery && (
                                <button className={styles.clearSearch} onClick={() => { setSearchQuery(''); setSearchResults(null); }}>
                                    <X size={12} />
                                </button>
                            )}
                        </div>

                        {/* Category list */}
                        <div className={styles.catList}>
                            {loading ? (
                                <div className={styles.loadingText}>불러오는 중...</div>
                            ) : (
                                renderSidebar()
                            )}
                        </div>

                        {/* Add category */}
                        <div className={styles.sidebarFooter}>
                            {showCatInput ? (
                                <div className={styles.newCatRow}>
                                    <input
                                        autoFocus
                                        placeholder="카테고리 이름"
                                        value={newCatTitle}
                                        onChange={(e) => setNewCatTitle(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') createCategory();
                                            if (e.key === 'Escape') { setShowCatInput(false); setNewCatTitle(''); }
                                        }}
                                    />
                                    <button onClick={createCategory}><Plus size={14} /></button>
                                </div>
                            ) : (
                                <button className={styles.addCatBtn} onClick={() => setShowCatInput(true)}>
                                    <FolderPlus size={14} /> 카테고리 추가
                                </button>
                            )}
                        </div>
                    </aside>

                    {/* Content */}
                    <main className={styles.content}>
                        {pageContent ? (
                            editMode ? (
                                <div className={styles.editor}>
                                    <div className={styles.editorToolbar}>
                                        <input
                                            className={styles.titleInput}
                                            value={editTitle}
                                            onChange={(e) => setEditTitle(e.target.value)}
                                            placeholder="페이지 제목"
                                        />
                                        <div className={styles.editorBtns}>
                                            <button
                                                className={styles.iconBtnLg}
                                                title="이미지 삽입"
                                                onClick={() => fileInputRef.current?.click()}
                                            >
                                                <Image size={16} /> 이미지
                                            </button>
                                            <input
                                                ref={fileInputRef}
                                                type="file"
                                                accept="image/*"
                                                style={{ display: 'none' }}
                                                onChange={(e) => {
                                                    const f = e.target.files?.[0];
                                                    if (f) insertImage(f);
                                                    e.target.value = '';
                                                }}
                                            />
                                            <button className={styles.cancelBtn} onClick={() => setEditMode(false)}>취소</button>
                                            <button className={styles.saveBtn} onClick={savePage} disabled={saving}>
                                                <Save size={14} /> {saving ? '저장 중...' : '저장'}
                                            </button>
                                        </div>
                                    </div>
                                    <textarea
                                        ref={editorRef}
                                        className={styles.textarea}
                                        value={editContent}
                                        onChange={(e) => setEditContent(e.target.value)}
                                        onPaste={handleImagePaste}
                                        placeholder="마크다운으로 내용을 입력하세요.
# 제목1  ## 제목2
**굵게**  *이탤릭*
![이미지설명](URL)  또는 이미지 붙여넣기
```코드블록```"
                                    />
                                    <div className={styles.editorHint}>
                                        이미지: 버튼으로 업로드하거나 클립보드에서 붙여넣기 (Ctrl+V)
                                    </div>
                                </div>
                            ) : (
                                <div className={styles.viewer}>
                                    <div className={styles.viewerHeader}>
                                        <h2 className={styles.viewerTitle}>{pageContent.title}</h2>
                                        <div className={styles.viewerBtns}>
                                            <button className={styles.iconBtnLg} onClick={enterEdit}>
                                                <Edit2 size={15} /> 편집
                                            </button>
                                            <button
                                                className={`${styles.iconBtnLg} ${styles.dangerBtn}`}
                                                onClick={() => deletePage(pageContent.id)}
                                            >
                                                <Trash2 size={15} /> 삭제
                                            </button>
                                        </div>
                                    </div>
                                    <div
                                        className={styles.viewerBody}
                                        dangerouslySetInnerHTML={{ __html: renderMarkdown(pageContent.content) }}
                                    />
                                </div>
                            )
                        ) : (
                            <div className={styles.placeholder}>
                                <BookOpen size={48} />
                                <p>왼쪽에서 페이지를 선택하거나 새 페이지를 만드세요.</p>
                            </div>
                        )}
                    </main>
                </div>
            </div>
        </div>
    );
};

export default GuidebookModal;
