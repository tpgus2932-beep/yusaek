import { Search, Bell } from 'lucide-react';
import { useState } from 'react';
import styles from './Header.module.css';

const Header = ({ onLogout, displayName, onProfileUpdate }) => {
    const initials = displayName ? displayName.slice(0, 2) : 'JD';
    const [showProfile, setShowProfile] = useState(false);
    const [nameInput, setNameInput] = useState(displayName || '');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');

    const saveProfile = async () => {
        setError('');
        if (!nameInput.trim()) {
            setError('이름을 입력해주세요.');
            return;
        }
        try {
            setSaving(true);
            const token = localStorage.getItem('token');
            const res = await fetch('http://127.0.0.1:8000/auth/profile', {
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

    return (
        <header className={styles.header}>
            <div className={styles.searchBar}>
                <Search size={18} className={styles.searchIcon} />
                <input type="text" placeholder="Search anything..." />
            </div>

            <div className={styles.profileSection}>
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
        </header>
    );
};

export default Header;
