#!/usr/bin/env bash
set -euo pipefail
s="$1/bin/slugify.sh"
[ -x "$s" ]
[ "$("$s" "Hello World")" = "hello-world" ]
[ "$("$s" "  Route 66 -- West! ")" = "route-66-west" ]
[ "$("$s" Mixed Case args)" = "mixed-case-args" ]
[ "$("$s" "!!!")" = "" ]
set +e
err="$("$s" 2>&1 >/dev/null)"
code=$?
set -e
[ "$code" = 2 ]
[ "$err" = "usage: slugify.sh TEXT..." ]
echo ok
