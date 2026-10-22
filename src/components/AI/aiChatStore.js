import { LOCAL_API_BASE, getAuthHeaders, handleUnauthorized } from '../../lib/api';

// 탭을 옮겨 컴포넌트가 사라져도 대화/스트리밍이 유지되도록 모듈 단위로 상태를 보관한다.
const STORAGE_KEY = 'aiChatMessages';
const MAX_STORED = 100;

const load = () => {
    try {
        const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
};

let state = { messages: load(), busy: false };
const listeners = new Set();

const setState = (next) => {
    state = { ...state, ...next };
    if (!state.busy) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state.messages.slice(-MAX_STORED)));
        } catch { /* 저장 실패는 무시 */ }
    }
    listeners.forEach((fn) => fn());
};

export const subscribe = (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
};
export const getSnapshot = () => state;

const patchLast = (fn) =>
    setState({ messages: state.messages.map((m, i) => (i === state.messages.length - 1 ? fn(m) : m)) });

export const clearChat = () => {
    if (!state.busy) setState({ messages: [] });
};

export const sendMessage = async (text) => {
    if (state.busy || !text.trim()) return;
    const history = [...state.messages, { role: 'user', content: text }];
    setState({ messages: [...history, { role: 'assistant', content: '', tools: [] }], busy: true });
    try {
        const res = await fetch(`${LOCAL_API_BASE}/ai/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify({ messages: history.map(({ role, content }) => ({ role, content })) }),
        });
        if (handleUnauthorized(res)) return;
        if (!res.ok) throw new Error(`요청 실패 (${res.status})`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const parts = buf.split('\n\n');
            buf = parts.pop();
            for (const part of parts) {
                if (!part.startsWith('data: ')) continue;
                const evt = JSON.parse(part.slice(6));
                if (evt.type === 'token') patchLast((m) => ({ ...m, content: m.content + evt.text }));
                else if (evt.type === 'tool') patchLast((m) => ({ ...m, tools: [...(m.tools || []), evt.name] }));
                else if (evt.type === 'error') patchLast((m) => ({ ...m, content: `${m.content}\n⚠ ${evt.message}` }));
            }
        }
    } catch (err) {
        patchLast((m) => ({ ...m, content: `⚠ ${err.message}` }));
    } finally {
        setState({ busy: false });
    }
};
