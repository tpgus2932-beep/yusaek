import React, { useEffect, useState } from 'react';
import { EzadminSessionProvider } from './lib/EzadminSessionContext';
import Sidebar from './components/Layout/Sidebar';
import Header from './components/Layout/Header';
import Overview from './components/Dashboard/Overview';
import styles from './components/Layout/Layout.module.css';
import BarcodeTabs from './components/Barcode/BarcodeTabs';
import HapbaeManagementTabs from './components/Barcode/HapbaeManagementTabs';
import ProductUploadPage from './components/Barcode/ProductUploadPage';
import ReturnsPage from './components/Barcode/ReturnsPage';
import AuthPage from './components/Auth/AuthPage';
import AdminUsers from './components/Admin/AdminUsers';
import OrderPage from './components/Admin/OrderPage';
import SettingsPage from './components/Layout/SettingsPage';
import NoyeKimPage from './components/NoyeKim/NoyeKimPage';
import ClientPage from './components/ClientSchedule/ClientPage';
import SMSPage from './components/SMS/SMSPage';
import CollaborationMenuPage from './components/CollabTools/CollaborationMenuPage';
import MobileRequestKimsungilPage from './components/Mobile/MobileRequestKimsungilPage';
import CollabPortalPage from './components/Collab/CollabPortalPage';
import AttendancePage from './components/Attendance/AttendancePage';
import AttendanceAdminPage from './components/Attendance/AttendanceAdminPage';
import TestTabs from './components/Test/TestTabs';
import GuidebookPage from './components/Guidebook/GuidebookPage';
import AmoodSettlement from './components/AmoodSettlement/AmoodSettlement';
import DBManagerLayout from './components/DBManager/DBManagerLayout';
import InventoryDashboardPage from './components/InventoryDashboard/InventoryDashboardPage';
import OrderRecommendationDashboardPage from './components/OrderRecommendation/OrderRecommendationDashboardPage';
import { COLLAB_API_BASE } from './lib/api';


const KNOWN_TABS = [
  'dashboard', 'barcode', 'returns', 'barcode-product-upload',
  'noye-kimsungil', 'client-schedule', 'sms', 'collaboration-menu', 'hapbae-management',
  'test', 'order', 'admin', 'settings', 'margin-calc',
];

const App = () => {
  const pathname = (window.location.pathname || '/').replace(/\/+$/, '') || '/';
  const isMobileKimsungilRequestRoute = pathname === '/request-kimsungil';
  const isCollabPortalRoute = pathname === '/collab';
  const isAttendanceRoute = pathname === '/attendance';
  const isAttendanceAdminRoute = pathname === '/attendance-admin';
  const isPaymentRequestRoute = pathname === '/payment-request';
  const isGuidebookRoute = pathname === '/guidebook';
  const [activeTab, setActiveTab] = useState(() => localStorage.getItem('activeTab') || 'dashboard');
  const [topMode, setTopMode] = useState('home'); // 'home' | 'db-manager' | 'inventory-dashboard' | 'order-dashboard'
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [authChecked, setAuthChecked] = useState(() => !localStorage.getItem('token'));
  const [displayName, setDisplayName] = useState(localStorage.getItem('displayName'));
  const [username, setUsername] = useState(localStorage.getItem('username'));
  const [phoneNumber, setPhoneNumber] = useState(localStorage.getItem('phoneNumber') || '');
  const [isAdmin, setIsAdmin] = useState(localStorage.getItem('isAdmin') === 'true');
  const [role, setRole] = useState(localStorage.getItem('role') || 'user');
  const [hiddenTabs, setHiddenTabs] = useState([]);
  const [amoodHapbaeTransfer, setAmoodHapbaeTransfer] = useState(null);

  const isTabAllowed = (tab, adminFlag = isAdmin, hidden = hiddenTabs, userRole = role) => {
    if (!KNOWN_TABS.includes(tab)) return false;
    if (userRole === 'viewer') return tab === 'dashboard';
    if (tab === 'settings') return true;
    if (tab === 'order' || tab === 'admin') {
      return adminFlag && !hidden.includes(tab);
    }
    return !hidden.includes(tab);
  };

  const getFallbackTab = (adminFlag = isAdmin, hidden = hiddenTabs, userRole = role) => {
    if (userRole === 'viewer') return 'dashboard';
    const candidates = [...KNOWN_TABS.filter((t) => !['order', 'admin'].includes(t))];
    if (adminFlag) candidates.push('order', 'admin');
    candidates.push('settings');
    return candidates.find((tab) => isTabAllowed(tab, adminFlag, hidden, userRole)) || 'settings';
  };

  const visibleActiveTab = isTabAllowed(activeTab) ? activeTab : getFallbackTab();

  const toggleTheme = () => {
    setIsDarkMode(!isDarkMode);
    document.documentElement.setAttribute('data-theme', !isDarkMode ? 'dark' : 'light');
  };

  useEffect(() => {
    const t = token || localStorage.getItem('token');
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
          localStorage.removeItem('phoneNumber');
          setToken(null);
          setDisplayName(null);
          setUsername(null);
          setPhoneNumber('');
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
        const nextPhoneNumber = String(data.phone_number || '').replace(/[^0-9]/g, '');
        setPhoneNumber(nextPhoneNumber);
        localStorage.setItem('phoneNumber', nextPhoneNumber);
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
  }, [token]);

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

  const handleAuth = (newToken, name, nextPhoneNumber = '') => {
    localStorage.setItem('token', newToken);
    setToken(newToken);
    if (name) {
      localStorage.setItem('displayName', name);
      setDisplayName(name);
    }
    const normalizedPhoneNumber = String(nextPhoneNumber || '').replace(/[^0-9]/g, '');
    localStorage.setItem('phoneNumber', normalizedPhoneNumber);
    setPhoneNumber(normalizedPhoneNumber);
    setAuthChecked(true);
  };

  const handleAuthWithUser = (newToken, name, user, adminFlag, userRole, nextPhoneNumber = '') => {
    handleAuth(newToken, name, nextPhoneNumber);
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
    ? ['barcode', 'returns', 'barcode-product-upload', 'noye-kimsungil', 'client-schedule', 'sms', 'collaboration-menu', 'order', 'admin', 'settings', 'hapbae-management', 'test', 'margin-calc']
    : hiddenTabs;

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('displayName');
    localStorage.removeItem('username');
    localStorage.removeItem('isAdmin');
    localStorage.removeItem('role');
    localStorage.removeItem('phoneNumber');
    setToken(null);
    setDisplayName(null);
    setUsername(null);
    setPhoneNumber('');
    setIsAdmin(false);
    setRole('user');
    setHiddenTabs([]);
  };

  const handleAmoodHapbaeTransfer = (file) => {
    setAmoodHapbaeTransfer({ file, id: Date.now() });
    localStorage.setItem('hapbaeManagementActiveTab', 'amood-hapbae');
    setActiveTab('hapbae-management');
  };

  // 출퇴근 페이지 — 로그인 불필요, 최우선 처리
  if (isAttendanceRoute) return <AttendancePage />;
  if (isAttendanceAdminRoute) return <AttendanceAdminPage />;
  if (isPaymentRequestRoute) return <AttendanceAdminPage initialTab="paymentRequest" paymentRequestOnly />;
  if (isGuidebookRoute) return <GuidebookPage />;

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
    <EzadminSessionProvider>
    <div className={styles.appContainer}>
      {topMode === 'home' && (
        <Sidebar
          activeTab={visibleActiveTab}
          setActiveTab={setActiveTab}
          isDarkMode={isDarkMode}
          toggleTheme={toggleTheme}
          isAdmin={isAdmin}
          hiddenTabs={effectiveHiddenTabs}
          onLogout={handleLogout}
        />
      )}

      <main className={styles.mainContent}>
        <Header
          onLogout={handleLogout}
          displayName={displayName}
          topMode={topMode}
          setTopMode={setTopMode}
          onProfileUpdate={(name) => {
            setDisplayName(name);
            localStorage.setItem('displayName', name);
          }}
        />

        {topMode === 'db-manager' && <DBManagerLayout />}

        {topMode === 'inventory-dashboard' && <InventoryDashboardPage />}
        {topMode === 'order-dashboard' && <OrderRecommendationDashboardPage />}

        {topMode === 'home' && (
          <>
            {visibleActiveTab === 'dashboard' && !effectiveHiddenTabs.includes('dashboard') && <Overview currentUser={username} currentUserPhone={phoneNumber} />}
            {visibleActiveTab === 'barcode' && !effectiveHiddenTabs.includes('barcode') && (
              <BarcodeTabs
                onOpenTestTab={() => setActiveTab('test')}
                onTransferAmoodHapbae={handleAmoodHapbaeTransfer}
              />
            )}
            {visibleActiveTab === 'returns' && !effectiveHiddenTabs.includes('returns') && <ReturnsPage />}
            {visibleActiveTab === 'barcode-product-upload' && !effectiveHiddenTabs.includes('barcode-product-upload') && <ProductUploadPage />}
            {visibleActiveTab === 'noye-kimsungil' && !effectiveHiddenTabs.includes('noye-kimsungil') && <NoyeKimPage />}
            {visibleActiveTab === 'client-schedule' && !effectiveHiddenTabs.includes('client-schedule') && <ClientPage />}
            {visibleActiveTab === 'sms' && !effectiveHiddenTabs.includes('sms') && <SMSPage />}
            {visibleActiveTab === 'collaboration-menu' && !effectiveHiddenTabs.includes('collaboration-menu') && <CollaborationMenuPage />}
            {visibleActiveTab === 'hapbae-management' && !effectiveHiddenTabs.includes('hapbae-management') && (
              <HapbaeManagementTabs transferredAmoodFile={amoodHapbaeTransfer} />
            )}
            {visibleActiveTab === 'test' && !effectiveHiddenTabs.includes('test') && <TestTabs />}
            {visibleActiveTab === 'order' && isAdmin && !effectiveHiddenTabs.includes('order') && <OrderPage />}
            {visibleActiveTab === 'admin' && isAdmin && !effectiveHiddenTabs.includes('admin') && <AdminUsers currentUser={username} />}
            {visibleActiveTab === 'margin-calc' && !effectiveHiddenTabs.includes('margin-calc') && <AmoodSettlement />}
            {visibleActiveTab === 'settings' && (
              <SettingsPage hiddenTabs={hiddenTabs} setHiddenTabs={setHiddenTabs} isAdmin={isAdmin} />
            )}
          </>
        )}

        {!KNOWN_TABS.includes(visibleActiveTab) && (
          <div className={styles.placeholderSection}>
            <h2>{visibleActiveTab.charAt(0).toUpperCase() + visibleActiveTab.slice(1)} Section</h2>
            <p>Coming soon...</p>
          </div>
        )}

      </main>
    </div>
    </EzadminSessionProvider>
  );
};

export default App;
