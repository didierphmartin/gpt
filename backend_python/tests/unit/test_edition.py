"""Edition (Services/Edition.php, minimal twin): 'individual' | 'corporate' | '' (hosted)."""
from __future__ import annotations

from app.services import edition


def test_current_reads_config_then_env(monkeypatch):
    monkeypatch.setenv('GPT_EDITION', 'individual')
    assert edition.current({'edition': 'corporate'}) == 'corporate'
    assert edition.current({'edition': ''}) == ''
    assert edition.current({}) == 'individual'
    monkeypatch.delenv('GPT_EDITION')
    assert edition.current({}) == ''


def test_is_corporate():
    assert edition.is_corporate({'edition': 'corporate'})
    assert not edition.is_corporate({'edition': 'individual'})
    assert not edition.is_corporate({'edition': ''})
