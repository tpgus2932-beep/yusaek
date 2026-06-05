export async function appendTsvToCostBase({
  apiBase,
  endpoint,
  text,
  headers = {},
  skipHeader = false,
}) {
  const normalizedText = String(text || "").trim();
  if (!normalizedText) {
    throw new Error("원본 텍스트를 먼저 입력하세요.");
  }

  const res = await fetch(`${apiBase}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ text: normalizedText, skip_header: skipHeader }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.detail || "원가베이스 데이터 추가 실패");
  }
  return data;
}
