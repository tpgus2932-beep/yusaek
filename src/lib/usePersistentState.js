import { useEffect, useState } from "react";

// 새로고침(F5 / Ctrl+R)해도 보던 하위 탭·화면이 유지되도록 문자열 상태를 localStorage에 저장하는 useState.
// allowed를 주면 저장된 값이 그 안에 있을 때만 쓰고, 아니면 기본값으로 시작한다 (탭이 없어졌을 때 빈 화면 방지).
// 저장소를 못 쓰는 환경(사생활 보호 모드 등)에서도 기본값으로 정상 동작한다.
export default function usePersistentState(key, defaultValue, allowed = null) {
  const [value, setValue] = useState(() => {
    try {
      const saved = localStorage.getItem(key);
      if (saved != null && (!allowed || allowed.includes(saved))) return saved;
    } catch {
      /* 저장소 사용 불가 → 기본값 */
    }
    return defaultValue;
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* 저장 실패는 무시 (다음 새로고침 때 기본값) */
    }
  }, [key, value]);
  return [value, setValue];
}
