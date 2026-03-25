import React, { useState } from 'react';
import {
    LayoutDashboard,
    Users,
    ShoppingBag,
    BarChart3,
    Settings,
    LogOut,
    Moon,
    Sun,
    Barcode,
    Shield,
    Upload,
    FolderOpen,
    RotateCcw,
    Activity,
    MessageSquare,
    PackageCheck,
    CalendarDays,
} from 'lucide-react';
import styles from './Sidebar.module.css';
import ServerStatsModal from '../Admin/ServerStatsModal';



const Sidebar = ({ activeTab, setActiveTab, isDarkMode, toggleTheme, isAdmin, hiddenTabs = [], onLogout }) => {
    const isHidden = (tab) => hiddenTabs.includes(tab);
    const [showStats, setShowStats] = useState(false);
    return (
        <>
        <aside className={styles.sidebar}>
            <div className={styles.logo} onClick={() => setActiveTab('dashboard')}>
                <div className={styles.logoIcon}></div>
                YUSAEK
            </div>

            <nav className={styles.navGroup}>
                {!isHidden('dashboard') && (
                <div
                    className={`${styles.navItem} ${activeTab === 'dashboard' ? styles.active : ''}`}
                    onClick={() => setActiveTab('dashboard')}
                >
                    <LayoutDashboard size={20} />
                    대시보드
                </div>
                )}
                {!isHidden('barcode') && (
                <div
                className={`${styles.navItem} ${activeTab === 'barcode' ? styles.active : ''}`}
                onClick={() => setActiveTab('barcode')}
                >
                <Barcode size={20} />
                바코드
                </div>
                )}
                {!isHidden('returns') && (
                <div
                    className={`${styles.navItem} ${activeTab === 'returns' ? styles.active : ''}`}
                    onClick={() => setActiveTab('returns')}
                >
                    <RotateCcw size={20} />
                    반품
                </div>
                )}
                {!isHidden('barcode-product-upload') && (
                <div
                    className={`${styles.navItem} ${activeTab === 'barcode-product-upload' ? styles.active : ''}`}
                    onClick={() => setActiveTab('barcode-product-upload')}
                >
                    <Upload size={20} />
                    상품 업로드
                </div>
                )}
                {!isHidden('shared-files') && (
                <div
                    className={`${styles.navItem} ${activeTab === 'shared-files' ? styles.active : ''}`}
                    onClick={() => setActiveTab('shared-files')}
                >
                    <FolderOpen size={20} />
                    유색 공용 파일
                </div>
                )}
                {!isHidden('noye-kimsungil') && (
                <div
                    className={`${styles.navItem} ${activeTab === 'noye-kimsungil' ? styles.active : ''}`}
                    onClick={() => setActiveTab('noye-kimsungil')}
                >
                    <Users size={20} />
                    노예김승일
                </div>
                )}
                {!isHidden('client-schedule') && (
                <div
                    className={`${styles.navItem} ${activeTab === 'client-schedule' ? styles.active : ''}`}
                    onClick={() => setActiveTab('client-schedule')}
                >
                    <CalendarDays size={20} />
                    거래처 일정
                </div>
                )}
                {!isHidden('sms') && (
                <div
                    className={`${styles.navItem} ${activeTab === 'sms' ? styles.active : ''}`}
                    onClick={() => setActiveTab('sms')}
                >
                    <MessageSquare size={20} />
                    문자 발송
                </div>
                )}
                {!isHidden('hapbae-management') && (
                <div
                    className={`${styles.navItem} ${activeTab === 'hapbae-management' ? styles.active : ''}`}
                    onClick={() => setActiveTab('hapbae-management')}
                >
                    <PackageCheck size={20} />
                    합배송관리
                </div>
                )}

                {isAdmin && !isHidden('order') && (
                    <div
                        className={`${styles.navItem} ${activeTab === 'order' ? styles.active : ''}`}
                        onClick={() => setActiveTab('order')}
                    >
                        <ShoppingBag size={20} />
                        발주
                    </div>
                )}

                {isAdmin && !isHidden('cost-base-manager') && (
                    <div
                        className={`${styles.navItem} ${activeTab === 'cost-base-manager' ? styles.active : ''}`}
                        onClick={() => setActiveTab('cost-base-manager')}
                    >
                        <BarChart3 size={20} />
                        원가베이스 관리
                    </div>
                )}

                {isAdmin && !isHidden('admin') && (
                    <div
                        className={`${styles.navItem} ${activeTab === 'admin' ? styles.active : ''}`}
                        onClick={() => setActiveTab('admin')}
                    >
                        <Shield size={20} />
                        관리자
                    </div>
                )}
                <div
                    className={`${styles.navItem} ${activeTab === 'settings' ? styles.active : ''}`}
                    onClick={() => setActiveTab('settings')}
                >
                    <Settings size={20} />
                    설정
                </div>
            </nav>

            <div className={styles.footer}>
                {isAdmin && (
                    <div className={styles.navItem} onClick={() => setShowStats(true)}>
                        <Activity size={20} />
                        서버 현황
                    </div>
                )}
                <div className={styles.navItem} onClick={toggleTheme}>
                    {isDarkMode ? <Sun size={20} /> : <Moon size={20} />}
                    {isDarkMode ? '라이트 모드' : '다크 모드'}
                </div>
                <div className={styles.navItem} onClick={onLogout}>
                    <LogOut size={20} />
                    로그아웃
                </div>
            </div>
        </aside>
        {showStats && <ServerStatsModal onClose={() => setShowStats(false)} />}
        </>
    );
};

export default Sidebar;
