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


def same_stream(a_text: str, b_text: str, *, ignore_response_keys=('text',)):
    a, b = parse_sse(a_text), parse_sse(b_text)
    assert skeleton(a) == skeleton(b), (skeleton(a), skeleton(b))
    ra, rb = payload(a, 'response'), payload(b, 'response')
    assert (ra is None) == (rb is None), (ra, rb)
    if ra is not None or rb is not None:
        for k in ignore_response_keys:
            ra.pop(k, None); rb.pop(k, None)
        assert normalize_usage(ra) == normalize_usage(rb), (ra, rb)
    assert payload(a, 'complete') == payload(b, 'complete')
    ea, eb = payload(a, 'error'), payload(b, 'error')
    assert (ea is None) == (eb is None) and (ea is None or list(ea) == list(eb)), (ea, eb)
