#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  找不到 Node.js。請先安裝（免費）：https://nodejs.org ，裝「LTS」版本即可。"
  echo "  裝好之後，再點兩下這個檔案一次。"
  echo
  open https://nodejs.org 2>/dev/null
  read -n 1 -s -r -p "按任意鍵關閉"
  exit 1
fi
( sleep 1.5; open http://localhost:3000/host ) &
node server.js
