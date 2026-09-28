#!/usr/bin/env bash
# 反证 harness：把海报链路的实现逐项打坏，确认 scripts/verify-poster-pipeline-hardening.mjs
# 真的会变红。存在的意义是防「假绿」——只测常量名、不测行为的断言，以及恒真的断言。
#
# 每个用例：先备份原文件 → sed 打坏 → 跑验证 → 记录 [FAIL] 条数 → 立刻还原。
# 全程只改工作区文件，不启动服务、不截图、不投递。
#
# 用法（Git Bash）：bash scripts/counterproof-poster-pipeline.sh
# 期望输出：8 个用例全部「[OK 变红]」，最后「已还原，全绿」。
set -u
export PATH="/usr/bin:/bin:/c/Windows/System32:$PATH"
cd "$(dirname "$0")/.." || exit 1

S=server/scheduler.js
P=scripts/scheduled-posters.mjs
U=server/scheduler-support.js
V="node scripts/verify-poster-pipeline-hardening.mjs"

TMP=$(mktemp -d)
cp "$S" "$TMP/s.js"; cp "$P" "$TMP/p.js"; cp "$U" "$TMP/u.js"
restore() { cp "$TMP/s.js" "$S"; cp "$TMP/p.js" "$P"; cp "$TMP/u.js" "$U"; }

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

sed -i 's/timeout: 420000,/timeout: 180000,/' "$S"
run_case "① 外层超时改回 180000（预算倒挂）"

sed -i 's/const RENDER_TIMEOUT_MS = 45_000;/const RENDER_TIMEOUT_MS = 90_000;/' "$P"
run_case "② 内层截图超时改回 90s（预算倒挂）"

sed -i 's/if (running.has(kind)) return false;/if (running.size) return false;/' "$U"
run_case "③ kind 锁退化成整条链路互斥（周报被日报拖死）"

sed -i 's/console.warn(`\[poster\] PNG 裁边/console.log(`[poster] PNG 裁边/' "$P"
run_case "④ 裁边日志改回 stdout（6190ca4 的原始 bug）"

sed -i 's/for (let index = lines.length - 1; index >= 0; index -= 1) {/for (let index = -1; index >= 0; index -= 1) {/' "$U"
run_case "⑤ 去掉 stdout 的兜底解析"

sed -i 's/stdoutTail: tailText(error?.stdout),/stdoutTail: "",/' "$U"
run_case "⑥ 丢掉子进程 stdout"

sed -i 's/cron.schedule("50 8 \* \* 1"/cron.schedule("35 8 * * 1"/' "$S"
sed -i 's/周一08:50周报/周一08:35周报/' "$S"
run_case "⑦ 周报改回 08:35（与日报最坏窗口重叠）"

sed -i 's/const DELIVERY_LOCK_TTL_MS = 10 \* 60 \* 1000;/const DELIVERY_LOCK_TTL_MS = 5 * 60 * 1000;/' "$P"
run_case "⑧ 投递锁 TTL 缩到 5 分钟（小于外层超时）"

echo
echo "=== 还原后复检 ==="
restore
if $V > /dev/null 2>&1; then echo "  已还原，全绿 ✓"; else echo "  !! 还原后仍红，检查工作区！"; fi

echo
echo "=== 与被备份版本逐文件比对（应无输出）==="
diff -q "$TMP/s.js" "$S"
diff -q "$TMP/p.js" "$P"
diff -q "$TMP/u.js" "$U"
rm -rf "$TMP"
