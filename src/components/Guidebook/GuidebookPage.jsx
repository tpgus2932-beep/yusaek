import { useState, useEffect, useRef, useCallback } from 'react';
import { Plus, Trash2, Edit2, Search, FolderPlus, Image, ChevronRight, ChevronDown, Save, BookOpen, X } from 'lucide-react';
import { COLLAB_API_BASE, getAuthHeaders } from '../../lib/api';
import styles from './GuidebookPage.module.css';
import ImageAnnotator from './ImageAnnotator';

const GuidebookPage = () => {
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
    const [annotTarget, setAnnotTarget] = useState(null); // 주석 편집 중인 img 요소

    const [showCatInput, setShowCatInput] = useState(false);
    const [newCatTitle, setNewCatTitle] = useState('');
    const [editingCatId, setEditingCatId] = useState(null);
    const [editingCatTitle, setEditingCatTitle] = useState('');
    const [addingPageCatId, setAddingPageCatId] = useState(null);
    const [newPageTitle, setNewPageTitle] = useState('');

    const editorRef = useRef(null);   // contenteditable div
    const fileInputRef = useRef(null);
    const searchTimerRef = useRef(null);

    const fetchCategories = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch(`${COLLAB_API_BASE}/guidebook/categories`, { headers: getAuthHeaders() });
            if (!res.ok) throw new Error();
            const data = await res.json();
            setCategories(data);
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

    useEffect(() => { fetchCategories(); }, [fetchCategories]);

    const loadPage = async (id) => {
        if (!id) return;
        setEditMode(false);
        try {
            const res = await fetch(`${COLLAB_API_BASE}/guidebook/pages/${id}`, { headers: getAuthHeaders() });
            if (!res.ok) throw new Error();
            const data = await res.json();
            setPageContent(data);
            setSelectedPageId(id);
        } catch { /* ignore */ }
    };

    const handleSearch = (q) => {
        setSearchQuery(q);
        clearTimeout(searchTimerRef.current);
        if (!q.trim()) { setSearchResults(null); return; }
        searchTimerRef.current = setTimeout(async () => {
            try {
                const res = await fetch(`${COLLAB_API_BASE}/guidebook/search?q=${encodeURIComponent(q)}`, { headers: getAuthHeaders() });
                if (!res.ok) throw new Error();
                setSearchResults(await res.json());
            } catch { setSearchResults([]); }
        }, 300);
    };

    const toggleCat = (id) => setExpandedCats((prev) => ({ ...prev, [id]: !prev[id] }));

    // ── 카테고리 CRUD ──────────────────────────────────────────────────────────
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
                const d = await res.json().catch(() => ({}));
                throw new Error(d?.detail || `HTTP ${res.status}`);
            }
            const created = await res.json();
            setNewCatTitle('');
            setShowCatInput(false);
            setExpandedCats((prev) => ({ ...prev, [created.id]: true }));
            await fetchCategories();
        } catch (err) { alert(`카테고리 추가 실패: ${err.message}`); }
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
        await fetch(`${COLLAB_API_BASE}/guidebook/categories/${id}`, { method: 'DELETE', headers: getAuthHeaders() });
        fetchCategories();
    };

    // ── 페이지 CRUD ────────────────────────────────────────────────────────────
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
        } finally { setSaving(false); }
    };

    const deletePage = async (id) => {
        if (!confirm('페이지를 삭제할까요?')) return;
        await fetch(`${COLLAB_API_BASE}/guidebook/pages/${id}`, { method: 'DELETE', headers: getAuthHeaders() });
        setPageContent(null);
        setSelectedPageId(null);
        fetchCategories();
    };

    const enterEdit = () => {
        setEditTitle(pageContent.title);
        setEditContent(pageContent.content || '');
        setEditMode(true);
    };

    // 편집 모드 진입 시 contenteditable div에 내용 세팅
    useEffect(() => {
        if (editMode && editorRef.current) {
            editorRef.current.innerHTML = editContent;
            editorRef.current.focus();
        }
    // editContent 의존성 제거 — 진입할 때 한 번만
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editMode]);

    // ── 이미지 업로드 ──────────────────────────────────────────────────────────
    const insertImage = async (file) => {
        const form = new FormData();
        form.append('file', file);
        try {
            const res = await fetch(`${COLLAB_API_BASE}/guidebook/images`, {
                method: 'POST', headers: getAuthHeaders(), body: form,
            });
            const data = await res.json();
            const imgTag = `<img src="${COLLAB_API_BASE}${data.url}" alt="${file.name}" style="max-width:100%;border-radius:6px;margin:8px 0;" />`;
            document.execCommand('insertHTML', false, imgTag);
            if (editorRef.current) setEditContent(editorRef.current.innerHTML);
        } catch { alert('이미지 업로드 실패'); }
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

    // ── 선택 영역에 span 서식 적용 (선택 없으면 커서 위치에 삽입 후 그 안에서 입력) ──
    const applySpan = (styleKey, styleVal) => {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);
        const span = document.createElement('span');
        span.style[styleKey] = styleVal;

        if (sel.isCollapsed) {
            // 선택 없음 → 빈 span 삽입 후 커서를 그 안에 위치
            const ZWS = '​'; // zero-width space
            span.textContent = ZWS;
            range.insertNode(span);
            const newRange = document.createRange();
            newRange.setStart(span.firstChild, 1); // zero-width space 뒤에 커서
            newRange.collapse(true);
            sel.removeAllRanges();
            sel.addRange(newRange);
        } else {
            // 텍스트 선택됨 → 선택 영역을 span으로 감쌈
            try {
                range.surroundContents(span);
            } catch {
                const frag = range.extractContents();
                span.appendChild(frag);
                range.insertNode(span);
            }
            sel.removeAllRanges();
        }

        editorRef.current?.focus();
        if (editorRef.current) setEditContent(editorRef.current.innerHTML);
    };

    const applyColor = (color) => applySpan('color', color);
    const applySize  = (size)  => applySpan('fontSize', `${size}pt`);


    // ── 사이드바 렌더 ──────────────────────────────────────────────────────────
    const renderSidebar = () => {
        if (searchResults) {
            return (
                <div className={styles.searchResultList}>
                    <div className={styles.searchResultHeader}>검색 결과 {searchResults.length}건</div>
                    {searchResults.length === 0
                        ? <div className={styles.empty}>결과 없음</div>
                        : searchResults.map((r) => (
                            <div key={r.id}
                                className={`${styles.pageItem} ${selectedPageId === r.id ? styles.active : ''}`}
                                onClick={() => { setSearchResults(null); setSearchQuery(''); loadPage(r.id); }}>
                                <span className={styles.pageTitle}>{r.title}</span>
                                {r.category_title && <span className={styles.catTag}>{r.category_title}</span>}
                            </div>
                        ))
                    }
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
                    ) : <span className={styles.catTogglePlaceholder} />}

                    {editingCatId === cat.id ? (
                        <input className={styles.catEditInput} value={editingCatTitle} autoFocus
                            onChange={(e) => setEditingCatTitle(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') saveCategory(cat.id);
                                if (e.key === 'Escape') setEditingCatId(null);
                            }}
                            onBlur={() => saveCategory(cat.id)} />
                    ) : (
                        <span className={styles.catTitle}>{cat.title}</span>
                    )}

                    <div className={styles.catActions}>
                        <button className={styles.iconBtn} title="페이지 추가"
                            onClick={() => { setAddingPageCatId(cat.id); setExpandedCats((p) => ({ ...p, [cat.id]: true })); }}>
                            <Plus size={13} />
                        </button>
                        {cat.id && (
                            <>
                                <button className={styles.iconBtn} title="카테고리 이름 수정"
                                    onClick={() => { setEditingCatId(cat.id); setEditingCatTitle(cat.title); }}>
                                    <Edit2 size={13} />
                                </button>
                                <button className={styles.iconBtn} title="카테고리 삭제"
                                    onClick={() => deleteCategory(cat.id)}>
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
                                <input autoFocus placeholder="페이지 제목" value={newPageTitle}
                                    onChange={(e) => setNewPageTitle(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') createPage(cat.id);
                                        if (e.key === 'Escape') { setAddingPageCatId(null); setNewPageTitle(''); }
                                    }}
                                    onBlur={() => { if (!newPageTitle.trim()) { setAddingPageCatId(null); setNewPageTitle(''); } }} />
                            </div>
                        )}
                        {cat.pages.map((p) => (
                            <div key={p.id}
                                className={`${styles.pageItem} ${selectedPageId === p.id ? styles.active : ''}`}
                                onClick={() => loadPage(p.id)}>
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

    const handleAnnotSave = (dataUrl) => {
        if (!annotTarget) return;
        annotTarget.src = dataUrl;
        setAnnotTarget(null);
        if (editorRef.current) setEditContent(editorRef.current.innerHTML);
    };

    return (
        <>
        {annotTarget && (
            <ImageAnnotator
                src={annotTarget.src}
                onSave={handleAnnotSave}
                onCancel={() => setAnnotTarget(null)}
            />
        )}
        <div className={styles.page}>
            {/* 사이드바 */}
            <aside className={styles.sidebar}>
                <div className={styles.sidebarHeader}>
                    <div className={styles.sidebarLogo}><BookOpen size={16} /></div>
                    <span className={styles.sidebarTitle}>가이드북</span>
                </div>

                <div className={styles.searchWrap}>
                    <Search size={14} className={styles.searchIcon} />
                    <input className={styles.searchInput} placeholder="페이지 검색..."
                        value={searchQuery} onChange={(e) => handleSearch(e.target.value)} />
                    {searchQuery && (
                        <button className={styles.clearSearch}
                            onClick={() => { setSearchQuery(''); setSearchResults(null); }}>
                            <X size={12} />
                        </button>
                    )}
                </div>

                <div className={styles.catList}>
                    {loading
                        ? <div className={styles.loadingText}>불러오는 중...</div>
                        : renderSidebar()
                    }
                </div>

                <div className={styles.sidebarFooter}>
                    {showCatInput ? (
                        <div className={styles.newCatRow}>
                            <input autoFocus placeholder="카테고리 이름" value={newCatTitle}
                                onChange={(e) => setNewCatTitle(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') createCategory();
                                    if (e.key === 'Escape') { setShowCatInput(false); setNewCatTitle(''); }
                                }} />
                            <button onClick={createCategory}><Plus size={14} /></button>
                        </div>
                    ) : (
                        <button className={styles.addCatBtn} onClick={() => setShowCatInput(true)}>
                            <FolderPlus size={14} /> 카테고리 추가
                        </button>
                    )}
                </div>
            </aside>

            {/* 본문 */}
            <main className={styles.content}>
                {pageContent ? (
                    editMode ? (
                        <div className={styles.editor}>
                            {/* 제목 + 저장/취소 */}
                            <div className={styles.editorToolbar}>
                                <input className={styles.titleInput} value={editTitle}
                                    onChange={(e) => setEditTitle(e.target.value)} placeholder="페이지 제목" />
                                <div className={styles.editorBtns}>
                                    <button className={styles.iconBtnLg} title="이미지 삽입"
                                        onClick={() => fileInputRef.current?.click()}>
                                        <Image size={16} /> 이미지
                                    </button>
                                    <input ref={fileInputRef} type="file" accept="image/*"
                                        style={{ display: 'none' }}
                                        onChange={(e) => { const f = e.target.files?.[0]; if (f) insertImage(f); e.target.value = ''; }} />
                                    <button className={styles.cancelBtn} onClick={() => setEditMode(false)}>취소</button>
                                    <button className={styles.saveBtn} onClick={savePage} disabled={saving}>
                                        <Save size={14} /> {saving ? '저장 중...' : '저장'}
                                    </button>
                                </div>
                            </div>

                            {/* 서식 툴바 */}
                            <div className={styles.formatBar}>
                                <span className={styles.formatLabel}>색상</span>
                                {[
                                    { color: '#111111', label: '기본' },
                                    { color: '#e53e3e', label: '빨강' },
                                    { color: '#dd6b20', label: '주황' },
                                    { color: '#d69e2e', label: '노랑' },
                                    { color: '#38a169', label: '초록' },
                                    { color: '#3182ce', label: '파랑' },
                                    { color: '#805ad5', label: '보라' },
                                    { color: '#d53f8c', label: '핑크' },
                                    { color: '#718096', label: '회색' },
                                ].map(({ color, label }) => (
                                    <button key={color} className={styles.colorSwatch}
                                        style={{ background: color }}
                                        title={label}
                                        onClick={() => applyColor(color)} />
                                ))}
                                <span className={styles.formatDivider} />
                                <span className={styles.formatLabel}>크기</span>
                                {[
                                    { size: 10, label: 'S' },
                                    { size: 12, label: 'M' },
                                    { size: 15, label: 'L' },
                                    { size: 18, label: 'XL' },
                                    { size: 24, label: '2X' },
                                ].map(({ size, label }) => (
                                    <button key={size} className={styles.sizeBtn}
                                        style={{ fontSize: `${Math.min(size, 15)}px` }}
                                        title={`${size}pt`}
                                        onClick={() => applySize(size)}>
                                        {label}
                                    </button>
                                ))}
                            </div>

                            <div
                                ref={editorRef}
                                className={styles.textarea}
                                contentEditable
                                suppressContentEditableWarning
                                onInput={() => { if (editorRef.current) setEditContent(editorRef.current.innerHTML); }}
                                onPaste={handleImagePaste}
                                onClick={(e) => {
                                    if (e.target.tagName === 'IMG') setAnnotTarget(e.target);
                                }}
                                data-placeholder="내용을 입력하세요. 텍스트를 선택한 뒤 색상·크기 버튼으로 서식을 적용하세요."
                            />
                            <div className={styles.editorHint}>
                                텍스트 선택 → 색상/크기 버튼 클릭으로 서식 적용 · 이미지: 버튼 업로드 또는 Ctrl+V 붙여넣기
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
                                    <button className={`${styles.iconBtnLg} ${styles.dangerBtn}`}
                                        onClick={() => deletePage(pageContent.id)}>
                                        <Trash2 size={15} /> 삭제
                                    </button>
                                </div>
                            </div>
                            <div className={styles.viewerBody}
                                dangerouslySetInnerHTML={{ __html: pageContent.content }} />
                        </div>
                    )
                ) : (
                    <div className={styles.placeholder}>
                        <BookOpen size={56} />
                        <p>왼쪽에서 페이지를 선택하거나 새 페이지를 만드세요.</p>
                    </div>
                )}
            </main>
        </div>
        </>
    );
};

export default GuidebookPage;
