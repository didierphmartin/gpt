"""Ported from backend/scripts/test-ingestion-loader.php -- WITH A DEVIATION:
running that script against the CURRENT IngestionLoader.php
(`php backend/scripts/test-ingestion-loader.php`, 2026-09-07) fatals at line
101 with `Call to undefined method IngestionLoader::decode()`. The PHP class
no longer has a decode() method: its docblock (IngestionLoader.php:139-146)
says the legacy UniversalFS raw-bytes decode path (pdf/docx/html extraction)
was REMOVED once every storage server became a langfs/LangChain loader that
extracts text server-side; `loadFile()` now requires the injected `readFile`
callable to already return {'is_text': True, 'data': str} and raises
otherwise. So per "PHP wins over the brief": this test file ports
detectType/enumerateFiles/loadFile/loadDocuments/readRound against the
CURRENT source (verified via `php -r` against the real class, not the stale
script) and does NOT port decode() -- there is nothing to port; it doesn't
exist. See task-5-report.md for the full deviation writeup.
"""
from __future__ import annotations

from app.agent_team.services.ingestion_loader import IngestionLoader


def _f(path: str) -> dict:
    return {'id': path, 'name': path.rsplit('/', 1)[-1], 'type': 'file'}


def _d(path: str) -> dict:
    return {'id': path, 'name': path.rsplit('/', 1)[-1], 'type': 'folder'}


def _fake_list_files(tree: dict):
    return lambda provider, path: {'files': tree.get(path, [])}


def _fake_read_file(blobs: dict):
    """Current contract: readFile returns {'is_text': True, 'data': str} on
    success (langfs already extracted the text); a missing/unreadable file
    returns {'is_text': False} (loadFile then raises)."""
    def rf(provider, fileId):
        if fileId not in blobs:
            return {'is_text': False}
        return {'is_text': True, 'data': blobs[fileId]}
    return rf


# ---------------------------------------------------------------------------
# detectType (pinned via `php -r`, 2026-09-07 -- unchanged from the stale
# script's assertions, lines 86-96, which DID run before the fatal)
# ---------------------------------------------------------------------------

def test_detect_type_pdf():
    assert IngestionLoader.detectType('report.pdf') == 'pdf'


def test_detect_type_pdf_case_insensitive():
    assert IngestionLoader.detectType('notes.PDF') == 'pdf'


def test_detect_type_docx():
    assert IngestionLoader.detectType('memo.docx') == 'word'


def test_detect_type_doc():
    assert IngestionLoader.detectType('memo.doc') == 'word'


def test_detect_type_txt():
    assert IngestionLoader.detectType('readme.txt') == 'text'


def test_detect_type_csv():
    assert IngestionLoader.detectType('data.csv') == 'csv'


def test_detect_type_with_path():
    assert IngestionLoader.detectType('a/b/deep.pdf') == 'pdf'


def test_detect_type_html():
    assert IngestionLoader.detectType('page.html') == 'html'


def test_detect_type_htm():
    assert IngestionLoader.detectType('page.htm') == 'html'


def test_detect_type_unsupported():
    assert IngestionLoader.detectType('archive.zip') is None


def test_detect_type_no_extension():
    assert IngestionLoader.detectType('noext') is None


# ---------------------------------------------------------------------------
# enumerateFiles (pinned via `php -r`, 2026-09-07 -- this section never ran
# in the stale script, so it is verified fresh here against current source)
# ---------------------------------------------------------------------------

def test_enumerate_single_file():
    single = IngestionLoader.enumerateFiles(_fake_list_files({}), 'local', 'doc.pdf', [], False)
    assert single == [{
        'provider': 'local', 'file_id': 'doc.pdf', 'name': 'doc.pdf',
        'source': 'doc.pdf', 'doc_type': 'pdf',
    }]


def test_enumerate_single_excluded_by_filter():
    excluded = IngestionLoader.enumerateFiles(_fake_list_files({}), 'local', 'doc.pdf', ['word'], False)
    assert excluded == []


def test_enumerate_single_kept_when_type_checked():
    included = IngestionLoader.enumerateFiles(_fake_list_files({}), 'local', 'doc.pdf', ['pdf', 'word'], False)
    assert len(included) == 1 and included[0]['doc_type'] == 'pdf'


def _tree():
    return {
        'root': [_f('root/a.pdf'), _f('root/notes.txt'), _f('root/image.png'), _d('root/sub')],
        'root/sub': [_f('root/sub/b.docx'), _d('root/sub/deep')],
        'root/sub/deep': [_f('root/sub/deep/c.csv')],
    }


def test_enumerate_folder_recursive_no_filter_keeps_all_supported():
    all_ = IngestionLoader.enumerateFiles(_fake_list_files(_tree()), 'local', 'root', [], True)
    by_source = {it['source']: it['doc_type'] for it in all_}
    assert by_source == {
        'root/a.pdf': 'pdf',
        'root/notes.txt': 'text',
        'root/sub/b.docx': 'word',
        'root/sub/deep/c.csv': 'csv',
    }


def test_enumerate_folder_skips_unsupported():
    all_ = IngestionLoader.enumerateFiles(_fake_list_files(_tree()), 'local', 'root', [], True)
    assert 'root/image.png' not in {it['source'] for it in all_}


def test_enumerate_folder_filter_single_type():
    only_pdf = IngestionLoader.enumerateFiles(_fake_list_files(_tree()), 'local', 'root', ['pdf'], True)
    assert [i['source'] for i in only_pdf] == ['root/a.pdf']


def test_enumerate_folder_filter_pdf_and_word():
    pdf_word = IngestionLoader.enumerateFiles(_fake_list_files(_tree()), 'local', 'root', ['pdf', 'word'], True)
    assert sorted(i['source'] for i in pdf_word) == ['root/a.pdf', 'root/sub/b.docx']


def test_enumerate_cycle_guard():
    cycle_tree = {
        'root': [_f('root/a.pdf'), _d('root/loop')],
        'root/loop': [_f('root/loop/b.txt'), _d('root')],  # back-edge
    }
    cyc = IngestionLoader.enumerateFiles(_fake_list_files(cycle_tree), 'local', 'root', [], True)
    assert sorted(i['source'] for i in cyc) == ['root/a.pdf', 'root/loop/b.txt']


def test_enumerate_max_depth_cap():
    deep_tree = {}
    for i in range(5):
        deep_tree[f'lvl{i}'] = [_d(f'lvl{i + 1}')]
    deep_tree['lvl5'] = [_f('lvl5/x.txt')]
    deep = IngestionLoader.enumerateFiles(_fake_list_files(deep_tree), 'local', 'lvl0', [], True, 3)
    assert deep == []  # lvl4 (depth 4) is never listed, so lvl5/x.txt is never reached


# ---------------------------------------------------------------------------
# loadFile (pinned via `php -r`, 2026-09-07 -- reflects the CURRENT contract:
# readFile must return {'is_text': True, 'data': str}, or loadFile raises)
# ---------------------------------------------------------------------------

def test_load_file_reads_and_returns_text():
    rf = _fake_read_file({'root/notes.txt': 'hello from disk'})
    desc = IngestionLoader.enumerateFiles(_fake_list_files({}), 'local', 'root/notes.txt', [], False)[0]
    assert IngestionLoader.loadFile(rf, desc) == 'hello from disk'


def test_load_file_raises_when_read_file_does_not_return_text():
    rf = _fake_read_file({})  # any fileId returns {'is_text': False}
    desc = {'provider': 'local', 'file_id': 'missing.txt', 'name': 'missing.txt', 'doc_type': 'text'}
    try:
        IngestionLoader.loadFile(rf, desc)
        assert False, 'expected RuntimeError'
    except RuntimeError as e:
        assert str(e) == (
            "read_file did not return extracted text for 'missing.txt' — "
            "the legacy raw-bytes decode path was removed; use a langfs storage server (format=text)."
        )


# ---------------------------------------------------------------------------
# loadDocuments (generator)
# ---------------------------------------------------------------------------

def test_load_documents_yields_text_and_source():
    doc_tree = {
        'root': [_f('root/a.txt'), _f('root/b.csv'), _f('root/skip.png'), _d('root/sub')],
        'root/sub': [_f('root/sub/c.txt')],
    }
    blobs = {'root/a.txt': 'alpha', 'root/b.csv': 'x,y\n1,2', 'root/sub/c.txt': 'gamma'}
    docs = list(IngestionLoader.loadDocuments(_fake_list_files(doc_tree), _fake_read_file(blobs), 'local', 'root', [], True))
    doc_map = {d['source']: d['text'] for d in docs}
    assert doc_map == {
        'root/a.txt': 'alpha',
        'root/b.csv': 'x,y\n1,2',
        'root/sub/c.txt': 'gamma',
    }


# ---------------------------------------------------------------------------
# readRound -- one file's text per round (the Output tab)
# ---------------------------------------------------------------------------

def _rr_setup():
    rr_tree = {
        'root': [_f('root/a.txt'), _f('root/b.csv'), _f('root/skip.png'), _d('root/sub')],
        'root/sub': [_f('root/sub/c.txt')],
    }
    rr_blobs = {'root/a.txt': 'alpha', 'root/b.csv': 'x,y\n1,2', 'root/sub/c.txt': 'gamma'}
    return _fake_list_files(rr_tree), _fake_read_file(rr_blobs)


def test_read_round_count_is_supported_files_only():
    lf, rf = _rr_setup()
    r0 = IngestionLoader.readRound(lf, rf, 'local', 'root', [], True, 0)
    assert r0['count'] == 3


def test_read_round_exposes_ordered_sources():
    lf, rf = _rr_setup()
    r0 = IngestionLoader.readRound(lf, rf, 'local', 'root', [], True, 0)
    assert r0['sources'] == ['root/a.txt', 'root/b.csv', 'root/sub/c.txt']


def test_read_round_zero_is_first_file_text():
    lf, rf = _rr_setup()
    r0 = IngestionLoader.readRound(lf, rf, 'local', 'root', [], True, 0)
    assert r0['current']['source'] == 'root/a.txt'
    assert r0['current']['text'] == 'alpha'
    assert r0['current']['type'] == 'text'
    assert r0['current']['chars'] == 5
    assert r0['current']['clipped'] is False


def test_read_round_advances():
    lf, rf = _rr_setup()
    r2 = IngestionLoader.readRound(lf, rf, 'local', 'root', [], True, 2)
    assert r2['cursor'] == 2
    assert r2['current']['source'] == 'root/sub/c.txt'
    assert r2['current']['text'] == 'gamma'


def test_read_round_past_end_is_exhausted():
    lf, rf = _rr_setup()
    r_end = IngestionLoader.readRound(lf, rf, 'local', 'root', [], True, 3)
    assert r_end['count'] == 3 and r_end['current'] is None


def test_read_round_negative_cursor_is_exhausted():
    lf, rf = _rr_setup()
    r_neg = IngestionLoader.readRound(lf, rf, 'local', 'root', [], True, -1)
    assert r_neg['count'] == 3 and r_neg['current'] is None


def test_read_round_no_files_matched():
    _, rf = _rr_setup()
    r_empty = IngestionLoader.readRound(_fake_list_files({}), rf, 'local', 'nope.txt', ['word'], False, 0)
    assert r_empty == {'count': 0, 'cursor': 0, 'sources': [], 'current': None}


def test_read_round_clips_long_text():
    r_clip = IngestionLoader.readRound(
        _fake_list_files({'r': [_f('r/big.txt')]}),
        _fake_read_file({'r/big.txt': 'z' * 100}),
        'local', 'r', [], True, 0, 10,
    )
    assert r_clip['current']['clipped'] is True
    assert len(r_clip['current']['text']) == 10
    assert r_clip['current']['text'] == 'z' * 10


def test_read_round_clips_by_code_points_not_bytes():
    # 30 code points, each 3 UTF-8 bytes -- clip must cut at 12 CHARACTERS.
    mb_text = '日本語' * 10
    r_clip = IngestionLoader.readRound(
        _fake_list_files({'r': [_f('r/mb.txt')]}),
        _fake_read_file({'r/mb.txt': mb_text}),
        'local', 'r', [], True, 0, 12,
    )
    assert r_clip['current']['chars'] == 30
    assert r_clip['current']['clipped'] is True
    assert r_clip['current']['text'] == '日本語' * 4
    assert len(r_clip['current']['text']) == 12


def test_read_round_surfaces_per_file_error():
    def boom_read(provider, fileId):
        if fileId == 'r/bad.txt':
            raise RuntimeError('read blew up')
        return {'is_text': True, 'data': 'ok'}

    r_err = IngestionLoader.readRound(
        _fake_list_files({'r': [_f('r/bad.txt'), _f('r/good.txt')]}),
        boom_read, 'local', 'r', [], True, 0,
    )
    assert r_err['current']['source'] == 'r/bad.txt'
    assert r_err['current']['error'] == 'read blew up'
    assert 'text' not in r_err['current']
