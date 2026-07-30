import { Bell, CalendarDays, ClipboardList, DatabaseZap, Key, Warehouse } from 'lucide-react';
import { useState } from 'react';
import styles from './Header.module.css';
import { COLLAB_API_BASE, LOCAL_API_BASE, getAuthHeaders } from '../../lib/api';
import EventCalendarModal from '../EventCalendar/EventCalendarModal';

const Header = ({ onLogout, displayName, onProfileUpdate, topMode, setTopMode }) => {
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
    const [showEventCalendar, setShowEventCalendar] = useState(false);

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
                <a
                    href="/attendance"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.attendanceLink}
                    title="출퇴근 체크 페이지 열기"
                >
                    🏢 출퇴근
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
