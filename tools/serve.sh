#!/usr/bin/env bash
# pm2 的启动脚本。为什么不直接 `pm2 start server.js`：
# 那样得先把 OPENROUTER_API_KEY 塞进 pm2 的环境，而 `pm2 describe/env/jlist`
# 会把环境变量原样打出来，等于把密钥摊在任何查状态的人面前。
# 这里让 `secret` 在进程起来的那一刻自己去取，pm2 里一个密钥都不存。
#
#   pm2 start tools/serve.sh --name hundredyears
#
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"
exec secret exec OPENROUTER_API_KEY -- node server.js
