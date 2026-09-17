const listeners = new Set();
const STORAGE_KEY = "gamenews:selected-article-ids";

function readSelected() {
  try {
    const ids = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(ids) ? [...new Set(ids.filter(Boolean))] : [];
  } catch {
    return [];
  }
}

function persist(ids) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // 选择状态持久化失败时仍保留当前会话状态。
  }
}

let selectedIds = readSelected();

export const articleStore = {
  getSelected: () => selectedIds,
  setSelected: (ids) => {
    selectedIds = [...new Set((ids || []).filter(Boolean))];
    persist(selectedIds);
    listeners.forEach((fn) => fn(selectedIds));
  },
  toggle: (id) => {
    if (selectedIds.includes(id)) {
      selectedIds = selectedIds.filter((x) => x !== id);
    } else {
      selectedIds = [...selectedIds, id];
    }
    persist(selectedIds);
    listeners.forEach((fn) => fn(selectedIds));
  },
  subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
};
