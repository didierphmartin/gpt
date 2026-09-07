"""SSE differential comparator: compare two event streams (PHP vs Python) by
shape rather than by bytes. Token counts and generated text differ run to run,
so the skeleton (event order), the response payload's key set / types, and the
terminal events are what parity means here."""
import json


def parse_sse(text: str) -> list[tuple[str, str]]:
    events = []
    for block in text.split('\n\n'):
        if not block.strip():
            continue
        lines = block.split('\n')
        ev = next((l[6:].strip() for l in lines if l.startswith('event:')), '')
        data = '\n'.join(l[5:].lstrip(' ') if l.startswith('data:') else l for l in lines if l.startswith('data:'))
        if ev:
            events.append((ev, data))
    return events


def skeleton(events) -> list[str]:
    out = []
    for ev, _ in events:
        if not out or out[-1] != ev:
            out.append(ev)
    return out


def payload(events, name: str):
    for ev, data in reversed(events):
        if ev == name:
            try:
                return json.loads(data)
            except ValueError:
                return data
    return None


def normalize_usage(d):
    if isinstance(d, dict):
        return {k: ('int' if isinstance(v, int) and not isinstance(v, bool) else normalize_usage(v)) for k, v in d.items()}
    if isinstance(d, list):
        return [normalize_usage(x) for x in d]
    return d


# The terminal event families: the primary chat pane plus the verification and
# comparison panes (ChatController::verify / compareOnly and the in-chat phases).
# Each triple is (response, complete, error) and is compared the same way.
TERMINAL_FAMILIES = (
    ('response', 'complete', 'error'),
    ('verification_response', 'verification_complete', 'verification_error'),
    ('compare_response', 'compare_complete', 'compare_error'),
)


def parse_data_only(text: str) -> list:
    """Parse a stream of BARE `data:` frames -- no `event:` line
    (format_sse_data_frame()'s wire format, e.g. AgentController.php:486,
    :507 / agent_controller.py's chat()). parse_sse() above can't see these:
    it only appends a block when it finds a leading `event:` line, so an
    event-less block is silently dropped. Each block becomes either the
    decoded JSON payload (object/array/scalar) or, if it isn't valid JSON
    (e.g. the literal `[DONE]` sentinel), the raw joined string -- in
    stream order."""
    out = []
    for block in text.split('\n\n'):
        if not block.strip():
            continue
        lines = [l[5:].lstrip(' ') for l in block.split('\n') if l.startswith('data:')]
        if not lines:
            continue
        raw = '\n'.join(lines)
        try:
            out.append(json.loads(raw))
        except ValueError:
            out.append(raw)
    return out


def same_data_stream(a_text: str, b_text: str):
    """Compare two bare-`data:`-frame streams by exact decoded payload
    sequence. Unlike same_stream() (which compares by `event:` name and
    tolerates payload differences like token counts), this format carries no
    event name to group/skip by, so parity here means the two payload
    sequences are identical."""
    a, b = parse_data_only(a_text), parse_data_only(b_text)
    assert a == b, (a, b)


def same_stream(a_text: str, b_text: str, *, ignore_response_keys=('text',)):
    a, b = parse_sse(a_text), parse_sse(b_text)
    assert skeleton(a) == skeleton(b), (skeleton(a), skeleton(b))
    for resp, complete, error in TERMINAL_FAMILIES:
        ra, rb = payload(a, resp), payload(b, resp)
        assert (ra is None) == (rb is None), (resp, ra, rb)
        if ra is not None or rb is not None:
            for k in ignore_response_keys:
                ra.pop(k, None); rb.pop(k, None)
            assert normalize_usage(ra) == normalize_usage(rb), (resp, ra, rb)
        assert payload(a, complete) == payload(b, complete), complete
        ea, eb = payload(a, error), payload(b, error)
        assert (ea is None) == (eb is None) and (ea is None or list(ea) == list(eb)), (error, ea, eb)
