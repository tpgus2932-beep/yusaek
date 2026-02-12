import React, { useState } from "react";
import BarcodePage from "./BarcodePage";
import AmoodBarcodePage from "./AmoodBarcodePage";
import AmoodHapbaePage from "./AmoodHapbaePage";
import styles from "./BarcodePage.module.css";

const TABS = [
  { key: "barcode", label: "바코드" },
  { key: "amood", label: "아무드" },
  { key: "amood-hapbae", label: "아무드합배" },
];

export default function BarcodeTabs() {
  const [activeTab, setActiveTab] = useState("barcode");
  const headerExtra = (
    <div className={styles.tabRow}>
      {TABS.map((tab) => (
        <button
          key={tab.key}
          className={`${styles.tabBtn} ${activeTab === tab.key ? styles.tabActive : ""}`}
          onClick={() => setActiveTab(tab.key)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );

  if (activeTab === "amood") {
    return <AmoodBarcodePage headerExtra={headerExtra} />;
  }
  if (activeTab === "amood-hapbae") {
    return <AmoodHapbaePage headerExtra={headerExtra} />;
  }

  return <BarcodePage title="Barcode" headerExtra={headerExtra} />;
}
