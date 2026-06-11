# File Storage

Browse the **local folder dedicated to this application** on your computer — the same folder where workflow outputs are written.

## What you can do

- Open files written by workflows.
- Feed local files back into a conversation as attachments.
- Inspect outputs from past runs without leaving the app.

## Setup

This requires the PWA to be installed and the folder permission granted:

1. Install the application as a PWA (the install wizard prompts you on first launch).
2. Pick a root folder when prompted.
3. The browser will ask once to confirm folder access — choose **"Allow on every visit"** so you don't have to re-grant on every session.

The folder handle is persisted via the browser's IndexedDB so the app remembers it across launches.

## Why a local folder?

Storing files locally means:

- **Privacy** — outputs never leave your machine unless you explicitly upload them.
- **Persistence** — workflow outputs are accessible even when the app isn't running.
- **Interop** — open files in your normal editors / viewers; the AI Assistant is just one consumer of the folder.
