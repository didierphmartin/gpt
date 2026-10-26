"""Port of backend/tests/Unit/AgentTeam/WorkflowDocumentPathTest.php.

A document node's path reads only files under the storage root folder. No universalFS adapter exists in Python."""
from __future__ import annotations

import os

import pytest

from app.agent_team.services.graph_workflow_runner import GraphWorkflowRunner


@pytest.fixture
def runner(tmp_path):
    (tmp_path / 'synergyaichatroot' / 'alice').mkdir(parents=True)
    (tmp_path / 'synergyaichatroot' / 'alice' / 'a.txt').write_text('inside')
    (tmp_path / 'secret.txt').write_text('outside')
    os.symlink(tmp_path / 'secret.txt', tmp_path / 'synergyaichatroot' / 'alice' / 'link.txt')
    r = GraphWorkflowRunner.__new__(GraphWorkflowRunner)
    r.config = {'storage_path': str(tmp_path)}
    r.currentUserId = None
    return r


def test_file_under_the_root_folder_is_read(runner):
    assert runner._readFileRaw({'path': 'alice/a.txt'}) == b'inside'
    assert runner._readFileRaw({'fullPath': '/synergyaichatroot/alice/a.txt'}) == b'inside'


@pytest.mark.parametrize('doc', [
    {'path': '../secret.txt'},
    {'fullPath': 'secret.txt'},
    {'fullPath': 'synergyaichatroot/../secret.txt'},
    {'fullPath': 'synergyaichatroot\\..\\secret.txt'},
    {'path': 'alice/link.txt'},
    {'fullPath': '/etc/passwd'},
])
def test_paths_leaving_the_root_folder_are_refused(runner, doc):
    assert runner._readFileRaw(doc) is None
