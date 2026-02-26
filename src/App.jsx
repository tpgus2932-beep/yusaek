import React, { useEffect, useState } from 'react';
import Sidebar from './components/Layout/Sidebar';
import Header from './components/Layout/Header';
import Overview from './components/Dashboard/Overview';
import styles from './components/Layout/Layout.module.css';
import BarcodeTabs from './components/Barcode/BarcodeTabs';
import ProductUploadPage from './components/Barcode/ProductUploadPage';
import SharedFilesPage from './components/Barcode/SharedFilesPage';
import ReturnsPage from './components/Barcode/ReturnsPage';
import AuthPage from './components/Auth/AuthPage';
import AdminUsers from './components/Admin/AdminUsers';
import OrderPage from './components/Admin/OrderPage';
import CostBaseManagerPage from './components/Admin/CostBaseManagerPage';
import SettingsPage from './components/Layout/SettingsPage';
import NoyeKimPage from './components/NoyeKim/NoyeKimPage';
import MobileRequestKimsungilPage from './components/Mobile/MobileRequestKimsungilPage';


const App = () => {
  const pathname = (window.location.pathname || '/').replace(/\/+$/, '') || '/';
  const isMobileKimsungilRequestRoute = pathname === '/request-kimsungil';
  const [activeTab, setActiveTab] = useState(() => localStorage.getItem('activeTab') || 'dashboard');
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [authChecked, setAuthChecked] = useState(false);
  const [displayName, setDisplayName] = useState(localStorage.getItem('displayName'));
  const [username, setUsername] = useState(localStorage.getItem('username'));
  const [isAdmin, setIsAdmin] = useState(localStorage.getItem('isAdmin') === 'true');
  const [hiddenTabs, setHiddenTabs] = useState([]);

  const isTabAllowed = (tab, adminFlag = isAdmin, hidden = hiddenTabs) => {
    if (tab === 'settings') return true;
    if (tab === 'order' || tab === 'admin' || tab === 'cost-base-manager') {
      return adminFlag && !hidden.includes(tab);
    }
    return !hidden.includes(tab);
  };

  const getFallbackTab = (adminFlag = isAdmin, hidden = hiddenTabs) => {
    const candidates = ['dashboard', 'barcode', 'returns', 'barcode-product-upload', 'shared-files', 'noye-kimsungil'];
    if (adminFlag) candidates.push('order', 'cost-base-manager', 'admin');
    candidates.push('settings');
    return candidates.find((tab) => isTabAllowed(tab, adminFlag, hidden)) || 'settings';
  };

  const toggleTheme = () => {
    setIsDarkMode(!isDarkMode);
    document.documentElement.setAttribute('data-theme', !isDarkMode ? 'dark' : 'light');
  };

  useEffect(() => {
    const t = localStorage.getItem('token');
    if (!t) {
      setAuthChecked(true);
      return;
    }
    fetch(`http://${window.location.hostname}:8000/auth/me`, {
      headers: { Authorization: `Bearer ${t}` },
    })
      .then(async (res) => {
        if (res.status === 401) {
          localStorage.removeItem('token');
          localStorage.removeItem('displayName');
          localStorage.removeItem('isAdmin');
          setToken(null);
          setDisplayName(null);
          setIsAdmin(false);
          return;
        }
        if (!res.ok) {
          // 서버 일시 오류면 토큰 유지
          return;
        }
        const data = await res.json();
        setToken(t);
        setDisplayName(data.display_name || data.username || '');
        if (data.username) {
          setUsername(data.username);
          localStorage.setItem('username', data.username);
        }
        const adminFlag = !!data.is_admin;
        setIsAdmin(adminFlag);
        localStorage.setItem('isAdmin', adminFlag ? 'true' : 'false');
      })
      .catch(() => {
        // 네트워크 오류면 토큰 유지
      })
      .finally(() => setAuthChecked(true));
  }, []);

  useEffect(() => {
    localStorage.setItem('activeTab', activeTab);
  }, [activeTab]);

  useEffect(() => {
    if (!token) {
      setHiddenTabs([]);
      return;
    }
    fetch(`http://${window.location.hostname}:8000/settings/menu-visibility`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (res) => {
        if (!res.ok) return;
        const data = await res.json();
        if (data && Array.isArray(data.hidden_tabs)) {
          setHiddenTabs(data.hidden_tabs);
        }
      })
      .catch(() => {});
  }, [token]);

  useEffect(() => {
    if (!isTabAllowed(activeTab)) {
      setActiveTab(getFallbackTab());
    }
  }, [activeTab, isAdmin, hiddenTabs]);

  const handleAuth = (newToken, name) => {
    localStorage.setItem('token', newToken);
    setToken(newToken);
    if (name) {
      localStorage.setItem('displayName', name);
      setDisplayName(name);
    }
    setAuthChecked(true);
  };

  const handleAuthWithUser = (newToken, name, user, adminFlag) => {
    handleAuth(newToken, name);
    if (user) {
      localStorage.setItem('username', user);
      setUsername(user);
    }
    localStorage.setItem('todos-reset-on-login', '1');
    if (typeof adminFlag === 'boolean') {
      localStorage.setItem('isAdmin', adminFlag ? 'true' : 'false');
      setIsAdmin(adminFlag);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('displayName');
    localStorage.removeItem('username');
    localStorage.removeItem('isAdmin');
    setToken(null);
    setDisplayName(null);
    setUsername(null);
    setIsAdmin(false);
    setHiddenTabs([]);
  };

  if (!authChecked) {
    if (isMobileKimsungilRequestRoute) {
      return <MobileRequestKimsungilPage />;
    }
    return <div className={styles.placeholderSection}>Loading...</div>;
  }

  if (isMobileKimsungilRequestRoute) {
    return <MobileRequestKimsungilPage />;
  }

  if (!token) {
    return <AuthPage onAuth={handleAuthWithUser} />;
  }

  return (
    <div className={styles.appContainer}>
      <Sidebar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        isDarkMode={isDarkMode}
        toggleTheme={toggleTheme}
        isAdmin={isAdmin}
        hiddenTabs={hiddenTabs}
      />

      <main className={styles.mainContent}>
        <Header
          onLogout={handleLogout}
          displayName={displayName}
          onProfileUpdate={(name) => {
            setDisplayName(name);
            localStorage.setItem('displayName', name);
          }}
        />

        {activeTab === 'dashboard' && !hiddenTabs.includes('dashboard') && <Overview currentUser={username} />}
        {activeTab === 'barcode' && !hiddenTabs.includes('barcode') && <BarcodeTabs />}
        {activeTab === 'returns' && !hiddenTabs.includes('returns') && <ReturnsPage />}
        {activeTab === 'barcode-product-upload' && !hiddenTabs.includes('barcode-product-upload') && <ProductUploadPage />}
        {activeTab === 'shared-files' && !hiddenTabs.includes('shared-files') && <SharedFilesPage />}
        {activeTab === 'noye-kimsungil' && !hiddenTabs.includes('noye-kimsungil') && <NoyeKimPage />}
        {activeTab === 'order' && isAdmin && !hiddenTabs.includes('order') && <OrderPage />}
        {activeTab === 'cost-base-manager' && isAdmin && !hiddenTabs.includes('cost-base-manager') && <CostBaseManagerPage />}
        {activeTab === 'admin' && isAdmin && !hiddenTabs.includes('admin') && <AdminUsers currentUser={username} />}
        {activeTab === 'settings' && (
          <SettingsPage hiddenTabs={hiddenTabs} setHiddenTabs={setHiddenTabs} isAdmin={isAdmin} />
        )}

        {activeTab !== 'dashboard' &&
          activeTab !== 'barcode' &&
          activeTab !== 'returns' &&
          activeTab !== 'barcode-product-upload' &&
          activeTab !== 'shared-files' &&
          activeTab !== 'noye-kimsungil' &&
          activeTab !== 'order' &&
          activeTab !== 'cost-base-manager' &&
          activeTab !== 'admin' &&
          activeTab !== 'settings' && (
          <div className={styles.placeholderSection}>
            <h2>{activeTab.charAt(0).toUpperCase() + activeTab.slice(1)} Section</h2>
            <p>Coming soon...</p>
          </div>
        )}

      </main>
    </div>
  );
};

export default App;
