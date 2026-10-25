"""Port of backend/tests/Unit/NooaE2ETest.php. Opt-in (NOOA_E2E=1): the ADK E2E scenarios (compiled_e2e_base)
on the NOOA target -- code routing, headers, listening, Jev."""
from __future__ import annotations

import tempfile

from app.agent_team.services.compiled_package import CompiledPackage
from app.agent_team.services.nooa_generator import NOOAGenerator
from tests.unit.compiled_e2e_base import CompiledE2EBase


class TestNooaE2E(CompiledE2EBase):
    ENV_FLAG = 'NOOA_E2E'

    def emit(self, analyzed):
        return NOOAGenerator.emitNooa(analyzed)

    def packageFiles(self, analyzed):
        return CompiledPackage.files(analyzed, tempfile.gettempdir(), [], NOOAGenerator.FRAMEWORK, 'NVIDIA NOOA')

    def packageSources(self, analyzed):
        return NOOAGenerator.packageFiles(analyzed)

    def a2aPackage(self, analyzed):
        return NOOAGenerator.a2aPackage(analyzed)

    def generatorClass(self):
        return NOOAGenerator
