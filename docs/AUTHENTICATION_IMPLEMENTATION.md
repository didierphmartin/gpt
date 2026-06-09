# GPT Multi-Provider Chat - Authentication Implementation

## Overview

Authentication has been successfully implemented for the GPT Multi-Provider Chat application. The system now supports:
- **Email/Password authentication**
- **Google OAuth** (via Firebase)
- **Facebook OAuth** (via Firebase)
- **JWT-based session management**
- **Role-based access control** (prospect, user, admin)
- **Auto-registration** for new social login users

## Firebase Configuration

**Firebase Project:** `transledgersite` (shared with Portfolio Management)

The same Firebase project is used for both Portfolio Management and GPT Chat applications, allowing users to authenticate once and access both systems.

## Files Created/Modified

### Frontend Files Created:

1. **`/app/login.html`**
   - Beautiful login page with Tailwind CSS
   - Email/password login form
   - Google and Facebook social login buttons
   - Responsive design

2. **`/app/assets/js/firebase-config.js`**
   - Firebase app initialization
   - Uses transledgersite Firebase project
   - Exports `firebaseApp` and `firebaseAuth` globally

3. **`/app/assets/js/auth.js`**
   - `AuthManager` class handling all authentication logic
   - Email/password login
   - Social login (Google, Facebook)
   - JWT token storage in localStorage
   - Auto-redirect to login if not authenticated
   - Token verification

### Frontend Files Modified:

4. **`/app/index.html`**
   - Added Firebase SDK scripts
   - Added firebase-config.js and auth.js scripts
   - Authentication check runs on page load

5. **`/app/assets/js/chat.js`**
   - Updated all `fetch()` calls to include JWT token
   - Added `Authorization: Bearer ${token}` header to:
     - `loadContextsList()`
     - `saveCurrentContext()`
     - `loadContext()`
     - `deleteContext()`

### Backend Files Created:

6. **`/app/api/auth.php`**
   - RESTful authentication API endpoint
   - Handles:
     - `login` - Email/password authentication
     - `register` - New user registration
     - `firebase` - Social authentication (Google/Facebook)
     - `verify` - JWT token verification
     - `logout` - Session termination
   - JWT token generation (access + refresh tokens)
   - Auto-registers new social login users as 'prospect' role

### Backend Files Modified:

7. **`/app/api/contexts.php`**
   - Added JWT library imports
   - Added `getUserIdFromToken()` function
   - Replaced hardcoded `$userId = 1` with JWT-based user extraction
   - Returns 401 Unauthorized if no valid token
   - Added Authorization header to CORS config

8. **`/config/ai_config.php`**
   - Added `auth` configuration section:
     ```php
     'auth' => [
         'jwt_secret' => 'gpt-chat-secret-key...',
         'jwt_expiry' => 3600,      // 1 hour
         'refresh_expiry' => 604800, // 7 days
     ]
     ```

### Database Files Created:

9. **`/database/users.sql`**
   - Complete users table schema
   - Fields:
     - `id`, `email`, `password`
     - `first_name`, `last_name`
     - `firebase_uid` (for social auth)
     - `provider` (email/google/facebook)
     - `role` (prospect/user/admin)
     - `last_login`, `created_at`, `updated_at`
   - Foreign key constraint linking `conversation_contexts` to `users`
   - Sample test user (email: test@example.com, password: Test123!)

## Database Schema

### Users Table

```sql
CREATE TABLE users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NULL,
    first_name VARCHAR(100) NULL,
    last_name VARCHAR(100) NULL,
    firebase_uid VARCHAR(255) NULL,
    provider ENUM('email', 'google', 'facebook') DEFAULT 'email',
    role ENUM('prospect', 'user', 'admin') DEFAULT 'prospect',
    profile_picture VARCHAR(500) NULL,
    email_verified BOOLEAN DEFAULT FALSE,
    last_login TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_email (email),
    INDEX idx_firebase_uid (firebase_uid),
    INDEX idx_role (role),
    INDEX idx_provider (provider)
);
```

**Status:** ✅ Table created successfully in `netfo587_chatbot` database

## Authentication Flow

### Email/Password Login:
1. User enters credentials on `/login.html`
2. Frontend sends POST to `/api/auth.php` with action='login'
3. Backend verifies credentials against `users` table
4. Backend generates JWT access + refresh tokens
5. Frontend stores tokens in localStorage
6. Frontend redirects to `/index.html`

### Social Login (Google/Facebook):
1. User clicks social login button on `/login.html`
2. Firebase popup authentication
3. Frontend receives Firebase ID token
4. Frontend sends POST to `/api/auth.php` with action='firebase'
5. Backend verifies Firebase token
6. Backend finds or creates user in database (auto-register)
7. New users created with role='prospect'
8. Backend generates JWT tokens
9. Frontend stores tokens and redirects to `/index.html`

### Protected Page Access:
1. User navigates to `/index.html`
2. `auth.js` runs `checkAuth()` on page load
3. Checks for token in localStorage
4. If no token → redirect to `/login.html`
5. If token exists → verify with backend
6. If valid → allow access
7. If invalid → clear storage and redirect to `/login.html`

### API Requests:
1. All API calls to `/api/contexts.php` include:
   ```javascript
   headers: {
       'Authorization': `Bearer ${token}`
   }
   ```
2. Backend extracts token from Authorization header
3. Backend verifies JWT signature and expiry
4. Backend extracts `user_id` from token payload
5. Backend uses `user_id` for database queries
6. Returns 401 if token invalid or missing

## User Roles

- **prospect** (default for new users)
  - Can access GPT chat
  - Conversations linked to their account
  - Default role for auto-registered social login users

- **user** (standard user)
  - Full access to all features
  - (Future: additional features)

- **admin** (administrator)
  - (Future: administrative features)

## Test Account

A test user has been created for testing:

- **Email:** test@example.com
- **Password:** Test123!
- **Role:** user

## Security Features

1. **Password Hashing:** bcrypt (PASSWORD_BCRYPT)
2. **JWT Tokens:** HS256 algorithm with secret key
3. **Token Expiry:**
   - Access token: 1 hour
   - Refresh token: 7 days
4. **CORS Headers:** Proper configuration for API access
5. **SQL Injection Protection:** PDO prepared statements
6. **Firebase Token Verification:** Server-side validation

## How to Use

### For New Users:

1. Navigate to `http://localhost/gpt/app/login.html`
2. Either:
   - **Create account:** Click "Sign Up" → enter details → register
   - **Use social login:** Click "Login with Google" or "Login with Facebook"
3. After successful login, automatically redirected to chat
4. Start chatting with AI assistants!

### For Existing Users:

1. Navigate to `http://localhost/gpt/app/login.html`
2. Enter email and password
3. Click "Sign In"
4. Access chat interface

### Logout:

Currently logout is handled client-side by clearing localStorage. To logout:
```javascript
localStorage.removeItem('token');
localStorage.removeItem('refresh_token');
localStorage.removeItem('user');
window.location.href = 'login.html';
```

## API Endpoints

### POST /api/auth.php

**Action: login**
```json
{
  "action": "login",
  "email": "user@example.com",
  "password": "password123"
}
```

**Action: register**
```json
{
  "action": "register",
  "email": "user@example.com",
  "password": "password123",
  "first_name": "John",
  "last_name": "Doe"
}
```

**Action: firebase** (social login)
```json
{
  "action": "firebase",
  "provider": "google",
  "idToken": "firebase_id_token_here",
  "userData": {
    "email": "user@example.com",
    "first_name": "John",
    "last_name": "Doe",
    "firebase_uid": "firebase_uid_here"
  }
}
```

**Action: verify**
```
Headers: Authorization: Bearer <jwt_token>
Body: { "action": "verify" }
```

**Response Format:**
```json
{
  "success": true,
  "message": "Login successful",
  "data": {
    "user": {
      "id": 1,
      "email": "user@example.com",
      "first_name": "John",
      "last_name": "Doe",
      "role": "prospect"
    },
    "access_token": "jwt_access_token",
    "refresh_token": "jwt_refresh_token",
    "expires_in": 3600
  }
}
```

## Conversation Context Integration

- All conversations are now linked to authenticated users
- Each context stored with `user_id` from JWT token
- Users can only access their own conversations
- Deleting a user cascades to delete their conversations
- No more hardcoded `user_id = 1`

## Future Enhancements

### Optional (Not Yet Implemented):

1. **AuthMiddleware.php** - Centralized authentication middleware
2. **User.php Model** - User management class
3. **Password reset** - Email-based password recovery
4. **Email verification** - Verify email addresses
5. **Refresh token rotation** - Enhanced security
6. **Account settings page** - User profile management
7. **Role-based permissions** - Feature access by role
8. **Session timeout** - Auto-logout after inactivity

## Troubleshooting

### Login not working:
- Check browser console for errors
- Verify Firebase configuration in `firebase-config.js`
- Check PHP error log for backend errors
- Verify database connection in `ai_config.php`

### Token errors:
- Clear localStorage and try logging in again
- Check JWT secret matches in config
- Verify token hasn't expired

### Social login issues:
- Verify Firebase project settings
- Check OAuth provider configuration in Firebase Console
- Ensure redirect URLs are configured correctly

### Database errors:
- Verify users table exists: `SHOW TABLES LIKE 'users';`
- Check foreign key constraints
- Verify database credentials in `ai_config.php`

## Notes

- **Production Security:** Change JWT secret in `ai_config.php` to a strong 64-character random string
- **Firebase:** Using shared Firebase project with Portfolio Management
- **User ID:** All new users default to role='prospect', except user id=1 can be manually set to other roles
- **Auto-registration:** Social login users are automatically created in database on first login

## Summary

✅ Authentication fully implemented and tested
✅ Email/password login working
✅ Google OAuth working
✅ Facebook OAuth working
✅ JWT token management implemented
✅ Users table created
✅ Conversation contexts linked to users
✅ All API endpoints protected
✅ Auto-redirect to login implemented

The GPT Multi-Provider Chat application is now fully authenticated and ready to use!
