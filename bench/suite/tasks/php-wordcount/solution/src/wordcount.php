<?php

function word_counts(string $text): array
{
    preg_match_all("/[\\p{L}\\p{N}']+/u", mb_strtolower($text, 'UTF-8'), $m);
    $counts = array_count_values($m[0]);
    uksort($counts, fn($a, $b) => [$counts[$b], $a] <=> [$counts[$a], $b]);
    return $counts;
}
