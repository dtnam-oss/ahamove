#!/bin/bash
# pc-typer cho macOS: bấm đúp để chạy. Cần Node.js (https://nodejs.org).
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" # Node cài bằng bộ cài nodejs.org hoặc Homebrew
if ! command -v node >/dev/null 2>&1; then
  echo "Máy chưa có Node.js. Tải và cài bản LTS tại https://nodejs.org rồi bấm đúp lại start.command."
  read -r -p "Bấm Enter để đóng." _
  exit 1
fi
node server.mjs
echo
read -r -p "pc-typer đã dừng. Bấm Enter để đóng." _
