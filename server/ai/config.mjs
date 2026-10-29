// AI 分析契约与配置登记（P4）
// 待提供项（规划 §05）：模型/权限、分析目标、输出格式、是否允许自动发布。
// 在配置就绪前，禁止真实调用模型；analysis.mjs 的记录层已就绪，可先记录“未配置”占位分析用于契约验证。
export const AI_CONFIG = {
  // 待提供：模型名与密钥/权限（当前为 null，禁止真实推理）
  model: null,
  // 待提供：提示词文本与版本（当前仅登记版本号，供 ai_analyses.prompt_version 引用）
  promptVersion: "v0-unconfigured",
  // 安全默认：不允许 AI 自动发布，所有 AI 输出需人工确认
  autoPublish: false,
};

// 提示词版本登记表（每次修改提示词必须新增版本号并在分析中写入该版本）
export const PROMPT_VERSIONS = [
  {
    version: "v0-unconfigured",
    note: "占位版本：模型与提示词尚未提供，仅用于契约与记录层验证。",
    createdAt: "2026-08-26",
  },
];

// 允许的分析目标类型（与 ai_analyses.target_type 对齐）
export const TARGET_TYPES = ["article", "game", "event"];
