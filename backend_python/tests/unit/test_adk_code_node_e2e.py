"""Port of backend/tests/Unit/AdkCodeNodeE2ETest.php. Opt-in (ADK_E2E=1): a compiled ADK script with code
nodes RUNS (runner venv) against a fake MCP server. The scenarios live in compiled_e2e_base (MAF / NOOA
subclass it with their own hooks, as PHP's MafE2ETest / NooaE2ETest do)."""
from __future__ import annotations

import tempfile

from app.agent_team.services.adk_generator import ADKGenerator, ADKPackage
from tests.unit.compiled_e2e_base import CompiledE2EBase


class TestAdkCodeNodeE2E(CompiledE2EBase):
    ENV_FLAG = 'ADK_E2E'

    def emit(self, analyzed):
        return ADKGenerator.emitAdk(analyzed)

    def packageFiles(self, analyzed):
        return ADKPackage.files(analyzed, tempfile.gettempdir())

    def packageSources(self, analyzed):
        return ADKGenerator.packageFiles(analyzed)

    def a2aPackage(self, analyzed):
        return ADKGenerator.a2aPackage(analyzed)

    def generatorClass(self):
        return ADKGenerator
