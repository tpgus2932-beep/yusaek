import React, { useState } from "react";
import AmoodHapbaePage from "./AmoodHapbaePage";
import JejuHapbaePage from "./JejuHapbaePage";
import styles from "./BarcodePage.module.css";

const TABS = [
  { key: "amood-hapbae", label: "아무드합배" },
  { key: "jeju-hapbae", label: "제주합배송" },
];

export default function HapbaeManagementTabs({ transferredAmoodFile = null }) {
  const [activeTab, setActiveTab] = useState(() => {
    const savedTab = localStorage.getItem("hapbaeManagementActiveTab");
    return TABS.some((tab) => tab.key === savedTab) ? savedTab : "amood-hapbae";
  });

  const headerExtra = (
    <div className={styles.tabRow}>
      {TABS.map((tab) => (
        <button
          key={tab.key}
          className={`${styles.tabBtn} ${activeTab === tab.key ? styles.tabActive : ""}`}
          onClick={() => {
            localStorage.setItem("hapbaeManagementActiveTab", tab.key);
            setActiveTab(tab.key);
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );

  if (activeTab === "jeju-hapbae") {
    return <JejuHapbaePage headerExtra={headerExtra} />;
  }

  return <AmoodHapbaePage headerExtra={headerExtra} transferredFile={transferredAmoodFile} />;
}
