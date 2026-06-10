# Voice Dictation Mic Button — Design Spec

- **Date:** 2026-06-10
- **Project:** `gpt` (frontend)
- **Status:** Approved design → ready for implementation planning

## 1. Goal

Let the user dictate a chat prompt by voice. A **mic button beside Send** toggles listening; the
selected provider (**Grok** or **Gemini**) transcribes the user's speech and the text appears **live in
the prompt input** (`#user-input`), where it can be edited and sent normally. This is **dictation**, not
a voice conversation — the AI does **not** reply with audio.

## 2. Decisions (locked in brainstorming)

- **Placement:** a new button `#voice-dictate-btn` **immediately to the left of `#send-btn`**, matching
  its height/style. Idle state = gray mic; recording state = red/pulsing.
- **Interaction:** **toggle with auto-stop on silence.** Click → start; the button turns red and
  interim text streams in; it stops automatically after a short pause in speech, or on a second click.
- **Text behavior:** **live, append.** Interim words stream into `#user-input`, appended to whatever is
  already there (existing typed text is preserved). On stop, the final transcript replaces the interim.
- **Transcription engine:** **reuse the existing realtime adapters** (`grok-live-client.js`,
  `gemini-realtime-adapter.js`), which already emit user-speech transcripts — but in a **dictation
  mode** that consumes only the *user* transcript and **suppresses the AI audio reply.**
- **Provider setting:** Settings → **Account** gains a **"Voice provider"** select (Grok | Gemini),
  persisted in `localStorage` under `voiceDictationProvider` (default **Grok**).

## 3. Non-Goals

- Changing the existing **Voice Panel** (full conversation mode stays as-is).
- AI **voice replies** in dictation mode.
- Offline / browser-native (Web Speech API) STT — we use Grok/Gemini per the requirement.
- Multi-language UI for the transcript beyond what the adapters already support.
- Server-side persistence of the provider choice (localStorage only for v1).

## 4. Architecture

A small **`VoiceDictation` controller** (new `frontend/assets/js/voice-dictation.js`) owns the feature;
the rest is thin glue. Units:

- **`VoiceDictation`** — state machine `idle ↔ recording`. On start: read the provider from settings,
  request mic, open a **dictation session** on the chosen adapter, subscribe to the user-transcript
  callback, and route text to the input. On stop (silence/2nd click/error): close the session, finalize
  text, return to idle. Exposes `toggle()`, `start()`, `stop()`, and an `isRecording` flag.
- **The button + states** — markup (`#voice-dictate-btn`) inserted before `#send-btn`; CSS for
  idle/recording (red + pulse). Click → `VoiceDictation.toggle()`.
- **Adapter dictation mode** — a thin wrapper/config over each adapter so a session: streams the user's
  mic, emits interim + final **user** transcripts via a callback, and does **not** trigger/playback an
  AI audio response. (Grok: consume `transcription` events; Gemini: `onTranscript`.) The AI-response
  path is disabled or ignored for these sessions.
- **`appendTranscriptToInput(text, { interim })`** — helper that maintains a "committed prefix"
  (text present before/around dictation) + the current interim tail, so live updates replace only the
  interim portion and the final commit appends cleanly. Preserves the user's caret-preceding text.
- **Account provider select** — a `<select>`/segmented control in the Settings Account section, bound
  to `localStorage['voiceDictationProvider']`.

## 5. Data Flow

1. Click `#voice-dictate-btn` → `VoiceDictation.toggle()` (idle → recording).
2. Read `voiceDictationProvider`; request `getUserMedia({audio})`.
3. Open the provider's adapter in dictation mode; mic audio streams to it.
4. Adapter emits **interim** user transcripts → `appendTranscriptToInput(text, {interim:true})` →
   live text in `#user-input` (button red).
5. Silence timeout (or 2nd click) → stop: adapter emits **final** transcript →
   `appendTranscriptToInput(final, {interim:false})` (commit) → close session → button idle.
6. User edits if desired and presses **Send** (normal chat flow — unchanged).

## 6. Error / Edge Handling

- **Mic permission denied / unavailable** → toast ("Microphone access is needed to dictate"), button
  stays idle, no session opened.
- **No provider configured / adapter cannot connect** → toast pointing to Settings → Account; idle.
- **Stop mid-stream / error mid-session** → keep whatever interim text was committed so far; never wipe
  the user's existing input.
- **Send pressed while recording** → stop dictation first (commit current text), then send.
- **Provider switched mid-recording** → not allowed; the select reads at session start only.
- **Empty transcript** (user said nothing) → no change to the input; silent return to idle.

## 7. Testing

(Frontend has no unit runner — Playwright/manual; assert behavior, mock the adapter.)
- `appendTranscriptToInput`: interim updates replace only the interim tail; final commits append;
  pre-existing input is preserved; empty transcript is a no-op.
- `VoiceDictation` state machine: toggle idle→recording→idle; stop on silence; stop on 2nd click;
  error path returns to idle without wiping input. (Mock the adapter + a fake transcript stream.)
- Provider select: persists to localStorage; the controller reads it at start.
- Manual E2E: click mic with Grok selected → speak → live text appends → pause → finalizes → Send works;
  repeat with Gemini; deny mic permission → toast; no AI audio plays in either case.

## 8. Tech Stack

| Aspect | Choice |
|---|---|
| Button | `#voice-dictate-btn` before `#send-btn`; idle/recording CSS |
| Controller | new `voice-dictation.js` (`VoiceDictation`) |
| Transcription | existing `grok-live-client.js` / `gemini-realtime-adapter.js` in dictation mode (user transcript only, AI reply suppressed) |
| Target | append into `#user-input` (live interim + final commit) |
| Provider setting | Settings → Account `<select>`, `localStorage['voiceDictationProvider']` (default Grok) |
| Stop | auto on silence (adapter/VAD) + manual toggle |

## 9. Decomposition (for the plan)

1. `appendTranscriptToInput` helper (interim/commit logic) — pure, testable first.
2. `VoiceDictation` controller (state machine) against a **mock adapter** interface.
3. Adapter dictation-mode wrapper for Grok, then Gemini (user transcript out, AI reply suppressed).
4. Button markup/CSS + wire click → `toggle()`; recording state; cache-version bump.
5. Settings → Account "Voice provider" select + persistence.
6. Manual/Playwright E2E across both providers + permission-denied path.

## 10. Future (out of scope)

Browser-native STT fallback; per-language hints; server-persisted provider; push-to-talk option;
inserting at an arbitrary caret position (v1 appends at end).
