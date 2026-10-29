// 来源优先级表（统一规则层的一部分）
// RULE-02：新游上线优先 TapTap；活动优先 好游快爆；其余给出稳定顺序。
export const SOURCE_PRIORITY = {
  新游上线: ["ref-taptap", "ref-steam", "ref-gamersky", "ref-x7", "ref-gcores", "ref-haoyou"],
  测试公测: ["ref-taptap", "ref-steam", "ref-gamersky", "ref-x7", "ref-gcores", "ref-haoyou"],
  版本更新: ["ref-taptap", "ref-haoyou", "ref-gamersky", "ref-gcores", "ref-x7", "ref-steam"],
  活动: ["ref-haoyou", "ref-taptap", "ref-gamersky", "ref-x7", "ref-gcores", "ref-steam"],
  default: ["ref-taptap", "ref-haoyou", "ref-gamersky", "ref-x7", "ref-gcores", "ref-steam"],
};

// source_name → source_id 兜底映射（WX/GameNews 记录若 source_id 缺失）
export const NAME_TO_ID = {
  TapTap: "ref-taptap",
  好游快爆: "ref-haoyou",
  游民星空: "ref-gamersky",
  机核: "ref-gcores",
  小七手游: "ref-x7",
  Steam: "ref-steam",
  九游: "ref-jiuyou",
  游侠网: "ref-ali213",
};

export function sourceIdOf(article) {
  if (article.source_id) return article.source_id;
  return NAME_TO_ID[article.source_name] || article.source_name || "";
}

// 返回该来源在给定分类下的名次（越小越优先）；不在表中则排最后
export function rankOf(sourceId, category) {
  const list = SOURCE_PRIORITY[category] || SOURCE_PRIORITY.default;
  const i = list.indexOf(sourceId);
  return i === -1 ? list.length + 1 : i;
}
