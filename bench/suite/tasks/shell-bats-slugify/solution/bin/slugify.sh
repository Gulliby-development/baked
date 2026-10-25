#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: slugify.sh TEXT..." >&2
  exit 2
fi

printf '%s' "$*" |
  tr '[:upper:]' '[:lower:]' |
  LC_ALL=C sed -e 's/[^a-z0-9][^a-z0-9]*/-/g' -e 's/^-//' -e 's/-$//'
echo
