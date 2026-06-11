# Voice Dictation Mic Button — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A mic button left of Send that, on toggle, dictates the user's speech (via the Grok/Gemini realtime adapter selected in Settings → Account) live into `#user-input`, with no AI audio reply.

**Architecture:** A new `VoiceDictation` controller (`voice-dictation.js`) mirrors `voice-panel.js::connect()` — reusing `window.AudioStreamer` for mic capture and the existing per-provider adapter — but routes the **user input transcript** into `#user-input` and **never plays `onAudio`** (so the AI doesn't speak). A pure `nextInputState` helper does the interim/commit text math. The provider lives in Settings → Account (`localStorage['voiceDictationProvider']`, default `grok`).

**Tech Stack:** vanilla JS; reuses `window.AudioStreamer`, `window.GrokLiveClient`, `window.GeminiRealtimeAdapter`, `window.APP_CONFIG[provider]`. **No frontend unit runner** — the pure helper is node-tested (UMD export); everything else is `node --check` + Playwright/manual.

**Spec:** `docs/superpowers/specs/2026-06-10-voice-dictation-design.md`
**Repo:** `/Applications/XAMPP/xamppfiles/htdocs/gpt` · **Branch:** create `feat/voice-dictation` off `initial-import`.

---

## Reference facts (verified)

- Input: `<textarea id="user-input">`; Send: `<button id="send-btn">` (index.html ~3691/3703). Mic button goes **before** `#send-btn`.
- `voice-panel.js::connect()` (536–630): `new window.AudioStreamer({ onAudioData: b64 => voiceClient.sendAudio(b64) })`, then `audioStreamer.startCapture()` after `onSetupComplete`; `onAudio: b64 => audioStreamer.playAudio(b64)` (AI reply — dictation OMITS this); `onInputTranscription(text, isFinal)` = user transcript. Provider config: `window.APP_CONFIG[provider]` (needs `.apiKey`). Provider stored by the panel under `localStorage['app-voice-provider']` (separate from ours).
- **Grok** (`grok-live-client.js`): `new window.GrokLiveClient(config)` with callbacks in `config` (`onInputTranscription(text, isFinal)`, `onAudio`, `onOpen`, `onSetupComplete`, `onError`, `onClose`); `await connect()`.
- **Gemini** (`gemini-realtime-adapter.js`): `new window.GeminiRealtimeAdapter(config)`; callbacks are **properties** (`adapter.onTranscript = (text, isFinal, dir) => {}` where `dir==='in'` is the user); `await connect()`.
- Settings Account tab wiring: `settings-panel.js::setupAccountListeners()` (~1075).

---

## Task 1: `nextInputState` pure helper (node-tested)

**Files:** Create `frontend/assets/js/voice-dictation.js`; Create `frontend/assets/js/__tests__/voice-dictation.test.js`.

- [ ] **Step 1: Write the failing test** — `frontend/assets/js/__tests__/voice-dictation.test.js`:

```javascript
const assert = require('assert');
const { nextInputState } = require('../voice-dictation.js');

// interim: value = base + transcript; base unchanged
let r = nextInputState('Hello ', 'world', false);
assert.strictEqual(r.value, 'Hello world');
assert.strictEqual(r.base, 'Hello ');

// final: commits — base grows by transcript + a trailing space
r = nextInputState('Hello ', 'world', true);
assert.strictEqual(r.value, 'Hello world');
assert.strictEqual(r.base, 'Hello world ');

// empty base (fresh input)
r = nextInputState('', 'hi there', false);
assert.strictEqual(r.value, 'hi there');
assert.strictEqual(r.base, '');

// empty transcript final → no spurious trailing space, base unchanged
r = nextInputState('Hello ', '', true);
assert.strictEqual(r.value, 'Hello ');
assert.strictEqual(r.base, 'Hello ');

console.log('nextInputState: ALL PASS');
```

- [ ] **Step 2: Run it — expect FAIL** (module not found / not a function):
`cd /Applications/XAMPP/xamppfiles/htdocs/gpt && node frontend/assets/js/__tests__/voice-dictation.test.js`
Expected: throws (cannot find module / `nextInputState` undefined).

- [ ] **Step 3: Create `voice-dictation.js` with the helper + UMD export:**

```javascript
/**
 * Voice dictation: a mic button that streams the user's speech (via the
 * selected Grok/Gemini realtime adapter) into the chat input. Dictation only —
 * the AI audio reply is never played.
 */
(function (global) {
    'use strict';

    // Pure text math for live dictation. `base` is the input value captured
    // when dictation started (with a trailing space if it was non-empty).
    // interim transcripts preview as base+transcript; a final transcript commits
    // into base (+ one trailing space) so the next phrase appends after it.
    function nextInputState(base, transcript, isFinal) {
        const value = base + transcript;
        const newBase = (isFinal && transcript) ? (base + transcript + ' ') : base;
        return { value, base: newBase };
    }

    const api = { nextInputState };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;                 // node tests
    } else {
        global.VoiceDictationLib = api;       // browser (controller added in Task 2)
    }
})(typeof window !== 'undefined' ? window : globalThis);
```

- [ ] **Step 4: Run the test — expect PASS:**
`node frontend/assets/js/__tests__/voice-dictation.test.js` → `nextInputState: ALL PASS`.

- [ ] **Step 5: Commit:**
```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
git add frontend/assets/js/voice-dictation.js frontend/assets/js/__tests__/voice-dictation.test.js
git commit -m "feat(voice-dictation): nextInputState helper (interim/commit text math) + node test

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `VoiceDictation` controller (mirror voice-panel connect)

**Files:** Modify `frontend/assets/js/voice-dictation.js`.

- [ ] **Step 1:** Inside the IIFE (before the `api` object), add the controller. It mirrors
`voice-panel.js::connect()` (read lines 536–630 first) but routes the user transcript into the input
and never plays `onAudio`:

```javascript
    const PROVIDER_KEY = 'voiceDictationProvider';
    const SILENCE_MS = 1500; // auto-stop after this much quiet (between final transcripts)

    class VoiceDictation {
        constructor({ inputEl, buttonEl, onState, onError } = {}) {
            this.inputEl = inputEl;
            this.buttonEl = buttonEl;
            this.onState = onState || (() => {});       // 'idle' | 'recording'
            this.onError = onError || ((msg) => console.warn('[VoiceDictation]', msg));
            this.isRecording = false;
            this._base = '';
            this._silenceTimer = null;
            this._client = null;
            this._streamer = null;
        }

        getProvider() {
            const p = localStorage.getItem(PROVIDER_KEY);
            return (p === 'gemini' || p === 'grok') ? p : 'grok';
        }

        toggle() { return this.isRecording ? this.stop() : this.start(); }

        _setState(s) { this.isRecording = (s === 'recording'); this.onState(s); }

        _applyTranscript(text, isFinal) {
            if (!text) return;
            const r = global.VoiceDictationLib.nextInputState(this._base, text, isFinal);
            this.inputEl.value = r.value;
            this.inputEl.dispatchEvent(new Event('input', { bubbles: true })); // grow textarea / enable Send
            if (isFinal) {
                this._base = r.base;
                this._resetSilenceTimer();
            }
        }

        _resetSilenceTimer() {
            clearTimeout(this._silenceTimer);
            this._silenceTimer = setTimeout(() => this.stop(), SILENCE_MS);
        }

        async start() {
            if (this.isRecording) return;
            const provider = this.getProvider();
            const config = (window.APP_CONFIG && window.APP_CONFIG[provider]) || {};
            if (!config.apiKey) {
                this.onError(`No ${provider} voice key configured — set the Voice provider in Settings → Account.`);
                return;
            }
            // Seed base from whatever's already typed (append, preserving it).
            const existing = (this.inputEl.value || '').replace(/\s+$/, '');
            this._base = existing ? existing + ' ' : '';

            try {
                this._streamer = new window.AudioStreamer({
                    onAudioData: (b64) => { if (this._client && this._client.isReady && this._client.isReady()) this._client.sendAudio(b64); },
                });

                if (provider === 'grok') {
                    this._client = new window.GrokLiveClient({
                        ...config,
                        onSetupComplete: async () => { await this._streamer.startCapture(); this._setState('recording'); this._resetSilenceTimer(); },
                        onInputTranscription: (text, isFinal) => this._applyTranscript(text, isFinal),
                        // onAudio intentionally omitted → AI reply is never played.
                        onError: (e) => { this.onError(String(e && e.message || e)); this.stop(); },
                        onClose: () => { if (this.isRecording) this.stop(); },
                    });
                } else {
                    this._client = new window.GeminiRealtimeAdapter(config);
                    this._client.onSessionReady = async () => { await this._streamer.startCapture(); this._setState('recording'); this._resetSilenceTimer(); };
                    this._client.onTranscript = (text, isFinal, dir) => { if (dir === 'in') this._applyTranscript(text, isFinal); };
                    this._client.onError = (e) => { this.onError(String(e && e.message || e)); this.stop(); };
                    this._client.onClose = () => { if (this.isRecording) this.stop(); };
                }
                await this._client.connect();
            } catch (e) {
                this.onError(String(e && e.message || e));
                await this.stop();
            }
        }

        async stop() {
            clearTimeout(this._silenceTimer);
            try { if (this._streamer && this._streamer.stopCapture) await this._streamer.stopCapture(); } catch (_) {}
            try { if (this._client && this._client.disconnect) await this._client.disconnect(); } catch (_) {}
            this._streamer = null; this._client = null;
            this._setState('idle');
        }
    }
```

- [ ] **Step 2:** Add `VoiceDictation` to the browser export. Change the `else` branch:
```javascript
        global.VoiceDictationLib = api;       // browser (controller added in Task 2)
```
to:
```javascript
        api.VoiceDictation = VoiceDictation;
        global.VoiceDictationLib = api;       // browser
```

- [ ] **Step 3: Verify** the node test still passes (controller is browser-only; the require still returns `nextInputState`) and syntax is valid:
```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
node frontend/assets/js/__tests__/voice-dictation.test.js
node --check frontend/assets/js/voice-dictation.js && echo "OK"
```
Expected: `nextInputState: ALL PASS` and `OK`.

NOTE during impl: confirm the real method names against the adapters — `AudioStreamer.stopCapture` (vs `.stop`), `GrokLiveClient.isReady`/`sendAudio`/`disconnect`, `GeminiRealtimeAdapter.disconnect`/`sendAudio`. If a name differs, match the real one (grep the class). Gemini's user-transcript is `onTranscript(text, isFinal, 'in')` per line 428; Grok's is `onInputTranscription` per line 161.

- [ ] **Step 4: Commit:**
```bash
git add frontend/assets/js/voice-dictation.js
git commit -m "feat(voice-dictation): VoiceDictation controller (reuses AudioStreamer + adapters, no AI reply)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Mic button + states + wiring + script include

**Files:** Modify `frontend/index.html`.

- [ ] **Step 1:** Insert the mic button **immediately before** `<button id="send-btn"`:
```html
                <button
                    id="voice-dictate-btn"
                    type="button"
                    title="Dictate your prompt"
                    data-i18n-title="input.dictate"
                    class="self-stretch bg-gray-100 hover:bg-gray-200 text-gray-600 px-3 md:px-4 py-2 md:py-3 rounded-lg font-medium transition flex items-center justify-center"
                >
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                              d="M19 11a7 7 0 01-14 0m7 7v3m0-3a4 4 0 01-4-4V7a4 4 0 118 0v4a4 4 0 01-4 4z" />
                    </svg>
                </button>
```

- [ ] **Step 2:** Add the recording-state CSS inside the existing inline `<style>` (near `.context-item.active`):
```css
        #voice-dictate-btn.recording {
            background-color: #ef4444;
            color: #ffffff;
            animation: vd-pulse 1.2s ease-in-out infinite;
        }
        @keyframes vd-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(239,68,68,0.5); } 50% { box-shadow: 0 0 0 6px rgba(239,68,68,0); } }
```

- [ ] **Step 3:** Add the script include + wiring. Add the `<script src>` near the other voice scripts (after `gemini-realtime-adapter.js`), then a small init `<script>` (or append to an existing init). Find the gemini-realtime-adapter script tag and add after it:
```html
    <script src="assets/js/voice-dictation.js?v=20260610-voicedictate"></script>
```
Then near the end (after `chat.js` loads, where `window.chatApp` exists), add:
```html
    <script>
      (function initVoiceDictation() {
        const input = document.getElementById('user-input');
        const btn = document.getElementById('voice-dictate-btn');
        if (!input || !btn || !window.VoiceDictationLib) return;
        const vd = new window.VoiceDictationLib.VoiceDictation({
          inputEl: input,
          buttonEl: btn,
          onState: (s) => btn.classList.toggle('recording', s === 'recording'),
          onError: (msg) => { (window.chatApp?.showToast || window.alert)(msg); btn.classList.remove('recording'); },
        });
        btn.addEventListener('click', () => vd.toggle());
        window.voiceDictation = vd;
      })();
    </script>
```
(If the app already has a single init block at the bottom, place this call there instead of a new tag. Verify `window.chatApp.showToast` exists; if not, use `alert`.)

- [ ] **Step 4: Syntax check (HTML loads + button present):**
```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
grep -nE 'id="voice-dictate-btn"|voice-dictation\.js\?v=' frontend/index.html
```
Expected: the button and the script include are present.

- [ ] **Step 5: Commit:**
```bash
git add frontend/index.html
git commit -m "feat(voice-dictation): mic button beside Send + recording state + wiring

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Settings → Account "Voice provider" select

**Files:** Modify `frontend/index.html` (the Account tab markup); Modify `frontend/assets/js/settings-panel.js` (`setupAccountListeners`).

- [ ] **Step 1:** In the Account tab markup, add the select (find the Account tab `<div>` — search `data-i18n` near the Account/phone section, place it as a labelled row):
```html
                <div class="mb-4">
                    <label class="block text-sm font-medium text-gray-700 mb-1" data-i18n="account.voiceProvider">Voice provider (dictation)</label>
                    <select id="voice-dictation-provider" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
                        <option value="grok">Grok</option>
                        <option value="gemini">Gemini</option>
                    </select>
                    <p class="text-xs text-gray-400 mt-1" data-i18n="account.voiceProviderHint">Used by the mic button next to Send.</p>
                </div>
```

- [ ] **Step 2:** In `settings-panel.js::setupAccountListeners()`, add init + persistence (use the same `localStorage` key the controller reads, `voiceDictationProvider`):
```javascript
        // Voice dictation provider (used by the mic button next to Send).
        const vdSelect = document.getElementById('voice-dictation-provider');
        if (vdSelect) {
            const saved = localStorage.getItem('voiceDictationProvider');
            vdSelect.value = (saved === 'gemini' || saved === 'grok') ? saved : 'grok';
            vdSelect.addEventListener('change', (e) => {
                localStorage.setItem('voiceDictationProvider', e.target.value);
            });
        }
```

- [ ] **Step 3: Verify:**
```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
node --check frontend/assets/js/settings-panel.js && echo "OK"
grep -nE 'voice-dictation-provider|voiceDictationProvider' frontend/index.html frontend/assets/js/settings-panel.js | head
```
Expected: `OK` and the select + key present in both.

- [ ] **Step 4: Commit:**
```bash
git add frontend/index.html frontend/assets/js/settings-panel.js
git commit -m "feat(settings): Account voice-provider select for dictation (Grok|Gemini)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: End-to-end verification (manual/Playwright)

- [ ] **Step 1: Static checks:**
```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
node frontend/assets/js/__tests__/voice-dictation.test.js
node --check frontend/assets/js/voice-dictation.js && node --check frontend/assets/js/settings-panel.js && echo "syntax OK"
```
Expected: `nextInputState: ALL PASS` + `syntax OK`.

- [ ] **Step 2: Manual E2E** (Chrome, mic available; **hard refresh** ⌘⇧R — cached assets):
  1. Settings → Account → set **Voice provider = Grok**. Reload.
  2. Type "Note: " in the input, click the mic (turns **red/pulsing**), say a sentence → words **append** live after "Note: "; pause → it **auto-stops** (idle), text finalized; **no AI voice** plays. Press **Send** → normal chat.
  3. Repeat with **Gemini**.
  4. **Deny** mic permission (or unset the key) → toast pointing to Account; button returns idle; input untouched.
  5. Click mic, then click again mid‑speech → stops immediately, keeps transcribed text.

- [ ] **Step 3:** Commit any fixes from manual testing:
```bash
git add -A && git commit -m "test(voice-dictation): manual e2e fixes"
```

---

## Done — outcome

A mic button beside Send dictates speech into `#user-input` via the Account-selected Grok/Gemini adapter — live, appended, auto-stopping on silence, with no AI audio reply — then the user edits and Sends normally.
