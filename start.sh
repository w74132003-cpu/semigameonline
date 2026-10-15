#!/bin/bash
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo "找不到 Node.js，請先安裝（https://nodejs.org，18 版以上）"; exit 1; }
node server.js
