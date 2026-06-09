/**
 * Service worker for Synergy AI Chat (gpt frontend).
 *
 * Phase 1 — minimum viable PWA: installs, activates, takes control of clients,
 * but doesn't intercept network requests. The browser still fetches everything
 * normally; this just makes the page installable and ready for caching
 * strategies in a follow-up phase.
 *
 * Future additions worth wiring later:
 *   - Cache the static shell (HTML, CSS, JS bundles) on install
 *   - Stale-while-revalidate for /api/v1/providers, /api/v1/me/package
 *   - Offline fallback page
 *   - Background sync for queued chat messages
 *
 * Bump CACHE_VERSION when shipping behaviour changes; the activate handler
 * cleans up old caches and forces all open tabs to use the new worker.
 */

const CACHE_VERSION = 'v1-2026-05-29';

self.addEventListener('install', (event) => {
    // Skip waiting so a new SW takes effect on next page load instead of
    // requiring all tabs to be closed first.
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        // Drop any caches from previous versions of the SW.
        const names = await caches.keys();
        await Promise.all(
            names
                .filter((n) => !n.endsWith(CACHE_VERSION))
                .map((n) => caches.delete(n))
        );
        await self.clients.claim();
    })());
});

// Phase 1: pass-through. No fetch interception.
// Adding a fetch handler here later is safe — the listener is idempotent.
