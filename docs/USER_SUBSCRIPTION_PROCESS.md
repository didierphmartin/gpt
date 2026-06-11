# User Subscription Process

Complete documentation of the user registration, subscription, billing, authentication, and access control flow for Synergy AI Chat.

**Last updated:** April 2026

---

## Table of Contents

| # | Section | Description |
|---|---------|-------------|
| 1 | [Overview](#1-overview) | High-level flow and architecture |
| 2 | [Plan Selection](#2-plan-selection) | Pricing plans and selection logic |
| 3 | [Payment Processing](#3-payment-processing) | Stripe and PayPal integration via Ledger API |
| 4 | [Ledger Account Gate](#4-ledger-account-gate) | How the Ledger account controls access |
| 5 | [Account Registration](#5-account-registration) | Email/password and social auth registration |
| 6 | [Authentication Methods](#6-authentication-methods) | All supported login methods |
| 7 | [Free Trial Quota](#7-free-trial-quota) | Token quota enforcement for free users |
| 8 | [Plan Upgrade Flow](#8-plan-upgrade-flow) | Upgrading from free to paid |
| 9 | [JWT Token Management](#9-jwt-token-management) | Token generation, storage, and validation |
| 10 | [Database Storage](#10-database-storage) | What gets stored for each user and when |
| 11 | [Ledger System Integration](#11-ledger-system-integration) | Financial accounts and transactions |
| 12 | [Data Flow Diagrams](#12-data-flow-diagrams) | Visual flow of data through the system |
| 13 | [Security Assessment](#13-security-assessment) | Implemented measures and known gaps |
| 14 | [Configuration Reference](#14-configuration-reference) | Keys, secrets, and settings |

---

## 1. Overview

### Core Principle

**No Ledger account = No access.** Every user who can log in must have a corresponding account in the Ledger system. This is the proof that the user went through the official registration funnel (free trial or paid plan). Direct API registration without a Ledger account is rejected.

### Registration Flow

```
User visits register.html
         |
    Select Plan
         |
    ┌────┴────────────────────────────┐
    Free ($0)                    Paid ($9.95 or $19.95)
    |                                 |
    |                            payment.html
    |                            (Stripe or PayPal)
    |                                 |
    |                            Ledger: create account
    |                            Ledger: record transaction
    |                                 |
    ├─────────────── ←────────────────┘
    |
    Fill registration form
    |
    ┌────┴────────────────────────────┐
    Email/Password               Google/Facebook
    |                                 |
    Ledger: create account       Ledger: create account
    (if free, created now)       (if free, created now)
    Ledger: $0 trial txn         Ledger: $0 trial txn
    |                                 |
    POST /api/v1/auth            POST /api/v1/auth
    {action: register,           {action: firebase,
     ledger_user_id: uuid,        ledger_user_id: uuid,
     plan: free|standard|...}     plan: free|standard|...}
    |                                 |
    User row created             User row created
    with ledger_user_id          with ledger_user_id
    |                                 |
    Redirect to login            Direct to app
```

### Architecture

| Service | Database | Purpose |
|---------|----------|---------|
| **GPT Backend** | `netfo587_chatbot` | User accounts, chat, agents, usage tracking |
| **Ledger Service** | `netfo587_ledger` | Financial accounts, payment transactions |
| **Firebase** | Google Cloud | OAuth (Google, Facebook), phone SMS, reCAPTCHA |

---

## 2. Plan Selection

### Plans

| Plan | Price | Ledger Plan ID | Token Quota | Features |
|------|-------|----------------|-------------|----------|
| Free Trial | $0 | `synergy_free` | 50,000 lifetime | Multi-provider chat, limited messages, basic tools |
| Standard | $9.95/mo | `synergy_standard` | Unlimited | Unlimited messages, own API keys, voice assistant, web search |
| Premium | $19.95/mo | `synergy_premium` | Unlimited | Agent teams, workflows, MCP servers, file storage, priority support |

### Selection Logic (`register.html`)

- **Free plan:** Shows registration form directly. Ledger account created at form submit time.
- **Paid plans:** Stores plan in `localStorage['selectedPlan']`, redirects to `payment.html`.
- **Returning from payment:** Detects `payment.status === 'success'` in localStorage, shows registration form with email pre-filled.

---

## 3. Payment Processing

### Ledger API Configuration

```javascript
const LEDGER_BASE = '/LandingPage/Ledger/api/v1';
const LEDGER_API_KEY = 'test_api_key_1';
const APPLICATION = 'SynergyAiChat';
```

All API calls include `application: 'SynergyAiChat'` to scope accounts and transactions.

### Stripe Flow

1. Create PaymentIntent: `POST /LandingPage/Ledger/api/v1/payment-intent/create`
2. User enters card via Stripe Payment Element
3. `stripe.confirmPayment()` processes payment
4. Create/fetch Ledger account: `POST /account` or `GET /account/by-email/{email}`
5. Record transaction: `POST /transactions` with `provider: 'stripe'`, `status: 'completed'`
6. Store payment details in `localStorage['selectedPlan'].payment`
7. Redirect to `register.html`

### PayPal Flow

Same post-payment logic as Stripe. PayPal SDK handles the payment UI, then same Ledger API calls with `provider: 'paypal'`.

### Free Trial "Payment"

No payment page. At registration time, `register.html` calls:

1. `POST /account` — Create Ledger account with `application: 'SynergyAiChat'`
2. `POST /transactions` — Record a $0 transaction with `provider: 'free_trial'`, `service_type: 'deposit'`

This creates the Ledger account that serves as proof of legitimate registration.

---

## 4. Ledger Account Gate

### How It Works

The `users` table has two new columns:

| Column | Type | Purpose |
|--------|------|---------|
| `ledger_user_id` | VARCHAR(36) | UUID from the Ledger system. NULL = not activated. |
| `plan` | VARCHAR(20) | `free`, `standard`, or `premium` |

### Enforcement Points

**At registration (`AuthController::register()`):**
- `ledger_user_id` is **required**. Registration without it returns 400: `LEDGER_ACCOUNT_REQUIRED`
- The `plan` field is stored in the user record

**At login (all methods — email, Firebase, WebAuthn):**
- After credential verification, check: `is ledger_user_id NULL?`
- If NULL → 403: `ACCOUNT_NOT_ACTIVATED` — "Please register through synergyaichat.com"
- If present → login proceeds normally

**At chat time (`ChatController::chat()`):**
- Before processing any message, check user's plan
- If `plan = 'free'` → check token quota (see section 7)
- If paid → proceed without quota check

### What This Prevents

| Attack | Result |
|--------|--------|
| Direct API call to register endpoint | Rejected: no `ledger_user_id` provided |
| Old user without Ledger account tries to login | Rejected: `ledger_user_id` is NULL |
| Bypassing payment for paid features | User has `plan: 'free'`, quota applies |

---

## 5. Account Registration

### Email/Password

**Endpoint:** `POST /api/v1/auth` with `action: 'register'`

**Request body:**
```json
{
    "action": "register",
    "email": "user@example.com",
    "password": "password123",
    "first_name": "John",
    "last_name": "Doe",
    "ledger_user_id": "550e8400-e29b-41d4-a716-446655440000",
    "plan": "free"
}
```

**Backend processing:**
1. Validate email format (`filter_var`)
2. Reject if `ledger_user_id` is empty
3. Validate `plan` is one of: `free`, `standard`, `premium`
4. Check duplicate email
5. Hash password (bcrypt)
6. Insert user with `ledger_user_id` and `plan`
7. Generate JWT tokens

### Social Auth (Google/Facebook)

**Endpoint:** `POST /api/v1/auth` with `action: 'firebase'`

**For new users:** `ledger_user_id` is required (passed via `userData` or request body). If missing → 400 error.

**For existing users:** `ledger_user_id` is checked on the existing user record. If NULL → 403 error.

---

## 6. Authentication Methods

| Method | Registration | Login | Ledger Check |
|--------|-------------|-------|--------------|
| Email/password | Yes | Yes | At both registration and login |
| Google OAuth | Yes | Yes | At both registration and login |
| Facebook OAuth | Yes | Yes | At both registration and login |
| Phone (SMS) | No (link only) | Yes | At login (on existing user record) |
| Biometric (WebAuthn) | No (setup only) | Yes | At login (on existing user record) |

Phone and biometric are login-only methods that require an existing activated account.

The biometric login button is **hidden** on the login page unless the user has previously registered a biometric credential (stored as `webauthn_credential_id` in localStorage).

---

## 7. Free Trial Quota

### Quota Details

- **Quota:** 50,000 tokens (lifetime total across all providers)
- **Scope:** Sum of `total_tokens` across all rows in `llm_usage_balance` for the user
- **Reset:** Never — this is a lifetime quota, not monthly
- **Applies to:** Users with `plan = 'free'` only

### Enforcement (`ChatController::checkFreeTrialQuota()`)

```
Chat request arrives
       |
   Look up user's plan from users table
       |
   ┌───┴───┐
   Paid    Free
   |       |
   Proceed Query SUM(total_tokens) from llm_usage_balance
           |
       ┌───┴───────┐
       Under 50k   Over 50k
       |           |
       Proceed     Return 403 QUOTA_EXCEEDED
                   {
                     "code": "QUOTA_EXCEEDED",
                     "usage": { "total_tokens": 52341, "quota": 50000 }
                   }
```

### Frontend Handling (`chat.js`)

When the chat endpoint returns 403 with `code: QUOTA_EXCEEDED`:
- The assistant message bubble shows: "Free trial quota reached" with usage stats
- An **"Upgrade to Standard"** button is displayed inline
- Clicking it stores the Standard plan in localStorage and navigates to `payment.html`

---

## 8. Plan Upgrade Flow

### From Free to Paid

```
User hits quota limit in chat
       |
   Clicks "Upgrade" button
       |
   payment.html loads
   (detects user is already logged in via localStorage token)
       |
   User pays via Stripe/PayPal
       |
   Ledger: find existing account by email
   Ledger: record new transaction (deposit, $9.95 or $19.95)
       |
   POST /api/v1/auth/upgrade-plan
   { "plan": "standard" }
       |
   users.plan updated to 'standard'
   localStorage user cache updated
       |
   Redirect back to app (index.html)
   Quota check no longer applies
```

### Upgrade Endpoint

**Endpoint:** `POST /api/v1/auth/upgrade-plan` (protected, requires JWT)

**Request:**
```json
{ "plan": "standard" }
```

**Validation:** Plan must be `standard` or `premium`.

**Response:**
```json
{
    "success": true,
    "message": "Plan upgraded to standard",
    "plan": "standard"
}
```

---

## 9. JWT Token Management

### Token Structure

**Access Token** (8-hour expiry):
```json
{ "iss": "gpt-chat", "iat": 1712580000, "exp": 1712608800, "sub": 123, "type": "access" }
```

**Refresh Token** (7-day expiry):
```json
{ "iss": "gpt-chat", "iat": 1712580000, "exp": 1713184800, "sub": 123, "type": "refresh" }
```

### Client-Side Storage (localStorage)

| Key | Value | Purpose |
|-----|-------|---------|
| `token` | JWT access token | `Authorization: Bearer` header on API calls |
| `refresh_token` | JWT refresh token | Token renewal |
| `user` | JSON user profile (includes `plan`) | UI display, plan checks |
| `webauthn_credential_id` | Base64URL string | Biometric login reference |

### User Object (includes plan)

```json
{
    "id": 123,
    "email": "user@example.com",
    "first_name": "John",
    "last_name": "Doe",
    "role": "prospect",
    "plan": "standard",
    "provider": "email",
    "last_login": "2026-04-08 14:30:00",
    "created_at": "2026-04-08 14:30:00"
}
```

---

## 10. Database Storage

### `users` Table — Key Columns

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `id` | INT AUTO_INCREMENT | — | Primary key |
| `email` | VARCHAR(255) UNIQUE | — | User email |
| `password` | VARCHAR(255) | NULL | Bcrypt hash (NULL for social auth) |
| `first_name` | VARCHAR(100) | — | First name |
| `last_name` | VARCHAR(100) | — | Last name |
| `role` | VARCHAR(50) | `prospect` | User role |
| `ledger_user_id` | VARCHAR(36) | NULL | **Ledger account UUID — required for access** |
| `plan` | VARCHAR(20) | `free` | **Current plan: free, standard, premium** |
| `provider` | VARCHAR(100) | `email` | Auth provider |
| `firebase_uid` | VARCHAR(255) | NULL | Firebase unique ID |
| `phone` | VARCHAR(20) | NULL | Linked phone number |
| `last_login` | DATETIME | NULL | Last login timestamp |
| `created_at` | TIMESTAMP | NOW() | Account creation |
| `updated_at` | TIMESTAMP | NOW() | Last update |

### Tables Created On First Use

| Table | Created When | Purpose |
|-------|-------------|---------|
| `llm_usage_balance` | First chat message | Running totals per user/provider — **used for quota check** |
| `llm_usage_transactions` | First chat message | Detailed log of every LLM call |
| `user_api_keys` | User saves custom key | Encrypted API keys (AES-256-CBC) |
| `user_model_selections` | User selects a model | Model preference per provider |
| `user_provider_settings` | User opens Settings | Voice/avatar provider config |

### Ledger System (Separate Database)

| Table | Key Fields | Purpose |
|-------|-----------|---------|
| `account` | `user_id` (UUID), `email`, `application`, `balance_*`, `status` | Financial account per user |
| `transactions` | `transaction_id` (UUID), `user_id`, `amount`, `provider`, `application`, `status` | Payment history |

**Relationship:** GPT `users.ledger_user_id` → Ledger `account.user_id`. Different databases, different ID types (INT vs UUID), linked by this reference.

---

## 11. Ledger System Integration

### Two User ID Systems

| System | User ID | Example | Database |
|--------|---------|---------|----------|
| GPT Application | INT (auto-increment) | `123` | `netfo587_chatbot` |
| Ledger Service | UUID | `550e8400-e29b-...` | `netfo587_ledger` |

The `users.ledger_user_id` column bridges the two systems. The only other common field is `email`.

### Ledger API Endpoints Used

| Endpoint | When | Purpose |
|----------|------|---------|
| `POST /account` | Registration (all plans) | Create Ledger account |
| `GET /account/by-email/{email}` | If account exists | Fetch existing account |
| `POST /transactions` | After payment or free signup | Record payment/trial transaction |
| `POST /payment-intent/create` | Paid plans only | Create Stripe PaymentIntent |

### Transaction Types

| Plan | Amount | Provider | Service Type |
|------|--------|----------|-------------|
| Free trial | $0.00 | `free_trial` | `deposit` |
| Standard (Stripe) | $9.95 | `stripe` | `deposit` |
| Standard (PayPal) | $9.95 | `paypal` | `deposit` |
| Premium (Stripe) | $19.95 | `stripe` | `deposit` |
| Premium (PayPal) | $19.95 | `paypal` | `deposit` |
| Upgrade (Stripe) | $9.95/$19.95 | `stripe` | `deposit` |

---

## 12. Data Flow Diagrams

### Access Control Chain

```
┌─────────────────────────────────────────────────────┐
│                   REGISTRATION                       │
│                                                      │
│  Plan selection → Payment (if paid) → Ledger account │
│       │                                    │         │
│       └── ledger_user_id ──────────────────┘         │
│                    │                                  │
│                    ▼                                  │
│            users table row                            │
│            ledger_user_id = UUID                      │
│            plan = free|standard|premium               │
└─────────────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────┐
│                     LOGIN                            │
│                                                      │
│  Credentials OK? ─── No ──> 401 Invalid credentials │
│       │                                              │
│      Yes                                             │
│       │                                              │
│  ledger_user_id NULL? ─── Yes ──> 403 Not activated │
│       │                                              │
│      No (has value)                                  │
│       │                                              │
│  Issue JWT tokens, return user data with plan        │
└─────────────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────┐
│                   CHAT REQUEST                       │
│                                                      │
│  JWT valid? ─── No ──> 401 Unauthorized              │
│       │                                              │
│      Yes                                             │
│       │                                              │
│  plan = 'free'? ─── No (paid) ──> Process normally  │
│       │                                              │
│      Yes                                             │
│       │                                              │
│  total_tokens >= 50,000? ─── No ──> Process normally│
│       │                                              │
│      Yes                                             │
│       │                                              │
│  403 QUOTA_EXCEEDED                                  │
│  "Upgrade to continue"                               │
└─────────────────────────────────────────────────────┘
```

---

## 13. Security Assessment

### Implemented Measures

| Measure | Implementation |
|---------|---------------|
| **Ledger account gate** | Registration requires `ledger_user_id`; login verifies it exists |
| **Password hashing** | bcrypt via `PASSWORD_BCRYPT` (auto-salted) |
| **JWT signatures** | HS256 (HMAC SHA-256) with configurable secret |
| **Token expiry** | 8h access, 7d refresh |
| **Free trial quota** | 50k token lifetime limit enforced server-side |
| **Firebase OAuth** | Google/Facebook via Firebase SDK |
| **Phone reCAPTCHA** | Invisible reCAPTCHA for SMS abuse prevention |
| **WebAuthn** | W3C standard, platform authenticator, user verification required |
| **API key encryption** | AES-256-CBC for stored user API keys |
| **Plan validation** | Server-side whitelist: `free`, `standard`, `premium` |

### Known Security Gaps

| Gap | Severity | Description |
|-----|----------|-------------|
| Firebase ID token not verified on backend | High | Backend trusts frontend Firebase verification |
| WebAuthn signature verification not implemented | High | TODO in code — only checks data is present |
| No password complexity requirements | Medium | Backend has no password rules beyond non-empty |
| No email verification | Medium | Accounts active immediately without confirming email |
| No rate limiting on auth endpoints | Medium | Brute-force login possible |
| Hardcoded Ledger API key in frontend JS | Medium | `test_api_key_1` visible in source |
| JWT secret in config file | Medium | Should be in environment variable |
| localStorage for token storage | Low-Medium | Vulnerable to XSS |
| No refresh token rotation | Low | Compromised refresh token valid for 7 days |

---

## 14. Configuration Reference

### JWT Settings (`backend/config/ai_config.php`)

```php
'auth' => [
    'jwt_secret'     => 'gpt-chat-secret-key-change-in-production-...',
    'jwt_expiry'     => 28800,      // 8 hours
    'refresh_expiry' => 604800,     // 7 days
]
```

### Free Trial Quota (`AuthController.php`)

```php
private const FREE_TRIAL_TOKEN_QUOTA = 50000;
```

### Payment Settings (`frontend/payment.html`)

| Provider | Key Type | Value |
|----------|----------|-------|
| Stripe | Publishable (test) | `pk_test_51SUAsZ...` |
| PayPal | Client ID | `AYPs3ba-zrxh...` |
| Ledger API | API Key | `test_api_key_1` |

### Ledger API

```
Base URL: /LandingPage/Ledger/api/v1
Application: SynergyAiChat
```

### SQL for `users` Table Columns

```sql
ALTER TABLE users ADD COLUMN ledger_user_id VARCHAR(36) DEFAULT NULL AFTER role;
ALTER TABLE users ADD COLUMN plan VARCHAR(20) DEFAULT 'free' AFTER ledger_user_id;
ALTER TABLE users ADD INDEX idx_ledger_user_id (ledger_user_id);
```

---

## Files Reference

| File | Purpose |
|------|---------|
| `frontend/register.html` | Plan selection + registration form + Ledger account creation |
| `frontend/payment.html` | Stripe/PayPal payment + upgrade flow |
| `frontend/login.html` | Login form (all methods) |
| `frontend/assets/js/auth.js` | AuthManager (token storage, biometric visibility) |
| `frontend/assets/js/chat.js` | Quota exceeded handling + upgrade prompt |
| `backend/src/Controllers/AuthController.php` | Register (with ledger gate), login (with ledger check), upgrade plan |
| `backend/src/Controllers/ChatController.php` | Free trial quota check before chat |
| `backend/src/Controllers/WebAuthnController.php` | Biometric login (with ledger check) |
| `backend/src/routes.php` | Route: `POST /api/v1/auth/upgrade-plan` |
| `backend/config/ai_config.php` | JWT secret, expiry settings |
