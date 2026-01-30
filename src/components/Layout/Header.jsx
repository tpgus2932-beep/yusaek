import { Search, Bell } from 'lucide-react';
import styles from './Header.module.css';

const Header = () => {
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
                <div className={styles.avatar}>JD</div>
            </div>
        </header>
    );
};

export default Header;
