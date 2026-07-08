import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SSEStream } from '../src/Services/SseStream';

function fakeRes() {
  const chunks: string[] = [];
  return {
    chunks,
    status() {
      return this;
    },
    setHeader() {},
    flushHeaders() {},
    writableEnded: false,
    write(s: string) {
      chunks.push(s);
      return true;
    },
    end() {
      (this as any).writableEnded = true;
    },
  } as any;
}

test('chunk: multi-line string splits into multiple data: lines', () => {
  const res = fakeRes();
  const sse = new SSEStream(res);
  sse.start();
  sse.send('chunk', 'line1\nline2');
  assert.equal(res.chunks.join(''), 'event: chunk\ndata: line1\ndata: line2\n\n');
});

test('object payload is a single JSON data: line', () => {
  const res = fakeRes();
  const sse = new SSEStream(res);
  sse.start();
  sse.send('complete', { status: 'done' });
  assert.equal(res.chunks.join(''), 'event: complete\ndata: {"status":"done"}\n\n');
});

test('progress: bare string, single line', () => {
  const res = fakeRes();
  const sse = new SSEStream(res);
  sse.start();
  sse.send('progress', 'Preparing Claude streaming request...');
  assert.equal(res.chunks.join(''), 'event: progress\ndata: Preparing Claude streaming request...\n\n');
});

test('trailing newline in chunk yields an extra empty data: line', () => {
  const res = fakeRes();
  const sse = new SSEStream(res);
  sse.start();
  sse.send('chunk', 'a\n');
  assert.equal(res.chunks.join(''), 'event: chunk\ndata: a\ndata: \n\n');
});

test('aborted stream throws CLIENT_ABORTED instead of writing', () => {
  const res = fakeRes();
  const sse = new SSEStream(res);
  sse.start();
  sse.markAborted();
  assert.throws(() => sse.send('chunk', 'x'), /CLIENT_ABORTED/);
});
