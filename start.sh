#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if command -v python3 >/dev/null 2>&1; then
  PYTHON="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON="python"
else
  echo "Python 3 is required. Install it with your distribution package manager." >&2
  exit 1
fi
printf '%s\n' "Launching kayralrics.com - video…" "The server will print the exact local URL (and will select another port if 8080 is busy)." "Site: kayralrics.com - video  ·  Credit: kayralrics.net" "Keep this terminal open while editing. Press Ctrl+C to stop."
exec "$PYTHON" server.py
