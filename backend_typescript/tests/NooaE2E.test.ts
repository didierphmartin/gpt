/**
 * Port of backend/tests/Unit/NooaE2ETest.php. Opt-in (NOOA_E2E=1): the ADK E2E scenarios (tests/support/compiledE2E.ts)
 * on the NOOA target -- code routing, headers, listening, Jev.
 */
import { tmpdir } from 'node:os';
import { NOOAGenerator } from '../src/AgentTeam/NOOAGenerator';
import { CompiledPackage } from '../src/AgentTeam/compiler/CompiledPackage';
import { defineCompiledE2E } from './support/compiledE2E';

defineCompiledE2E({
  flag: 'NOOA_E2E',
  label: 'NOOA',
  emit: (a) => NOOAGenerator.emitNooa(a),
  packageFiles: (a) => CompiledPackage.files(a, tmpdir(), [], NOOAGenerator.FRAMEWORK, 'NVIDIA NOOA'),
  packageSources: (a) => NOOAGenerator.packageFiles(a),
  a2aPackage: (a) => NOOAGenerator.a2aPackage(a),
  generatorClass: NOOAGenerator,
});
