# Hume EVI Tools - Automated Sync Setup Guide

## 🎯 Overview

This system automatically synchronizes your backend functions with Hume EVI, eliminating manual copy-paste workflows.

## ✨ Features

- ✅ **One-Click Sync** - Sync all tools to Hume API with one button
- ✅ **Status Monitoring** - See which tools are out of sync
- ✅ **Auto-Detection** - Detects new, updated, and deleted tools
- ✅ **Version Management** - Tracks tool versions in Hume
- ✅ **Error Handling** - Detailed error reporting and logging
- ✅ **Admin UI** - Beautiful interface for managing tools

## 📋 Prerequisites

1. **Hume API Key** - Get from [https://platform.hume.ai/](https://platform.hume.ai/)
2. **Database Access** - MySQL database configured
3. **Backend Running** - XAMPP/PHP backend operational

## 🚀 Quick Start

### Step 1: Run Database Migration

```bash
cd backend/migrations
php run_migrations.php
```

This creates the `hume_tool_mapping` table.

### Step 2: Configure Hume API Key

Edit `backend/config/ai_config.php`:

```php
'hume_evi' => [
    'api_key' => 'YOUR_HUME_API_KEY_HERE',
    'base_url' => 'https://api.hume.ai/v0/evi',
    'config_id' => '', // Optional: Your EVI config ID
    'auto_sync_on_changes' => false,
    'cleanup_orphaned_tools' => false,
],
```

### Step 3: Access Admin UI

Open in browser:
```
http://localhost/gpt/frontend/hume-tools-admin.html
```

### Step 4: Test Connection

Click **"Test Connection"** to verify Hume API access.

### Step 5: Sync Tools

Click **"Check Status"** then **"Sync All Tools"** to synchronize.

## 📡 API Endpoints

### GET /api/v1/hume/tools/test-connection
Test connection to Hume API.

**Response:**
```json
{
  "success": true,
  "message": "Connected to Hume API successfully",
  "tools_count": 25
}
```

### GET /api/v1/hume/tools/status
Get synchronization status.

**Response:**
```json
{
  "success": true,
  "status": {
    "local_count": 25,
    "hume_count": 20,
    "missing_in_hume": ["add_to_watchlist", "get_portfolio_diversification"],
    "missing_in_local": [],
    "needs_sync": true
  }
}
```

### POST /api/v1/hume/tools/sync
Sync all backend tools to Hume.

**Response:**
```json
{
  "success": true,
  "message": "Tools synchronized successfully",
  "stats": {
    "total_local": 25,
    "total_hume": 25,
    "created": 5,
    "updated": 2,
    "unchanged": 18,
    "errors": 0
  },
  "details": {
    "created": ["add_to_watchlist", "remove_from_watchlist"],
    "updated": ["get_user_watchlist"],
    "unchanged": [...],
    "tool_mapping": {
      "get_user_watchlist": "550e8400-e29b-41d4-a716-446655440000",
      "add_to_watchlist": "660e8400-e29b-41d4-a716-446655440001"
    }
  }
}
```

### GET /api/v1/hume/tools/list
List tools in Hume format (for manual config).

### POST /api/v1/hume/tools/execute
Execute a tool (used by EVI WebSocket handler).

## 🔄 How It Works

```
┌─────────────────┐         ┌──────────────────┐         ┌─────────────────┐
│   Admin UI      │────────→│  Sync Service    │────────→│   Hume API      │
│  (Frontend)     │         │  (Backend)       │         │  (External)     │
└─────────────────┘         └──────────────────┘         └─────────────────┘
       │                             │                            │
       │ 1. Click "Sync"             │                            │
       │─────────────────────────────→                            │
       │                             │                            │
       │                             │ 2. Get Backend Functions   │
       │                             │────────┐                   │
       │                             │        │                   │
       │                             │←───────┘                   │
       │                             │                            │
       │                             │ 3. List Hume Tools         │
       │                             │───────────────────────────→│
       │                             │                            │
       │                             │←───────────────────────────│
       │                             │                            │
       │                             │ 4. Compare & Sync          │
       │                             │────────┐                   │
       │                             │        │                   │
       │                             │←───────┘                   │
       │                             │                            │
       │                             │ 5. Create/Update Tools     │
       │                             │───────────────────────────→│
       │                             │                            │
       │                             │←───────────────────────────│
       │                             │                            │
       │                             │ 6. Store Mapping in DB     │
       │                             │────────┐                   │
       │                             │        │                   │
       │                             │←───────┘                   │
       │                             │                            │
       │←─────────────────────────────                            │
       │ 7. Show Results             │                            │
```

## 🗂️ File Structure

```
backend/
├── config/
│   └── ai_config.php ................... Hume API configuration
├── src/
│   └── Services/
│       └── HumeToolSyncService.php ..... Sync logic
├── api/
│   └── hume-tools.php .................. API endpoints
├── migrations/
│   ├── 001_create_hume_tool_mapping.sql
│   └── run_migrations.php .............. Migration runner

frontend/
└── hume-tools-admin.html ............... Admin UI
```

## 🛠️ Advanced Configuration

### Auto-Sync on Changes

Enable automatic synchronization when functions change:

```php
'auto_sync_on_changes' => true,
```

### Cleanup Orphaned Tools

Auto-delete tools from Hume that don't exist in backend:

```php
'cleanup_orphaned_tools' => true,
```

⚠️ **Warning**: Use with caution! This permanently deletes tools.

### Link Tools to EVI Config

Specify your EVI config ID to auto-link tools:

```php
'config_id' => 'your-evi-config-id-here',
```

## 📊 Database Schema

```sql
CREATE TABLE hume_tool_mapping (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tool_name VARCHAR(255) NOT NULL UNIQUE,
    hume_tool_id VARCHAR(36) NOT NULL,
    hume_version INT DEFAULT 1,
    definition_hash VARCHAR(64) NOT NULL,
    last_synced TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## 🐛 Troubleshooting

### Connection Failed
- Verify Hume API key in `ai_config.php`
- Check internet connection
- Confirm API key has correct permissions

### Tools Not Syncing
- Check console log in admin UI
- Verify database migration ran successfully
- Check backend error logs

### Sync Errors
- Review error details in admin UI
- Check tool definition format
- Ensure unique tool names

## 🔐 Security Notes

- **API Key Storage**: Store in environment variables in production
- **Access Control**: Restrict admin UI to authorized users only
- **Rate Limiting**: Hume API may have rate limits
- **Database Security**: Secure database credentials

## 📈 Monitoring

### Check Sync Status

```bash
curl http://localhost/gpt/backend/api/v1/hume/tools/status
```

### Test Connection

```bash
curl http://localhost/gpt/backend/api/v1/hume/tools/test-connection
```

### Manual Sync

```bash
curl -X POST http://localhost/gpt/backend/api/v1/hume/tools/sync
```

## 🎨 Admin UI Features

1. **Connection Status** - Real-time API connectivity
2. **Statistics Dashboard** - Tool counts and sync status
3. **One-Click Sync** - Synchronize with single button
4. **Detailed Results** - See exactly what changed
5. **Tool Details** - View missing/orphaned tools
6. **Console Log** - Real-time operation logging

## 🔄 Workflow

### Initial Setup
1. Run migrations
2. Configure API key
3. Access admin UI
4. Sync all tools

### Regular Use
1. Add new function to backend
2. Open admin UI
3. Check status (see new tool missing)
4. Click sync
5. Tool automatically created in Hume

### Updating Tools
1. Modify function definition
2. Sync updates version in Hume
3. EVI uses latest version automatically

## ✅ Testing Checklist

- [ ] Database migration successful
- [ ] Hume API connection works
- [ ] Status check shows correct counts
- [ ] Sync creates new tools
- [ ] Sync updates existing tools
- [ ] Error handling works
- [ ] Admin UI loads properly
- [ ] Console logging functional

## 📞 Support

For issues:
1. Check admin UI console log
2. Review backend error logs
3. Verify API key and permissions
4. Check database connectivity

## 🎯 Next Steps

1. **Configure EVI**: Use synced tool IDs in Hume Portal
2. **Test Tool Calls**: Try voice commands that trigger functions
3. **Monitor Usage**: Track tool execution in logs
4. **Optimize**: Enable auto-sync if needed

---

**🎉 You're all set!** Your backend functions are now automatically synchronized with Hume EVI.
