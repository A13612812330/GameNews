// 统一清洗规则层（唯一实现，供网站/海报/飞书共同调用，禁止出口各自实现清洗）
// 游戏名 / 标题 / 日期规范化，用于去重与跨出口一致性。

function halfWidth(s) {
  return s
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

// 游戏名清洗：去《》/括号注释、折叠空白、半角化、小写
export function normalizeGameName(name) {
  if (name == null) return "";
  return halfWidth(
    String(name)
      .replace(/[《》【】「」『』]/g, "")
      .replace(/[（(].*?[)）]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase()
  );
}

// P3 业务游戏名清洗：去除"官服/预约/预下载/预购/预售/活动"等运营后缀，保留"体验服/测试服"等正式区分。
// 用于跨平台去重的分组键，避免同一游戏因运营状态不同而拆成多条。
export function cleanBusinessGameName(name) {
  if (name == null) return "";
  let s = String(name);
  // 去书名号/角括号
  s = s.replace(/[《》【】「」『』]/g, "");
  // 括号包裹的运营后缀（保留体验服/测试服等正式区分）
  s = s.replace(/[（(]\s*(?:官服|官方服|预约|预约中|新游预约|版本预约|预下载|预购|预售|活动)\s*[)）]/giu, "");
  // 尾部运营后缀（"-预约/预下载/预购/预售/活动" 或 直接拼接的 官服/活动）
  s = s.replace(/[-—–：:]\s*(?:官服|官方服|预约|新游预约|版本预约|预下载|预购|预售|活动)\s*$/iu, "");
  s = s.replace(/\s+(?:官服|官方服|预约|预下载|预购|预售|活动)\s*$/iu, "");
  s = s.replace(/(?:官服|官方服)\s*$/iu, "");
  s = s.replace(/(?:活动)\s*$/iu, "");
  return halfWidth(s.replace(/\s+/g, " ").trim().toLowerCase());
}

// 标题清洗：去前导 #、去书名号/括号注释、标点符号→空格、折叠、小写、半角化
export function normalizeTitle(title) {
  if (title == null) return "";
  return halfWidth(
    String(title)
      .replace(/^#+\s*/, "")
      .replace(/[《》【】「」『』]/g, "")
      .replace(/[（(].*?[)）]/g, "")
      .replace(/[\p{P}\p{S}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase()
  );
}

// 从标题提取书名号《》内的游戏名（无则空串，避免把整条标题当游戏名）
export function extractBookTitle(title) {
  const m = String(title || "").match(/《([^》]{2,36})》/u);
  return m ? normalizeGameName(m[1]) : "";
}

// 从 date_text 或 discovered_at 提取 YYYY-MM-DD（无则空串）
// 支持无年份格式（MM月DD日 / MM-DD），补当前年；跨年（早于今天 180 天）补次年。
export function dateBucket(dateText, fallback) {
  const s = String(dateText || fallback || "");
  const m = s.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) {
    return `${m[1]}-${String(+m[2]).padStart(2, "0")}-${String(+m[3]).padStart(2, "0")}`;
  }
  const md = s.match(/(\d{1,2})月(\d{1,2})日/);
  if (md) {
    let year = new Date().getFullYear();
    const date = new Date(year, Number(md[1]) - 1, Number(md[2]));
    if (date.getTime() < Date.now() - 180 * 86400000) date.setFullYear(year + 1); // 跨年
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }
  return "";
}

// 去重键：规范化游戏名 + 规范化标题 + 日期桶
export function dedupKey(article) {
  return `${normalizeGameName(article.game_name)}|${normalizeTitle(article.title)}|${dateBucket(
    article.date_text,
    article.discovered_at
  )}`;
}
