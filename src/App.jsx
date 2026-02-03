import React, { useEffect, useState } from 'react';
import Sidebar from './components/Layout/Sidebar';
import Header from './components/Layout/Header';
import Overview from './components/Dashboard/Overview';
import styles from './components/Layout/Layout.module.css';
import BarcodePage from './components/Barcode/BarcodePage';
import ProductUploadPage from './components/Barcode/ProductUploadPage';
import AuthPage from './components/Auth/AuthPage';
import AdminUsers from './components/Admin/AdminUsers';


const App = () => {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [authChecked, setAuthChecked] = useState(false);
  const [displayName, setDisplayName] = useState(localStorage.getItem('displayName'));
  const [username, setUsername] = useState(localStorage.getItem('username'));
  const [isAdmin, setIsAdmin] = useState(localStorage.getItem('isAdmin') === 'true');

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
  };

  if (!authChecked) {
    return <div className={styles.placeholderSection}>Loading...</div>;
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

        {activeTab === 'dashboard' && <Overview currentUser={username} />}
        {activeTab === 'barcode' && <BarcodePage />}
        {activeTab === 'barcode-product-upload' && <ProductUploadPage />}
        {activeTab === 'admin' && isAdmin && <AdminUsers currentUser={username} />}

        {activeTab !== 'dashboard' &&
          activeTab !== 'barcode' &&
          activeTab !== 'barcode-product-upload' &&
          activeTab !== 'admin' && (
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
