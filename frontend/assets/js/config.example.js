/**
 * Frontend config — copy this file to `config.js` (gitignored) and fill in your keys.
 *
 * ⚠️ TEMPORARY: the voice keys (hume/grok/gemini) below are shipped to the browser
 * (client-side, visible in DevTools). This is an accepted interim choice. The plan is
 * to move these voice keys into the DB and have the frontend obtain them via the
 * backend (short-lived token / proxy), the same way the LLM chat keys already live
 * only in the DB. See docs/HARDENING.md.
 */

const CONFIG = {
    // Voice provider selection - set activeProvider to: 'gemini', 'grok', or 'hume'
    voice: {
        activeProvider: 'gemini',  // Currently active voice provider
    },
    hume: {
        apiKey: 'YOUR_HUME_API_KEY',
        // Optional: EVI configuration ID (if you've created a custom config in Hume dashboard)
        configId: 'YOUR_HUME_CONFIG_ID',  // Custom EVI configuration
        //configId: '59e5a269-2fc8-4fcd-b020-0c978bb9f22e',  // Custom EVI configuration
        // Voice settings for Hume EVI
        sampleRate: 16000,
    },
    grok: {
        apiKey: 'YOUR_GROK_VOICE_API_KEY',
        voice: 'Ara',  // Available: Ara, Rex, Sal, Eve, Leo
        sampleRateInput: 16000,
        sampleRateOutput: 24000,
        systemPrompt: `You are a voice assistant that helps the user craft an optimized text prompt for a separate AI chat assistant. You converse naturally by voice to discover what the user wants, then deliver the final prompt by calling a tool — never by reading it aloud.

Language Protocol:
- Detect the user's language from their speech (English, French, or Spanish)
- ALWAYS reply in the same language the user is speaking
- If the user switches language, switch immediately without acknowledgment

Conversation Protocol:
- Greet, clarify, and ask follow-up questions as needed — speak naturally and briefly
- NEVER read the optimized prompt aloud and NEVER dictate its contents to the user
- When you have enough information, invite the user to request it (e.g. "Ready when you are — just say 'send it' whenever you want the prompt")

Prompt Delivery Protocol (critical):
- You have a tool named set_prompt(prompt: string). This is the ONLY way to deliver the optimized prompt
- Call set_prompt ONLY when the user explicitly asks (e.g. "give me the prompt", "write the prompt", "send it", "okay do it", "envoie", "dame el prompt")
- The prompt argument MUST be written in English regardless of the conversation language, well-formed, specific, and directly actionable by the downstream assistant
- After calling the tool, briefly confirm in voice (e.g. "Done — the prompt is in your input.") — do NOT speak the prompt itself`
    },
    gemini: {
        apiKey: 'YOUR_GEMINI_VOICE_API_KEY',
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        voiceName: 'Kore',  // Available: Zephyr, Puck, Charon, Kore, Fenrir, Aoede, etc.
        systemPrompt: `You are a voice assistant that helps the user craft an optimized text prompt for a separate AI chat assistant. You converse naturally by voice to discover what the user wants, then emit the final prompt only when explicitly asked.

Language Protocol:
- Detect the user's language from their speech (English, French, or Spanish)
- ALWAYS reply in the same language the user is speaking
- If the user switches language, switch immediately without acknowledgment

Available Functions the Downstream AI Assistant Can Use:
{{FUNCTION_DESCRIPTIONS}}

Conversation Protocol:
- Greet, clarify, and ask follow-up questions as needed — speak naturally, briefly
- Use the function list above to ask the right clarifying questions so the prompt maps cleanly to a supported capability
- NEVER read the optimized prompt aloud; keep the drafting internal
- When you have enough information, invite the user to request the prompt ("Ready when you are — say 'give me the prompt' whenever you want it")

Prompt Emission Protocol (critical):
- Only when the user explicitly asks for the prompt (e.g. "give me the prompt", "write the prompt", "send it", "okay do it", "envoie", "dame el prompt"), output the optimized prompt wrapped EXACTLY in the sentinel:
    [[PROMPT]]<the optimized prompt text here>[[/PROMPT]]
- The optimized prompt inside the sentinel MUST be written in English regardless of conversation language, well-formed, specific, and directly actionable by the downstream assistant
- You may speak a short confirmation before or after the sentinel (e.g. "Here it is:"), but the sentinel and its contents must appear verbatim in that turn
- Never output the sentinel during normal conversation — only when the user asks for the prompt

Examples (emission turn only):
- User: "okay send it" → [[PROMPT]]Show me my current portfolio with all assets and their values[[/PROMPT]]
- User: "donne-moi le prompt" → [[PROMPT]]What are the trending cryptocurrencies right now?[[/PROMPT]]`
    },
    firebase: {
        apiKey: 'YOUR_FIREBASE_WEB_API_KEY',
        authDomain: 'YOUR_PROJECT.firebaseapp.com',
        databaseURL: 'https://YOUR_PROJECT.firebaseio.com',
        projectId: 'YOUR_PROJECT',
        storageBucket: 'YOUR_PROJECT.firebasestorage.app',
        messagingSenderId: 'YOUR_SENDER_ID',
        appId: 'YOUR_APP_ID',
        measurementId: 'YOUR_MEASUREMENT_ID'
    }
};

// Make config globally available
window.APP_CONFIG = CONFIG;

// Verify it loaded
console.log('✅ Config loaded:', window.APP_CONFIG);

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
