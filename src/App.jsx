import React, { useState } from 'react';
import Sidebar from './components/Layout/Sidebar';
import Header from './components/Layout/Header';
import Overview from './components/Dashboard/Overview';
import styles from './components/Layout/Layout.module.css';
import BarcodePage from './components/Barcode/BarcodePage';


const App = () => {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [isDarkMode, setIsDarkMode] = useState(false);

  const toggleTheme = () => {
    setIsDarkMode(!isDarkMode);
    document.documentElement.setAttribute('data-theme', !isDarkMode ? 'dark' : 'light');
  };

  return (
    <div className={styles.appContainer}>
      <Sidebar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        isDarkMode={isDarkMode}
        toggleTheme={toggleTheme}
      />

      <main className={styles.mainContent}>
        <Header />

        {activeTab === 'dashboard' && <Overview />}
        {activeTab === 'barcode' && <BarcodePage />}

        {activeTab !== 'dashboard' && activeTab !== 'barcode' && (
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
