import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Bot, Send, Trash2, Wrench } from 'lucide-react';
import { LOCAL_API_BASE, getAuthHeaders, handleUnauthorized } from '../../lib/api';
import { clearChat, getSnapshot, sendMessage, subscribe } from './aiChatStore';
import styles from './AIChatPage.module.css';

const TOOL_LABELS = {
    search_guidebook: '가이드북 검색',
    list_tables: '테이블 목록 조회',
    describe_table: '테이블 구조 조회',
    query_db: 'DB 조회',
};

const AIChatPage = () => {
    const { messages, busy } = useSyncExternalStore(subscribe, getSnapshot);
    const [input, setInput] = useState('');
    const [status, setStatus] = useState(null);
    const bottomRef = useRef(null);

    useEffect(() => {
        fetch(`${LOCAL_API_BASE}/ai/status`, { headers: getAuthHeaders() })
            .then((res) => (handleUnauthorized(res) ? null : res.json()))
            .then((data) => data && setStatus(data))
            .catch(() => setStatus({ ok: false }));
    }, []);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    const send = () => {
        const text = input.trim();
        if (!text || busy) return;
        setInput('');
        sendMessage(text);
    };

    const onKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
        }
    };

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <Bot size={22} />
                <h2>사내 AI</h2>
                {status && (
                    <span className={`${styles.badge} ${status.ok && status.installed ? styles.ok : styles.warn}`}>
                        {!status.ok
                            ? 'Ollama 연결 안 됨'
                            : status.installed
                              ? status.model
                              : `${status.model} 모델 미설치`}
                    </span>
                )}
                <button className={styles.clearBtn} onClick={clearChat} disabled={busy || messages.length === 0}>
                    <Trash2 size={14} /> 새 대화
                </button>
            </div>

            <div className={styles.messages}>
                {messages.length === 0 && (
                    <div className={styles.empty}>
                        업무 방법을 물어보거나, 관리자는 데이터 조회도 요청할 수 있어요.
                        <br />예) "반품 처리 순서 알려줘", "오늘 등록된 요청 몇 건이야?"
                    </div>
                )}
                {messages.map((m, i) => (
                    <div key={i} className={`${styles.msg} ${m.role === 'user' ? styles.user : styles.assistant}`}>
                        {m.tools?.map((t, j) => (
                            <div key={j} className={styles.tool}>
                                <Wrench size={12} /> {TOOL_LABELS[t] || t}
                            </div>
                        ))}
                        <div className={styles.text}>{m.content || (busy && i === messages.length - 1 ? '생각 중…' : '')}</div>
                    </div>
                ))}
                <div ref={bottomRef} />
            </div>

            <div className={styles.inputRow}>
                <textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={onKeyDown}
                    placeholder="질문을 입력하세요 (Enter 전송, Shift+Enter 줄바꿈)"
                    rows={4}
                />
                <button onClick={send} disabled={busy || !input.trim()} aria-label="전송">
                    <Send size={18} />
                </button>
            </div>
        </div>
    );
};

export default AIChatPage;
