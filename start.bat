@echo off
rem ZCode 工具链渐进解锁代理 - 启动脚本
rem
rem 上游选择(可选参数,省略时使用 config.json 中的 upstream):
rem   start.bat opencode   -> https://opencode.ai/zen/go/v1
rem   start.bat deepseek   -> https://api.deepseek.com (需在客户端配置 DeepSeek 官方 API Key)
rem   start.bat custom     -> 使用环境变量 UPSTREAM_BASE_URL 指定的完整地址
rem
rem 也可直接修改同目录 config.json(环境变量优先级更高)。

cd /d "%~dp0"

if /I "%1"=="opencode" set UPSTREAM_BASE_URL=https://opencode.ai/zen/go/v1
if /I "%1"=="deepseek" set UPSTREAM_BASE_URL=https://api.deepseek.com

echo 启动代理... (Ctrl+C 停止)
node server.mjs
pause
