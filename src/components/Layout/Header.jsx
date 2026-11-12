import { Bell, CalendarDays, CircleDollarSign, ClipboardList, DatabaseZap, Headset, Key, NotebookPen, PackageCheck, RotateCw, Timer, Warehouse } from 'lucide-react';
import { useState } from 'react';
import styles from './Header.module.css';
import { COLLAB_API_BASE, LOCAL_API_BASE, getAuthHeaders } from '../../lib/api';
import EventCalendarModal from '../EventCalendar/EventCalendarModal';
import EzautoButtons from './EzautoButtons';
import { requestEzadminSessionFromExtension } from '../../lib/ezadminAuto';

const DEV_SERVER_USERS = ['tmddlfnan']; // 5175 서버 재시작 버튼 노출 계정(김승일)

const Header = ({ onLogout, displayName, onProfileUpdate, topMode, setTopMode, currentUser, userRole }) => {
    const initials = displayName ? displayName.slice(0, 2) : 'JD';
    const [showProfile, setShowProfile] = useState(false);
    const [nameInput, setNameInput] = useState(displayName || '');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [showEzadmin, setShowEzadmin] = useState(false);
    const [ezadminValue, setEzadminValue] = useState('');
    const [ezadminInput, setEzadminInput] = useState('');
    const [ezadminVisible, setEzadminVisible] = useState(false);
    const [ezadminLoading, setEzadminLoading] = useState(false);
    const [ezadminMsg, setEzadminMsg] = useState('');
    const [ezadminMsgType, setEzadminMsgType] = useState('');
    const [ezadminNeedExt, setEzadminNeedExt] = useState(false); // 확장 미설치로 자동 가져오기에 실패한 경우
    const [showEventCalendar, setShowEventCalendar] = useState(false);
    const [showDevMenu, setShowDevMenu] = useState(false);
    const [devRestarting, setDevRestarting] = useState(false);

    const restartDevServer = async (withBackend) => {
        const label = withBackend ? '5175 프론트 + 백엔드' : '5175 프론트';
        if (!window.confirm(`${label}를 시작(재시작)할까요?${withBackend ? ' (백엔드가 잠시 끊기고 스캔 상태가 초기화됩니다)' : ''}`)) return;
        setShowDevMenu(false);
        setDevRestarting(true);
        try {
            const res = await fetch(`${LOCAL_API_BASE}/dev-server/restart`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                body: JSON.stringify({ withBackend }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.detail || `요청 실패 (${res.status})`);
            }
            window.alert('시작/재시작을 요청했습니다. 잠시 후 새로고침하세요.');
        } catch (e) {
            window.alert(e.message || '시작/재시작 요청에 실패했습니다.');
        } finally {
            setDevRestarting(false);
        }
    };

    const saveProfile = async () => {
        setError('');
        if (!nameInput.trim()) {
            setError('이름을 입력해주세요.');
            return;
        }
        try {
            setSaving(true);
            const token = localStorage.getItem('token');
            const res = await fetch(`${COLLAB_API_BASE}/auth/profile`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ display_name: nameInput.trim() }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || '프로필 수정 실패');
            if (onProfileUpdate) onProfileUpdate(data.display_name);
            setShowProfile(false);
        } catch (err) {
            setError(err.message || '프로필 수정 실패');
        } finally {
            setSaving(false);
        }
    };

    const openEzadmin = async () => {
        setEzadminMsg('');
        setEzadminMsgType('');
        setEzadminVisible(false);
        setEzadminNeedExt(false);
        setEzadminInput('');
        setEzadminValue('');
        setEzadminLoading(true);
        setShowEzadmin(true);
        try {
            const res = await fetch(`${LOCAL_API_BASE}/ezadmin/session`, {
                headers: getAuthHeaders(),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.ok) {
                setEzadminValue(data.phpsessid || '');
                setEzadminInput(data.phpsessid || '');
            }
        } catch {
            // 조회 실패 시 빈 값으로 진행
        } finally {
            setEzadminLoading(false);
        }
        // 확장이 설치돼 있으면 오늘 로그인한 이지어드민 세션으로 자동 갱신 (없으면 기존 수동 입력 그대로)
        const auto = await requestEzadminSessionFromExtension();
        if (typeof auto === 'string') {
            try {
                const res = await fetch(`${LOCAL_API_BASE}/ezadmin/session`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                    body: JSON.stringify({ phpsessid: auto }),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok || !data?.ok) throw new Error(data?.detail || '저장 실패');
                setEzadminValue(auto);
                setEzadminInput(auto);
                setEzadminMsg('로그인된 이지어드민 세션으로 자동 갱신했습니다.');
                setEzadminMsgType('ok');
            } catch (err) {
                setEzadminMsg(err.message || '자동 갱신 실패');
                setEzadminMsgType('error');
            }
        } else if (auto === null) {
            // 확장이 응답하지 않음 = 미설치(또는 이 주소가 확장 허용 목록에 없음)
            setEzadminNeedExt(true);
        } else if (auto?.error) {
            setEzadminMsg(`자동 가져오기 실패: ${auto.error} (이지어드민에 먼저 로그인하세요)`);
            setEzadminMsgType('error');
        }
    };

    const saveEzadmin = async () => {
        const phpsessid = ezadminInput.trim();
        if (!phpsessid) {
            setEzadminMsg('PHPSESSID를 입력해주세요.');
            setEzadminMsgType('error');
            return;
        }
        try {
            setEzadminLoading(true);
            setEzadminMsg('');
            const res = await fetch(`${LOCAL_API_BASE}/ezadmin/session`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                body: JSON.stringify({ phpsessid }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data?.ok) throw new Error(data?.detail || '저장 실패');
            setEzadminValue(phpsessid);
            setEzadminMsg('저장 완료');
            setEzadminMsgType('ok');
        } catch (err) {
            setEzadminMsg(err.message || '저장 실패');
            setEzadminMsgType('error');
        } finally {
            setEzadminLoading(false);
        }
    };

    return (
        <header className={styles.header}>
            <div className={styles.leftSection}>
                <button type="button" className={styles.ezadminBtn} onClick={openEzadmin}>
                    <Key size={15} />
                    EZAdmin 설정
                </button>
                <div className={styles.topNav}>
                    <button
                        type="button"
                        className={`${styles.topNavItem} ${topMode === 'home' ? styles.topNavItemActive : ''}`}
                        onClick={() => setTopMode?.('home')}
                    >
                        홈
                    </button>
                    <button
                        type="button"
                        className={`${styles.topNavItem} ${topMode === 'db-manager' ? styles.topNavItemActive : ''}`}
                        onClick={() => setTopMode?.('db-manager')}
                    >
                        <DatabaseZap size={14} />
                        DB관리
                    </button>
                    <button
                        type="button"
                        className={`${styles.topNavItem} ${topMode === 'inventory-dashboard' ? styles.topNavItemActive : ''}`}
                        onClick={() => setTopMode?.('inventory-dashboard')}
                    >
                        <Warehouse size={14} />
                        재고대시보드
                    </button>
                    <button
                        type="button"
                        className={`${styles.topNavItem} ${topMode === 'order-dashboard' ? styles.topNavItemActive : ''}`}
                        onClick={() => setTopMode?.('order-dashboard')}
                    >
                        <ClipboardList size={14} />
                        발주대시보드
                    </button>
                    <button
                        type="button"
                        className={`${styles.topNavItem} ${topMode === 'timebox' ? styles.topNavItemActive : ''}`}
                        onClick={() => setTopMode?.('timebox')}
                    >
                        <Timer size={14} />
                        타임박스
                    </button>
                    <button
                        type="button"
                        className={`${styles.topNavItem} ${topMode === 'worklog' ? styles.topNavItemActive : ''}`}
                        onClick={() => setTopMode?.('worklog')}
                    >
                        <NotebookPen size={14} />
                        업무일지
                    </button>
                    <button
                        type="button"
                        className={`${styles.topNavItem} ${topMode === 'order-receiving' ? styles.topNavItemActive : ''}`}
                        onClick={() => setTopMode?.('order-receiving')}
                    >
                        <PackageCheck size={14} />
                        SO+
                    </button>
                    <button
                        type="button"
                        className={`${styles.topNavItem} ${topMode === 'cs' ? styles.topNavItemActive : ''}`}
                        onClick={() => setTopMode?.('cs')}
                    >
                        <Headset size={14} />
                        CS
                    </button>
                    {DEV_SERVER_USERS.includes(currentUser) && (
                        <div style={{ position: 'relative' }}>
                            <button
                                type="button"
                                className={styles.topNavItem}
                                disabled={devRestarting}
                                onClick={() => setShowDevMenu((v) => !v)}
                                title="5175 서버 시작/재시작"
                            >
                                <RotateCw size={14} />
                                5175
                            </button>
                            {showDevMenu && (
                                <div className={styles.devMenu}>
                                    <button type="button" className={styles.devMenuItem} onClick={() => restartDevServer(false)}>
                                        프론트만 시작/재시작
                                    </button>
                                    <button type="button" className={styles.devMenuItem} onClick={() => restartDevServer(true)}>
                                        프론트 + 백엔드 시작/재시작
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>

            <div className={styles.profileSection}>
                <button
                    type="button"
                    className={styles.eventCalendarButton}
                    onClick={() => setShowEventCalendar(true)}
                >
                    <CalendarDays size={15} />
                    행사 일정
                </button>
                {userRole !== 'viewer' && <EzautoButtons />}
                <a
                    href="https://gwanri-page.vercel.app/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.managementLink}
                    title="관리페이지 열기"
                >
                    <CircleDollarSign size={15} />
                    관리페이지
                </a>
                <a
                    href="/guidebook"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.guidebookLink}
                    title="가이드북 열기"
                >
                    📖 가이드북
                </a>
                <button className={styles.notificationBtn}>
                    <Bell size={22} />
                    <span className={styles.badge}></span>
                </button>
                {displayName && <div className={styles.userName}>{displayName}</div>}
                <button className={styles.secondaryBtn} onClick={() => setShowProfile(true)}>
                    프로필
                </button>
                {onLogout && (
                    <button className={styles.logoutBtn} onClick={onLogout}>
                        Logout
                    </button>
                )}
                <div className={styles.avatar}>{initials}</div>
            </div>

            {showProfile && (
                <div className={styles.modalOverlay} onClick={() => setShowProfile(false)}>
                    <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
                        <div className={styles.modalHeader}>
                            <h4 className={styles.modalTitle}>프로필 수정</h4>
                            <button className={styles.secondaryBtn} onClick={() => setShowProfile(false)}>
                                닫기
                            </button>
                        </div>
                        <label className={styles.modalLabel}>
                            이름
                            <input
                                type="text"
                                value={nameInput}
                                onChange={(e) => setNameInput(e.target.value)}
                            />
                        </label>
                        {error && <div className={styles.error}>{error}</div>}
                        <button className={styles.primaryBtn} onClick={saveProfile} disabled={saving}>
                            {saving ? '저장 중...' : '저장'}
                        </button>
                    </div>
                </div>
            )}

            {showEzadmin && (
                <div className={styles.modalOverlay} onClick={() => { setShowEzadmin(false); setEzadminMsg(''); }}>
                    <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
                        <div className={styles.modalHeader}>
                            <h4 className={styles.modalTitle}>EZAdmin 세션 설정</h4>
                            <button
                                className={styles.secondaryBtn}
                                onClick={() => { setShowEzadmin(false); setEzadminMsg(''); }}
                            >
                                닫기
                            </button>
                        </div>

                        <label className={styles.modalLabel}>
                            현재 저장된 PHPSESSID
                            <div className={styles.sessionValueRow}>
                                <div className={`${styles.sessionValue} ${!ezadminValue ? styles.sessionValueEmpty : ''}`}>
                                    {ezadminLoading
                                        ? '불러오는 중...'
                                        : ezadminValue
                                            ? (ezadminVisible ? ezadminValue : `${ezadminValue.slice(0, 6)}${'•'.repeat(Math.max(0, ezadminValue.length - 6))}`)
                                            : '저장된 값 없음'}
                                </div>
                                {ezadminValue && (
                                    <button
                                        type="button"
                                        className={styles.toggleVisibilityBtn}
                                        onClick={() => setEzadminVisible((v) => !v)}
                                    >
                                        {ezadminVisible ? '숨기기' : '보기'}
                                    </button>
                                )}
                            </div>
                        </label>

                        <label className={styles.modalLabel}>
                            새 값으로 변경
                            <input
                                type="text"
                                value={ezadminInput}
                                onChange={(e) => setEzadminInput(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') saveEzadmin(); }}
                                placeholder="PHPSESSID 값 붙여넣기"
                                disabled={ezadminLoading}
                            />
                        </label>

                        {ezadminNeedExt && (
                            <div className={styles.error} style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', alignItems: 'flex-start' }}>
                                <span>자동 가져오기용 크롬 확장이 설치되어 있지 않습니다.</span>
                                <a
                                    href="/yusaek-ezadmin-extension.zip"
                                    download
                                    style={{ padding: '0.35rem 0.8rem', borderRadius: '6px', background: 'var(--accent, #2563eb)', color: '#fff', fontWeight: 600, textDecoration: 'none', fontSize: '0.85rem' }}
                                >
                                    확장 설치 파일 받기
                                </a>
                                <span style={{ fontSize: '0.78rem', lineHeight: 1.5 }}>
                                    1) 받은 zip 압축 풀기 → 2) 크롬 주소창에 chrome://extensions 입력 → 3) 오른쪽 위 「개발자 모드」 켜기 →
                                    4) 「압축해제된 확장 프로그램을 로드합니다」로 압축 푼 폴더 선택 → 5) 이 페이지 새로고침 후 다시 EZAdmin 설정 클릭
                                </span>
                            </div>
                        )}
                        {ezadminMsg && (
                            <div className={ezadminMsgType === 'ok' ? styles.successMsg : styles.error}>
                                {ezadminMsg}
                            </div>
                        )}

                        <button
                            type="button"
                            className={styles.primaryBtn}
                            onClick={saveEzadmin}
                            disabled={ezadminLoading}
                        >
                            {ezadminLoading ? '처리 중...' : '저장'}
                        </button>
                    </div>
                </div>
            )}
            {showEventCalendar ? <EventCalendarModal onClose={() => setShowEventCalendar(false)} /> : null}
        </header>
    );
};

export default Header;
