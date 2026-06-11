# Hume AI Text-to-Speech Integration Guide

## Overview

The GPT chatbot now uses **Hume AI's Empathic Voice** for text-to-speech instead of the browser's built-in speech synthesis. When voice mode is enabled, AI responses are converted to natural, emotionally-aware speech using Hume's Octave model.

## How It Works

### Workflow

```
User asks question (voice mode ON)
         ↓
Frontend → Backend (with voice_enabled flag)
         ↓
Backend gets AI response (Claude/Grok/etc.)
         ↓
Backend calls Hume TTS API (text → audio)
         ↓
Backend returns: { text, audio, audio_format }
         ↓
Frontend displays text + plays Hume audio
```

### Conditional Processing

- **Voice Mode OFF**: Only text is returned (no TTS call, no cost)
- **Voice Mode ON**: Text + audio returned (Hume TTS called)

This saves costs by only generating audio when needed!

## Configuration

### 1. Add API Keys

Edit `/gpt/config/ai_config.php`:

```php
'hume' => [
    'api_key' => 'YOUR_HUME_API_KEY',
    'secret_key' => 'YOUR_HUME_SECRET_KEY',
    'base_url' => 'https://api.hume.ai/v0',
    'voice' => [
        'enabled' => true,
        'model' => 'octave-2',
        'default_voice_id' => null,
        'emotion_awareness' => true,
    ],
],
```

**Get your API keys from**: https://platform.hume.ai

### 2. Keys are already configured

Your keys are already in the config file:
- API Key: `Fll2fEjHfOAaA0JPjvhKrnbcHxT9gQ0FwbXOz1Exiu3l0u9I`
- Secret Key: `iAwvaRn3DPgYb1fXmZowCACAILhgplQy0YTiyq32IjxYQCTtraQ1HjrqbQkfXLjj`

## Usage

### For End Users

1. Click the **microphone button** to enable voice mode
2. The button turns **green** and pulses when active
3. Ask your question (speak or type)
4. AI response is **displayed as text** AND **spoken with Hume voice**
5. Click microphone again to disable voice mode

### Voice Mode Features

✅ **Speech-to-text** - Speak your questions (browser speech recognition)
✅ **Text-to-speech** - AI responses spoken with Hume's empathic voice
✅ **Multi-language** - Works with English, French, and Spanish
✅ **Conditional** - Audio only generated when voice mode is ON

## Technical Implementation

### Backend Components

#### 1. HumeVoice.php Class

Location: `/gpt/src/Voice/HumeVoice.php`

**Key Methods:**
```php
// Convert text to speech
public function textToSpeech(string $text, array $options = []): array

// Check if Hume is enabled
public function isEnabled(): bool
```

**Response Format:**
```php
[
    'success' => true,
    'audio' => 'base64_encoded_audio_data',
    'format' => 'mp3',
    'content_type' => 'audio/mpeg'
]
```

#### 2. chat.php API Endpoint

Location: `/gpt/app/api/chat.php`

**Request:**
```json
{
  "message": "What is AI?",
  "voice_enabled": true,
  "provider": "claude",
  "conversation_history": []
}
```

**Response (voice OFF):**
```json
{
  "success": true,
  "text": "AI stands for Artificial Intelligence...",
  "usage": { "tokens": 150 },
  "provider": "claude"
}
```

**Response (voice ON):**
```json
{
  "success": true,
  "text": "AI stands for Artificial Intelligence...",
  "audio": "base64_encoded_mp3_data...",
  "audio_format": "mp3",
  "usage": { "tokens": 150 },
  "provider": "claude"
}
```

### Frontend Components

#### chat.js Updates

**Sending voice_enabled flag:**
```javascript
fetch('api/chat.php', {
    method: 'POST',
    body: JSON.stringify({
        message: message,
        voice_enabled: this.voiceModeEnabled  // ← Voice state
    })
});
```

**Handling response with audio:**
```javascript
if (finalResponse.audio) {
    // Play Hume audio
    this.playHumeAudio(finalResponse.audio, finalResponse.audio_format);
} else if (this.voiceModeEnabled) {
    // Fallback to browser TTS
    this.speak(finalResponse.text);
}
```

**Playing Hume audio:**
```javascript
playHumeAudio(base64Audio, format = 'mp3') {
    // Decode base64 → binary → Blob → Audio
    const binaryString = atob(base64Audio);
    const bytes = new Uint8Array(binaryString.length);
    // ... convert to blob
    const audio = new Audio(audioUrl);
    audio.play();
}
```

## API Endpoints

### Hume AI Endpoints Used

The `HumeVoice.php` class tries these endpoints:

1. **Primary**: `/v0/tts` - Direct TTS endpoint
2. **Fallback**: `/v0/evi/chat` - Empathic Voice Interface with audio output

**Authentication:**
```
X-Hume-Api-Key: YOUR_API_KEY
X-Hume-Secret-Key: YOUR_SECRET_KEY
```

## Error Handling

### Graceful Degradation

If Hume TTS fails:
1. Error is logged to PHP error log
2. Response still includes text (no audio field)
3. Frontend displays text normally
4. No error shown to user (seamless fallback)

### Fallback Chain

```
Hume TTS
  ↓ (fails)
Browser TTS (if voice mode enabled)
  ↓ (fails/not supported)
Text only (always works)
```

### Debug Errors

Check PHP error log:
```bash
tail -f /Applications/XAMPP/xamppfiles/logs/error_log
```

Common errors:
- `Hume TTS failed: Invalid API key` → Check api_config.php
- `Hume TTS exception: Connection timeout` → Network issue
- `No audio in response` → Hume API endpoint changed

## Cost Management

### When Audio is Generated

✅ Only when voice mode is enabled
✅ Only for AI responses (not user input)
✅ Skipped if Hume API call fails

### When Audio is NOT Generated

❌ Voice mode disabled
❌ Hume config disabled (`enabled: false`)
❌ API key missing/invalid

### Monitoring Usage

Track Hume API usage:
- Check Hume dashboard: https://platform.hume.ai
- Monitor PHP error logs for TTS calls
- Count responses with `audio` field

## Testing

### 1. Test Voice Mode

```javascript
// Open browser console at http://localhost/gpt/app/
// Enable voice mode
chatApp.voiceModeEnabled = true;

// Send a message
chatApp.sendMessage();

// Check response includes audio
// Look in Network tab for chat.php response
```

### 2. Test API Directly

```php
<?php
require_once 'vendor/autoload.php';

use Quantis\AIPortfolioAssistant\Voice\HumeVoice;

$config = require 'config/ai_config.php';
$hume = new HumeVoice($config);

$result = $hume->textToSpeech("Hello, this is a test!");

if ($result['success']) {
    echo "✅ TTS Success!\n";
    echo "Format: " . $result['format'] . "\n";
    echo "Audio size: " . strlen($result['audio']) . " bytes\n";
} else {
    echo "❌ TTS Failed: " . $result['error'] . "\n";
}
```

### 3. Verify Integration

1. Open chatbot: `http://localhost/gpt/app/`
2. Click microphone button (should turn green)
3. Type a message and send
4. Check browser console for errors
5. Verify audio plays after response

## Troubleshooting

### No Audio Playing

**Check:**
1. Voice mode enabled? (green microphone button)
2. Browser console errors?
3. Network tab shows `audio` in response?
4. PHP error log has Hume errors?

**Solution:**
```bash
# Check PHP errors
tail -f /Applications/XAMPP/xamppfiles/logs/error_log

# Verify API keys
grep -A 5 "hume" /Applications/XAMPP/xamppfiles/htdocs/gpt/config/ai_config.php
```

### Invalid API Key

```
Error: Hume TTS failed: Invalid API key
```

**Solution:**
1. Verify API key in `config/ai_config.php`
2. Check key is active on https://platform.hume.ai
3. Ensure both `api_key` and `secret_key` are set

### Audio Playback Error

```
Error playing Hume audio: [error details]
```

**Possible causes:**
- Audio format not supported by browser
- Corrupted base64 data
- Network interrupted during transfer

**Solution:**
- Check browser console for detailed error
- Verify audio format is `mp3` (most compatible)
- Test with shorter text to reduce transfer size

### Hume API Rate Limits

If you hit rate limits:
1. Check your Hume plan limits
2. Implement caching for common phrases
3. Add rate limiting in chat.php

## Benefits Over Browser TTS

| Feature | Browser TTS | Hume Octave |
|---------|-------------|-------------|
| **Voice Quality** | ⚠️ Robotic | ✅ Natural |
| **Emotional Tone** | ❌ No | ✅ Yes |
| **Consistency** | ❌ Varies by browser | ✅ Consistent |
| **Languages** | ⚠️ Limited | ✅ Multiple |
| **Offline** | ✅ Yes | ❌ No |
| **Cost** | ✅ Free | ⚠️ Paid API |

## Future Enhancements

Possible improvements:

- [ ] Cache common phrases to reduce API calls
- [ ] Add voice selection UI (different Hume voices)
- [ ] Adjust emotion based on AI response sentiment
- [ ] Show audio generation progress indicator
- [ ] Implement audio preloading for faster playback
- [ ] Add audio download button
- [ ] Support streaming audio (if Hume provides it)

## API Reference

### HumeVoice Class

```php
namespace Quantis\AIPortfolioAssistant\Voice;

class HumeVoice {
    public function __construct(array $config)
    public function textToSpeech(string $text, array $options = []): array
    public function isEnabled(): bool
}
```

### Response Format

```php
// Success
[
    'success' => true,
    'audio' => 'base64_string',
    'format' => 'mp3',
    'content_type' => 'audio/mpeg'
]

// Failure
[
    'success' => false,
    'error' => 'Error message'
]
```

## Resources

- **Hume AI Platform**: https://platform.hume.ai
- **Hume Documentation**: https://dev.hume.ai
- **API Reference**: https://dev.hume.ai/reference
- **Octave Model**: Hume's empathic voice model

---

**Version**: 1.0.0
**Last Updated**: November 2024
**Status**: ✅ Fully Integrated and Tested
