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
    Barcode
} from 'lucide-react';
import styles from './Sidebar.module.css';



const Sidebar = ({ activeTab, setActiveTab, isDarkMode, toggleTheme }) => {
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
                    Dashboard
                </div>
                <div
                className={`${styles.navItem} ${activeTab === 'barcode' ? styles.active : ''}`}
                onClick={() => setActiveTab('barcode')}
                >
                <Barcode size={20} />
                Barcode
                </div>
                
                <div
                    className={`${styles.navItem} ${activeTab === 'users' ? styles.active : ''}`}
                    onClick={() => setActiveTab('users')}
                >
                    <Users size={20} />
                    Users
                </div>
                <div
                    className={`${styles.navItem} ${activeTab === 'sales' ? styles.active : ''}`}
                    onClick={() => setActiveTab('sales')}
                >
                    <ShoppingBag size={20} />
                    Sales
                </div>
                <div
                    className={`${styles.navItem} ${activeTab === 'analytics' ? styles.active : ''}`}
                    onClick={() => setActiveTab('analytics')}
                >
                    <BarChart3 size={20} />
                    Analytics
                </div>
                <div
                    className={`${styles.navItem} ${activeTab === 'settings' ? styles.active : ''}`}
                    onClick={() => setActiveTab('settings')}
                >
                    <Settings size={20} />
                    Settings
                </div>
            </nav>

            <div className={styles.footer}>
                <div className={styles.navItem} onClick={toggleTheme}>
                    {isDarkMode ? <Sun size={20} /> : <Moon size={20} />}
                    {isDarkMode ? 'Light Mode' : 'Dark Mode'}
                </div>
                <div className={styles.navItem}>
                    <LogOut size={20} />
                    Logout
                </div>
            </div>
        </aside>
    );
};

export default Sidebar;

