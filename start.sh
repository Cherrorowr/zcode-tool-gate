#!/usr/bin/env bash
# ZCode 工具链渐进解锁代理 - 启动脚本(Linux/macOS/Windows Git Bash)
# 用法:
#   ./start.sh                使用 config.json 配置
#   ./start.sh opencode       上游 = https://opencode.ai/zen/go/v1
#   ./start.sh deepseek       上游 = https://api.deepseek.com
#   UPSTREAM_BASE_URL=... ./start.sh custom   指定完整上游地址
set -e
cd "$(dirname "$0")"
case "$1" in
  opencode) export UPSTREAM_BASE_URL="https://opencode.ai/zen/go/v1" ;;
  deepseek) export UPSTREAM_BASE_URL="https://api.deepseek.com" ;;
esac
echo "启动代理... (Ctrl+C 停止)"
node server.mjs
