/** Port of backend/tests/Unit/LangGraphParityTest.php. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphAnalyzer } from '../src/AgentTeam/compiler/GraphAnalyzer';

test('testTopoOrderMatchesAnalyzer', () => {
  const graph = {
    nodes: [
      { id: '1', type: 'start', config: { type: 'start' } },
      { id: '2', type: 'agent', config: { type: 'agent' } },
      { id: '3', type: 'output', config: { type: 'output' } },
    ],
    edges: [{ from: '1', to: '2' }, { from: '2', to: '3' }],
  };
  const a = GraphAnalyzer.analyzeGraph(graph);
  assert.deepEqual([...a.order], ['1', '2', '3']);
});
