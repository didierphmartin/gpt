"""Port of backend/tests/Unit/MAFPackageTest.php: the MAF package's workflow.py contract.

The "Dispatcher demo" (Start -> techBuddy dispatcher -> IT claims | Human resources -> Output) in an
in-memory SQLite read through the real repositories (compiled_target_support, the port of PHP's
Support/DispatcherDemoFixture), compiled with generatePackage().
"""
from __future__ import annotations

import re

from app.agent_team.services.maf_generator import MAFGenerator
from tests.unit import compiled_target_support as demo


def _files() -> dict:
    return demo.package_files(MAFGenerator)


def _run_workflow_body(wf: str) -> str:
    """run_workflow()'s own body: from its def to the next top-level statement."""
    at = wf.index('async def run_workflow(')
    m = re.compile(r'\n(?=\S)').search(wf, at + 1)
    return wf[at:m.start()]


def test_exposes_the_contract():
    assert 'async def run_workflow(prompt: str, session: str | None = None) -> str:' in _files()['workflow.py']


def test_run_workflow_returns_the_terminal_output():
    wf = _files()['workflow.py']
    assert '_outputs = _result.get_outputs()' in wf
    assert 'return _text' in wf


def test_saving_stays_out_of_run_workflow():
    # A conversational turn (POST /runs -> run_workflow) must not write a file per prompt.
    wf = _files()['workflow.py']
    assert 'OUTPUT_STORAGE_ENABLED' not in _run_workflow_body(wf), 'saving leaked into run_workflow'
    assert 'saved = _save_output(output)' in wf


def test_run_workflow_does_not_pre_strip_the_document():
    wf = _files()['workflow.py']
    assert '<!doctype html' not in _run_workflow_body(wf), 'document extraction leaked into run_workflow'
