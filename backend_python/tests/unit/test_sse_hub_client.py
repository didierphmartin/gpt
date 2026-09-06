import asyncio
from app.services.sse_hub_client import SSEHubClient
from app.support.sse import SseStream


def test_events_use_php_string_framing():
    async def run():
        loop = asyncio.get_running_loop(); s = SseStream(loop)
        c = SSEHubClient.create('sess', None, False, stream=s)
        await loop.run_in_executor(None, lambda: (c.sendProgress('Claude: Thinking...'), c.sendChunk('a\nb'),
                                                  c.sendResponse({'text': 'x'}), c.sendCustomEvent('mcp_ui', {'k': 1}),
                                                  c.sendError('bad', 500), c.complete()))
        frames = []
        while not s.queue.empty():
            frames.append(await s.queue.get())
        return frames, c.isConnected(), c.getSessionId()
    frames, connected, sid = asyncio.run(run())
    assert frames == [b'event: progress\ndata: Claude: Thinking...\n\n', b'event: chunk\ndata: a\ndata: b\n\n',
                      b'event: response\ndata: {"text":"x"}\n\n', b'event: mcp_ui\ndata: {"k":1}\n\n',
                      b'event: error\ndata: {"error":true,"message":"bad","code":500}\n\n',
                      b'event: complete\ndata: {"status":"done"}\n\n']
    assert connected is False and sid == 'sess'
