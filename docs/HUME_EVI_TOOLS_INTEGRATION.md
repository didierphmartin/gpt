# Hume EVI Tools Integration Guide

## Overview
This integration allows Hume EVI to execute backend functions (portfolio, watchlist, search, etc.) through your existing chat.js interface.

## What Was Implemented

### 1. Backend API Endpoint
**File:** `backend/api/hume-tools.php`

**Routes:**
- `GET /api/v1/hume/tools/list` - Get all available tools in Hume format
- `POST /api/v1/hume/tools/execute` - Execute a tool function

**Registered Functions:**
- ✅ WatchlistFunctions (get_user_watchlist, add_to_watchlist, remove_from_watchlist, etc.)
- ✅ PortfolioFunctions (get_portfolios, get_portfolio_assets_with_discovery, etc.)
- ✅ SearchFunctions (serpapi_search, brave_search, get_sec_filings, etc.)
- ✅ AnalysisFunctions (get_analyst_ratings, get_financial_ratios, etc.)
- ✅ FinancialNewsFunctions
- ✅ CryptoNewsFunctions
- ✅ PubMedFunctions

### 2. Frontend Integration
**File:** `frontend/assets/js/chat.js`

**Added:**
- Tool call handler in `handleEVIMessage()` switch statement
- New method `handleEVIToolCall()` to process tool calls

## How It Works

```
┌─────────────┐         ┌──────────────┐         ┌─────────────────┐
│  Hume EVI   │         │   chat.js    │         │  Backend PHP    │
│  WebSocket  │         │              │         │                 │
└──────┬──────┘         └───────┬──────┘         └────────┬────────┘
       │                        │                          │
       │  tool_call             │                          │
       │ {name, params, id}     │                          │
       │───────────────────────>│                          │
       │                        │                          │
       │                        │  POST /api/v1/hume/      │
       │                        │  tools/execute           │
       │                        │─────────────────────────>│
       │                        │                          │
       │                        │                          │ Execute via
       │                        │                          │ ToolsManager
       │                        │                          │─────┐
       │                        │                          │     │
       │                        │                          │<────┘
       │                        │                          │
       │                        │  {success, content}      │
       │                        │<─────────────────────────│
       │                        │                          │
       │  tool_response         │                          │
       │<───────────────────────│                          │
       │ {toolCallId, content}  │                          │
```

## Setup Instructions

### Step 1: Configure Hume EVI Tools

1. Visit your backend endpoint:
   ```
   http://localhost/gpt/backend/api/v1/hume/tools/list
   ```

2. Copy the JSON output

3. Go to [Hume AI Portal](https://platform.hume.ai/)

4. Create or edit your EVI Configuration

5. Paste the tool definitions into the "Tools" section

### Step 2: Test the Integration

1. Connect to EVI in your chat interface (click the EVI toggle button)

2. Try asking questions that trigger tools:
   - "What's in my portfolio?" → triggers `get_portfolio_assets_with_discovery`
   - "Add AAPL to my watchlist" → triggers `add_to_watchlist`
   - "Search for Tesla news" → triggers `serpapi_search`

3. Watch the console logs:
   - `🔧 Tool call received: [function_name]`
   - `✅ Tool result sent to EVI`

### Step 3: Monitor Tool Execution

Open browser console (F12) to see tool execution flow:
```
🔧 Tool call received: get_user_watchlist {}
✅ Tool result sent to EVI: get_user_watchlist
```

The EVI status indicator will show:
- ⚙️ "Executing..." when running tools
- 🟢 "Listening..." when complete
- ⚠️ "Error" if something fails

## Example Tool Call Flow

### User says: "Show me my watchlist"

1. **Hume EVI decides** to call `get_watchlist_with_market_data`

2. **EVI sends WebSocket message:**
   ```json
   {
     "type": "tool_call",
     "tool_call_id": "call_abc123",
     "name": "get_watchlist_with_market_data",
     "parameters": "{}"
   }
   ```

3. **chat.js receives** and calls backend:
   ```javascript
   POST /api/v1/hume/tools/execute
   {
     "toolCallId": "call_abc123",
     "toolName": "get_watchlist_with_market_data",
     "parameters": {}
   }
   ```

4. **Backend executes** WatchlistFunctions->getWatchlistWithMarketData()

5. **Backend returns:**
   ```json
   {
     "success": true,
     "toolCallId": "call_abc123",
     "content": "{\"success\":true,\"watchlist\":[...],\"count\":5}"
   }
   ```

6. **chat.js sends** to EVI:
   ```json
   {
     "type": "tool_response",
     "toolCallId": "call_abc123",
     "content": "{\"success\":true,\"watchlist\":[...],\"count\":5}"
   }
   ```

7. **EVI responds** with natural language about the watchlist data

## Available Functions

### Watchlist Functions
- `get_user_watchlist` - Get tracked assets
- `get_watchlist_with_market_data` - Get watchlist with current prices
- `add_to_watchlist` - Add asset to watchlist
- `remove_from_watchlist` - Remove asset from watchlist

### Portfolio Functions
- `get_portfolios` - List all portfolios
- `get_portfolio_assets_with_discovery` - Get portfolio holdings with prices
- `get_portfolio_diversification` - Get asset allocation breakdown
- `get_all_transactions` - Get transaction history

### Search Functions
- `serpapi_search` - Web search using Google
- `brave_search` - Web search using Brave
- `search_assets` - Search for stocks/crypto
- `get_sec_filings` - Get SEC EDGAR data
- `get_sec_filing_document` - Get specific SEC documents

### Analysis Functions
- `get_analyst_ratings` - Get analyst recommendations
- `get_financial_ratios` - Get P/E, ROE, etc.

### News Functions
- Financial news search
- Crypto news search
- PubMed research search

## Troubleshooting

### Tools not being called
- Check Hume EVI configuration has tools properly defined
- Verify tool names match exactly (case-sensitive)
- Check browser console for errors

### Backend errors
- Verify database connection in backend
- Check API keys in `backend/config/ai_config.php`
- Review backend logs

### WebSocket errors
- Ensure EVI is connected (status should be green)
- Check network tab for failed requests
- Verify API endpoints are accessible

## Security Notes

- Currently uses demo user (`demo-user`) for testing
- **Production:** Implement proper session authentication
- **Production:** Add rate limiting to tool execution endpoint
- **Production:** Validate all tool parameters on backend
- **Production:** Add user permission checks for sensitive operations

## Next Steps

1. **Authentication:** Replace demo user with actual session management
2. **Rate Limiting:** Add throttling to prevent abuse
3. **Logging:** Add tool usage tracking to database
4. **Monitoring:** Track tool performance and errors
5. **Custom Tools:** Add more business-specific functions as needed

## File Changes Summary

### Modified Files
- ✅ `backend/index.php` - Added Hume tools route
- ✅ `frontend/assets/js/chat.js` - Added tool call handling

### New Files
- ✅ `backend/api/hume-tools.php` - Tool execution endpoint
- ✅ `HUME_EVI_TOOLS_INTEGRATION.md` - This documentation

## API Reference

### GET /api/v1/hume/tools/list
Returns all available tools in Hume format.

**Response:**
```json
{
  "success": true,
  "tools": [
    {
      "name": "get_user_watchlist",
      "description": "Get the user watchlist...",
      "parameters": {
        "type": "object",
        "properties": {},
        "required": []
      }
    }
  ],
  "count": 25
}
```

### POST /api/v1/hume/tools/execute
Execute a tool function.

**Request:**
```json
{
  "toolCallId": "call_abc123",
  "toolName": "add_to_watchlist",
  "parameters": {
    "symbol": "AAPL",
    "name": "Apple Inc.",
    "type": "stock"
  }
}
```

**Response:**
```json
{
  "success": true,
  "toolCallId": "call_abc123",
  "toolName": "add_to_watchlist",
  "content": "{\"success\":true,\"message\":\"AAPL added to watchlist\"}",
  "result": {
    "success": true,
    "message": "AAPL added to watchlist"
  }
}
```

## Support

For issues or questions:
1. Check browser console logs
2. Check backend error logs
3. Verify Hume EVI configuration
4. Review this documentation
