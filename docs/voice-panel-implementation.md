# Voice Panel Implementation

This document describes the voice panel implementation in the GPT application, which enables real-time voice conversations using Google's Gemini Live API.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         Frontend                                │
│  ┌─────────────┐    ┌──────────────────┐    ┌────────────────┐  │
│  │ VoicePanel  │───▶│ GeminiLiveClient │───▶│ AudioStreamer  │  │
│  │ (UI/State)  │    │   (WebSocket)    │    │   (Playback)   │  │
│  └─────────────┘    └──────────────────┘    └────────────────┘  │
│         │                   │                                   │
│         │           ┌──────────────────┐                        │
│         └──────────▶│ AudioProcessor   │                        │
│                     │  (Microphone)    │                        │
│                     └──────────────────┘                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ WebSocket (wss://generativelanguage.googleapis.com)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Gemini Live API                               │
│                 (Real-time Voice Processing)                     │
└─────────────────────────────────────────────────────────────────┘
```

## File Structure

```
frontend/assets/js/
├── voice-panel.js           # Main UI component and state management
├── gemini-live-client.js    # WebSocket connection to Gemini Live API
├── audio-streamer.js        # Audio playback using Web Audio API
├── audio-processor.js       # Microphone capture using AudioWorklet
├── config.js                # Configuration constants
└── chat.js                  # Integration point for voice panel
```

## Components

### 1. VoicePanel (`voice-panel.js`)

The main UI component that manages the voice conversation interface.

**Key Features:**
- Renders the voice panel UI with connection status, audio visualizer, and controls
- Manages conversation state (idle, connecting, connected, speaking, listening)
- Coordinates between audio input (microphone) and output (playback)
- Handles conversation history display

**State Management:**
```javascript
this.state = {
    isConnected: false,
    isListening: false,
    isSpeaking: false,
    conversationHistory: [],
    currentTranscript: ''
};
```

**Key Methods:**
- `show()` / `hide()` - Toggle panel visibility
- `connect()` - Establish connection to Gemini Live API
- `disconnect()` - Close connection and cleanup
- `startListening()` - Begin microphone capture
- `stopListening()` - Stop microphone capture
- `handleAudioResponse()` - Process incoming audio from Gemini

**Audio Visualization:**
The panel includes a real-time audio visualizer that shows audio levels during conversation using canvas rendering.

### 2. GeminiLiveClient (`gemini-live-client.js`)

Handles WebSocket communication with the Gemini Live API.

**Connection URL:**
```
wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent
```

**Key Features:**
- Establishes and maintains WebSocket connection
- Handles authentication via API key
- Sends audio chunks to Gemini
- Receives audio responses and transcripts
- Manages connection lifecycle and error handling

**Message Types:**

*Outgoing:*
- `setup` - Initial configuration with model and generation settings
- `realtimeInput` - Audio data chunks from microphone

*Incoming:*
- `setupComplete` - Connection established
- `serverContent` - Audio responses and model turns
- `toolCall` - Function calling requests (if tools enabled)

**Configuration Sent on Setup:**
```javascript
{
    setup: {
        model: "models/gemini-2.0-flash-exp",
        generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
                voiceConfig: {
                    prebuiltVoiceConfig: {
                        voiceName: "Puck"  // Available: Puck, Charon, Kore, Fenrir, Aoede
                    }
                }
            }
        },
        systemInstruction: {
            parts: [{ text: "System prompt here..." }]
        }
    }
}
```

**Event Callbacks:**
- `onConnect` - Called when connection is established
- `onDisconnect` - Called when connection is closed
- `onAudio` - Called with audio data chunks
- `onTranscript` - Called with transcribed text
- `onError` - Called on errors
- `onInterrupted` - Called when user interrupts AI speech

### 3. AudioStreamer (`audio-streamer.js`)

Manages audio playback using the Web Audio API.

**Key Features:**
- Creates and manages AudioContext for playback
- Buffers incoming audio chunks for smooth playback
- Handles audio format conversion (base64 to PCM)
- Provides audio level data for visualization

**Audio Configuration:**
- Sample Rate: 24000 Hz (output from Gemini)
- Channels: 1 (mono)
- Format: 16-bit PCM

**Key Methods:**
```javascript
class AudioStreamer {
    constructor(sampleRate = 24000)

    // Add audio chunk to playback queue
    addPCM16(chunk: Uint8Array): void

    // Start audio playback
    resume(): Promise<void>

    // Stop and clear audio
    stop(): void

    // Get current audio level (0-1) for visualization
    getAudioLevel(): number
}
```

**Buffer Management:**
The streamer maintains a buffer queue to handle network jitter and ensure smooth playback. Audio chunks are queued and played sequentially.

### 4. AudioProcessor (`audio-processor.js`)

Handles microphone capture using AudioWorklet for low-latency processing.

**Key Features:**
- Captures microphone audio using getUserMedia API
- Processes audio in real-time using AudioWorklet
- Resamples audio from device sample rate to 16000 Hz (Gemini input requirement)
- Provides audio level data for input visualization

**Audio Configuration:**
- Input Sample Rate: Device native (typically 44100 or 48000 Hz)
- Output Sample Rate: 16000 Hz (required by Gemini)
- Channels: 1 (mono)
- Format: 16-bit PCM

**AudioWorklet Processor:**
The worklet runs in a separate thread for real-time audio processing without blocking the main thread.

```javascript
class AudioProcessor {
    constructor()

    // Start microphone capture
    async start(): Promise<void>

    // Stop capture
    stop(): void

    // Set callback for processed audio chunks
    onAudioData(callback: (chunk: Uint8Array) => void): void

    // Get current input audio level
    getAudioLevel(): number
}
```

### 5. Config (`config.js`)

Contains configuration for voice providers. The config supports two providers, though currently only Gemini is implemented in the voice panel.

```javascript
const CONFIG = {
    // Hume EVI configuration (not currently used by voice panel)
    hume: {
        apiKey: '...',
        configId: '...'  // Custom EVI configuration ID
    },

    // Gemini Live configuration (actively used)
    gemini: {
        apiKey: '...',
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        voiceName: 'Kore',  // Available: Zephyr, Puck, Charon, Kore, Fenrir, Aoede
        systemPrompt: '...'  // Function-aware prompt template
    }
};
```

**Provider Status:**
- **Gemini Live**: Actively used - full implementation in voice-panel.js
- **Hume EVI**: Configuration present but not implemented in current voice panel

The Gemini system prompt includes a `{{FUNCTION_DESCRIPTIONS}}` placeholder that gets replaced with available tool descriptions at runtime.

## Connection Flow

```
1. User clicks "Start Voice"
         │
         ▼
2. VoicePanel.connect()
         │
         ▼
3. GeminiLiveClient.connect()
   - Opens WebSocket to Gemini Live API
   - Sends setup message with model config
         │
         ▼
4. Receive "setupComplete" from Gemini
         │
         ▼
5. AudioProcessor.start()
   - Request microphone permission
   - Initialize AudioWorklet
   - Start capturing audio
         │
         ▼
6. AudioStreamer.resume()
   - Initialize AudioContext for playback
         │
         ▼
7. Voice conversation active
   - Audio chunks sent to Gemini
   - Audio responses played back
```

## Audio Pipeline

### Input Pipeline (User → Gemini)

```
Microphone (44.1/48kHz)
        │
        ▼
AudioWorklet (Capture)
        │
        ▼
Resampler (→ 16kHz)
        │
        ▼
PCM16 Encoding
        │
        ▼
Base64 Encoding
        │
        ▼
WebSocket → Gemini
```

### Output Pipeline (Gemini → User)

```
WebSocket ← Gemini
        │
        ▼
Base64 Decoding
        │
        ▼
PCM16 Audio Data
        │
        ▼
AudioContext Buffer
        │
        ▼
Speakers (24kHz)
```

## Integration with Main Chat

The voice panel is integrated with the main chat interface in `chat.js`:

```javascript
// Initialize voice panel
this.voicePanel = new VoicePanel({
    container: document.getElementById('voice-panel-container'),
    apiKey: this.geminiApiKey,
    systemPrompt: this.systemPrompt,
    onTranscript: (text, isUser) => {
        // Add transcript to chat history
        this.addMessage(text, isUser ? 'user' : 'assistant');
    }
});

// Toggle voice panel
toggleVoicePanel() {
    if (this.voicePanel.isVisible()) {
        this.voicePanel.hide();
    } else {
        this.voicePanel.show();
    }
}
```

## UI Elements

The voice panel includes:

1. **Connection Status Indicator** - Shows current connection state
2. **Audio Visualizer** - Real-time visualization of audio levels
3. **Conversation Display** - Shows transcribed conversation
4. **Control Buttons:**
   - Mute/Unmute microphone
   - End conversation
   - Settings (voice selection)

## Error Handling

The implementation handles various error scenarios:

- **Microphone Permission Denied** - Shows user-friendly message
- **WebSocket Connection Failed** - Attempts reconnection with backoff
- **Audio Playback Issues** - Falls back gracefully
- **API Rate Limiting** - Displays appropriate error message

## Browser Compatibility

Requirements:
- WebSocket support
- Web Audio API
- AudioWorklet support
- getUserMedia API (microphone access)

Tested on:
- Chrome 90+
- Firefox 85+
- Safari 14+
- Edge 90+

## Security Considerations

1. **API Key** - The Gemini API key is passed from the backend and should not be exposed in client-side code in production
2. **Microphone Access** - Requires explicit user permission
3. **HTTPS Required** - getUserMedia requires secure context
4. **Audio Data** - Streamed directly to Gemini, not stored locally

## Configuration Options

The voice panel can be configured with:

```javascript
new VoicePanel({
    // Required
    container: HTMLElement,      // Container element for the panel
    apiKey: string,              // Gemini API key

    // Optional
    systemPrompt: string,        // Custom system prompt
    voice: string,               // Voice name (default: 'Puck')
    autoConnect: boolean,        // Connect on show (default: false)
    showTranscripts: boolean,    // Display transcripts (default: true)

    // Callbacks
    onConnect: () => void,
    onDisconnect: () => void,
    onTranscript: (text, isUser) => void,
    onError: (error) => void
});
```

## Future Improvements

Potential enhancements:
- **Hume EVI integration**: Config already exists in config.js, needs voice-panel.js implementation
- Support for multiple languages
- Voice activity detection (VAD) for automatic turn-taking
- Audio recording/playback of conversations
- Integration with other voice APIs (e.g., OpenAI Realtime)
- Push-to-talk mode option
- Background noise suppression
- Provider switching UI (Gemini vs Hume)
