"""Differential test: the Python ADK, MAF and NOOA compilers emit PHP's bytes.

Every fixture under tests/fixtures/compiler/workflows/ is compiled for each target in each code structure
(single = generate(), modular = generatePackage(), a2a = generateA2A(), as WorkflowController's
generate-adk / -maf / -nooa routes call them) by the PHP reference (tests/fixtures/compiler/php_compile.php
--target=<target>, no database) and by the Python port. The two results must be identical byte for byte --
same files, same order, same content, same keys -- or fail with the same error message. The only
normalisation is the wall clock (the Generated: stamp, the WORKFLOW_VERSION date).

Skipped, with the reason, when no PHP binary is available (PHP_BIN, XAMPP's, or `php` on PATH).
"""
from __future__ import annotations

import pytest

from tests.unit import compiler_fixtures as cf
from tests.unit.test_lang_graph_compiler_differential import _first_difference

pytestmark = pytest.mark.skipif(cf.php_binary() is None,
                                reason='no PHP binary (set PHP_BIN, or install XAMPP / php on PATH): '
                                       'the PHP compilers are the reference this test compares against')

PATHS = cf.fixture_paths()
TARGETS = ('adk', 'maf', 'nooa')
_php_cache: dict = {}


def _php(target: str) -> dict:
    if target not in _php_cache:
        _php_cache[target] = cf.compile_php(PATHS, target)
    return _php_cache[target]


@pytest.fixture(autouse=True)
def _utc(monkeypatch):
    monkeypatch.setenv('PHP_TIMEZONE', 'UTC')   # php_compile.php compiles in UTC


@pytest.mark.parametrize('target', TARGETS)
@pytest.mark.parametrize('path', PATHS, ids=[p.stem for p in PATHS])
def test_python_target_emits_php_bytes(target, path):
    php = _php(target)[path.stem]
    py = cf.compile_python(cf.load(path), target)
    assert list(php) == list(py)
    problems = []
    for mode in php:
        diff = _first_difference(cf.file_map(php[mode]), cf.file_map(py[mode]))
        if diff:
            problems.append(f'[{target} {mode}] {diff}')
    assert not problems, '\n\n'.join(problems)
