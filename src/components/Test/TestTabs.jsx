import React, { useState } from "react";
import HapbaePreMatch from "./HapbaePreMatch";
import AmoodBarcodeTest from "./AmoodBarcodeTest";
import ReturnShippingTest from "./ReturnShippingTest";
import ExchangeReturnTest from "./ExchangeReturnTest";
import AblyMinusTab from "./AblyMinusTab";
import AccidentCargoTab from "./AccidentCargoTab";
import DeliveryStatusTest from "./DeliveryStatusTest";
import styles from "./TestTabsContainer.module.css";

const TABS = [
    { key: "hapbae", label: "합배 구성 선매칭" },
    { key: "amood-barcode", label: "아무드 바코드 테스트" },
    { key: "return-shipping", label: "반품배송 테스트" },
    { key: "exchange-return", label: "교환반품 테스트" },
    { key: "delivery-status", label: "배송 현황 조회" },
    { key: "ably-minus", label: "오출마이너스" },
    { key: "accident-cargo", label: "택배 사고처리" },
];

export default function TestTabs() {
    const [activeTab, setActiveTab] = useState(() => {
        const savedTab = localStorage.getItem("testActiveTab");
        return TABS.some((tab) => tab.key === savedTab) ? savedTab : "hapbae";
    });

    return (
        <div className={styles.container}>
            <div className={styles.tabBar}>
                {TABS.map((t) => (
                    <button
                        key={t.key}
                        className={`${styles.tabBtn} ${activeTab === t.key ? styles.active : ""}`}
                        onClick={() => {
                            localStorage.setItem("testActiveTab", t.key);
                            setActiveTab(t.key);
                        }}
                    >
                        {t.label}
                    </button>
                ))}
            </div>
            <div className={styles.content}>
                {activeTab === "hapbae" && <HapbaePreMatch />}
                {activeTab === "amood-barcode" && <AmoodBarcodeTest />}
                {activeTab === "return-shipping" && <ReturnShippingTest />}
                {activeTab === "exchange-return" && <ExchangeReturnTest />}
                {activeTab === "delivery-status" && <DeliveryStatusTest />}
                {activeTab === "ably-minus" && <AblyMinusTab />}
                {activeTab === "accident-cargo" && <AccidentCargoTab />}
            </div>
        </div>
    );
}
