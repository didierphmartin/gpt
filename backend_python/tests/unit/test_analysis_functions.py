import json
import httpx
import pytest
from app.config_.configuration import Configuration
from app.functions.analysis_functions import AnalysisFunctions


def _af(handler, key='FMP'):
    af = AnalysisFunctions(Configuration({'financial': {'fmp': {'api_key': key}}}))
    af.httpClient = httpx.Client(transport=httpx.MockTransport(handler))
    return af


def test_registry_names_schemas_and_handlers():
    af = _af(lambda r: httpx.Response(200, json=[]))
    fns = af.getAllFunctions()
    assert list(fns) == ['get_analyst_ratings', 'get_financial_ratios', 'get_price_targets', 'get_company_profile', 'get_asset_sentiment']
    for name, cfg in fns.items():
        # NOTE: PHP AnalysisFunctions.php:32-44 schema arrays hold only
        # 'description' and 'input_schema' (no 'name' key) — same shape as
        # the already-ported SearchFunctions and consumed by ToolsManager,
        # which adds 'name' itself in getToolDefinitions() (tools_manager.py:72),
        # not on the per-function schema. Adjusted from the brief's
        # `cfg['schema']['name'] == name` accordingly.
        assert callable(cfg['handler']) and cfg['schema']['input_schema']['type'] == 'object'
    assert fns['get_analyst_ratings']['schema']['input_schema']['required'] == ['symbol']
    assert fns['get_asset_sentiment']['schema']['input_schema']['required'] == ['symbol']
    af.close(); assert af.httpClient.is_closed


def test_missing_key_and_missing_symbol():
    assert _af(lambda r: None, key='').getAnalystRatings({'symbol': 'AAPL'}, 3) == {'error': 'FMP API key not configured'}
    assert _af(lambda r: None).getAnalystRatings({}, 3) == {'error': 'Symbol is required'}
    assert _af(lambda r: None).getFinancialRatios({'symbol': ''}, 3) == {'error': 'Symbol is required'}


def test_analyst_ratings_calls_fmp_and_slices_ten():
    seen = {}
    def handler(req):
        seen['url'] = str(req.url); return httpx.Response(200, json=[{'grade': i} for i in range(15)])
    out = _af(handler).getAnalystRatings({'symbol': 'aapl'}, 3)
    assert seen['url'] == 'https://financialmodelingprep.com/api/v3/grade/AAPL?apikey=FMP'
    assert out == {'success': True, 'symbol': 'AAPL', 'ratings': [{'grade': i} for i in range(10)]}


def test_http_error_becomes_php_error_message():
    out = _af(lambda r: httpx.Response(500, text='boom')).getAnalystRatings({'symbol': 'AAPL'}, 3)
    assert 'error' in out and out['error'].startswith('Failed to fetch analyst ratings: ')


def test_financial_ratios_price_targets_profile_shapes():
    seen = []
    def handler(req):
        seen.append(str(req.url))
        if '/ratios/' in req.url.path:
            return httpx.Response(200, json=[{'peRatio': 30.1}])
        if 'price-target' in req.url.path:
            return httpx.Response(200, json=[{'priceTarget': 200}, {'priceTarget': 210}])
        return httpx.Response(200, json=[{'companyName': 'Apple Inc.'}])
    af = _af(handler)
    ratios = af.getFinancialRatios({'symbol': 'AAPL'}, 3)
    targets = af.getPriceTargets({'symbol': 'AAPL'}, 3)
    profile = af.getCompanyProfile({'symbol': 'AAPL'}, 3)
    assert ratios['success'] is True and ratios['symbol'] == 'AAPL'
    assert targets['success'] is True and targets['symbol'] == 'AAPL'
    assert profile['success'] is True and profile['symbol'] == 'AAPL' and profile['profile'] == {'companyName': 'Apple Inc.'}
    # Important #1 (final review): pin the actual values, not just success/symbol.
    assert ratios['ratios'] == {'peRatio': 30.1}
    assert targets['price_targets'] == [{'priceTarget': 200}, {'priceTarget': 210}]
    assert any('apikey=FMP&limit=1' in u or 'limit=1&apikey=FMP' in u for u in seen)          # ratios query: apikey + limit=1
    assert any('symbol=AAPL' in u for u in seen)                                              # price targets pass symbol as a query param


def test_asset_sentiment_is_static():
    assert _af(lambda r: None).getAssetSentiment({'symbol': 'tsla'}, 3) == {'success': True, 'symbol': 'TSLA', 'message': 'Sentiment analysis requires integration with news/social APIs'}


def test_asset_sentiment_coerces_non_string_symbol_like_strtoupper():
    # Minor #6 (final review): PHP `strtoupper()` coerces a non-string via
    # (string) cast instead of raising; getAssetSentiment has no try/except
    # so a bare `.upper()` on an int would escape as an uncaught exception.
    assert _af(lambda r: None).getAssetSentiment({'symbol': 700}, 3) == {
        'success': True,
        'symbol': '700',
        'message': 'Sentiment analysis requires integration with news/social APIs',
    }


def test_fmp_response_shapes_data_0_or_empty_list():
    # Important #1 (final review): PHP `$data[0] ?? []` always encodes as `[]`
    # (never `{}`) regardless of why the index is missing — empty list, an
    # FMP error-object response, or invalid JSON (`data = None`).
    for bad in ([], {'Error Message': 'Limit Reach'}, None):
        af = _af(lambda r, bad=bad: httpx.Response(200, json=bad) if bad is not None else httpx.Response(200, text='not json'))
        ratios = af.getFinancialRatios({'symbol': 'AAPL'}, 3)
        assert ratios['ratios'] == [], f'ratios for data={bad!r}'
        profile = af.getCompanyProfile({'symbol': 'AAPL'}, 3)
        assert profile['profile'] == [], f'profile for data={bad!r}'


def test_fmp_response_shapes_array_slice_preserves_dict_keys():
    # Important #1 (final review): PHP `array_slice($data, 0, 10)` on a
    # string-keyed array (FMP error-object response) preserves the keys
    # instead of collapsing to `[]`; only a genuinely non-array/non-list
    # decode (invalid JSON -> None) collapses to `[]`.
    error_obj = {'Error Message': 'Limit Reach'}
    af = _af(lambda r: httpx.Response(200, json=error_obj))
    ratings = af.getAnalystRatings({'symbol': 'AAPL'}, 3)
    assert ratings['ratings'] == error_obj
    targets = af.getPriceTargets({'symbol': 'AAPL'}, 3)
    assert targets['price_targets'] == error_obj

    af2 = _af(lambda r: httpx.Response(200, text='not json'))
    assert af2.getAnalystRatings({'symbol': 'AAPL'}, 3)['ratings'] == []
    assert af2.getPriceTargets({'symbol': 'AAPL'}, 3)['price_targets'] == []

    af3 = _af(lambda r: httpx.Response(200, json=[]))
    assert af3.getAnalystRatings({'symbol': 'AAPL'}, 3)['ratings'] == []
    assert af3.getPriceTargets({'symbol': 'AAPL'}, 3)['price_targets'] == []
