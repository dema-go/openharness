#!/usr/bin/env bash
# Supervisor 真机冒烟脚本(DeepSeek,人在环)
# 用法:先配置 Key(curl -X PUT http://127.0.0.1:3900/api/supervisor/config -d '{"apiKey":"sk-..."}'),
#      然后 bash scripts/smoke-supervisor.sh [port]
# 流程:发起 hitl run → 轮询至 awaiting_approval → approve → 轮询至终态 → 打印报告与步骤
set -euo pipefail
PORT="${1:-3900}"
BASE="http://127.0.0.1:${PORT}"
CWD="$(mktemp -d /tmp/oh-sup-smoke.XXXXXX)"

echo "== 1. 配置检查 =="
curl -s "$BASE/api/supervisor/config"; echo
CFG=$(curl -s "$BASE/api/supervisor/config")
echo "$CFG" | grep -q '"configured":true' || { echo "❌ LLM 未配置,先 PUT apiKey"; exit 1; }

echo "== 2. 发起 hitl run(工作目录 $CWD)=="
RUN=$(curl -s -X POST "$BASE/api/supervisor/runs" -H 'content-type: application/json' \
  -d "{\"goal\":\"在 $CWD 里创建 hello.txt,内容为一行中文问候语,然后结束。\",\"cwd\":\"$CWD\",\"mode\":\"hitl\"}")
RUN_ID=$(echo "$RUN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "run: $RUN_ID"

wait_state() {
  local want="$1" timeout="${2:-180}" elapsed=0
  while [ $elapsed -lt $timeout ]; do
    STATE=$(curl -s "$BASE/api/supervisor/runs/$RUN_ID" | python3 -c 'import json,sys; print(json.load(sys.stdin)["run"]["state"])')
    case "$STATE" in
      done|failed|stopped) return 0 ;;
      "$want") return 0 ;;
    esac
    sleep 2; elapsed=$((elapsed+2))
  done
  echo "等待 $want 超时(当前 $STATE)"; return 1
}

echo "== 3. 等待计划(→ awaiting_approval)=="
wait_state awaiting_approval 120 || { curl -s "$BASE/api/supervisor/runs/$RUN_ID"; exit 1; }
curl -s "$BASE/api/supervisor/runs/$RUN_ID" | python3 -m json.tool | head -40

echo "== 4. 批准计划 =="
curl -s -X POST "$BASE/api/supervisor/runs/$RUN_ID/approve" -H 'content-type: application/json' -d '{"action":"approve"}'; echo

echo "== 5. 等待终态(Worker 执行 + 验收 + 报告)=="
wait_state done 600
curl -s "$BASE/api/supervisor/runs/$RUN_ID" | python3 -m json.tool
echo "== 6. Worker 实际产物 =="
ls -la "$CWD"; cat "$CWD"/hello.txt 2>/dev/null || true
