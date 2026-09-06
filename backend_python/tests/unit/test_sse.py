import asyncio
import pytest
from app.support.sse import SseStream, format_sse_frame


def test_frame_string_splits_lines_raw():
    assert format_sse_frame('chunk', 'a\nb') == b'event: chunk\ndata: a\ndata: b\n\n'
    assert format_sse_frame('progress', 'Claude: Thinking...') == b'event: progress\ndata: Claude: Thinking...\n\n'


def test_frame_object_is_single_json_line_clean():
    assert format_sse_frame('response', {'success': True, 'text': 'é/x'}) == \
        b'event: response\ndata: {"success":true,"text":"\xc3\xa9/x"}\n\n'
    assert format_sse_frame('complete', {'status': 'done'}) == b'event: complete\ndata: {"status":"done"}\n\n'


def test_send_starts_queues_and_end_sentinel():
    async def run():
        loop = asyncio.get_running_loop()
        s = SseStream(loop)
        assert not s.started
        await loop.run_in_executor(None, s.send, 'progress', 'hi')
        assert s.started and s.started_future.done()
        await loop.run_in_executor(None, s.end)
        assert await s.queue.get() == b'event: progress\ndata: hi\n\n'
        assert await s.queue.get() is None
        assert s.ended
    asyncio.run(run())


def test_send_after_abort_raises_client_aborted():
    async def run():
        loop = asyncio.get_running_loop()
        s = SseStream(loop)
        s.mark_aborted()
        with pytest.raises(RuntimeError, match='CLIENT_ABORTED'):
            await loop.run_in_executor(None, s.send, 'chunk', 'x')
    asyncio.run(run())
