// 统一爬虫注册表：统一库 sources 表 → 适配器映射。
// 迁入状态：ref-x7 / ref-steam 已可运行；其余平台解析器保留在 GameNews（动态抓取待迁）。
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
export const DB_PATH = path.join(ROOT, "data", "game-news-unified.sqlite");

// 已迁入并可运行的适配器
export const ADAPTERS = {
  "ref-x7": { module: () => import("./x7.mjs"), runnable: true, kind: "手游", fetch: (m) => m.fetchReservePages, detail: null },
  "ref-steam": { module: () => import("./steam.mjs"), runnable: true, kind: "端游", fetch: (m) => m.fetchItems, detail: null },
  "ref-gamersky": { module: () => import("./pc-news.mjs"), runnable: true, kind: "端游", fetch: (m) => m.fetchGamerskyItems, detail: (m) => m.fetchGamerskyDetail },
  "ref-gcores": { module: () => import("./pc-news.mjs"), runnable: true, kind: "资讯", fetch: (m) => m.fetchGcoresItems, detail: (m) => m.fetchGcoresDetail },
  "ref-haoyou": { module: () => import("./hykb.mjs"), runnable: true, kind: "手游", fetch: (m) => m.fetchHykbItems, detail: null },
  "ref-taptap": { module: () => import("./taptap.mjs"), runnable: true, kind: "手游", fetch: (m) => m.fetchTapTapHashtags, detail: null },
};

export function openDb() {
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA query_only = 0;");
  return db;
}

export function sourceInfo(db, id) {
  return db.prepare("SELECT * FROM sources WHERE id=?").get(id) || null;
}
