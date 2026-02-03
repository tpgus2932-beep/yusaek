import React from 'react';
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
    Upload
} from 'lucide-react';
import styles from './Sidebar.module.css';



const Sidebar = ({ activeTab, setActiveTab, isDarkMode, toggleTheme, isAdmin }) => {
    return (
        <aside className={styles.sidebar}>
            <div className={styles.logo}>
                <div className={styles.logoIcon}></div>
                YUSAEK
            </div>

            <nav className={styles.navGroup}>
                <div
                    className={`${styles.navItem} ${activeTab === 'dashboard' ? styles.active : ''}`}
                    onClick={() => setActiveTab('dashboard')}
                >
                    <LayoutDashboard size={20} />
                    대시보드
                </div>
                <div
                className={`${styles.navItem} ${activeTab === 'barcode' ? styles.active : ''}`}
                onClick={() => setActiveTab('barcode')}
                >
                <Barcode size={20} />
                바코드
                </div>
                <div
                    className={`${styles.navItem} ${activeTab === 'barcode-product-upload' ? styles.active : ''}`}
                    onClick={() => setActiveTab('barcode-product-upload')}
                >
                    <Upload size={20} />
                    상품 업로드
                </div>
                
                <div
                    className={`${styles.navItem} ${activeTab === 'users' ? styles.active : ''}`}
                    onClick={() => setActiveTab('users')}
                >
                    <Users size={20} />
                    사용자
                </div>
                {isAdmin && (
                    <div
                        className={`${styles.navItem} ${activeTab === 'admin' ? styles.active : ''}`}
                        onClick={() => setActiveTab('admin')}
                    >
                        <Shield size={20} />
                        관리자
                    </div>
                )}
                <div
                    className={`${styles.navItem} ${activeTab === 'sales' ? styles.active : ''}`}
                    onClick={() => setActiveTab('sales')}
                >
                    <ShoppingBag size={20} />
                    판매
                </div>
                <div
                    className={`${styles.navItem} ${activeTab === 'analytics' ? styles.active : ''}`}
                    onClick={() => setActiveTab('analytics')}
                >
                    <BarChart3 size={20} />
                    분석
                </div>
                <div
                    className={`${styles.navItem} ${activeTab === 'settings' ? styles.active : ''}`}
                    onClick={() => setActiveTab('settings')}
                >
                    <Settings size={20} />
                    설정
                </div>
            </nav>

            <div className={styles.footer}>
                <div className={styles.navItem} onClick={toggleTheme}>
                    {isDarkMode ? <Sun size={20} /> : <Moon size={20} />}
                    {isDarkMode ? '라이트 모드' : '다크 모드'}
                </div>
                <div className={styles.navItem}>
                    <LogOut size={20} />
                    로그아웃
                </div>
            </div>
        </aside>
    );
};

export default Sidebar;
