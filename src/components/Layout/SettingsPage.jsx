import React, { useEffect, useMemo, useState } from "react";
import styles from "./SettingsPage.module.css";
import { COLLAB_API_BASE as API } from "../../lib/api";

const defaultMenuLabels = {
  dashboard: "대시보드",
  barcode: "바코드",
  returns: "반품",
  "barcode-product-upload": "상품 업로드",
  "noye-kimsungil": "노예김승일",
  "client-schedule": "거래처",
  sms: "문자 발송",
  "collaboration-menu": "협업메뉴",
  "hapbae-management": "합배송관리",
  "zigzag-upload": "지그재그 업로드",
  test: "테스트",
  "margin-calc": "마진계산",
  order: "발주",
  admin: "관리자",
};

const SettingsPage = ({ hiddenTabs, setHiddenTabs, menuLabels, setMenuLabels, isAdmin }) => {
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [msgType, setMsgType] = useState("");
  const [labelDrafts, setLabelDrafts] = useState(menuLabels || {});

  useEffect(() => {
    setLabelDrafts(menuLabels || {});
  }, [menuLabels]);

  const visibleMenuTabs = useMemo(() => {
    const base = [
      "dashboard",
      "barcode",
      "returns",
      "barcode-product-upload",
      "noye-kimsungil",
      "client-schedule",
      "sms",
      "collaboration-menu",
      "hapbae-management",
      "zigzag-upload",
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

  const renameTab = (tab, value) => {
    setMsg("");
    setMsgType("");
    setLabelDrafts((prev) => ({ ...prev, [tab]: value }));
  };

  const save = async () => {
    setSaving(true);
    setMsg("");
    setMsgType("");
    try {
      const token = localStorage.getItem("token");
      const headers = {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };
      const [visRes, labelRes] = await Promise.all([
        fetch(`${API}/settings/menu-visibility`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ hidden_tabs: hiddenTabs }),
        }),
        fetch(`${API}/settings/menu-labels`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ menu_labels: labelDrafts }),
        }),
      ]);
      const visData = await visRes.json().catch(() => ({}));
      const labelData = await labelRes.json().catch(() => ({}));
      if (!visRes.ok || visData.ok === false) {
        throw new Error(visData.detail || "저장 실패");
      }
      if (!labelRes.ok || labelData.ok === false) {
        throw new Error(labelData.detail || "저장 실패");
      }
      setHiddenTabs(Array.isArray(visData.hidden_tabs) ? visData.hidden_tabs : hiddenTabs);
      setMenuLabels(labelData.menu_labels && typeof labelData.menu_labels === "object" ? labelData.menu_labels : labelDrafts);
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
          <p className={styles.subtitle}>계정과 사이드메뉴 표시/이름을 관리합니다.</p>
        </div>
        <div className={styles.stats}>
          <span className={styles.statBadge}>표시 {showCount}</span>
          <span className={styles.statBadge}>숨김 {visibleMenuTabs.length - showCount}</span>
        </div>
      </section>

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <h3 className={styles.cardTitle}>메뉴 표시/이름 설정</h3>
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
              <div
                key={tab}
                className={`${styles.menuItem} ${isShown ? styles.menuOn : styles.menuOff}`}
              >
                <input
                  type="text"
                  className={styles.menuNameInput}
                  value={labelDrafts[tab] ?? ""}
                  placeholder={defaultMenuLabels[tab] || tab}
                  maxLength={20}
                  onChange={(e) => renameTab(tab, e.target.value)}
                />
                <span
                  role="button"
                  tabIndex={0}
                  className={`${styles.switch} ${isShown ? styles.switchOn : ""}`}
                  onClick={() => toggleHidden(tab)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggleHidden(tab);
                    }
                  }}
                >
                  <span className={styles.knob} />
                </span>
              </div>
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
