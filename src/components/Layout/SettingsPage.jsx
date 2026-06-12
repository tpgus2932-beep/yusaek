import React, { useMemo, useState } from "react";
import styles from "./SettingsPage.module.css";
import { COLLAB_API_BASE as API } from "../../lib/api";

const menuLabels = {
  dashboard: "대시보드",
  barcode: "바코드",
  returns: "반품",
  "barcode-product-upload": "상품 업로드",
  "shared-files": "유색 공용 파일",
  "noye-kimsungil": "노예김승일",
  "client-schedule": "거래처 일정",
  sms: "문자 발송",
  "collaboration-menu": "협업메뉴",
  "hapbae-management": "합배송관리",
  test: "테스트",
  "margin-calc": "마진계산",
  order: "발주",
  admin: "관리자",
};

const SettingsPage = ({ hiddenTabs, setHiddenTabs, isAdmin }) => {
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [msgType, setMsgType] = useState("");

  const visibleMenuTabs = useMemo(() => {
    const base = [
      "dashboard",
      "barcode",
      "returns",
      "barcode-product-upload",
      "shared-files",
      "noye-kimsungil",
      "client-schedule",
      "sms",
      "collaboration-menu",
      "hapbae-management",
      "test",
      "margin-calc",
    ];
    if (isAdmin) {
      base.push("order", "admin");
    }
    return base;
  }, [isAdmin]);

  const toggleHidden = (tab) => {
    setMsg("");
    setMsgType("");
    if (hiddenTabs.includes(tab)) {
      setHiddenTabs(hiddenTabs.filter((value) => value !== tab));
      return;
    }
    setHiddenTabs([...hiddenTabs, tab]);
  };

  const showCount = visibleMenuTabs.length - hiddenTabs.filter((tab) => visibleMenuTabs.includes(tab)).length;

  const save = async () => {
    setSaving(true);
    setMsg("");
    setMsgType("");
    try {
      const token = localStorage.getItem("token");
      const res = await fetch(`${API}/settings/menu-visibility`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ hidden_tabs: hiddenTabs }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        throw new Error(data.detail || "저장 실패");
      }
      setHiddenTabs(Array.isArray(data.hidden_tabs) ? data.hidden_tabs : hiddenTabs);
      setMsg("저장 완료");
      setMsgType("ok");
    } catch (error) {
      setMsg(`오류: ${error.message}`);
      setMsgType("error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <div>
          <h2 className={styles.title}>설정</h2>
          <p className={styles.subtitle}>계정과 사이드메뉴 표시 상태를 관리합니다.</p>
        </div>
        <div className={styles.stats}>
          <span className={styles.statBadge}>표시 {showCount}</span>
          <span className={styles.statBadge}>숨김 {visibleMenuTabs.length - showCount}</span>
        </div>
      </section>

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <h3 className={styles.cardTitle}>메뉴 표시 설정</h3>
          <div className={styles.quickActions}>
            <button
              type="button"
              className={styles.secondaryBtn}
              onClick={() => {
                setHiddenTabs([]);
                setMsg("");
                setMsgType("");
              }}
            >
              전체 표시
            </button>
            <button
              type="button"
              className={styles.secondaryBtn}
              onClick={() => {
                setHiddenTabs([...visibleMenuTabs]);
                setMsg("");
                setMsgType("");
              }}
            >
              전체 숨김
            </button>
          </div>
        </div>

        <div className={styles.menuGrid}>
          {visibleMenuTabs.map((tab) => {
            const isShown = !hiddenTabs.includes(tab);
            return (
              <button
                key={tab}
                type="button"
                className={`${styles.menuItem} ${isShown ? styles.menuOn : styles.menuOff}`}
                onClick={() => toggleHidden(tab)}
              >
                <span className={styles.menuName}>{menuLabels[tab] || tab}</span>
                <span className={`${styles.switch} ${isShown ? styles.switchOn : ""}`}>
                  <span className={styles.knob} />
                </span>
              </button>
            );
          })}
        </div>

        <div className={styles.footer}>
          <button type="button" className={styles.primaryBtn} onClick={save} disabled={saving}>
            {saving ? "저장 중..." : "저장"}
          </button>
          {msg && <span className={`${styles.message} ${msgType === "ok" ? styles.ok : styles.error}`}>{msg}</span>}
        </div>
      </section>
    </div>
  );
};

export default SettingsPage;
