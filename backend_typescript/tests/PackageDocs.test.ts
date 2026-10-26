import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CompiledPackage } from '../src/AgentTeam/compiler/CompiledPackage';
import { LangGraphPackage } from '../src/AgentTeam/compiler/LangGraphPackage';
import { PackageDocs } from '../src/AgentTeam/compiler/PackageDocs';

/** MODEL_NAME in .env.example and the README's Configure list exactly when the program reads it
 * (twin of ExportReadmeTest::testModelNameIsListedOnlyWhenTheProgramReadsIt). */
test('MODEL_NAME is listed only when the program reads it', () => {
  assert.equal(LangGraphPackage.envVariables({}).model, 'One model for every node, instead of each node\'s own');
  assert.equal(CompiledPackage.envVariables({ playbooks: {} }).model, null);
  const pb = CompiledPackage.envVariables({ playbooks: { 7: { provider: 'claude' } } });
  assert.equal(pb.model, 'One model for every playbook node, instead of each node\'s own');

  const env = PackageDocs.envExample('W', pb, []);
  assert.ok(env.includes('# Optional\n# One model for every playbook node, instead of each node\'s own\n# MODEL_NAME=\n'), env);
  assert.ok(PackageDocs.head('W', [], 'w', pb).join('\n')
    .includes('- `MODEL_NAME` -- optional: one model for every playbook node, instead of each node\'s own.\n'));
  const none = { ...pb, model: null };
  assert.ok(!PackageDocs.envExample('W', none, []).includes('MODEL_NAME'));
  assert.ok(!PackageDocs.head('W', [], 'w', none).join('\n').includes('MODEL_NAME'));
});
