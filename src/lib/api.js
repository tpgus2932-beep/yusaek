const defaultBase = `http://${window.location.hostname}:8000`;

const trimTrailingSlash = (value) => String(value || '').replace(/\/+$/, '');

export const LOCAL_API_BASE = trimTrailingSlash(import.meta.env.VITE_LOCAL_API_BASE || defaultBase);
export const COLLAB_API_BASE = trimTrailingSlash(import.meta.env.VITE_COLLAB_API_BASE || LOCAL_API_BASE);
