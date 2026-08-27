import React, { useState } from "react";
import { Database } from "lucide-react";
import styles from "./DBManager.module.css";
import WonbeTable from "./WonbeTable";
import KdgTable from "./KdgTable";
import JanggiTable from "./JanggiTable";
import AccountDataTable from "./AccountDataTable";
import IchaeTable from "./IchaeTable";
import InvoiceManageTable from "./InvoiceManageTable";
import IngodaegiTable from "./IngodaegiTable";
import AblyStockTable from "./AblyStockTable";
import DefectProcessLogTable from "./DefectProcessLogTable";
import OrderHistoryTable from "./OrderHistoryTable";

const TABLES = [
  { key: "wonbe", label: "원가베이스유", component: WonbeTable },
  { key: "kdg", label: "케이디지원가베이스", component: KdgTable },
  { key: "janggi", label: "날짜별장끼정리", component: JanggiTable },
  { key: "account", label: "거래처계좌데이터", component: AccountDataTable },
  { key: "ichae", label: "이체파일", component: IchaeTable },
  { key: "invoice-manage", label: "계산서 관리", component: InvoiceManageTable },
  { key: "ingodaegi", label: "입고대기", component: IngodaegiTable },
  { key: "ably-stock", label: "에이블리재고변경", component: AblyStockTable },
  { key: "defect-process-logs", label: "불량처리로그", component: DefectProcessLogTable },
  { key: "order-history", label: "발주내역", component: OrderHistoryTable },
];

export default function DBManagerLayout() {
  const [activeTable, setActiveTable] = useState(TABLES[0].key);

  const ActiveComponent = TABLES.find((t) => t.key === activeTable)?.component ?? null;

  return (
    <div className={styles.root}>
      <aside className={styles.sidebar}>
        <div className={styles.sidebarTitle}>테이블 목록</div>
        {TABLES.map((t) => (
          <div
            key={t.key}
            className={`${styles.sidebarItem} ${activeTable === t.key ? styles.sidebarItemActive : ""}`}
            onClick={() => setActiveTable(t.key)}
          >
            <Database size={14} />
            {t.label}
          </div>
        ))}
      </aside>

      <main className={styles.content}>
        {ActiveComponent && <ActiveComponent />}
      </main>
    </div>
  );
}
