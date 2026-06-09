# PubMed Integration - Quick Start

## ✅ Integration Complete!

The PubMed Service has been successfully integrated into your GPT chatbot. Your LLM can now search biomedical literature and access PubMed articles.

## Test Results

All integration tests passed:
- ✅ PubMed functions registered
- ✅ PubMed service accessible
- ✅ Tool definitions correct
- ✅ Configuration working

## Available Functions

Your LLM now has access to 3 new functions:

1. **pubmed_search** - Search biomedical literature
2. **pubmed_build_query** - Build structured queries with MeSH terms
3. **pubmed_mesh_suggestions** - Get medical terminology suggestions

## Quick Usage

### Basic Search

```php
use Quantis\AIPortfolioAssistant\AIPortfolioAssistant;

$assistant = new AIPortfolioAssistant([
    'pubmed' => [
        'service_url' => 'http://localhost/pubmed/public',
    ],
    'claude' => [
        'api_key' => 'your-api-key',
    ],
]);

// The LLM will automatically use PubMed functions when appropriate
$response = $assistant->chat(
    "Find recent articles about COVID-19 vaccines",
    $userId
);

echo $response['text'];
```

### Example Queries

Try these queries with your chatbot:

**Medical Research:**
```
"Find recent articles about machine learning in healthcare"
"Search for clinical trials of metformin in type 2 diabetes"
"What are the latest findings on Alzheimer's disease treatment?"
```

**MeSH Term Search:**
```
"Get MeSH terms for heart disease, then search for recent articles"
"Search PubMed using MeSH terms for diabetes and drug therapy from 2020-2024"
```

**Complex Queries:**
```
"Build a PubMed query for cancer immunotherapy articles from 2020-2024, then search"
"Find peer-reviewed articles about artificial intelligence in medical diagnosis"
```

## Configuration

### Default (Localhost)

```php
$assistant = new AIPortfolioAssistant([
    'pubmed' => [
        'service_url' => 'http://localhost/pubmed/public',
    ],
]);
```

### Environment Variable

```bash
export PUBMED_SERVICE_URL="http://localhost/pubmed/public"
```

```php
$assistant = AIPortfolioAssistant::fromEnvironment();
```

### Config File

Create `config/ai_config.php`:
```php
return [
    'pubmed' => [
        'service_url' => 'http://localhost/pubmed/public',
    ],
    // ... other settings
];
```

Load with:
```php
$assistant = AIPortfolioAssistant::fromConfigFile('config/ai_config.php');
```

## Verify Integration

Run the test:
```bash
php tests/PubMedIntegrationTest.php
```

Expected output:
```
=== Testing PubMed Integration ===
✓ Assistant initialized
✓ All PubMed functions registered
✓ PubMed service is healthy
✓ Tool definitions look good
=== All Tests Passed ===
```

## How It Works

```
User: "Find articles about diabetes treatment"
  ↓
LLM (Claude/Grok): Analyzes query
  ↓
LLM: Calls pubmed_search("diabetes treatment")
  ↓
PubMedFunctions: HTTP request to PubMed Service
  ↓
PubMed Service: Queries NCBI E-utilities API
  ↓
Results: Returned to LLM
  ↓
LLM: Formats and presents articles to user
```

## Function Calling Support

The integration uses **function tools** (not MCP), which is compatible with:
- ✅ Grok
- ✅ Claude
- ✅ OpenAI GPT-4
- ✅ Any OpenAI-compatible API

## What Can Users Ask?

Your chatbot can now answer questions like:

**Medical Information:**
- "What does recent research say about [condition]?"
- "Find clinical trials for [drug] in [disease]"
- "Search for evidence about [treatment] effectiveness"

**Literature Reviews:**
- "Find recent peer-reviewed articles about [topic]"
- "What are the latest findings on [research area]?"
- "Search for meta-analyses on [subject]"

**Drug Information:**
- "Find studies about [drug name] side effects"
- "Search for [drug] interactions with [condition]"
- "What does PubMed say about [medication]?"

**Disease Research:**
- "Find articles about [disease] causes"
- "Search for [condition] treatment options"
- "What's new in [disease] research?"

## Features

✅ **Full Abstracts** - Get complete article abstracts
✅ **MeSH Terms** - Use controlled medical vocabulary
✅ **Date Filtering** - Search by publication date
✅ **Author Search** - Find articles by author
✅ **Field-Specific** - Search titles, abstracts, or both
✅ **Rate Limiting** - Automatic NCBI rate limit compliance
✅ **Natural Language** - Simple queries or complex syntax

## Troubleshooting

### Service Not Accessible

```bash
# Check PubMed service
curl http://localhost/pubmed/public/health

# Should return:
{"success":true,"status":"running","version":"1.0.0",...}
```

If not working:
1. Check XAMPP is running
2. Verify PubMed service is installed at `/xampp/htdocs/pubmed`
3. Check service permissions (see PubMed QUICK_START.md)

### LLM Not Using Functions

If the LLM doesn't call PubMed functions:
1. Be explicit: "Search PubMed for..."
2. Check function definitions are loaded:
   ```php
   $tools = $assistant->getToolsManager()->getRegisteredFunctions();
   var_dump(in_array('pubmed_search', $tools)); // Should be true
   ```
3. Enable debug mode to see function calls

### Rate Limiting

NCBI has rate limits:
- 3 requests/second (default)
- 10 requests/second (with API key)

To add API key to PubMed Service:
```bash
curl -X PUT http://localhost/pubmed/public/config \
  -H "Content-Type: application/json" \
  -d '{"api_key": "YOUR_NCBI_KEY", "rate_limit": 10}'
```

Get API key at: https://www.ncbi.nlm.nih.gov/account/

## Documentation

- **Full Integration Guide**: `docs/PUBMED_INTEGRATION.md`
- **PubMed Service Docs**: `/xampp/htdocs/pubmed/README.md`
- **Query Syntax**: `/xampp/htdocs/pubmed/docs/QUERIES.md`
- **API Reference**: `/xampp/htdocs/pubmed/docs/API.md`

## Examples

### Example 1: Simple Search

```php
$response = $assistant->chat(
    "Find 5 recent articles about COVID-19 vaccines",
    $userId
);
```

LLM calls:
```json
{
  "function": "pubmed_search",
  "arguments": {
    "query": "COVID-19 vaccines",
    "max_results": 5
  }
}
```

### Example 2: MeSH Terms

```php
$response = $assistant->chat(
    "Get MeSH terms for diabetes, then search for treatment articles from 2020-2024",
    $userId
);
```

LLM calls:
1. `pubmed_mesh_suggestions(topic: "diabetes")`
2. `pubmed_search(query: "\"Diabetes Mellitus\"[MeSH Terms] AND treatment AND 2020:2024[PDAT]")`

### Example 3: Complex Query

```php
$response = $assistant->chat(
    "Build a query for cancer immunotherapy clinical trials from 2020-2024, then search",
    $userId
);
```

LLM calls:
1. `pubmed_build_query(mesh_terms: ["Neoplasms", "Immunotherapy", "Clinical Trials"], date_start: "2020", date_end: "2024")`
2. `pubmed_search(query: [built query])`

## Performance

- **Average Search**: 500-1000ms
- **With Abstracts**: 1-2 seconds
- **Without Abstracts**: 200-500ms
- **Rate Limit**: Automatic (3-10 req/s)

## Next Steps

1. ✅ Integration complete - ready to use!
2. Try example queries with your chatbot
3. Customize system prompt to emphasize PubMed for medical queries
4. Add NCBI API key for higher rate limits
5. Monitor usage via PubMed service health endpoint

## Support

- **Integration Issues**: See `docs/PUBMED_INTEGRATION.md`
- **PubMed Service**: See `/xampp/htdocs/pubmed/docs/TROUBLESHOOTING.md`
- **NCBI API**: https://www.ncbi.nlm.nih.gov/home/develop/api/

---

**Integration Status**: ✅ Complete and Tested
**Functions Available**: 3 (search, build_query, mesh_suggestions)
**Service Version**: 1.0.0
**Last Updated**: November 2024
