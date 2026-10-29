// 统一规则层唯一入口。
// 约束：网站(website)、简讯/海报/周报(publishing)、飞书(feishu) 三个出口必须只从这里导入清洗/去重/评级能力，
// 禁止各自实现同名规则，避免三套口径。
export * from "./normalize.mjs";
export * from "./priority.mjs";
export * from "./dedup.mjs";
export { createRatingService } from "./rating.mjs";

export const RULES_VERSION = "v1";
