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
import CollabPortalPage from './components/Collab/CollabPortalPage';
import { COLLAB_API_BASE } from './lib/api';


const App = () => {
  const pathname = (window.location.pathname || '/').replace(/\/+$/, '') || '/';
  const isMobileKimsungilRequestRoute = pathname === '/request-kimsungil';
  const isCollabPortalRoute = pathname === '/collab';
  const [activeTab, setActiveTab] = useState(() => localStorage.getItem('activeTab') || 'dashboard');
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [authChecked, setAuthChecked] = useState(() => !localStorage.getItem('token'));
  const [displayName, setDisplayName] = useState(localStorage.getItem('displayName'));
  const [username, setUsername] = useState(localStorage.getItem('username'));
  const [isAdmin, setIsAdmin] = useState(localStorage.getItem('isAdmin') === 'true');
  const [role, setRole] = useState(localStorage.getItem('role') || 'user');
  const [hiddenTabs, setHiddenTabs] = useState([]);

  const isTabAllowed = (tab, adminFlag = isAdmin, hidden = hiddenTabs, userRole = role) => {
    if (userRole === 'viewer') return tab === 'dashboard';
    if (tab === 'settings') return true;
    if (tab === 'order' || tab === 'admin' || tab === 'cost-base-manager') {
      return adminFlag && !hidden.includes(tab);
    }
    return !hidden.includes(tab);
  };

  const getFallbackTab = (adminFlag = isAdmin, hidden = hiddenTabs, userRole = role) => {
    if (userRole === 'viewer') return 'dashboard';
    const candidates = ['dashboard', 'barcode', 'returns', 'barcode-product-upload', 'shared-files', 'noye-kimsungil'];
    if (adminFlag) candidates.push('order', 'cost-base-manager', 'admin');
    candidates.push('settings');
    return candidates.find((tab) => isTabAllowed(tab, adminFlag, hidden, userRole)) || 'settings';
  };

  const visibleActiveTab = isTabAllowed(activeTab) ? activeTab : getFallbackTab();

  const toggleTheme = () => {
    setIsDarkMode(!isDarkMode);
    document.documentElement.setAttribute('data-theme', !isDarkMode ? 'dark' : 'light');
  };

  useEffect(() => {
    const t = localStorage.getItem('token');
    if (!t) return;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    fetch(`${COLLAB_API_BASE}/auth/me`, {
      headers: { Authorization: `Bearer ${t}` },
      signal: controller.signal,
    })
      .then(async (res) => {
        clearTimeout(timeoutId);
        if (res.status === 401 || res.status === 403) {
          localStorage.removeItem('token');
          localStorage.removeItem('displayName');
          localStorage.removeItem('username');
          localStorage.removeItem('isAdmin');
          setToken(null);
          setDisplayName(null);
          setUsername(null);
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
        const userRole = data.role || 'user';
        setRole(userRole);
        localStorage.setItem('role', userRole);
      })
      .catch(() => {
        // 네트워크 오류면 토큰 유지
      })
      .finally(() => setAuthChecked(true));
  }, []);

  useEffect(() => {
    localStorage.setItem('activeTab', visibleActiveTab);
  }, [visibleActiveTab]);

  useEffect(() => {
    if (!token) return;
    fetch(`${COLLAB_API_BASE}/settings/menu-visibility`, {
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

  const handleAuth = (newToken, name) => {
    localStorage.setItem('token', newToken);
    setToken(newToken);
    if (name) {
      localStorage.setItem('displayName', name);
      setDisplayName(name);
    }
    setAuthChecked(true);
  };

  const handleAuthWithUser = (newToken, name, user, adminFlag, userRole) => {
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
    if (userRole) {
      localStorage.setItem('role', userRole);
      setRole(userRole);
    }
  };

  // viewer 역할이면 hiddenTabs 무시하고 대시보드만 허용
  const effectiveHiddenTabs = role === 'viewer'
    ? ['barcode', 'returns', 'barcode-product-upload', 'shared-files', 'noye-kimsungil', 'order', 'cost-base-manager', 'admin', 'settings']
    : hiddenTabs;

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('displayName');
    localStorage.removeItem('username');
    localStorage.removeItem('isAdmin');
    localStorage.removeItem('role');
    setToken(null);
    setDisplayName(null);
    setUsername(null);
    setIsAdmin(false);
    setRole('user');
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
    if (isCollabPortalRoute) {
      return (
        <AuthPage
          onAuth={handleAuthWithUser}
          title="YUSAEK COLLAB"
          loginSubtitle="외부 협업 포털 로그인"
          registerSubtitle="외부 협업 계정 신청"
        />
      );
    }
    return <AuthPage onAuth={handleAuthWithUser} />;
  }

  if (isCollabPortalRoute) {
    return (
      <CollabPortalPage
        currentUser={username}
        displayName={displayName}
        onLogout={handleLogout}
      />
    );
  }

  return (
    <div className={styles.appContainer}>
      <Sidebar
        activeTab={visibleActiveTab}
        setActiveTab={setActiveTab}
        isDarkMode={isDarkMode}
        toggleTheme={toggleTheme}
        isAdmin={isAdmin}
        hiddenTabs={effectiveHiddenTabs}
        onLogout={handleLogout}
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

        {visibleActiveTab === 'dashboard' && !hiddenTabs.includes('dashboard') && <Overview currentUser={username} />}
        {visibleActiveTab === 'barcode' && !hiddenTabs.includes('barcode') && <BarcodeTabs />}
        {visibleActiveTab === 'returns' && !hiddenTabs.includes('returns') && <ReturnsPage />}
        {visibleActiveTab === 'barcode-product-upload' && !hiddenTabs.includes('barcode-product-upload') && <ProductUploadPage />}
        {visibleActiveTab === 'shared-files' && !hiddenTabs.includes('shared-files') && <SharedFilesPage />}
        {visibleActiveTab === 'noye-kimsungil' && !hiddenTabs.includes('noye-kimsungil') && <NoyeKimPage />}
        {visibleActiveTab === 'order' && isAdmin && !hiddenTabs.includes('order') && <OrderPage />}
        {visibleActiveTab === 'cost-base-manager' && isAdmin && !hiddenTabs.includes('cost-base-manager') && <CostBaseManagerPage />}
        {visibleActiveTab === 'admin' && isAdmin && !hiddenTabs.includes('admin') && <AdminUsers currentUser={username} />}
        {visibleActiveTab === 'settings' && (
          <SettingsPage hiddenTabs={hiddenTabs} setHiddenTabs={setHiddenTabs} isAdmin={isAdmin} />
        )}

        {visibleActiveTab !== 'dashboard' &&
          visibleActiveTab !== 'barcode' &&
          visibleActiveTab !== 'returns' &&
          visibleActiveTab !== 'barcode-product-upload' &&
          visibleActiveTab !== 'shared-files' &&
          visibleActiveTab !== 'noye-kimsungil' &&
          visibleActiveTab !== 'order' &&
          visibleActiveTab !== 'cost-base-manager' &&
          visibleActiveTab !== 'admin' &&
          visibleActiveTab !== 'settings' && (
          <div className={styles.placeholderSection}>
            <h2>{visibleActiveTab.charAt(0).toUpperCase() + visibleActiveTab.slice(1)} Section</h2>
            <p>Coming soon...</p>
          </div>
        )}

      </main>
    </div>
  );
};

export default App;
