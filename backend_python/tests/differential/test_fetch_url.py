from .conftest import same


def test_fetch_url_validation_parity(both):
    same(*both('POST', '/api/v1/fetch-url', json={}))
    same(*both('POST', '/api/v1/fetch-url', json={'url': 'not a url'}))
    same(*both('POST', '/api/v1/fetch-url', json={'url': 'http://'}))


def test_fetch_url_live_example_com(both):
    a, b = both('POST', '/api/v1/fetch-url', json={'url': 'https://example.com/'})
    assert a.status_code == b.status_code == 200
    ja, jb = a.json(), b.json()
    assert ja['success'] is jb['success'] is True and list(ja) == list(jb) and list(ja['data']) == list(jb['data'])
    assert ja['data']['status'] == jb['data']['status'] == 200 and ja['data']['final_url'] == jb['data']['final_url']
    assert abs(ja['data']['bytes'] - jb['data']['bytes']) < 64 and 'Example Domain' in jb['data']['html']
