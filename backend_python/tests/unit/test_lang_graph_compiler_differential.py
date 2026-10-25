"""Differential test: the Python LangGraph compiler emits PHP's bytes.

Every fixture under tests/fixtures/compiler/workflows/ is compiled in each mode it lists (single, modular,
a2a) by the PHP reference (tests/fixtures/compiler/php_compile.php, no database: in-memory SQLite and
in-memory repositories) and by the Python port, and the two file maps must be identical byte for byte --
same files, same order, same content -- or fail with the same error message. The only normalisation is
the wall clock (the Generated: stamp, the WORKFLOW_VERSION date).

Skipped, with the reason, when no PHP binary is available (PHP_BIN, XAMPP's, or `php` on PATH).
"""
from __future__ import annotations

import difflib

import pytest

from tests.unit import compiler_fixtures as cf

pytestmark = pytest.mark.skipif(cf.php_binary() is None,
                                reason='no PHP binary (set PHP_BIN, or install XAMPP / php on PATH): '
                                       'the PHP compiler is the reference this test compares against')

PATHS = cf.fixture_paths()


@pytest.fixture(scope='module')
def php_results():
    return cf.compile_php(PATHS)


@pytest.fixture(autouse=True)
def _utc(monkeypatch):
    monkeypatch.setenv('PHP_TIMEZONE', 'UTC')   # php_compile.php compiles in UTC


def _first_difference(php: dict, py: dict) -> str:
    if list(php) != list(py):
        return f'file lists differ:\n  php: {list(php)}\n  py:  {list(py)}'
    for path in php:
        if php[path] != py[path]:
            a = (php[path] or '').splitlines(keepends=True)
            b = (py[path] or '').splitlines(keepends=True)
            diff = ''.join(list(difflib.unified_diff(a, b, 'php/' + path, 'py/' + path, n=2))[:80])
            return f'{path} differs:\n{diff}'
    return ''


@pytest.mark.parametrize('path', PATHS, ids=[p.stem for p in PATHS])
def test_python_compiler_emits_php_bytes(path, php_results):
    fx = cf.load(path)
    php = php_results[path.stem]
    py = cf.compile_python(fx)
    assert list(php) == list(py)
    problems = []
    for mode in php:
        diff = _first_difference(cf.file_map(php[mode]), cf.file_map(py[mode]))
        if diff:
            problems.append(f'[{mode}] {diff}')
    assert not problems, '\n\n'.join(problems)
