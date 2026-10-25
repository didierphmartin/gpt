/**
 * Port of backend/tests/Unit/MafE2ETest.php. Opt-in (MAF_E2E=1): the ADK E2E scenarios (tests/support/compiledE2E.ts)
 * on the MAF target -- code routing, headers, listening, Jev.
 */
import { tmpdir } from 'node:os';
import { MAFGenerator } from '../src/AgentTeam/MAFGenerator';
import { CompiledPackage } from '../src/AgentTeam/compiler/CompiledPackage';
import { defineCompiledE2E } from './support/compiledE2E';

defineCompiledE2E({
  flag: 'MAF_E2E',
  label: 'MAF',
  emit: (a) => MAFGenerator.emitMaf(a),
  packageFiles: (a) => CompiledPackage.files(a, tmpdir(), [], MAFGenerator.FRAMEWORK, 'Microsoft Agent Framework'),
  packageSources: (a) => MAFGenerator.packageFiles(a),
  a2aPackage: (a) => MAFGenerator.a2aPackage(a),
  generatorClass: MAFGenerator,
});
