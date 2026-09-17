const STORAGE_KEY = "gamenews:brief-preferences";

export const DEFAULT_BRIEF_PREFERENCES = Object.freeze({
  style: "professional",
  maxLen: 5000,
  contentMode: "full",
  imagesPerArticle: -1,
});

export function getBriefPreferences() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return { ...DEFAULT_BRIEF_PREFERENCES, ...(stored || {}) };
  } catch {
    return { ...DEFAULT_BRIEF_PREFERENCES };
  }
}

export function saveBriefPreferences(patch = {}) {
  const next = { ...getBriefPreferences(), ...patch };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 偏好写入失败不能阻断简讯生成。
  }
  return next;
}
