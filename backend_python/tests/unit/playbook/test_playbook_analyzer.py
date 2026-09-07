"""Port of backend/tests/Unit/Playbook/PlaybookAnalyzerTest.php (172 lines, 9 cases)."""
from __future__ import annotations

from app.playbook.playbook_analyzer import _ACTION_RE, PlaybookAnalyzer
from app.playbook.playbook_document import PlaybookDocument


def _by_name(actions):
    return {a['name']: a for a in actions}


def _doc(over=None):
    base = {
        'title': 'MFA', 'trigger': {'kind': 'request', 'description': 'locked out'},
        'instructions': "#Search Okta User by Email first. Medium risk: #Request Approval from manager. "
                         "High: #Prompt for Handoff to security. Then #Reset Password (Okta). "
                         "#Reset User Factors (Custom) if lost device. #Leave Internal Note. #Resolve Request.",
        'tools_used': ['Okta'],
        'actions_used': ['#Search Okta User by Email', '#Request Approval', '#Prompt for Handoff',
                          '#Reset Password (Okta)', '#Reset User Factors (Custom)', '#Leave Internal Note', '#Resolve Request'],
        'bindings': {'#Search Okta User by Email': 'okta.search_users',
                     '#Reset Password (Okta)': 'okta.reset_password',
                     '#Reset User Factors (Custom)': None},
    }
    if over:
        base.update(over)
    return PlaybookDocument.fromArray(base)


# ---------------------------------------------------------------------------
# _ACTION_RE -- Phase 5 final-review wave, round 2. D2's original rationale
# was wrong and has been reverted: real PHP 8.2 / PCRE 10.40 DOES match
# Unicode letters with `\w` under the `/u` modifier --
#   php -r 'var_dump(preg_match("/#[A-Z][\w\x27\x{2019}]*(?: [A-Z][\w\x27\x{2019}]*){0,5}(?: \([A-Za-z ]+\))?/u", "#Résumé the case", $m)); var_dump($m[0]);'
#   -> int(1), string(9) "#Résumé"
# so Python's original bare `\w` (unicode-aware under `re.UNICODE`, which is
# also the default for `str` patterns) was already correct and matches PHP.
# ---------------------------------------------------------------------------

def test_action_re_unicode_letter_extends_the_match_like_php():
    m = _ACTION_RE.search('#Résumé the case')
    assert m is not None
    assert m.group(0) == '#Résumé'


def test_action_re_ascii_word_chars_extend_the_match():
    m = _ACTION_RE.search('#Reset Password (Okta)')
    assert m is not None
    assert m.group(0) == '#Reset Password (Okta)'


def test_classification():
    r = PlaybookAnalyzer().analyze(_doc(), ['okta.search_users', 'okta.reset_password'])
    byName = _by_name(r['actions'])
    assert byName['#Search Okta User by Email']['kind'] == 'bound'
    assert byName['#Search Okta User by Email']['target'] == 'okta.search_users'
    assert byName['#Request Approval']['kind'] == 'native'
    assert byName['#Resolve Request']['kind'] == 'native'
    assert byName['#Reset User Factors (Custom)']['kind'] == 'unbound'
    assert 'approval' in r['gates']
    assert 'handoff' in r['gates']
    assert r['errors'] == []
    assert r['warnings']  # the unbound action


def test_dangling_binding_is_error():
    r = PlaybookAnalyzer().analyze(_doc(), ['okta.search_users'])  # reset_password missing
    assert r['errors']
    assert '#Reset Password (Okta)' in r['errors'][0]


def test_messages_point_at_the_faulty_step():
    doc = PlaybookDocument.fromArray({
        'title': 'T', 'trigger': {'kind': 'request', 'description': 'x'},
        'instructions': "1. Greet.\n2. #Reset Password (Okta) for the user.\n3. #Slack Pin Message on it.\n- then #Sub Bullet Action too\n4. #Resolve Request.",
        'actions_used': ['#Reset Password (Okta)', '#Resolve Request', '#Never Used'],
        'bindings': {'#Reset Password (Okta)': 'okta.reset_password', '#Never Used': None},
    })
    r = PlaybookAnalyzer().analyze(doc, [])
    assert 'step 2: "2. #Reset Password (Okta) for the user."' in r['errors'][0]
    unlisted = [w for w in r['warnings'] if '#Slack Pin Message' in w]
    assert len(unlisted) == 1
    assert 'not listed under "Actions used"' in unlisted[0]
    assert 'step 3:' in unlisted[0]
    sub = [w for w in r['warnings'] if '#Sub Bullet Action' in w]
    assert 'step 3, line 4: "- then #Sub Bullet Action too"' in sub[0]
    assert '#Never Used is listed under "Actions used" but never appears' in "\n".join(r['notices'])
    # Listed actions must not be re-reported as unlisted.
    assert '#Resolve Request is used' not in "\n".join(r['warnings'])


def test_checklist_preserves_prose_order():
    r = PlaybookAnalyzer().analyze(_doc(), ['okta.search_users', 'okta.reset_password'])
    assert r['checklist'][0] == '#Search Okta User by Email'
    assert r['checklist'][-1] == '#Resolve Request'


def test_checklist_order_handles_overlapping_action_names():
    # "#Reset User Factor" is a literal prefix of "#Reset User Factors
    # (Custom)". The long name's real occurrence comes first in the prose;
    # the short name's real (standalone) occurrence comes later. Without
    # masking the long name's match first, a naive find() for the short name
    # would find it embedded inside the long name's earlier occurrence and
    # misreport it as coming first.
    doc = PlaybookDocument.fromArray({
        'title': 'Overlap',
        'trigger': {'kind': 'request', 'description': 'd'},
        'instructions': '#Reset User Factors (Custom) if the device is lost. '
                         'Separately, later, #Reset User Factor for legacy systems. #Resolve Request.',
        'actions_used': ['#Reset User Factor', '#Reset User Factors (Custom)', '#Resolve Request'],
        'bindings': {'#Reset User Factor': None, '#Reset User Factors (Custom)': None},
    })
    r = PlaybookAnalyzer().analyze(doc, [])
    assert r['checklist'] == ['#Reset User Factors (Custom)', '#Reset User Factor', '#Resolve Request']


def test_auto_binding_from_console_text_with_no_bindings():
    # The markdown/Console text is the source format: with no bindings
    # block, the analyzer must translate #Actions to connected tools by
    # name-matching (explicit null still means deliberately unbound).
    doc = PlaybookDocument.fromArray({
        'title': 'MFA', 'trigger': {'kind': 'request', 'description': 'locked out'},
        'instructions': "#Search Okta User by Email first. #Search Okta System Log Custom next. "
                         "#List User Factors. Then #Reset Password (Okta) or #Reset User Factor. "
                         "#Reset User Factors (Custom) if lost device. #Leave Internal Note. #Resolve Request.",
        'tools_used': ['Okta'],
        'actions_used': ['#Search Okta User by Email', '#Search Okta System Log Custom',
                          '#List User Factors', '#Reset Password (Okta)', '#Reset User Factor',
                          '#Reset User Factors (Custom)', '#Leave Internal Note', '#Resolve Request'],
        # no bindings at all — plain pasted text
    })
    tools = ['okta.search_users', 'okta.search_system_log', 'okta.list_user_factors',
             'okta.verify_security_answers', 'okta.reset_password', 'okta.reset_factor', 'okta.unlock_user']
    r = PlaybookAnalyzer().analyze(doc, tools)
    byName = _by_name(r['actions'])
    assert byName['#Search Okta User by Email']['kind'] == 'bound'
    assert byName['#Search Okta User by Email']['target'] == 'okta.search_users'
    assert byName['#Search Okta User by Email']['auto'] is True
    assert byName['#Search Okta System Log Custom']['target'] == 'okta.search_system_log'
    assert byName['#List User Factors']['target'] == 'okta.list_user_factors'
    assert byName['#Reset Password (Okta)']['target'] == 'okta.reset_password'
    assert byName['#Reset User Factor']['target'] == 'okta.reset_factor'
    assert byName['#Reset User Factors (Custom)']['target'] == 'okta.reset_factor'
    assert byName['#Leave Internal Note']['kind'] == 'native'
    assert r['errors'] == []
    # Auto-bindings are surfaced transparently as NOTICES, not warnings
    # (a Warning tag reads as a problem; auto-binding is the success path).
    assert [n for n in r['notices'] if 'Auto-bound' in n]
    assert [w for w in r['warnings'] if 'Auto-bound' in w] == []


def test_explicit_null_binding_is_not_auto_bound():
    doc = PlaybookDocument.fromArray({
        'title': 'T', 'trigger': {'kind': 'request', 'description': 'd'},
        'instructions': '#Reset User Factors (Custom) then #Resolve Request.',
        'actions_used': ['#Reset User Factors (Custom)', '#Resolve Request'],
        'bindings': {'#Reset User Factors (Custom)': None},
    })
    r = PlaybookAnalyzer().analyze(doc, ['okta.reset_factor'])
    byName = _by_name(r['actions'])
    assert byName['#Reset User Factors (Custom)']['kind'] == 'unbound'


def test_ambiguous_name_stays_unbound():
    doc = PlaybookDocument.fromArray({
        'title': 'T', 'trigger': {'kind': 'request', 'description': 'd'},
        'instructions': '#Do Thing then #Resolve Request.',
        'actions_used': ['#Do Thing', '#Resolve Request'],
    })
    # No token overlap at all -> no auto-bind, stays a warning.
    r = PlaybookAnalyzer().analyze(doc, ['okta.reset_password', 'okta.reset_factor'])
    byName = _by_name(r['actions'])
    assert byName['#Do Thing']['kind'] == 'unbound'


def test_agent_binding():
    doc = _doc({'bindings': {'#Search Okta User by Email': 'agent.researcher',
                              '#Reset Password (Okta)': 'okta.reset_password', '#Reset User Factors (Custom)': None}})
    ok = PlaybookAnalyzer().analyze(doc, ['okta.reset_password'], ['researcher'])
    assert _by_name(ok['actions'])['#Search Okta User by Email']['kind'] == 'bound'
    bad = PlaybookAnalyzer().analyze(doc, ['okta.reset_password'], [])
    assert bad['errors']
