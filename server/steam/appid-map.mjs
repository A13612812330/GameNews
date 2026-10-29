// Steam AppID 映射（P4）
// 名称 → AppID 的唯一解析入口，供前端/分析/发布共用。
// 解析顺序：game_aliases 精确命中 → games.cn_name / games.name 规范化命中 → null。
import { normalizeGameName } from "../rules/index.mjs";

export function createAppIdMap(db) {
  let loaded = false;
  const aliasMap = new Map(); // 规范化别名 -> appid
  const nameMap = new Map(); // 规范化 cn/en 名 -> appid

  function warm() {
    if (loaded) return;
    for (const r of db.prepare("SELECT appid, alias FROM game_aliases WHERE appid IS NOT NULL").all()) {
      aliasMap.set(normalizeGameName(r.alias), r.appid);
    }
    for (const r of db.prepare("SELECT appid, cn_name, name FROM games").all()) {
      if (r.cn_name) nameMap.set(normalizeGameName(r.cn_name), r.appid);
      if (r.name) nameMap.set(normalizeGameName(r.name), r.appid);
    }
    loaded = true;
  }

  // 解析名称；secondChance 时可尝试去掉“手游/版”等后缀的模糊匹配
  function resolve(name, { fuzzy = true } = {}) {
    warm();
    const key = normalizeGameName(name);
    if (!key) return null;
    if (aliasMap.has(key)) return aliasMap.get(key);
    if (nameMap.has(key)) return nameMap.get(key);
    if (fuzzy) {
      const stripped = key.replace(/(手游|游戏|版|移动端|pc|steam)$/g, "");
      if (stripped !== key) {
        if (aliasMap.has(stripped)) return aliasMap.get(stripped);
        if (nameMap.has(stripped)) return nameMap.get(stripped);
      }
    }
    return null;
  }

  return { resolve, warm };
}
