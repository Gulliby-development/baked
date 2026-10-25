#!/usr/bin/env bash
set -euo pipefail

limit=""
if [ "$#" -gt 0 ]; then
  case "$1" in
  '' | *[!0-9]* | 0)
    echo "usage: wordfreq.sh [N]" >&2
    exit 2
    ;;
  esac
  limit="$1"
fi

counts() {
  LC_ALL=C tr -cs 'A-Za-z' '\n' |
    tr '[:upper:]' '[:lower:]' |
    grep -v '^$' |
    sort |
    uniq -c |
    awk '{ print $1 " " $2 }' |
    sort -k1,1nr -k2,2
}

if [ -n "$limit" ]; then
  counts | head -n "$limit"
else
  counts
fi
