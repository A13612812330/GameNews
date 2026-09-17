export function qualityLabel(q) {
  const map = {
    verified: "质量可靠", ok: "可用", needs_review: "待审核",
    low: "低质", low_quality: "低质量", failed: "抓取失败", pending: "待抓取",
  };
  return map[q] || q;
}

export function categoryLabel(c) {
  const map = { "新游上线": "新游上线", "热度延续": "热度延续", "版本更新": "版本更新", "联动活动": "联动活动" };
  return map[c] || c;
}

export function scoreColor(s) {
  if (s >= 80) return "var(--pine)";
  if (s >= 50) return "var(--pine)";
  return "var(--rose)";
}
