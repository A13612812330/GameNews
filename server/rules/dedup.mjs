// 跨平台去重（统一规则层）
// RULE-02：同游戏同日期 + 标题相似(标准 bigram Dice ≥ 阈值) 归为一组；
//          胜者按来源优先级表；保留组内全部来源关系（members/duplicates）。
import { cleanBusinessGameName, normalizeTitle, dateBucket, dedupKey } from "./normalize.mjs";
import { sourceIdOf, rankOf } from "./priority.mjs";

function bigrams(s) {
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

// 标准 Dice 系数（2*|A∩B| / (|A|+|B|)），衡量两个规范化标题的相似度
export function titleSimilarity(a, b) {
  const A = bigrams(normalizeTitle(a));
  const B = bigrams(normalizeTitle(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return (2 * inter) / (A.size + B.size);
}

// 输入：articles（含 source_id/source_name/game_name/title/category/date_text/discovered_at）
// 输出：[{ key, winner, members, duplicates }]
export function dedupArticles(articles, { simThreshold = 0.5 } = {}) {
  // 一级：业务游戏名 + 日期桶 + 分类（业务名去除官服/预约等运营后缀，避免同游戏被拆开；
  //       分类用于区分如 Steam 热玩榜 vs 畅销榜 这类同游戏不同事件）
  const level1 = new Map();
  for (const a of articles) {
    const k = `${cleanBusinessGameName(a.game_name)}|${dateBucket(a.date_text, a.discovered_at)}|${a.category || ""}`;
    if (!level1.has(k)) level1.set(k, []);
    level1.get(k).push(a);
  }
  const groups = [];
  for (const bucket of level1.values()) {
    // 二级：标题相似度贪心聚类
    const clusters = [];
    for (const a of bucket) {
      const nt = normalizeTitle(a.title);
      let placed = false;
      for (const c of clusters) {
        if (titleSimilarity(nt, c[0].title) >= simThreshold) {
          c.push(a);
          placed = true;
          break;
        }
      }
      if (!placed) clusters.push([a]);
    }
    for (const members of clusters) {
      const sorted = [...members].sort(
        (x, y) => rankOf(sourceIdOf(x), x.category) - rankOf(sourceIdOf(y), y.category)
      );
      groups.push({ key: dedupKey(sorted[0]), winner: sorted[0], members: sorted, duplicates: sorted.slice(1) });
    }
  }
  return groups;
}
