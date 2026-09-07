import asyncio
import pytest
from app.support.sse import SseStream, format_sse_data_frame, format_sse_frame


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


# ---------------------------------------------------------------------------
# format_sse_data_frame / SseStream.send_data — bare `data:` frames, no
# `event:` line (AgentController.php:486, :507 — Task 2 fix round 1).
# ---------------------------------------------------------------------------

def test_data_frame_string_splits_lines_raw_with_no_event_line():
    assert format_sse_data_frame('a\nb') == b'data: a\ndata: b\n\n'
    assert format_sse_data_frame('[DONE]') == b'data: [DONE]\n\n'


def test_data_frame_object_uses_php_json_encode_escaped_slashes_and_unicode():
    # php_json_encode (PHP's plain json_encode() defaults), NOT the cosmetic
    # dumps() format_sse_frame() uses: '/' and non-ASCII are escaped.
    assert format_sse_data_frame({'success': True, 'text': 'é/x'}) == \
        b'data: {"success":true,"text":"\\u00e9\\/x"}\n\n'
    assert format_sse_data_frame({'type': 'agent_start', 'agent_id': 5}) == \
        b'data: {"type":"agent_start","agent_id":5}\n\n'


def test_send_data_starts_queues_and_end_sentinel():
    async def run():
        loop = asyncio.get_running_loop()
        s = SseStream(loop)
        assert not s.started
        await loop.run_in_executor(None, s.send_data, {'type': 'agent_start'})
        assert s.started and s.started_future.done()
        await loop.run_in_executor(None, s.send_data, '[DONE]')
        await loop.run_in_executor(None, s.end)
        assert await s.queue.get() == b'data: {"type":"agent_start"}\n\n'
        assert await s.queue.get() == b'data: [DONE]\n\n'
        assert await s.queue.get() is None
        assert s.ended
    asyncio.run(run())


def test_send_data_after_abort_raises_client_aborted():
    async def run():
        loop = asyncio.get_running_loop()
        s = SseStream(loop)
        s.mark_aborted()
        with pytest.raises(RuntimeError, match='CLIENT_ABORTED'):
            await loop.run_in_executor(None, s.send_data, 'x')
    asyncio.run(run())
