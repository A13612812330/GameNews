// 固定回归样本（P3）：用于 RULE-01/02 与清洗规则的确定性回归，禁止随业务数据漂移。
export const sameEventThreeSources = [
  {
    id: "s1-taptap",
    source_id: "ref-taptap",
    source_name: "TapTap",
    game_name: "土豆兄弟",
    title: "土豆兄弟定档1月15日",
    category: "新游上线",
    date_text: "2026-08-17",
    discovered_at: "2026-08-17 08:00:00",
  },
  {
    id: "s1-haoyou",
    source_id: "ref-haoyou",
    source_name: "好游快爆",
    game_name: "《土豆兄弟》",
    title: "土豆兄弟公测定档1月15日",
    category: "新游上线",
    date_text: "2026-08-17",
    discovered_at: "2026-08-17 08:00:00",
  },
  {
    id: "s1-steam",
    source_id: "ref-steam",
    source_name: "Steam",
    game_name: "土豆兄弟",
    title: "土豆兄弟上线定档1月15日",
    category: "新游上线",
    date_text: "2026-08-17",
    discovered_at: "2026-08-17 08:00:00",
  },
];

export const activityTwoSources = [
  {
    id: "s2-haoyou",
    source_id: "ref-haoyou",
    source_name: "好游快爆",
    game_name: "原神",
    title: "「夏日祭」活动正式开启",
    category: "活动",
    date_text: "2026-08-20",
    discovered_at: "2026-08-20 09:00:00",
  },
  {
    id: "s2-taptap",
    source_id: "ref-taptap",
    source_name: "TapTap",
    game_name: "原神",
    title: "夏日祭活动开启公告",
    category: "活动",
    date_text: "2026-08-20",
    discovered_at: "2026-08-20 09:00:00",
  },
];

export const cleaningSamples = [
  { name: "《绝区零》", expect: "绝区零" },
  { name: "绝区零（PC版）", expect: "绝区零" },
  { name: " 荒野 行动 ", expect: "荒野 行动" },
  { name: "POTATO BROTHERS", expect: "potato brothers" },
  { name: "ＡＢＣ１２３", expect: "abc123" },
];
