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
