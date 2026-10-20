#!/usr/bin/env bash
# Hidden acceptance check: runs in the finished workspace; exit 0 means the task passed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cp "$HERE/hidden/test_hidden.py" ./test_hidden_check.py
PYTHONPATH=src pytest -q -p no:cacheprovider test_hidden_check.py
