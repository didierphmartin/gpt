## 🛠️ System Architecture Overview

To ensure the assistant is swap-ready for different Speech-to-Speech (S2S) providers while maintaining PWA capabilities, we use a modular layer approach.

| Layer | Responsibility | Technology Stack |
| --- | --- | --- |
| **Interface Layer** | PWA Support, Voice Overlay, Markdown Rendering | React/Next.js or Vanilla JS + Tailwind |
| **Voice Provider** | STT/TTS & S2S Handling (Gemini 3 Voice) | Gemini Multimodal Live API |
| **Knowledge Bridge** | Config-based routing (Local vs. Backend) | Middleware Logic (Node/Python) |
| **Data Source** | System Prompt vs. `/htdocs/gpt/backend` | JSON Config + REST/Function Tools |

---

## ⚙️ Configuration (`config.json`)

This file controls the "brain" of the assistant. By toggling `knowledge_mode`, you switch between a fast, canned response system and a deep-search backend system.

```json
{
  "assistant_settings": {
    "provider": "gemini-3-voice",
    "knowledge_mode": "sophisticated", 
    "render_text_overlay": true,
    "local_resource_optimization": true
  },
  "context": {
    "system_prompt_path": "./prompts/default.md",
    "backend_endpoint": "htdocs/gpt/backend",
    "inject_timestamp": true
  }
}

```

---

## 🤖 The Assistant System Prompt

*Save this as `system_prompt.md`. This is what the Gemini model uses to understand its identity.*

```markdown
# Identity
You are a responsive, vocal-first assistant. Your goal is to provide concise, helpful information with a natural conversational flow.

# Operational Context
- Current Time: {{current_time}}
- Platform: {{platform_type}} (Web/PWA)

# Interaction Phases
1. WELCOME: Greet the user briefly and wait for input.
2. LISTEN: Process speech input with high efficiency.
3. RESPOND: 
   - If 'knowledge_mode' is "local": Answer directly using your internal training and this prompt.
   - If 'knowledge_mode' is "sophisticated": Use the provided backend tools to fetch real-time data.

# Rules for Backend Mode
When fetching complex data (e.g., market trends, gold prices):
1. Execute the function call to the backend.
2. Receive the Markdown response.
3. Verbally summarize the key takeaway to the user.
4. Trigger the 'TEXT_OVERLAY' event so the user can read the full Markdown/HTML details.

# Tone & Style
- Be succinct. Avoid long-winded verbal lists.
- If displaying text on the overlay, tell the user: "I've put the details on the screen for you."

```

---

## 🔄 Interaction Scenarios

### Scenario A: Local Knowledge (Efficiency Mode)

*Best for simple FAQs and general assistance.*

1. **Trigger:** User clicks the floating action button (FAB).
2. **Voice Overlay:** "Hello! How can I help you today?" (Gemini 3 Voice).
3. **User:** "What time is it in Paris?"
4. **Process:** Assistant checks `current_time` context + internal knowledge.
5. **Voice Output:** "It's currently 8:30 PM in Paris."

### Scenario B: Sophisticated Knowledge (Backend Mode)

*Best for real-time data like finance or internal databases.*

1. **Trigger:** User clicks FAB.
2. **User:** "Tell me more about the current situation of gold."
3. **Process:** Assistant detects a need for external data -> Calls `/htdocs/gpt/backend`.
4. **Backend:** Returns a detailed Markdown report on gold prices.
5. **Voice Output:** "Gold is currently trading at a 3-month high. I've pulled up a detailed report on your screen."
6. **UI Action:** The **Text Overlay** slides over the voice interface, rendering the Markdown as HTML.
7. **Exit:** User clicks "Back to Chat" to return to the voice UI.

---

## 📱 Implementation Guide

### 1. The Voice Overlay (CSS/JS)

The overlay should be a full-screen or partial modal with a pulsing "listening" animation to indicate the Gemini 3 voice stream is active.

### 2. PWA Capabilities

To make it installable, ensure your `manifest.json` includes:

* `display: standalone`
* Service Workers for offline caching of the UI assets.

### 3. Backend Integration

The script at `htdocs/gpt/backend` should act as a **Tool Handler**. When the assistant decides it needs "sophisticated" knowledge, it sends a JSON payload:

```json
{
  "query": "current situation of gold",
  "timestamp": "2026-01-30T14:33:42",
  "user_id": "optional_id"
}

```

### 4. Modular Voice Provider Interface

To allow switching from Gemini to another provider (like OpenAI or ElevenLabs) in the future, wrap your voice logic in a class:

```javascript
class VoiceAssistant {
    constructor(provider) {
        this.provider = provider; // e.g., new GeminiProvider()
    }
    
    async startListening() {
        return this.provider.stream();
    }
    
    onResponse(callback) {
        this.provider.on('data', callback);
    }
}

```