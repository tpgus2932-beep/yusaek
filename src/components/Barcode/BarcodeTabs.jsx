import React, { useState } from "react";
import BarcodePage from "./BarcodePage";
import AmoodBarcodePage from "./AmoodBarcodePage";
import PostShipmentCancelPage from "./PostShipmentCancelPage";
import ShippingEtaPage from "./ShippingEtaPage";
import InvoicePrintPage from "./InvoicePrintPage";
import LeadTimePage from "./LeadTimePage";
import styles from "./BarcodePage.module.css";

const TABS = [
  { key: "barcode", label: "바코드" },
  { key: "amood", label: "아무드" },
  { key: "post-shipment-cancel", label: "배송후취소" },
  { key: "shipping-eta", label: "출고예상" },
  { key: "invoice-print", label: "송장출력" },
  { key: "lead-time", label: "리드타임" },
];

export default function BarcodeTabs({ onOpenTestTab = null, onTransferAmoodHapbae = null }) {
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
    return (
      <AmoodBarcodePage
        headerExtra={headerExtra}
        onOpenTestTab={onOpenTestTab}
        onTransferAmoodHapbae={onTransferAmoodHapbae}
      />
    );
  }

  if (activeTab === "post-shipment-cancel") {
    return <PostShipmentCancelPage headerExtra={headerExtra} />;
  }

  if (activeTab === "shipping-eta") {
    return <ShippingEtaPage headerExtra={headerExtra} />;
  }

  if (activeTab === "invoice-print") {
    return <InvoicePrintPage headerExtra={headerExtra} />;
  }

  if (activeTab === "lead-time") {
    return <LeadTimePage headerExtra={headerExtra} />;
  }

  return <BarcodePage title="Barcode" headerExtra={headerExtra} />;
}
