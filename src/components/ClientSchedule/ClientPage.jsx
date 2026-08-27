import React, { useState } from 'react';
import styles from './ClientPage.module.css';
import ClientSchedulePage from './ClientSchedulePage';
import ClientCancelSoldOutPage from './ClientCancelSoldOutPage';
import ClientCancelSoldOutLogPage from './ClientCancelSoldOutLogPage';

const TABS = [
  { key: 'schedule', label: '일정' },
  { key: 'cancel-soldout', label: '품절취소' },
  { key: 'cancel-soldout-log', label: '품절취소로그' },
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
      {activeTab === 'cancel-soldout-log' && <ClientCancelSoldOutLogPage />}
    </div>
  );
};

export default ClientPage;
