"""Port of backend/tests/Unit/PythonEmitHelpersTest.php (Phase 6, Task 1)."""
from __future__ import annotations

from app.agent_team.services.python_emit_helpers import PythonEmitHelpers


def test_py_str_escapes():
    """PHP testPyStrEscapes (lines 8-13)."""
    out = PythonEmitHelpers.pyStr('line1\nquote"x')
    assert '\\n' in out
    assert '\\"' in out


def test_json_to_python_null_true_false():
    """PHP testJsonToPythonNullTrueFalse (lines 14-20)."""
    out = PythonEmitHelpers.jsonToPython({'a': None, 'b': True, 'c': False})
    assert 'None' in out
    assert 'True' in out
    assert 'False' in out
