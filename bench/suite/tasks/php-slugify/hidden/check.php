<?php
require $argv[1] . '/src/slug.php';
$cases = [['Hello, World!', '-', 'hello-world'], ["Cr\u{e8}me Br\u{fb}l\u{e9}e", '-', 'creme-brulee'], ['  a  b ', '_', 'a_b'], ['!!!', '-', '']];
foreach ($cases as [$in, $sep, $want]) {
    $got = slugify($in, $sep);
    if ($got !== $want) { fwrite(STDERR, "slugify($in) = $got, want $want\n"); exit(1); }
}
echo "ok\n";
