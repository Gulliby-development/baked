<?php
require $argv[1] . '/src/wordcount.php';
$got = word_counts("The cat, the DOG. \u{c9}t\u{e9} \u{e9}t\u{e9} don't");
$want = ['the' => 2, "don't" => 1, 'cat' => 1, 'dog' => 1, "\u{e9}t\u{e9}" => 2];
uksort($want, fn($a, $b) => [$want[$b], $a] <=> [$want[$a], $b]);
if ($got !== $want) { fwrite(STDERR, var_export($got, true)); exit(1); }
if (word_counts('') !== []) { exit(1); }
echo "ok\n";
