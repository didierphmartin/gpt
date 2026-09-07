"""Port of backend/tests/Unit/PythonEmitHelpersPinTest.php (Phase 6, Task 1).

Pins the byte-exact content of the shared Python emit blocks. These blocks
are emitted VERBATIM by BOTH LangGraphGenerator and (Task 2/3 of this port)
ADKGenerator. A change here silently alters the generated Python of every
compiled workflow across both backends. If a future task intentionally
changes a block, update the hash below in the same commit -- the diff is
the review gate.

DEVIATION FROM THE PHP ORACLE (documented, not "fixed" quietly): the PHP
PythonEmitHelpersPinTest::testSkillFsSyncBlockUnchanged pin (length 5092,
sha256 9ca556...) is STALE against the current
backend/src/AgentTeam/Services/PythonEmitHelpers.php -- running it live
(`php vendor/bin/phpunit tests/Unit/PythonEmitHelpersPinTest.php`) FAILS on
this branch with "Failed asserting that 6017 is identical to 5092." The
live PHP method (verified via `php -r` against
`backend/src/AgentTeam/Services/PythonEmitHelpers.php`, autoloaded from
`backend/vendor/autoload.php`) actually returns 6017 bytes, sha256
7b9543f3...; this port's byte-identical-emission mandate is to match the
ACTUAL PHP source (the oracle), not a stale hard-coded test fixture nobody
updated after `skillFsSyncBlock` grew. This pin below asserts the real,
current PHP byte content, extracted programmatically from the .php source
(no manual transcription) -- see task-1-report.md.
"""
from __future__ import annotations

import hashlib

from app.agent_team.services.python_emit_helpers import PythonEmitHelpers


def test_mcp_client_block_unchanged():
    """PHP testMcpClientBlockUnchanged (lines 20-29)."""
    block = PythonEmitHelpers.mcpClientBlock()
    assert len(block.encode('utf-8')) == 4868, 'mcpClientBlock byte length changed'
    assert hashlib.sha256(block.encode('utf-8')).hexdigest() == (
        '873230865dafdbdbaa7fdccf4189c99f6cf47d9fac32977350dbdb1545b94ab4'
    ), 'mcpClientBlock content changed -- this alters generated Python for both generators'


def test_skill_deps_block_unchanged():
    """PHP testSkillDepsBlockUnchanged (lines 31-40)."""
    block = PythonEmitHelpers.skillDepsBlock()
    assert len(block.encode('utf-8')) == 2423, 'skillDepsBlock byte length changed'
    assert hashlib.sha256(block.encode('utf-8')).hexdigest() == (
        '79f69500a85e9aa03f75f4336d93f8913bb954608a18e59885f90207af20948d'
    ), 'skillDepsBlock content changed -- this alters generated Python for both generators'


def test_document_converter_block_unchanged():
    """PHP testDocumentConverterBlockUnchanged (lines 42-51)."""
    block = PythonEmitHelpers.documentConverterBlock()
    assert len(block.encode('utf-8')) == 5127, 'documentConverterBlock byte length changed'
    assert hashlib.sha256(block.encode('utf-8')).hexdigest() == (
        '0d4241548ff1d929cc88d083501cb8e1d9df126b719bc258d2f1cca7400c8dd1'
    ), 'documentConverterBlock content changed -- this alters generated Python for both generators'


def test_skill_fs_sync_block_unchanged():
    """PHP testSkillFsSyncBlockUnchanged (lines 53-62) -- pinned to the ACTUAL
    live PHP output (6017 bytes / sha256 7b9543f3...), not the stale PHP test
    fixture (5092 / 9ca556...). See module docstring."""
    block = PythonEmitHelpers.skillFsSyncBlock()
    assert len(block.encode('utf-8')) == 6017, 'skillFsSyncBlock byte length changed'
    assert hashlib.sha256(block.encode('utf-8')).hexdigest() == (
        '7b9543f387e0a7fce98aa2ed74c5304e452ddc9d6c06588ecf93d7adf4d03f50'
    ), 'skillFsSyncBlock content changed -- this alters generated Python for both generators'
