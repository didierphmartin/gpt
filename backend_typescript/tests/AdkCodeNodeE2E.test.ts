/**
 * Port of backend/tests/Unit/AdkCodeNodeE2ETest.php. Opt-in (ADK_E2E=1): a compiled ADK script with code nodes RUNS
 * (runner venv) against a fake MCP server -- single file, listening package, A2A package, playbook nodes. The
 * scenarios live in tests/support/compiledE2E.ts, shared with the MAF and NOOA ports (MAF_E2E, NOOA_E2E).
 */
import { tmpdir } from 'node:os';
import { ADKGenerator } from '../src/AgentTeam/ADKGenerator';
import { ADKPackage } from '../src/AgentTeam/compiler/ADKPackage';
import { defineCompiledE2E } from './support/compiledE2E';

defineCompiledE2E({
  flag: 'ADK_E2E',
  label: 'ADK',
  emit: (a) => ADKGenerator.emitAdk(a),
  packageFiles: (a) => ADKPackage.files(a, tmpdir()),
  packageSources: (a) => ADKGenerator.packageFiles(a),
  a2aPackage: (a) => ADKGenerator.a2aPackage(a),
  generatorClass: ADKGenerator,
});
