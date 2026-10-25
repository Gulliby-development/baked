#!/usr/bin/env bash
set -euo pipefail
s="$1/bin/wordfreq.sh"
[ -x "$s" ]
[ "$(printf 'The cat and the hat.\nTHE end, cat!\n' | "$s")" = "$(printf '3 the\n2 cat\n1 and\n1 end\n1 hat')" ]
[ "$(printf 'b a b a c\n' | "$s" 2)" = "$(printf '2 a\n2 b')" ]
[ "$(printf '' | "$s")" = "" ]
set +e
err="$(printf 'x' | "$s" zero 2>&1 >/dev/null)"
code=$?
set -e
[ "$code" = 2 ]
[ "$err" = "usage: wordfreq.sh [N]" ]
echo ok
