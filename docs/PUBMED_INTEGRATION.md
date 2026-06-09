# PubMed Integration

The PubMed Service integration provides access to biomedical and life sciences literature through three specialized functions.

## Overview

This integration connects your GPT chatbot to the PubMed Service, enabling:
- Search biomedical literature
- Build structured queries with MeSH terms
- Get MeSH term suggestions
- Access article abstracts and metadata

## Prerequisites

1. **PubMed Service Running**
   - Service should be accessible at `http://localhost/pubmed/public`
   - See `/Applications/XAMPP/xamppfiles/htdocs/pubmed/README.md` for setup

2. **Configuration**
   - Add PubMed service URL to configuration
   - Default: `http://localhost/pubmed/public`

## Configuration

### Option 1: Environment Variable

```bash
export PUBMED_SERVICE_URL="http://localhost/pubmed/public"
```

Then create assistant with:
```php
$assistant = AIPortfolioAssistant::fromEnvironment();
```

### Option 2: Configuration Array

```php
$assistant = new AIPortfolioAssistant([
    'pubmed' => [
        'service_url' => 'http://localhost/pubmed/public',
    ],
    // ... other config
]);
```

### Option 3: Configuration File

Create `config/ai_config.php`:
```php
return [
    'pubmed' => [
        'service_url' => 'http://localhost/pubmed/public',
    ],
    // ... other config
];
```

Load with:
```php
$assistant = AIPortfolioAssistant::fromConfigFile('config/ai_config.php');
```

## Available Functions

### 1. pubmed_search

Search PubMed for biomedical literature.

**Parameters:**
- `query` (string, required): Search query
  - Use natural language: "diabetes treatment"
  - Use MeSH terms: "\"Diabetes Mellitus\"[MeSH Terms]"
  - Use field tags: "cancer[Title] AND therapy[Abstract]"
  - Use simplified syntax: "[mesh:Cancer] AND [title:treatment]"
- `max_results` (integer, optional): Maximum articles to return (1-100, default: 10)
- `include_abstracts` (boolean, optional): Include full abstracts (default: true)

**Returns:**
- `success`: Boolean success status
- `query`: The processed query used
- `total_found`: Total number of articles found
- `returned`: Number of articles returned
- `articles`: Array of articles with:
  - `pmid`: PubMed ID
  - `title`: Article title
  - `authors`: Author list (formatted)
  - `journal`: Journal name
  - `publication_date`: Publication date
  - `abstract`: Full abstract text
  - `url`: PubMed URL

**Example:**
```json
{
  "query": "COVID-19 treatment",
  "max_results": 5,
  "include_abstracts": true
}
```

### 2. pubmed_build_query

Build a structured PubMed query using MeSH terms and field-specific searches.

**Parameters:**
- `mesh_terms` (array, optional): MeSH terms to include
- `title_terms` (array, optional): Terms to search in titles
- `author` (string, optional): Author name
- `date_start` (string, optional): Start year (YYYY format)
- `date_end` (string, optional): End year (YYYY format)
- `combine_with` (string, optional): "AND" or "OR" (default: "AND")

**Returns:**
- `success`: Boolean success status
- `query`: Built query string
- `message`: Success message
- `usage_example`: Example of how to use the query

**Example:**
```json
{
  "mesh_terms": ["Diabetes Mellitus", "Drug Therapy"],
  "title_terms": ["insulin"],
  "date_start": "2020",
  "date_end": "2024",
  "combine_with": "AND"
}
```

### 3. pubmed_mesh_suggestions

Get Medical Subject Headings (MeSH) term suggestions for a topic.

**Parameters:**
- `topic` (string, required): Medical topic or condition

**Returns:**
- `success`: Boolean success status
- `topic`: The queried topic
- `mesh_terms`: Array of suggested MeSH terms
- `message`: Information message
- `note`: Usage instructions

**Example:**
```json
{
  "topic": "cancer"
}
```

## Usage Examples

### Basic Search

```php
use Quantis\AIPortfolioAssistant\AIPortfolioAssistant;

$assistant = new AIPortfolioAssistant([
    'pubmed' => [
        'service_url' => 'http://localhost/pubmed/public',
    ],
]);

// Simple query
$response = $assistant->chat(
    "Find recent articles about COVID-19 treatment",
    $userId
);

// The LLM will use pubmed_search automatically
```

### Using MeSH Terms

```php
// Ask for MeSH suggestions first
$response = $assistant->chat(
    "Get MeSH terms for diabetes, then search for recent diabetes treatment articles",
    $userId
);

// The LLM will:
// 1. Call pubmed_mesh_suggestions with topic "diabetes"
// 2. Use returned MeSH terms in pubmed_search
```

### Building Complex Queries

```php
$response = $assistant->chat(
    "Build a PubMed query for diabetes drug therapy articles from 2020-2024, then search",
    $userId
);

// The LLM will:
// 1. Call pubmed_build_query with appropriate parameters
// 2. Use the built query with pubmed_search
```

### Specific Research Tasks

```php
// Literature review
$response = $assistant->chat(
    "Find 10 recent peer-reviewed articles about machine learning in medical diagnosis",
    $userId
);

// Drug information
$response = $assistant->chat(
    "Search PubMed for clinical trials of metformin in type 2 diabetes",
    $userId
);

// Disease research
$response = $assistant->chat(
    "Find recent research on Alzheimer's disease treatment",
    $userId
);
```

## Query Syntax Guide

### Natural Language
```
"diabetes treatment"
"COVID-19 vaccines"
"cancer immunotherapy"
```

### MeSH Terms
```
"Diabetes Mellitus"[MeSH Terms]
"Neoplasms"[MeSH Terms] AND "Immunotherapy"[MeSH Terms]
```

### Field Tags
```
cancer[Title]
"machine learning"[Title/Abstract]
Smith J[Author]
2020:2024[PDAT]
```

### Simplified Syntax
```
[mesh:Diabetes Mellitus] AND [title:treatment]
[author:Smith] AND [mesh:COVID-19]
```

### Boolean Operators
```
diabetes AND treatment
cancer OR neoplasm OR tumor
therapy NOT surgery
(diabetes OR "type 2 diabetes") AND treatment
```

## Best Practices

### 1. Start with MeSH Suggestions
```
"Get MeSH terms for heart disease, then search for recent articles"
```

### 2. Use Specific Queries
```
"Search PubMed for randomized controlled trials of aspirin in heart disease from 2020-2024"
```

### 3. Limit Results Appropriately
```
"Find 5 most recent articles about COVID-19 vaccines"
```

### 4. Request Abstracts When Needed
```
"Search for cancer immunotherapy articles and include abstracts for detailed analysis"
```

## Troubleshooting

### Service Not Accessible

**Error:** `PubMed search error: Connection refused`

**Solutions:**
1. Check PubMed service is running:
   ```bash
   curl http://localhost/pubmed/public/health
   ```

2. Verify XAMPP is running

3. Check service URL in configuration

### No Results Found

**Error:** `Found 0 articles`

**Solutions:**
1. Try broader search terms
2. Use MeSH suggestions to find proper terminology
3. Check query syntax
4. Test query on PubMed.gov first

### Timeout Errors

**Error:** `PubMed search error: Timeout`

**Solutions:**
1. Reduce `max_results`
2. Set `include_abstracts` to false for faster searches
3. Check internet connection
4. Check NCBI service status

### Rate Limiting

The PubMed Service handles NCBI rate limiting automatically:
- 3 requests/second without API key
- 10 requests/second with API key

To add API key to PubMed Service:
```bash
curl -X PUT http://localhost/pubmed/public/config \
  -H "Content-Type: application/json" \
  -d '{"api_key": "YOUR_NCBI_KEY"}'
```

## Testing

### Test PubMed Service

```bash
# Health check
curl http://localhost/pubmed/public/health

# Test search
curl -X POST http://localhost/pubmed/public/search \
  -H "Content-Type: application/json" \
  -d '{"query": "COVID-19", "max_results": 2}'
```

### Test Integration

```php
use Quantis\AIPortfolioAssistant\AIPortfolioAssistant;

$assistant = new AIPortfolioAssistant([
    'pubmed' => [
        'service_url' => 'http://localhost/pubmed/public',
    ],
]);

// Test PubMed search
$response = $assistant->chat(
    "Search PubMed for 2 articles about COVID-19",
    'test-user'
);

print_r($response);

// Check that pubmed_search was called
$tools = $assistant->getToolsManager()->getRegisteredFunctions();
var_dump(in_array('pubmed_search', $tools)); // Should be true
```

## Advanced Configuration

### Custom Service URL

For remote PubMed service:
```php
$assistant = new AIPortfolioAssistant([
    'pubmed' => [
        'service_url' => 'https://your-domain.com/pubmed/api',
    ],
]);
```

### Disable PubMed Functions

To temporarily disable without removing code:
```php
// Don't set pubmed configuration
$assistant = new AIPortfolioAssistant([
    // No pubmed key
]);

// Or set invalid URL to make functions fail gracefully
$assistant = new AIPortfolioAssistant([
    'pubmed' => [
        'service_url' => '',
    ],
]);
```

## Function Execution Flow

```
User Query: "Find articles about diabetes treatment"
     ↓
LLM analyzes query
     ↓
LLM calls: pubmed_search(query: "diabetes treatment", max_results: 10)
     ↓
PubMedFunctions.searchPubMed() → HTTP POST to PubMed Service
     ↓
PubMed Service → NCBI E-utilities API
     ↓
Results returned to LLM
     ↓
LLM formats and presents results to user
```

## Related Documentation

- [PubMed Service Documentation](../../pubmed/README.md)
- [PubMed Query Guide](../../pubmed/docs/QUERIES.md)
- [PubMed API Reference](../../pubmed/docs/API.md)
- [NCBI E-utilities Documentation](https://www.ncbi.nlm.nih.gov/books/NBK25501/)

## Support

For issues with:
- **Integration**: Check this documentation
- **PubMed Service**: See `/pubmed/docs/TROUBLESHOOTING.md`
- **NCBI API**: Visit https://www.ncbi.nlm.nih.gov/home/develop/api/
