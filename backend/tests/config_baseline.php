<?php
// Dumps each config's effective array (secret values HASHED) to compare before/after the .env move.
declare(strict_types=1);
$files = ['config','database/config','migrations/config','examples/config'];
$flatten = function ($a, $p = '') use (&$flatten) {
    $out = [];
    foreach ($a as $k => $v) {
        $key = $p === '' ? (string)$k : "$p.$k";
        if (is_array($v)) { $out += $flatten($v, $key); }
        else { $out[$key] = preg_match('/(api_key|password|secret|token)$/i', $key) || str_ends_with($key, '.username')
            ? 'H:' . md5((string)$v) : $v; }
    }
    return $out;
};
$snap = [];
foreach ($files as $f) { $snap[$f] = $flatten(require __DIR__ . "/../$f/ai_config.php"); }
echo json_encode($snap, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
