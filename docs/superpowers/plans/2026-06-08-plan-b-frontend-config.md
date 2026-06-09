# Plan B — Frontend: One Config Per App — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task.

**Goal:** Consolidate the main site's two config files into a single gitignored `config.js` (`window.APP_CONFIG` + Firebase init), re-point every page at it, delete `firebase-config.js`, and commit placeholder `*.example` files — so a fresh clone is documented and no committed file holds a secret. The voice PWA keeps its own single `voice/config.json`.

**Architecture:** `config.js` gains a `firebase` section and the Firebase compat init (moved verbatim from `firebase-config.js`, reading `CONFIG.firebase`). All pages load only `config.js`. `config.js` + `voice/config.json` stay gitignored; committed `config.example.js` + `voice/config.example.json` document them.

**Tech Stack:** static HTML/JS, Firebase compat SDK. No build step.

**Working dir:** `/Applications/XAMPP/xamppfiles/htdocs/gpt`
**Note:** `config.js`, `firebase-config.js`, `voice/config.json` are **gitignored** — edits to them are local (not committed). The committed deliverables are the HTML page edits, the `*.example` files, and `.gitignore`.

---

## Task 1: Merge Firebase into `config.js`; delete `firebase-config.js`

**Files:** Modify `frontend/assets/js/config.js` (local); Delete `frontend/assets/js/firebase-config.js` (local).

- [ ] **Step 1:** In `frontend/assets/js/config.js`, add a `firebase` section as the last key inside the `CONFIG` object (after the `gemini: { … }` block, before the closing `};`). Copy the values **verbatim** from `firebase-config.js`'s `firebaseConfig` object:

```js
    ,
    firebase: {
        apiKey: "YOUR_FIREBASE_WEB_API_KEY",
        authDomain: "YOUR_PROJECT.firebaseapp.com",
        databaseURL: "https://YOUR_PROJECT.firebaseio.com",
        projectId: "YOUR_PROJECT",
        storageBucket: "YOUR_PROJECT.firebasestorage.app",
        messagingSenderId: "YOUR_SENDER_ID",
        appId: "YOUR_APP_ID",
        measurementId: "YOUR_MEASUREMENT_ID"
    }
```

- [ ] **Step 2:** After the existing `window.APP_CONFIG = CONFIG;` line (and its console.log), append the Firebase init moved from `firebase-config.js`:

```js

// Initialize Firebase (merged from the former firebase-config.js).
// On pages without the Firebase SDK loaded, the try/catch leaves these undefined harmlessly.
let firebaseApp, firebaseAuth;
try {
    firebaseApp = firebase.initializeApp(CONFIG.firebase);
    console.log('✅ Firebase app initialized successfully');
    firebaseAuth = firebase.auth();
    console.log('✅ Firebase Auth initialized successfully');
} catch (error) {
    console.error('❌ Firebase initialization failed:', error);
}
window.firebaseApp = firebaseApp;
window.firebaseAuth = firebaseAuth;
```

- [ ] **Step 3:** Delete the now-merged file: `rm frontend/assets/js/firebase-config.js`

- [ ] **Step 4:** Syntax check the merged file: `node --check frontend/assets/js/config.js`
Expected: no output (valid JS).

- [ ] **Step 5:** Confirm structure (no secret values printed):
`node -e 'global.window={};global.firebase={initializeApp:()=>({}),auth:()=>({})};require("./frontend/assets/js/config.js");const c=window.APP_CONFIG;console.log("firebase?",!!c.firebase&&!!c.firebase.projectId,"grok?",!!c.grok,"app set?",!!window.firebaseApp);'`
Expected: `firebase? true grok? true app set? true`.

(No commit yet — `config.js` is gitignored; committed pieces come in later tasks.)

---

## Task 2: Re-point the HTML pages at `config.js`

**Files:** Modify `frontend/index.html`, `frontend/login.html`, `frontend/register.html`, `frontend/auth/signInWithPopup.html` (all committed).

- [ ] **Step 1: `index.html`** — it loads `firebase-config.js` then `config.js`. Remove the `firebase-config.js` `<script>` line (keep the `config.js` one). Find and delete the line matching:
`<script src="assets/js/firebase-config.js"...></script>`
Verify `config.js` is still loaded **after** the Firebase SDK `<script>` (it is — it was already after `firebase-config.js`).

- [ ] **Step 2: `login.html` and `register.html`** — each loads `firebase-config.js` only. In each, change that script's `src` from `assets/js/firebase-config.js` to `assets/js/config.js` (same position, so it still loads after the Firebase SDK):
`<script src="assets/js/firebase-config.js"...>` → `<script src="assets/js/config.js"...>`

- [ ] **Step 3: `frontend/auth/signInWithPopup.html`** — it has an inline `firebaseConfig` object (currently a sanitized placeholder) used at two spots. (a) Add a `<script src="../assets/js/config.js"></script>` **after** the Firebase SDK script and before the page's own script. (b) Replace the inline `const firebaseConfig = { … }` with `const firebaseConfig = window.APP_CONFIG.firebase;`. Leave the two `firebaseConfig` usages as-is (they now read the merged config).

- [ ] **Step 4:** Verify no page still references the deleted file:
`grep -rn "firebase-config.js" frontend --include="*.html" | grep -v node_modules`
Expected: no matches.

- [ ] **Step 5: Commit the HTML rewiring:**
```bash
git add frontend/index.html frontend/login.html frontend/register.html frontend/auth/signInWithPopup.html
git commit -m "refactor(frontend): load single config.js per page; drop firebase-config.js

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Committed examples + `.gitignore` + verification

**Files:** Create `frontend/assets/js/config.example.js`, `frontend/voice/config.example.json`; Modify `.gitignore`.

- [ ] **Step 1: `config.example.js`** — a placeholder mirror of the merged `config.js`: same structure/keys, but every secret value replaced with a placeholder. Keep the non-secret fields (voice.activeProvider, model names, voiceName, the systemPrompt strings) so it documents the shape. Replace each API key with a placeholder, e.g.:
```js
    hume:   { apiKey: 'YOUR_HUME_API_KEY', configId: 'YOUR_HUME_CONFIG_ID', sampleRate: 16000 },
    grok:   { apiKey: 'YOUR_GROK_VOICE_API_KEY', voice: 'Ara', sampleRateInput: 16000, sampleRateOutput: 24000, systemPrompt: '…keep…' },
    gemini: { apiKey: 'YOUR_GEMINI_VOICE_API_KEY', model: 'gemini-2.5-flash-native-audio-preview-12-2025', voiceName: 'Kore', systemPrompt: '…keep…' },
    firebase: { apiKey: 'YOUR_FIREBASE_WEB_API_KEY', authDomain: 'YOUR_PROJECT.firebaseapp.com', databaseURL: 'https://YOUR_PROJECT.firebaseio.com', projectId: 'YOUR_PROJECT', storageBucket: 'YOUR_PROJECT.firebasestorage.app', messagingSenderId: 'YOUR_SENDER_ID', appId: 'YOUR_APP_ID', measurementId: 'YOUR_MEASUREMENT_ID' }
```
Keep `window.APP_CONFIG = CONFIG;` and the Firebase-init block identical (no secrets there). Header comment: "Copy to config.js and fill in your keys."

- [ ] **Step 2: `voice/config.example.json`** — read `frontend/voice/config.json`, copy its structure to `config.example.json`, and replace any secret value (anything matching an API-key shape: `AIza…`, `xai-…`, `sk-…`, or fields named `*key`/`*secret`/`*token`) with a placeholder like `"YOUR_…"`. Keep all non-secret fields.

- [ ] **Step 3: `.gitignore`** — remove the `firebase-config.js` line (file deleted); keep `config.js` and `voice/config.json` ignored. Change:
```
frontend/assets/js/config.js
frontend/assets/js/firebase-config.js
frontend/voice/config.json
```
to:
```
frontend/assets/js/config.js
frontend/voice/config.json
```

- [ ] **Step 4: Verify the examples are secret-free** and the real configs stay ignored:
```bash
git add frontend/assets/js/config.example.js frontend/voice/config.example.json .gitignore
grep -lIE "AIza[0-9A-Za-z_-]{30,}|xai-[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}" frontend/assets/js/config.example.js frontend/voice/config.example.json; echo "example secret-grep exit=$? (1=clean)"
git check-ignore -q frontend/assets/js/config.js && echo "config.js ignored: ok" || echo "BAD"
git check-ignore -q frontend/voice/config.json && echo "voice/config.json ignored: ok" || echo "BAD"
git status --porcelain | grep -E "assets/js/config\.js$|voice/config\.json$" && echo "BAD: real config staged" || echo "ok: real configs not staged"
```
Expected: `example secret-grep exit=1`, both `ignored: ok`, `ok: real configs not staged`.

- [ ] **Step 5: Repo-wide secret sweep (tracked files):**
```bash
git add -A
git grep --cached -lIE "AIza[0-9A-Za-z_-]{30,}|xai-[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9_-]{15,}|sk-[A-Za-z0-9_-]{20,}" 2>/dev/null; echo "repo sweep exit=$? (1=clean)"
```
Expected: nothing printed, `exit=1`.

- [ ] **Step 6: Commit:**
```bash
git commit -m "feat(frontend): commit config.example.js + voice/config.example.json; gitignore single config per app

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Manual browser verification (user)

- [ ] The dev tests in a browser (config.js is local): **login.html**, **register.html**, and **index.html** all initialize Firebase (console: "✅ Firebase app initialized") and Google/Facebook sign-in works; the **voice prompt-builder** (index) still loads its provider config; the **voice PWA** (`/frontend/voice/`) still works via `voice/config.json`. The `signInWithPopup` OAuth popup completes.

---

## Done — Plan B outcome

The main site loads a **single `config.js`** (`window.APP_CONFIG` + Firebase init); `firebase-config.js` is gone; the voice PWA keeps `voice/config.json`. Both real configs stay gitignored; committed `*.example` files document them. No committed file holds a secret. Combined with Plan A, the whole repo is secret-free for the first PR.
