export const getDownloadFilename = (res, fallback) => {
  const disposition = res.headers.get("content-disposition") || "";
  const match = disposition.match(/filename\*?=(?:UTF-8''|"?)([^";]+)/i);
  if (match?.[1]) {
    try {
      return decodeURIComponent(match[1].replace(/"/g, ""));
    } catch {
      return match[1].replace(/"/g, "");
    }
  }
  return fallback;
};
