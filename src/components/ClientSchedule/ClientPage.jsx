import React, { useState } from 'react';
import styles from './ClientPage.module.css';
import ClientSchedulePage from './ClientSchedulePage';
import ClientCancelSoldOutPage from './ClientCancelSoldOutPage';

const TABS = [
  { key: 'schedule', label: '일정' },
  { key: 'cancel-soldout', label: '품절취소' },
];

const ClientPage = () => {
  const [activeTab, setActiveTab] = useState('schedule');

  return (
    <div className={styles.page}>
      <div className={styles.tabs}>
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            className={`${styles.tabBtn} ${activeTab === tab.key ? styles.tabActive : ''}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'schedule' && <ClientSchedulePage />}
      {activeTab === 'cancel-soldout' && <ClientCancelSoldOutPage />}
    </div>
  );
};

export default ClientPage;
