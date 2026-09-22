# Goal 2: Gemini 2.5 Live API Integration Plan

## Objective
Integrate real-time voice communication with Gemini 2.5 Flash using the Live API WebSocket protocol into the existing voice panel UI.

## Research Summary

### API Documentation
- **WebSocket Endpoint**: `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`
- **Model**: `gemini-2.5-flash-native-audio-preview-12-2025`
- **Documentation**: [Google AI Live API](https://ai.google.dev/gemini-api/docs/live)

### Audio Specifications
| Direction | Sample Rate | Format | Encoding |
|-----------|-------------|--------|----------|
| Input (to API) | 16,000 Hz | 16-bit Int16 PCM, Mono | Base64 |
| Output (from API) | 24,000 Hz | 16-bit Int16 PCM, Mono | Base64 |

### Key Learnings from Voice Project
1. Uses `@google/genai` library which wraps WebSocket connection
2. AudioWorklet runs on separate thread for low-latency capture
3. Gapless audio playback using scheduled AudioBufferSourceNode
4. Supports interruption handling (user can interrupt AI)
5. Transcriptions come as streaming chunks, committed on `turnComplete`

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         VOICE PANEL (UI)                                │
│  ┌─────────────┐  ┌─────────────────┐  ┌──────────────────────────┐    │
│  │ Status      │  │ Transcription   │  │ Visualizer + Controls    │    │
│  │ Indicator   │  │ History         │  │                          │    │
│  └─────────────┘  └─────────────────┘  └──────────────────────────┘    │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
┌────────────────────────────────▼────────────────────────────────────────┐
│                       GEMINI LIVE CLIENT                                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                  │
│  │ WebSocket    │  │ Audio Input  │  │ Audio Output │                  │
│  │ Manager      │  │ Pipeline     │  │ Pipeline     │                  │
│  └──────────────┘  └──────────────┘  └──────────────┘                  │
└─────────────────────────────────────────────────────────────────────────┘
                                 │
                    WebSocket (wss://)
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    GEMINI 2.5 LIVE API                                  │
│  - Native audio understanding                                           │
│  - Real-time speech-to-text                                            │
│  - Text-to-speech with HD voices                                       │
│  - Interruption detection                                              │
└─────────────────────────────────────────────────────────────────────────┘
```

## Implementation Plan

### Files to Create/Modify

#### 1. NEW: `/gpt/frontend/assets/js/gemini-live-client.js`
Core WebSocket client for Gemini Live API.

```javascript
class GeminiLiveClient {
    constructor(options) {
        this.apiKey = options.apiKey;
        this.model = options.model || 'gemini-2.5-flash-native-audio-preview-12-2025';
        this.systemPrompt = options.systemPrompt || '';
        this.voiceName = options.voiceName || 'Zephyr';
        this.callbacks = options.callbacks || {};

        this.ws = null;
        this.isConnected = false;
    }

    // Connect to Gemini Live API
    async connect() { ... }

    // Send setup message with configuration
    sendSetup() { ... }

    // Send audio data (Base64 PCM)
    sendAudio(base64Data) { ... }

    // Send text message
    sendText(text, turnComplete = true) { ... }

    // Handle incoming messages
    handleMessage(message) { ... }

    // Disconnect and cleanup
    disconnect() { ... }
}
```

#### 2. NEW: `/gpt/frontend/assets/js/audio-streamer.js`
Audio input/output handling.

```javascript
class AudioStreamer {
    constructor(options) {
        this.onAudioData = options.onAudioData;
        this.inputSampleRate = 16000;
        this.outputSampleRate = 24000;

        this.inputContext = null;
        this.outputContext = null;
        this.workletNode = null;
        this.mediaStream = null;
        this.audioSources = new Set();
        this.nextStartTime = 0;
    }

    // Start microphone capture
    async startCapture() { ... }

    // Stop microphone capture
    stopCapture() { ... }

    // Play received audio (gapless)
    playAudio(base64Data) { ... }

    // Stop all playback (for interruption)
    stopPlayback() { ... }

    // Check if currently playing
    isPlaying() { ... }

    // Cleanup all resources
    cleanup() { ... }
}
```

#### 3. COPY: `/gpt/frontend/assets/js/audio-processor.js`
AudioWorklet processor (copy from Voice project).

```javascript
class AudioProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._bufferSize = 2048;
        this._buffer = new Float32Array(this._bufferSize);
        this._writeIndex = 0;
    }

    process(inputs, outputs, parameters) {
        // Accumulate samples, convert Float32 to Int16, send via port
    }
}
registerProcessor('audio-processor', AudioProcessor);
```

#### 4. MODIFY: `/gpt/frontend/assets/js/voice-panel.js`
Update to use real Gemini connection instead of placeholders.

Changes needed:
- Import/use GeminiLiveClient and AudioStreamer
- Real connect/disconnect methods
- Handle transcriptions from API
- Pass audio data to visualizer
- Handle status changes from API events

#### 5. MODIFY: `/gpt/frontend/index.html`
- Add script tags for new JS files
- Add API key configuration (or use backend proxy)

### API Key Handling Options

**Option A: Direct Client (simpler, less secure)**
- Store API key in frontend config
- Connect directly to Gemini WebSocket
- Suitable for internal/demo use

**Option B: Backend Proxy (more secure)**
- Create PHP endpoint to proxy WebSocket
- API key stored server-side
- More complex implementation

**Recommendation**: Start with Option A for Goal 2, can add proxy in Goal 3.

### Message Protocol

#### Client → Server: Setup
```json
{
    "setup": {
        "model": "gemini-2.5-flash-native-audio-preview-12-2025",
        "generationConfig": {
            "responseModalities": ["AUDIO"]
        },
        "speechConfig": {
            "voiceConfig": {
                "prebuiltVoiceConfig": {
                    "voiceName": "Zephyr"
                }
            }
        },
        "systemInstruction": {
            "parts": [{ "text": "..." }]
        },
        "inputAudioTranscription": {},
        "outputAudioTranscription": {}
    }
}
```

#### Client → Server: Audio
```json
{
    "realtimeInput": {
        "mediaChunks": [{
            "data": "<base64-pcm>",
            "mimeType": "audio/pcm;rate=16000"
        }]
    }
}
```

#### Client → Server: Text
```json
{
    "clientContent": {
        "turns": [{
            "role": "user",
            "parts": [{ "text": "Hello" }]
        }],
        "turnComplete": true
    }
}
```

#### Server → Client: Audio Response
```json
{
    "serverContent": {
        "modelTurn": {
            "parts": [{
                "inlineData": {
                    "data": "<base64-pcm>",
                    "mimeType": "audio/pcm;rate=24000"
                }
            }]
        }
    }
}
```

#### Server → Client: Transcription
```json
{
    "serverContent": {
        "inputTranscription": { "text": "user speech..." },
        "outputTranscription": { "text": "AI response..." },
        "turnComplete": true,
        "interrupted": false
    }
}
```

### Implementation Steps

#### Phase 1: Core Infrastructure
1. Create `audio-processor.js` (copy from Voice project)
2. Create `audio-streamer.js` with microphone capture and playback
3. Test audio capture/playback independently

#### Phase 2: WebSocket Client
4. Create `gemini-live-client.js` with WebSocket connection
5. Implement setup message sending
6. Implement message receiving and parsing
7. Test connection with API key

#### Phase 3: Integration
8. Update `voice-panel.js` to use real client
9. Wire up audio streaming to WebSocket
10. Handle transcriptions in UI
11. Implement interruption handling

#### Phase 4: Polish
12. Add error handling and reconnection logic
13. Update visualizer with real audio data
14. Add configuration options (voice, language)
15. Test end-to-end flow

### System Prompt for GPT Voice Assistant

```
You are an AI assistant integrated into a multi-provider chat application. You can help users with:
- Answering questions and having conversations
- Explaining features of the application
- Providing information on various topics

Language Protocol:
- Detect the user's language from their speech
- Respond in the same language (English, French, or Spanish)
- Switch languages if the user switches

Communication Style:
- Keep responses concise (under 3 sentences unless more detail is requested)
- Speak naturally without markdown formatting
- Stop immediately if interrupted by the user
```

### Configuration Constants

```javascript
const GEMINI_CONFIG = {
    model: 'gemini-2.5-flash-native-audio-preview-12-2025',
    voiceName: 'Zephyr',
    inputSampleRate: 16000,
    outputSampleRate: 24000,
    workletBufferSize: 2048,
    allowInterruption: true,
    autoStartConversation: false
};
```

### Available Voices (Gemini 2.5)
- Zephyr (default)
- Puck
- Charon
- Kore
- Fenrir
- Aoede
- And more (30 HD voices available)

## Testing Checklist

- [ ] WebSocket connects successfully
- [ ] Setup message accepted (no errors)
- [ ] Microphone permission granted
- [ ] Audio captured and sent to API
- [ ] API responds with audio
- [ ] Audio plays back smoothly (no gaps)
- [ ] Transcriptions display correctly
- [ ] Interruption stops AI audio immediately
- [ ] Disconnect cleans up all resources
- [ ] Error states handled gracefully
- [ ] Works in Chrome, Firefox, Safari
- [ ] Status indicator updates correctly
- [ ] Visualizer shows audio activity

## Dependencies

- Web Audio API (built into browsers)
- WebSocket API (built into browsers)
- AudioWorklet API (modern browsers)

No external libraries required - pure vanilla JavaScript implementation.

## Security Considerations

1. **API Key Exposure**: For production, use backend proxy
2. **Microphone Permission**: Request only when user clicks "Start Voice"
3. **Audio Data**: Transmitted over secure WebSocket (wss://)
4. **No Local Storage of Audio**: Audio is streamed, not stored

## Sources

- [Gemini Live API Documentation](https://ai.google.dev/gemini-api/docs/live)
- [WebSocket API Reference](https://ai.google.dev/api/live)
- [Vertex AI Live API](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/live-api)
- Voice Project Reference Implementation
