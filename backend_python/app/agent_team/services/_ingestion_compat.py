"""Small PHP-cast helper shared by the ingestion services.

# TODO: promote to phpcompat.php_array_cast in the final wave (a concurrent
# Phase 5/6 fix wave may add it there first -- check before duplicating).
"""
from __future__ import annotations


def php_array_cast(v):
    """`(array) $v` -- PHP's array cast: None (unset/null) becomes []; a
    dict/list passes through unchanged (already array-shaped); any other
    scalar (str, int, float, bool) is wrapped as a single-element list
    (PHP wraps a scalar as [0 => $scalar]).

    Verified against `php -r`, 2026-09-07:
      (array) null       -> []
      (array) "abc"       -> ["abc"]
      (array) 123         -> [123]
      (array) ["pdf","x"] -> ["pdf","x"]        (unchanged)
      (array) ["a" => 1]  -> {"a":1}            (unchanged)
    """
    if v is None:
        return []
    if isinstance(v, (dict, list)):
        return v
    return [v]
