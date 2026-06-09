# Google Drive Integration - Implementation Plan

## Current Status: ❌ NOT IMPLEMENTED

**Last Updated:** 2025-11-26

---

## What I Learned from Portfolio Management Implementation

### Working Code Location
The Portfolio Management project has a **fully functional** Google Drive integration:
- **Service Class:** `/quantis/backend/portfolio-service/src/Services/GoogleDriveService.php`
- **Usage Example:** `/quantis/backend/portfolio-service/src/Services/AssetDocumentsService.php` (lines 112-139)
- **Controller:** `/quantis/backend/portfolio-service/src/Controllers/GoogleDriveController.php`

### How It Works (Portfolio Management)

#### 1. User Authorization Flow
```
User → Settings → Connect Google Drive → OAuth Popup → Authorization Code → Access Token → Stored in DB
```

#### 2. Saving Documents
```php
// Check if user authorized Google Drive
if (!$this->googleDriveService->isUserAuthorized($userId)) {
    throw new Exception("User must authorize Google Drive access");
}

// Generate filename
$fileName = "XLM_Analysis_2025-11-26_203015.md";

// Upload to Google Drive
$fileData = $this->googleDriveService->uploadFile($userId, $fileName, $content);

// Returns: file_id, file_name, web_view_link
```

#### 3. Key Components

**GoogleDriveService Methods:**
- `getAuthorizationUrl($userId)` - Generates OAuth URL
- `exchangeCodeForToken($code)` - Exchanges auth code for tokens
- `storeUserTokens($userId, $tokens)` - Saves tokens to database
- `getValidAccessToken($userId)` - Retrieves/refreshes token from DB
- `uploadFile($userId, $fileName, $content, $folderId)` - Uploads file to Drive
- `getOrCreateFolder($accessToken, $folderName)` - Creates/finds folder
- `isUserAuthorized($userId)` - Checks if user has valid tokens

**Database Table:** `google_drive_tokens`
```sql
- user_id (INT)
- access_token (TEXT)
- refresh_token (TEXT)
- expires_at (DATETIME)
- created_at (TIMESTAMP)
- updated_at (TIMESTAMP)
```

**Configuration Required:**
```php
'google_drive' => [
    'enabled' => true,
    'client_id' => 'xxx.apps.googleusercontent.com',
    'client_secret' => 'xxx',
    'redirect_uri' => 'http://localhost/callback',
    'scopes' => [
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/drive.metadata.readonly'
    ],
    'auth_endpoint' => 'https://accounts.google.com/o/oauth2/v2/auth',
    'token_endpoint' => 'https://oauth2.googleapis.com/token',
    'api_endpoint' => 'https://www.googleapis.com/drive/v3',
    'folder_name' => 'Portfolio Management Documents',
    'file_format' => 'text/markdown'
]
```

---

## What Needs to Be Done for GPT Project

### Phase 1: Database & User Management (NOT STARTED)

#### 1.1 Database Setup
- [ ] Create database for GPT project (or use existing Portfolio database)
- [ ] Create `users` table with authentication fields
- [ ] Create `google_drive_tokens` table (same structure as Portfolio)
- [ ] Add database connection to GPT project config

#### 1.2 User Authentication System
- [ ] Implement login/registration pages
- [ ] Add session management
- [ ] Create authentication middleware
- [ ] Store user sessions (use PHP sessions or JWT)

**Estimated Time:** 4-6 hours

---

### Phase 2: Google Drive Service Integration (NOT STARTED)

#### 2.1 Copy & Adapt GoogleDriveService
- [ ] Copy `GoogleDriveService.php` to `/gpt/src/Services/`
- [ ] Update namespace for GPT project
- [ ] Ensure Guzzle HTTP client is available (check composer.json)

#### 2.2 Google OAuth Setup
- [ ] Create Google Cloud Project (or reuse existing)
- [ ] Enable Google Drive API
- [ ] Create OAuth 2.0 credentials
- [ ] Add authorized redirect URI: `http://localhost/gpt/app/api/google-drive-callback.php`
- [ ] Get Client ID and Client Secret

#### 2.3 Configuration
- [ ] Add Google Drive config to `/gpt/config/ai_config.php`:
```php
'google_drive' => [
    'enabled' => true,
    'client_id' => 'YOUR_CLIENT_ID',
    'client_secret' => 'YOUR_CLIENT_SECRET',
    'redirect_uri' => 'http://localhost/gpt/app/api/google-drive-callback.php',
    'scopes' => [
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/drive.metadata.readonly'
    ],
    'auth_endpoint' => 'https://accounts.google.com/o/oauth2/v2/auth',
    'token_endpoint' => 'https://oauth2.googleapis.com/token',
    'api_endpoint' => 'https://www.googleapis.com/drive/v3',
    'folder_name' => 'Gpt-Research',  // ← Target folder name
    'file_format' => 'text/markdown'
]
```

**Estimated Time:** 2-3 hours

---

### Phase 3: Backend API Endpoints (NOT STARTED)

#### 3.1 Google Drive Controller
Create `/gpt/app/api/google-drive-controller.php`:
- [ ] `authorize` - Start OAuth flow
- [ ] `callback` - Handle OAuth callback
- [ ] `status` - Check if user is authorized
- [ ] `disconnect` - Revoke authorization

#### 3.2 Save to Drive Endpoint
Update `/gpt/app/api/save-to-drive.php`:
- [ ] Remove local file storage code
- [ ] Initialize GoogleDriveService
- [ ] Check user authorization
- [ ] Upload file with proper naming: `GPT_Research_{Provider}_{Timestamp}_{Prompt}.md`
- [ ] Return Google Drive file link

**File Format Example:**
```markdown
# GPT Research Response

**Provider:** Claude
**Date:** 2025-11-26 20:30:15

## Prompt

What is the capital of France?

## Response

The capital of France is Paris.
```

**Estimated Time:** 2-3 hours

---

### Phase 4: Frontend Updates (IN PROGRESS)

#### 4.1 Settings Page (NEW)
- [ ] Create settings/authorization page
- [ ] Add "Connect Google Drive" button
- [ ] Show authorization status
- [ ] Display connected Google account
- [ ] Add "Disconnect" option

#### 4.2 Chat Interface (PARTIALLY DONE)
- [x] ~~Add save icon (☁️) above print icon~~ (DONE)
- [x] ~~Add light blue background for icon area~~ (DONE)
- [ ] Show temporary dialog when clicked (until full implementation)
- [ ] Update dialog to call actual backend when ready
- [ ] Show success notification with Google Drive link
- [ ] Handle authorization errors gracefully

**Estimated Time:** 3-4 hours

---

## Current Frontend Implementation

### What's Already Done ✅
1. **Save icon added** to blue ribbon (☁️ above 🖨️)
2. **Light blue background** for icon container
3. **Handler function** `saveToGoogleDrive()` in `chat.js`
4. **Notification system** for success/error messages

### What Needs Updating ⚠️
- Handler currently calls `/gpt/app/api/save-to-drive.php` which:
  - ❌ Only saves files locally
  - ❌ Returns fake Google Drive links
  - ❌ Doesn't check user authorization
  - ❌ Doesn't use real Google Drive API

---

## Alternative Approach: Shared Backend

Instead of duplicating everything, we could:

1. **Share Portfolio Management Backend**
   - GPT frontend calls Portfolio Management API endpoints
   - Reuse existing GoogleDriveService, database, OAuth tokens
   - No code duplication
   - Users authorize once for both apps

2. **Requirements:**
   - Portfolio Management backend must be running
   - CORS configuration to allow GPT frontend requests
   - Shared user accounts or user mapping

**Pros:**
- Faster implementation (2-3 hours instead of 10-15 hours)
- No duplicate OAuth setup
- Single authorization for both apps
- Less code to maintain

**Cons:**
- GPT depends on Portfolio Management backend
- Requires Portfolio backend to be running
- More complex deployment

---

## Recommended Next Steps

### Immediate (Today):
1. ✅ Document what was learned (THIS FILE)
2. ⏳ Show temporary dialog when save icon clicked
3. ⏳ Remove local file storage code from backend

### Short Term (This Week):
- **Decision:** Choose implementation approach (standalone vs shared backend)
- If standalone: Begin Phase 1 (Database & User Management)
- If shared: Configure CORS and test API calls

### Long Term:
- Complete all phases based on chosen approach
- Test end-to-end with real Google Drive
- Deploy to production with proper OAuth credentials

---

## Files Modified So Far

### Frontend:
- `/gpt/app/assets/js/chat.js`
  - Added `saveToGoogleDrive()` method (lines 715-793)
  - Added `showNotification()` method (lines 795-815)
  - Updated `addMessage()` to include save button (lines 447-479)

### Backend:
- `/gpt/app/api/save-to-drive.php` (❌ NEEDS REPLACEMENT)
  - Currently saves files locally
  - Should use GoogleDriveService instead

---

## Notes & Lessons Learned

1. **Always check existing implementations first** before writing new code
2. **Google Drive requires OAuth** - cannot bypass user authorization
3. **Tokens must be stored per-user** in database with refresh capability
4. **Folder management** - API creates folder if it doesn't exist
5. **File format** - Uses multipart upload to Google Drive API
6. **Error handling** - Must check authorization before attempting upload

---

## Questions to Resolve

1. Should GPT have its own database or share Portfolio's database?
2. Should GPT reuse Portfolio's Google OAuth app or create a new one?
3. Where should user settings/authorization page be added in GPT UI?
4. Should we implement full user authentication or use simpler approach?

---

**Status:** Documentation complete, awaiting decision on implementation approach.
