#!/usr/bin/env bash
# 反证 harness：把海报链路的实现逐项打坏，确认 scripts/verify-poster-pipeline-hardening.mjs
# 真的会变红。存在的意义是防「假绿」——只测常量名、不测行为的断言，以及恒真的断言。
#
# 每个用例：先备份原文件 → 打坏 → 跑验证 → 记录 [FAIL] 条数 → 立刻还原。
# 全程只改工作区文件，不启动服务、不截图、不投递。
#
# 为什么不用 sed：sed 的模式若因实现改名而不再匹配，会**静默成功**（什么都不改），
# 于是验证仍然全绿，输出「说明该断言恒真，是假断言！」—— 把一条好断言诬告成假断言。
# 这里改用 break_src()，模式必须真的命中，否则明确报「用例过期」。
#
# 用法（Git Bash）：bash scripts/counterproof-poster-pipeline.sh
# 期望输出：17 个用例全部「[OK 变红]」，最后「已还原，全绿」，且逐文件 diff 无差异。
set -u
export PATH="/usr/bin:/bin:/c/Windows/System32:$PATH"
cd "$(dirname "$0")/.." || exit 1

S=server/scheduler.js
P=scripts/scheduled-posters.mjs
U=server/scheduler-support.js
G=scripts/poster-render-guard.mjs
V="node scripts/verify-poster-pipeline-hardening.mjs"

# 临时目录放在项目内：mktemp -d 在 Git Bash 下返回 Windows 风格路径（C:/Users/...），
# 与 POSIX 路径混用会让收尾的 rm 拼出非法路径（实测 rm -rf 失败并把临时目录留在别处）。
TMP=".counterproof-tmp"
rm -rf "$TMP" 2>/dev/null || true
mkdir -p "$TMP"
cp "$S" "$TMP/s.js"; cp "$P" "$TMP/p.js"; cp "$U" "$TMP/u.js"; cp "$G" "$TMP/g.js"
restore() { cp "$TMP/s.js" "$S"; cp "$TMP/p.js" "$P"; cp "$TMP/u.js" "$U"; cp "$TMP/g.js" "$G"; }

# 把 file 中的字面量 from 全部换成 to；模式没命中的话明确报错，绝不静默通过。
break_src() {
  if ! node -e '
const fs = require("node:fs");
const [file, from, to] = process.argv.slice(1);
const src = fs.readFileSync(file, "utf8");
if (!src.includes(from)) {
  console.error("PATTERN_NOT_FOUND");
  process.exit(2);
}
fs.writeFileSync(file, src.split(from).join(to));
' "$1" "$2" "$3"; then
    printf '  !! 打坏失败：目标模式未找到 —— 该用例已过期（实现改名了？），请更新用例\n'
  fi
}

run_case() {
  local label="$1"
  local out; out=$($V 2>&1)
  local fails; fails=$(printf '%s' "$out" | grep -c "\[FAIL\]")
  local hits; hits=$(printf '%s' "$out" | grep "\[FAIL\]" | sed 's/^ *//' | tr '\n' '|')
  if [ "$fails" -gt 0 ]; then
    printf '  [OK 变红] %s → %s 条断言失败\n          命中: %s\n' "$label" "$fails" "$hits"
  else
    printf '  [!! 仍绿] %s → 说明该断言恒真，是假断言！\n' "$label"
  fi
  restore
}

echo "=== 基线（应全绿） ==="
if $V > /dev/null 2>&1; then echo "  基线绿 ✓"; else echo "  !! 基线就是红的，先修基线"; fi

echo
echo "=== 逐个打坏 ==="

# ── 组 1/6：超时预算与调度不变式 ──────────────────────────────────────────
break_src "$S" 'timeout: 600000,' 'timeout: 180000,'
run_case "① 外层超时改回 180000（预算倒挂）"

break_src "$P" 'const RENDER_TIMEOUT_MS = 45_000;' 'const RENDER_TIMEOUT_MS = 90_000;'
run_case "② 内层截图超时改回 90s（预算倒挂）"

break_src "$S" 'const POSTER_ATTEMPTS = 2;' 'const POSTER_ATTEMPTS = 4;'
run_case "③ 重试次数放大到 4（日报最坏窗口盖住 09:00 周报）"

break_src "$S" 'cron.schedule("00 9 * * 1"' 'cron.schedule("35 8 * * 1"'
break_src "$S" '周一09:00周报' '周一08:35周报'
run_case "④ 周报改回 08:35（与日报最坏窗口重叠）"

# ── 组 2：kind 级互斥 ────────────────────────────────────────────────────
break_src "$U" 'if (running.has(kind)) return false;' 'if (running.size) return false;'
run_case "⑤ kind 锁退化成整条链路互斥（周报被日报拖死）"

# ── 组 3/4：stdout 契约与解析容错 ────────────────────────────────────────
break_src "$P" 'console.warn(`[poster] PNG 裁边' 'console.log(`[poster] PNG 裁边'
run_case "⑥ 裁边日志改回 stdout（6190ca4 的原始 bug）"

break_src "$U" 'for (let index = lines.length - 1; index >= 0; index -= 1) {' 'for (let index = -1; index >= 0; index -= 1) {'
run_case "⑦ 去掉 stdout 的兜底解析"

# ── 组 5：失败诊断完整性 ─────────────────────────────────────────────────
break_src "$U" 'stdoutTail: tailText(error?.stdout),' 'stdoutTail: "",'
run_case "⑧ 丢掉子进程 stdout"

# ── 组 6：锁 TTL ────────────────────────────────────────────────────────
break_src "$P" 'const DELIVERY_LOCK_TTL_MS = 15 * 60 * 1000;' 'const DELIVERY_LOCK_TTL_MS = 5 * 60 * 1000;'
run_case "⑨ 投递锁 TTL 缩到 5 分钟（小于外层超时）"

# ── 组 7：渲染防护 ──────────────────────────────────────────────────────
break_src "$G" 'export const POSTER_PLACEHOLDER_DATA_URI = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(PLACEHOLDER_SVG)}`;' 'export const POSTER_PLACEHOLDER_DATA_URI = "https://example.com/p.png";'
run_case "⑩ 占位图改成外链（又变成一次网络请求）"

break_src "$G" 'const next = Math.min(Math.round(current * growth), maxCanvasHeight);' 'const next = current;'
run_case "⑪ 画布触底也不再加高（截断内容无声丢失）"

break_src "$G" 'if (attempt >= maxAttempts) {' 'if (false) {'
run_case "⑫ 去掉重截上限（可能无限重截）"

break_src "$G" 'if (/^data:/iu.test(value)) return null;' 'if (false) return null;'
run_case "⑬ 内联 data: URI 也被当成待探测图片"

break_src "$G" 'if (profileDir) args.push(`--user-data-dir=${profileDir}`);' '/* 打坏：不注入 profile */'
run_case "⑭ 截图不带独立 user-data-dir（会被转交给 GUI 实例）"

break_src "$G" 'if (!resolved || !failed.has(resolved)) return tag;' 'if (!resolved) return tag;'
run_case "⑮ 占位替换不过滤（把可达的图也一起换掉）"

break_src "$P" 'await fs.rm(previewPath, { force: true });' 'void 0;'
run_case "⑯ 截图前不删旧 PNG（加高重截会把残留当成成功）"

break_src "$P" 'const CANVAS_GROWTH = 2;' 'const CANVAS_GROWTH = 1;'
run_case "⑰ 增长系数改成 1（加高变成空操作）"

echo
echo "=== 还原后复检 ==="
restore
if $V > /dev/null 2>&1; then echo "  已还原，全绿 ✓"; else echo "  !! 还原后仍红，检查工作区！"; fi

echo
echo "=== 与被备份版本逐文件比对（应无输出）==="
diff -q "$TMP/s.js" "$S"
diff -q "$TMP/p.js" "$P"
diff -q "$TMP/u.js" "$U"
diff -q "$TMP/g.js" "$G"
node --input-type=module -e 'import fs from "node:fs"; fs.rmSync(".counterproof-tmp", { recursive: true, force: true });' 2>/dev/null || true
echo "（逐文件 diff 无输出即表示工作区已完全还原）"
