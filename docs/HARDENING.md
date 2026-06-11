# Hardening TODO

Known security hardening items, tracked so they aren't forgotten.

## 1. Move frontend voice keys to backend brokering (browser exposure)

**Status:** open · **Priority:** medium

The voice prompt-builder ships **real provider keys to the browser** in
`frontend/assets/js/config.js` (and `frontend/voice/config.json`):

- `grok.apiKey` (xAI / `xai-…`) — voice realtime
- `gemini.apiKey` (Google / `AIza…`) — voice realtime
- `hume.apiKey` — EVI

These files are **gitignored** (not in the repo), but the keys are still loaded as
client-side `<script>` and are readable by anyone who opens the page in DevTools.

**Target state:** keep these keys **only server-side** — in the DB and/or `backend/.env`
— and have the frontend obtain what it needs from the **backend** (a short-lived token
or a server-side proxy), the same way the **LLM chat keys** already live only in the DB
(`system_llm_settings` / `user_api_keys`). The backend already holds
`GROK_VOICE_API_KEY` / `GEMINI_VOICE_API_KEY` / `HUME_API_KEY` in `backend/.env`.

If the voice keys are the **same** accounts as the chat keys, the frontend can just read
them from the DB via the backend; if **different**, store the voice keys in the DB/`.env`
and broker them the same way.

Reference pattern: the `learn_language` app brokers its Gemini voice key through its
backend instead of embedding it in the client.

## 2. Rotate previously-exposed keys

All keys that were in plaintext config on disk (and, for the LLM chat keys, briefly in
local — never pushed — commits via a seed file) should be rotated: OpenAI, Anthropic,
xAI/Grok, Gemini, DeepSeek, Kimi, SerpAPI, ScrapingDog, Brave, FMP, Hume, the DB
passwords, `jwt_secret`, and `app_key_secret`.
