#!/usr/bin/env bash
set -euo pipefail
exec python3 "$(dirname "$0")/serve.py" "${1:-8000}"
