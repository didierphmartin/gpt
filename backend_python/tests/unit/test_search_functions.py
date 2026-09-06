import httpx
from app.config_.configuration import Configuration
from app.functions.search_functions import SearchFunctions


def test_schema_names_and_unconfigured_keys():
    sf = SearchFunctions(Configuration({}))
    fns = sf.getAllFunctions()
    assert list(fns) == ['serpapi_search', 'brave_search', 'search_assets', 'get_trending_assets', 'get_top_gainers', 'get_top_losers', 'get_sec_filings', 'get_sec_filing_document']
    assert fns['serpapi_search']['schema']['input_schema']['required'] == ['query']
    assert sf.serpApiSearch({'query': 'x'}, None) == {'error': 'SerpAPI key not configured'}
    assert sf.braveSearch({'query': 'x'}, None) == {'error': 'Brave Search API key not configured'}
    assert sf.searchAssets({'query': 'q'}, None) == {'success': True, 'message': 'Asset search requires database connection', 'query': 'q'}
    assert sf.getSecFilings({}, None) == {'error': 'symbol_or_cik is required'}


def test_serpapi_and_sec_via_mock_transport():
    sf = SearchFunctions(Configuration({'search': {'serpapi': {'api_key': 'K'}}}))
    def handler(req):
        if 'serpapi.com' in str(req.url):
            assert req.url.params['api_key'] == 'K' and req.url.params['num'] == '3'
            return httpx.Response(200, json={'organic_results': [{'title': 't', 'link': 'l', 'snippet': 's', 'position': 1}]})
        if 'company_tickers' in str(req.url):
            return httpx.Response(200, json={'0': {'ticker': 'AAPL', 'cik_str': 320193}})
        assert req.headers['user-agent'] == 'GPT Chatbot admin@company.com'
        return httpx.Response(200, json={'facts': 1})
    sf.httpClient = httpx.Client(transport=httpx.MockTransport(handler))
    assert sf.serpApiSearch({'query': 'q', 'count': 3}, None) == {'success': True, 'query': 'q', 'results': [{'title': 't', 'link': 'l', 'snippet': 's', 'position': 1}], 'count': 1}
    out = sf.getSecFilings({'symbol_or_cik': 'aapl'}, None)
    assert out == {'success': True, 'data_type': 'facts', 'cik': '0000320193', 'data': {'facts': 1}}


def test_http_errors_are_caught_not_raised():
    # Guzzle's http_errors default is true: every PHP ->get() raises on 4xx/5xx
    # and lands in the method's own catch block. httpx does not raise by
    # default, so each call site must call raise_for_status() itself.
    sf = SearchFunctions(Configuration({'search': {'serpapi': {'api_key': 'K'}}}))
    sf.httpClient = httpx.Client(transport=httpx.MockTransport(lambda req: httpx.Response(500, text='boom')))
    out = sf.serpApiSearch({'query': 'q'}, None)
    assert 'error' in out and out['error'].startswith('Search failed: ')

    sf2 = SearchFunctions(Configuration({}))
    sf2.httpClient = httpx.Client(transport=httpx.MockTransport(lambda req: httpx.Response(404, text='not found')))
    out2 = sf2.getSecFilingDocument({'accession_number': '0000000000-00-000000'}, None)
    assert 'error' in out2 and out2['error'].startswith('SEC filing document error: ')

    sf3 = SearchFunctions(Configuration({}))
    sf3.httpClient = httpx.Client(transport=httpx.MockTransport(lambda req: httpx.Response(500, text='boom')))
    assert sf3._resolveToCik('aapl') is None


def test_close_closes_http_client():
    sf = SearchFunctions(Configuration({}))
    assert sf.httpClient.is_closed is False
    sf.close()
    assert sf.httpClient.is_closed is True
