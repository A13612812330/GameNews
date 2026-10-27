#!/usr/bin/env bash
# 一次性反证：把监控防护逐项打坏，确认 verify-monitor-watchdog.mjs 会变红。
# 全程备份→改→跑→立刻还原，收尾逐文件 diff 校验。
set -u
export PATH="/usr/bin:/bin:/c/Windows/System32:$PATH"
cd "$(dirname "$0")/.." || exit 1

S=server/scheduler.js
R=server/crawler/rateLimiter.js
F=server/crawler/fetcher.js
V="node scripts/verify-monitor-watchdog.mjs"

TMP=".tmp-breaktest"
rm -rf "$TMP"; mkdir -p "$TMP"
cp "$S" "$TMP/s.js"; cp "$R" "$TMP/r.js"; cp "$F" "$TMP/f.js"
restore() { cp "$TMP/s.js" "$S"; cp "$TMP/r.js" "$R"; cp "$TMP/f.js" "$F"; }
trap restore EXIT

break_src() {
  if ! node -e '
const fs=require("node:fs");
const [file,from,to]=process.argv.slice(1);
const src=fs.readFileSync(file,"utf8");
if(!src.includes(from)){console.error("PATTERN_NOT_FOUND");process.exit(2);}
fs.writeFileSync(file,src.split(from).join(to));
' "$1" "$2" "$3"; then
    printf '  !! 打坏失败：模式未命中（用例过期）\n'
  fi
}

run_case() {
  local out; out=$($V 2>&1)
  local fails; fails=$(printf '%s' "$out" | grep -c "\[FAIL\]")
  if [ "$fails" -gt 0 ]; then
    printf '  [OK 变红] %s → %s 条失败\n' "$1" "$fails"
  else
    printf '  [!! 仍绿] %s → 断言恒真\n' "$1"
  fi
  restore
}

echo "=== 基线 ==="
if $V >/dev/null 2>&1; then echo "  基线绿"; else echo "  !! 基线红"; fi

echo "=== 打坏 ==="
break_src "$S" 'await withDeadline(
      crawlCandidates(' 'await (crawlCandidates('
run_case "A 去掉 Step 1 的硬截止"

break_src "$R" 'Promise.race([scrape, timeout])' 'scrape'
run_case "B firecrawl 去掉超时兜底"

break_src "$S" '  releaseStaleMonitorRun();
' '
'
run_case "C 入口不再先释放卡死轮次"

break_src "$F" 'timeout: 25_000,' ''
run_case "D curl 子进程去掉 timeout"

echo "=== 还原复检 ==="
restore
if $V >/dev/null 2>&1; then echo "  已还原，全绿"; else echo "  !! 还原后仍红"; fi
diff -q "$TMP/s.js" "$S" && diff -q "$TMP/r.js" "$R" && diff -q "$TMP/f.js" "$F" && echo "  逐文件 diff 无差异"
# 收尾清理：不要让备份目录留在工作区（否则 git status 会多出一条未跟踪项）
rm -rf "$TMP"
