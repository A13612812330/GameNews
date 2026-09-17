import fs from "node:fs/promises";
import path from "node:path";
import { db } from "./database.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function safeJson(value, fallback = {}) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function shanghaiDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shanghaiStartOfDay(date = new Date()) {
  const key = shanghaiDateKey(date);
  return new Date(`${key}T00:00:00+08:00`);
}

function dateFromValue(value, now = new Date()) {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value < 1e12 ? value * 1000 : value);
  const text = String(value || "").trim();
  if (!text) return null;
  if (/^\d{10,13}$/.test(text)) return dateFromValue(Number(text), now);
  const iso = new Date(text);
  if (!Number.isNaN(iso.getTime()) && /\d{4}/.test(text)) return iso;
  const match = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:\s*(\d{1,2})[:：](\d{2}))?/u)
    || text.match(/(\d{1,2})[./-](\d{1,2})(?:\s*(\d{1,2})[:：](\d{2}))?/u);
  if (!match) return null;
  const [year] = shanghaiDateKey(now).split("-").map(Number);
  const hour = String(Number(match[3] || 0)).padStart(2, "0");
  const minute = String(Number(match[4] || 0)).padStart(2, "0");
  let target = new Date(`${year}-${String(Number(match[1])).padStart(2, "0")}-${String(Number(match[2])).padStart(2, "0")}T${hour}:${minute}:00+08:00`);
  const base = shanghaiStartOfDay(now);
  // 列表中的月日跨年时，优先理解为最近的业务日期，而不是遥远的过去。
  if (target.getTime() < base.getTime() - 183 * DAY_MS) target = new Date(`${year + 1}-${String(Number(match[1])).padStart(2, "0")}-${String(Number(match[2])).padStart(2, "0")}T${hour}:${minute}:00+08:00`);
  return target;
}

function articleBusinessDate(article, now = new Date()) {
  const facts = safeJson(article.facts, {});
  const candidates = [
    facts.taptapUpcomingStartTime,
    facts.timelineDate,
    facts.haoyouUpdateDate,
    facts.x7LaunchTime,
    facts.businessDate,
    article.date_text,
    article.discovered_at,
  ];
  for (const candidate of candidates) {
    const date = dateFromValue(candidate, now);
    if (date && !Number.isNaN(date.getTime())) return date;
  }
  return new Date(article.discovered_at || now);
}

function remoteImageValue(value, imageMap) {
  if (typeof value === "string") return imageMap.get(value) || value;
  if (Array.isArray(value)) return value.map((item) => remoteImageValue(item, imageMap));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remoteImageValue(item, imageMap)]));
  return value;
}

function normalizeImages(imagesValue) {
  const images = Array.isArray(imagesValue) ? imagesValue : safeJson(imagesValue, []);
  const imageMap = new Map();
  const normalized = [];
  const seen = new Set();
  for (const image of images) {
    if (!image || typeof image !== "object") continue;
    const original = String(image.originalUrl || image.url || image.src || image.localUrl || "").trim();
    if (!original) continue;
    const local = [image.src, image.localUrl].filter((item) => typeof item === "string" && item.includes("/crawler-assets/"));
    for (const item of local) {
      imageMap.set(item, original);
      const relative = item.slice(item.indexOf("/crawler-assets/"));
      imageMap.set(relative, original);
    }
    if (seen.has(original)) continue;
    seen.add(original);
    normalized.push({
      id: image.id || `remote-image-${normalized.length + 1}`,
      src: original,
      url: original,
      originalUrl: original,
      alt: image.alt || "",
      type: image.type || (normalized.length === 0 ? "cover_candidate" : "body_candidate"),
    });
  }
  return { images: normalized, imageMap };
}

function lightArticle(article, now = new Date()) {
  const { images } = normalizeImages(article.images_json);
  return {
    id: article.id,
    gameName: article.game_name || "",
    title: article.title || "",
    sourceId: article.source_id || "",
    sourceName: article.source_name || "",
    category: article.category || "",
    score: Number(article.score || 0),
    quality: article.quality || "",
    businessDate: articleBusinessDate(article, now).toISOString(),
    discoveredAt: article.discovered_at || "",
    detailUrl: article.detail_url || "",
    imageUrl: images[0]?.src || article.image_url || "",
    imageUrls: images.map((image) => image.src),
  };
}

async function mergeLightArchive(target, rows) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  let existing = [];
  try { existing = safeJson(await fs.readFile(target, "utf8"), []); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const byId = new Map(existing.filter(Boolean).map((item) => [item.id || `${item.gameName}|${item.detailUrl}`, item]));
  rows.forEach((row) => byId.set(row.id || `${row.gameName}|${row.detailUrl}`, row));
  await fs.writeFile(target, JSON.stringify([...byId.values()].sort((a, b) => String(a.businessDate).localeCompare(String(b.businessDate))), null, 2), "utf8");
}

export function migrateActiveArticlesToRemoteUrls() {
  const rows = db.prepare("SELECT id, image_url, images_json, facts FROM articles").all();
  const update = db.prepare("UPDATE articles SET image_url=?, images_json=?, facts=?, updated_at=datetime('now') WHERE id=?");
  let changed = 0;
  for (const row of rows) {
    const { images, imageMap } = normalizeImages(row.images_json);
    const facts = remoteImageValue(safeJson(row.facts, {}), imageMap);
    const imageUrl = imageMap.get(row.image_url) || row.image_url || images[0]?.src || "";
    const imagesJson = JSON.stringify(images);
    const factsJson = JSON.stringify(facts);
    if (imagesJson !== String(row.images_json || "[]") || factsJson !== String(row.facts || "{}") || imageUrl !== String(row.image_url || "")) {
      update.run(imageUrl, imagesJson, factsJson, row.id);
      changed += 1;
    }
  }
  return { scanned: rows.length, changed };
}

export async function archiveExpiredArticles({ root, keepDays = 7, now = new Date(), stage = false } = {}) {
  const cutoff = new Date(shanghaiStartOfDay(now).getTime() - Math.max(1, Number(keepDays) || 7) * DAY_MS);
  const rows = db.prepare("SELECT * FROM articles").all();
  const expired = rows.filter((article) => articleBusinessDate(article, now).getTime() < cutoff.getTime());
  const grouped = new Map();
  for (const article of expired) {
    const key = shanghaiDateKey(articleBusinessDate(article, now));
    const group = grouped.get(key) || [];
    group.push(lightArticle(article, now));
    grouped.set(key, group);
  }
  if (!stage) return { cutoff: cutoff.toISOString(), scanned: rows.length, expired: expired.length, archiveDays: [...grouped.keys()].sort(), deleted: 0 };
  for (const [date, lightRows] of grouped) {
    await mergeLightArchive(path.join(root, "data", "light-archive", "articles", `${date}.json`), lightRows);
  }
  if (expired.length) {
    const statement = db.prepare("DELETE FROM articles WHERE id=?");
    db.exec("BEGIN");
    try { expired.forEach((article) => statement.run(article.id)); db.exec("COMMIT"); }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  return { cutoff: cutoff.toISOString(), scanned: rows.length, expired: expired.length, archiveDays: [...grouped.keys()].sort(), deleted: expired.length };
}

function collectSnapshotArticles(raw) {
  const articles = Array.isArray(raw?.articles) ? raw.articles : [];
  return articles.map((article) => lightArticle({
    id: article.id,
    game_name: article.game_name || article.gameName,
    title: article.title,
    source_id: article.source_id || article.sourceId,
    source_name: article.source_name || article.sourceName,
    category: article.category,
    score: article.score,
    quality: article.quality,
    facts: typeof article.facts === "string" ? article.facts : JSON.stringify(article.facts || {}),
    images_json: typeof article.images_json === "string" ? article.images_json : JSON.stringify(article.images || article.imageItems || []),
    image_url: article.image_url || article.imageUrl,
    date_text: article.date_text || article.dateText,
    discovered_at: article.discovered_at || article.discoveredAt,
    detail_url: article.detail_url || article.detailUrl,
  }));
}

function normalizeSnapshotPayload(raw) {
  const articles = Array.isArray(raw?.articles) ? raw.articles : [];
  const replacements = new Map();
  const normalizedArticles = articles.map((article) => {
    const sourceImages = Array.isArray(article.images) && article.images.length
      ? article.images
      : Array.isArray(article.imageItems) && article.imageItems.length
        ? article.imageItems
        : safeJson(article.images_json, []);
    const { images, imageMap } = normalizeImages(sourceImages);
    imageMap.forEach((remote, local) => replacements.set(local, remote));
    const normalized = remoteImageValue({ ...article }, imageMap);
    normalized.images = images;
    if (Object.prototype.hasOwnProperty.call(normalized, "images_json")) normalized.images_json = JSON.stringify(images);
    if (Object.prototype.hasOwnProperty.call(normalized, "image_url")) normalized.image_url = imageMap.get(normalized.image_url) || normalized.image_url || images[0]?.src || "";
    if (Object.prototype.hasOwnProperty.call(normalized, "imageUrl")) normalized.imageUrl = imageMap.get(normalized.imageUrl) || normalized.imageUrl || images[0]?.src || "";
    return normalized;
  });
  return { payload: { ...raw, articles: normalizedArticles }, replacements };
}

async function replaceHtmlAssetUrls(file, replacements) {
  if (!replacements.size) return false;
  try {
    let html = await fs.readFile(file, "utf8");
    const original = html;
    replacements.forEach((remote, local) => { html = html.split(local).join(remote); });
    if (html !== original) await fs.writeFile(file, html, "utf8");
    return html !== original;
  } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

async function collectDateFolders(rootDir) {
  try { return (await fs.readdir(rootDir, { withFileTypes: true })).filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name)); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
}

async function removeDirectoryWithRetry(directory) {
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
      return { deleted: true, error: "" };
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
    }
  }
  return { deleted: false, error: lastError?.message || "未知删除错误" };
}

async function writeLightSnapshotArchive({ root, kind, date, source }) {
  try {
    const raw = safeJson(await fs.readFile(source, "utf8"), {});
    const rows = collectSnapshotArticles(raw);
    if (rows.length) await mergeLightArchive(path.join(root, "data", "light-archive", kind, `${date}.json`), rows);
    return rows.length;
  } catch { return 0; }
}

export async function archiveExpiredRawSnapshots({ root, keepDays = 7, now = new Date(), stage = false } = {}) {
  const cutoffKey = shanghaiDateKey(new Date(shanghaiStartOfDay(now).getTime() - Math.max(1, Number(keepDays) || 7) * DAY_MS));
  const rootDir = path.join(root, "data", "raw-archive");
  const entries = await collectDateFolders(rootDir);
  const expired = entries.filter((entry) => entry.name < cutoffKey);
  let archivedRows = 0;
  let normalized = 0;
  const pendingDeletion = [];
  if (stage) for (const entry of expired) {
    archivedRows += await writeLightSnapshotArchive({ root, kind: "raw", date: entry.name, source: path.join(rootDir, entry.name, "RAW_ARTICLES.json") });
    const removed = await removeDirectoryWithRetry(path.join(rootDir, entry.name));
    if (!removed.deleted) pendingDeletion.push({ date: entry.name, error: removed.error });
  }
  if (stage) for (const entry of entries.filter((item) => item.name >= cutoffKey)) {
    const dir = path.join(rootDir, entry.name);
    const jsonPath = path.join(dir, "RAW_ARTICLES.json");
    try {
      const raw = safeJson(await fs.readFile(jsonPath, "utf8"), {});
      const { payload, replacements } = normalizeSnapshotPayload(raw);
      await fs.writeFile(jsonPath, JSON.stringify(payload, null, 2), "utf8");
      await replaceHtmlAssetUrls(path.join(dir, "RAW_ARTICLES.html"), replacements);
      normalized += 1;
    } catch {}
  }
  return { cutoff: cutoffKey, expired: expired.map((entry) => entry.name), archivedRows, normalized, pendingDeletion, deleted: stage ? expired.length - pendingDeletion.length : 0 };
}

export async function archiveExpiredWeeklySnapshots({ root, keepDays = 7, now = new Date(), stage = false } = {}) {
  const cutoffKey = shanghaiDateKey(new Date(shanghaiStartOfDay(now).getTime() - Math.max(1, Number(keepDays) || 7) * DAY_MS));
  const rootDir = path.join(root, "data", "weekly-snapshots");
  const entries = await collectDateFolders(rootDir);
  const expired = entries.filter((entry) => entry.name < cutoffKey);
  let archivedRows = 0;
  let normalized = 0;
  const pendingDeletion = [];
  if (stage) for (const entry of expired) {
    archivedRows += await writeLightSnapshotArchive({ root, kind: "weekly", date: entry.name, source: path.join(rootDir, entry.name, "materials.json") });
    const removed = await removeDirectoryWithRetry(path.join(rootDir, entry.name));
    if (!removed.deleted) pendingDeletion.push({ date: entry.name, error: removed.error });
  }
  if (stage) for (const entry of entries.filter((item) => item.name >= cutoffKey)) {
    const dir = path.join(rootDir, entry.name);
    const jsonPath = path.join(dir, "materials.json");
    try {
      const raw = safeJson(await fs.readFile(jsonPath, "utf8"), {});
      const { payload } = normalizeSnapshotPayload(raw);
      await fs.writeFile(jsonPath, JSON.stringify(payload, null, 2), "utf8");
      const removed = await removeDirectoryWithRetry(path.join(dir, "assets"));
      if (!removed.deleted) pendingDeletion.push({ date: entry.name, error: `assets: ${removed.error}` });
      normalized += 1;
    } catch {}
  }
  return { cutoff: cutoffKey, expired: expired.map((entry) => entry.name), archivedRows, normalized, pendingDeletion, deleted: stage ? expired.length - pendingDeletion.filter((item) => !String(item.error).startsWith("assets:")).length : 0 };
}

export { articleBusinessDate, lightArticle, normalizeImages, remoteImageValue, shanghaiDateKey };
