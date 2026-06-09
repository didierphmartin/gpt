# Internationalization (i18n) Guide

## Overview

The GPT chatbot now supports multiple languages using a custom i18n implementation. The interface is available in:

- 🇺🇸 **English** (en)
- 🇫🇷 **French** (fr) - Français
- 🇪🇸 **Spanish** (es) - Español

## Features

✅ **Automatic Language Detection** - Detects browser language on first visit
✅ **Persistent Language Preference** - Saves selection in localStorage
✅ **Dynamic Language Switching** - Switch languages without page reload
✅ **Speech Recognition Support** - Voice input adapts to selected language
✅ **Text-to-Speech Support** - AI responses are spoken in the selected language
✅ **Complete UI Translation** - All interface elements are translated

## Usage

### Language Switcher

A language selector is located in the header (top-right area) with a globe icon 🌐. Simply select your preferred language from the dropdown.

### How Language Selection Works

1. **First Visit**:
   - System detects your browser's language
   - If your browser language is French or Spanish, it auto-selects that language
   - Otherwise defaults to English

2. **Subsequent Visits**:
   - Your language preference is saved in browser's localStorage
   - The saved language is automatically loaded on next visit

3. **Manual Change**:
   - Use the language dropdown to switch languages
   - All text updates immediately without page reload
   - Selection is automatically saved

## Technical Implementation

### File Structure

```
/gpt/app/assets/
├── i18n/
│   ├── en.json          # English translations
│   ├── fr.json          # French translations
│   └── es.json          # Spanish translations
└── js/
    ├── i18n.js          # i18n manager module
    └── chat.js          # Main chat application
```

### Translation Files Format

Translation files are structured JSON objects with nested keys:

```json
{
  "header": {
    "title": "AI Chat Assistant",
    "subtitle": "Multi-Provider with Function Tools",
    "clearChat": "Clear Chat"
  },
  "input": {
    "placeholder": "Ask me anything...",
    "send": "Send"
  }
}
```

### Using Translations in Code

#### In HTML (Static Elements)

Use `data-i18n` attribute for text content:
```html
<h1 data-i18n="header.title">AI Chat Assistant</h1>
```

For placeholders:
```html
<input data-i18n-placeholder="input.placeholder" placeholder="Ask me anything..." />
```

For tooltips/titles:
```html
<button data-i18n-title="input.voiceTooltip" title="Toggle voice mode">...</button>
```

#### In JavaScript (Dynamic Content)

Use the `i18n.t()` method:
```javascript
// Simple translation
const message = window.i18n.t('header.title');

// Translation with parameters
const text = window.i18n.t('messages.welcome', { name: 'John' });
```

### Language-Specific Features

#### Speech Recognition

The speech recognition language automatically changes when you switch languages:
- English: `en-US`
- French: `fr-FR`
- Spanish: `es-ES`

#### Text-to-Speech

AI responses are spoken in the selected language when voice mode is enabled.

## Adding New Languages

To add a new language (e.g., German):

### 1. Create Translation File

Create `/gpt/app/assets/i18n/de.json`:
```json
{
  "title": "AI-Chat - Multi-Provider-Assistent",
  "header": {
    "title": "AI-Chat-Assistent",
    ...
  }
}
```

### 2. Update i18n.js

Add the language to `supportedLanguages` array in `i18n.js`:
```javascript
this.supportedLanguages = [
    { code: 'en', name: 'English', flag: '🇺🇸' },
    { code: 'fr', name: 'Français', flag: '🇫🇷' },
    { code: 'es', name: 'Español', flag: '🇪🇸' },
    { code: 'de', name: 'Deutsch', flag: '🇩🇪' }  // New language
];
```

### 3. Add Speech Recognition Support

Update `getSpeechRecognitionLanguage()` in `i18n.js`:
```javascript
getSpeechRecognitionLanguage() {
    const languageMap = {
        'en': 'en-US',
        'fr': 'fr-FR',
        'es': 'es-ES',
        'de': 'de-DE'  // New language
    };
    return languageMap[this.currentLanguage] || 'en-US';
}
```

### 4. Test

1. Reload the page
2. Check that German appears in language dropdown
3. Select German and verify all text translates
4. Test voice input/output if supported

## Translation Keys Reference

### Header Section
- `title` - Page title
- `header.title` - Main header title
- `header.subtitle` - Subtitle
- `header.loading` - Loading state text
- `header.clearChat` - Clear chat button

### Provider Bar
- `providerBar.label` - Provider selection label
- `providerBar.mergeConversations` - Merge conversations checkbox
- `providerBar.loadingProviders` - Loading providers text
- `providerBar.failedToLoad` - Error loading providers

### Info Bar
- `infoBar.functionsAvailable` - Functions count label
- `infoBar.ready` - Ready state
- `infoBar.viewFunctions` - View functions button
- `infoBar.tokensUsed` - Tokens used label

### Welcome & Progress
- `welcome.message` - Initial welcome message
- `progress.processing` - Processing indicator
- `progress.connectingTo` - Connecting to provider
- `progress.switchingTo` - Switching provider

### Input Area
- `input.placeholder` - Input field placeholder
- `input.hint` - Keyboard shortcut hint
- `input.send` - Send button
- `input.voiceTooltip` - Voice button tooltip
- `input.voiceModeOn` - Voice mode active tooltip

### Functions Modal
- `functionsModal.title` - Modal title
- `functionsModal.loading` - Loading functions text

### Provider Status
- `provider.active` - Active provider label
- `provider.unavailable` - Unavailable provider label

### Messages & Errors
- `messages.error` - Generic error prefix
- `messages.failedToSwitch` - Provider switch error
- `messages.voiceNotSupported` - Voice mode not supported
- `messages.voiceModeEnabled` - Voice mode enabled message
- `messages.voiceModeDisabled` - Voice mode disabled message
- `messages.voiceRecognitionError` - Voice recognition error

## Browser Compatibility

The i18n system works with all modern browsers. Features:

- **Translation Loading**: All browsers (uses Fetch API)
- **Dynamic Updates**: All browsers (uses DOM manipulation)
- **Speech Recognition**: Chrome, Edge, Safari (limited support in Firefox)
- **Text-to-Speech**: All modern browsers

## Troubleshooting

### Language Not Changing

1. **Check Browser Console**: Look for errors loading translation files
2. **Verify Files Exist**: Check `/gpt/app/assets/i18n/` directory
3. **Check Permissions**: Ensure JSON files are readable (chmod 644)
4. **Clear Cache**: Hard refresh (Ctrl+Shift+R or Cmd+Shift+R)

### Translation Keys Not Found

If you see untranslated keys (e.g., `header.title` instead of translated text):

1. **Verify JSON Structure**: Ensure translation file has correct nested structure
2. **Check for Typos**: Key names must match exactly (case-sensitive)
3. **Validate JSON**: Use a JSON validator to check for syntax errors

### Voice Recognition Wrong Language

If voice input uses wrong language:

1. **Check Language Selection**: Verify correct language is selected in dropdown
2. **Browser Support**: Some browsers have limited language support
3. **Restart Voice Mode**: Disable and re-enable voice mode after changing language

### localStorage Not Working

If language preference is not saved:

1. **Check Browser Settings**: Ensure cookies/localStorage are enabled
2. **Private Browsing**: localStorage may not work in incognito/private mode
3. **Browser Compatibility**: Very old browsers may not support localStorage

## Future Enhancements

Possible improvements for future versions:

- [ ] Add more languages (German, Italian, Portuguese, Chinese, etc.)
- [ ] Support for RTL languages (Arabic, Hebrew)
- [ ] Translation management UI for admins
- [ ] Crowdsourced translations
- [ ] Language-specific date/time formatting
- [ ] Pluralization support
- [ ] Number formatting based on locale

## API Reference

### I18nManager Class

#### Methods

- `init()` - Initialize i18n system (async)
- `t(key, params)` - Get translation for key
- `setLanguage(code)` - Change current language (async)
- `getLanguage()` - Get current language code
- `getSupportedLanguages()` - Get array of supported languages
- `onLanguageChange(callback)` - Register language change listener
- `getSpeechRecognitionLanguage()` - Get speech recognition locale
- `createLanguageSwitcher()` - Create language selector UI element

#### Properties

- `currentLanguage` - Current language code (en, fr, es)
- `translations` - Object containing all loaded translations
- `supportedLanguages` - Array of supported language objects

## Credits

- **i18n Implementation**: Custom lightweight solution
- **Translations**: Professional translations for French and Spanish
- **Speech APIs**: Browser native Web Speech API

---

**Version**: 1.0.0
**Last Updated**: November 2024
**Supported Languages**: 3 (English, French, Spanish)
