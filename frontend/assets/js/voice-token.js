/**
 * Voice credentials from the backend. Voice keys stay on the server like every
 * other provider key: the browser asks whether one exists, and gets a
 * short-lived token (Grok client secret, Gemini single-use Live token) to open
 * a session with.
 */
(function (global) {
    'use strict';

    function headers() {
        const h = { 'Content-Type': 'application/json' };
        const jwt = global.authManager?.token || localStorage.getItem('token') || localStorage.getItem('auth_token');
        if (jwt) h['Authorization'] = `Bearer ${jwt}`;
        return h;
    }

    // Whether the signed-in user has a key for this voice provider.
    async function available(provider) {
        try {
            const resp = await fetch(global.apiUrl(`/voice/config?provider=${encodeURIComponent(provider)}`), {
                headers: headers(), credentials: 'include',
            });
            const j = await resp.json().catch(() => ({}));
            return !!(j && j.success && j.config && j.config.available);
        } catch (_) {
            return false;
        }
    }

    // { client_secret, model?, voice? } for one session.
    async function token(provider) {
        const resp = await fetch(global.apiUrl('/voice/token'), {
            method: 'POST', headers: headers(), credentials: 'include',
            body: JSON.stringify({ provider }),
        });
        const j = await resp.json().catch(() => ({}));
        if (!resp.ok || !j || !j.success || !j.client_secret) {
            throw new Error((j && j.error) || `Failed to get a ${provider} voice token (${resp.status}).`);
        }
        return j;
    }

    global.VoiceToken = { available, token };
})(window);
