import { LOCAL_API_BASE, getAuthHeaders, handleUnauthorized } from '../../lib/api';

/** /kakao 아래 API 호출. 실패하면 서버가 준 안내 문구(detail)로 Error를 던진다. */
export const call = async (path, { method = 'GET', body, params } = {}) => {
    const qs = params ? `?${new URLSearchParams(params)}` : '';
    const res = await fetch(`${LOCAL_API_BASE}/kakao${path}${qs}`, {
        method,
        headers: body ? { ...getAuthHeaders(), 'Content-Type': 'application/json' } : getAuthHeaders(),
        body: body ? JSON.stringify(body) : undefined,
    });
    if (handleUnauthorized(res)) throw new Error('로그인이 만료되었습니다.');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || '요청에 실패했습니다.');
    return data;
};

export const newRequestId = () => (window.crypto?.randomUUID ? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

/** 사진 한 장을 원본 바이트로 올린다. 서버가 내용으로 종류를 검사한다. 반환: { id, name, mime, bytes } */
export const uploadPhoto = async (file) => {
    const res = await fetch(`${LOCAL_API_BASE}/kakao/media?name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/octet-stream' },
        body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || '사진을 올리지 못했습니다.');
    return data;
};
