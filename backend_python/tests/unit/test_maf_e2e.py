"""Port of backend/tests/Unit/MafE2ETest.php. Opt-in (MAF_E2E=1): the ADK E2E scenarios (compiled_e2e_base)
on the MAF target -- code routing, headers, listening, Jev."""
from __future__ import annotations

import tempfile

from app.agent_team.services.compiled_package import CompiledPackage
from app.agent_team.services.maf_generator import MAFGenerator
from tests.unit.compiled_e2e_base import CompiledE2EBase


class TestMafE2E(CompiledE2EBase):
    ENV_FLAG = 'MAF_E2E'

    def emit(self, analyzed):
        return MAFGenerator.emitMaf(analyzed)

    def packageFiles(self, analyzed):
        return CompiledPackage.files(analyzed, tempfile.gettempdir(), [], MAFGenerator.FRAMEWORK, 'Microsoft Agent Framework')

    def packageSources(self, analyzed):
        return MAFGenerator.packageFiles(analyzed)

    def a2aPackage(self, analyzed):
        return MAFGenerator.a2aPackage(analyzed)

    def generatorClass(self):
        return MAFGenerator
