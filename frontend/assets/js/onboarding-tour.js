/**
 * First-run onboarding tour, powered by driver.js v1.4.0.
 *
 * Auto-runs on first visit (gated by localStorage flag). Can be re-triggered
 * any time via `window.startOnboardingTour()`.
 *
 * Library is loaded via CDN (see index.html). To switch to a locally built
 * copy, run `pnpm install && pnpm build` inside `frontend/driver.js/` and
 * point the <script>/<link> tags at `driver.js/dist/driver.js.iife.js` and
 * `driver.js/dist/driver.css`.
 */
(function () {
    'use strict';

    const STORAGE_KEY = 'gpt_onboarding_tour_seen';

    /**
     * Pull a string from the global i18n manager (assets/js/i18n.js). The
     * manager returns the dotted key itself when the translation is missing
     * — same fallback behavior as the rest of the app, so a missing key is
     * visible at runtime instead of silently empty.
     */
    function tt(key) {
        try {
            if (window.i18n && typeof window.i18n.t === 'function') {
                return window.i18n.t(key);
            }
        } catch (_) { /* ignore */ }
        return key;
    }

    function step(element, key, side, align) {
        return {
            element,
            popover: {
                title: tt(`onboarding.${key}.title`),
                description: tt(`onboarding.${key}.description`),
                side,
                align,
            },
        };
    }

    function tourSteps() {
        return [
            // Welcome (no element — full-screen intro popover)
            { popover: { title: tt('onboarding.welcome.title'), description: tt('onboarding.welcome.description') } },

            // Sidebar overview + each tool/service
            step('#contexts-sidebar',     'sidebar',       'right', 'start'),
            step('#nav-conversations',    'conversations', 'right', 'start'),
            step('#nav-verifier',         'verifier',      'right', 'start'),
            step('#nav-compare',          'compare',       'right', 'start'),
            step('#nav-prompt-library',   'promptLibrary', 'right', 'start'),
            step('#nav-skills',           'skills',        'right', 'start'),
            step('#nav-agent-teams',      'workflows',     'right', 'start'),
            step('#nav-file-storage',     'fileStorage',   'right', 'start'),

            // Top bar
            step('#tools-toggle-btn',     'tools',         'bottom', 'end'),
            step('#help-tour-btn',        'help',          'bottom', 'end'),
            step('#settings-header-btn',  'settings',      'bottom', 'end'),
            step('#logout-header-btn',    'logout',        'bottom', 'end'),

            // Provider bar + info bar controls (between top header and chat)
            step('#merge-conversations',  'merge',         'bottom', 'end'),
            step('#show-functions',       'viewFunctions', 'bottom', 'end'),
            step('#show-context',         'viewContext',   'bottom', 'end'),

            // Prompt / input area
            step('#user-input',           'input',         'top',    'center'),
            step('#attach-file-btn',      'attach',        'top',    'start'),
            step('#send-btn',             'send',          'top',    'end'),
        ];
    }

    function getDriverFactory() {
        // driver.js v1.4.0 iife exposes window.driver.js.driver
        const ns = window.driver;
        if (!ns) return null;
        if (typeof ns === 'function') return ns;
        if (ns.js && typeof ns.js.driver === 'function') return ns.js.driver;
        if (typeof ns.driver === 'function') return ns.driver;
        return null;
    }

    function start() {
        const factory = getDriverFactory();
        if (!factory) {
            console.warn('[onboarding-tour] driver.js not loaded — skipping tour.');
            return;
        }

        const steps = tourSteps().filter((s) => {
            // Drop steps whose target isn't in the DOM yet (defensive: keeps
            // the tour from breaking if the page swaps a panel out).
            if (!s.element) return true;
            return !!document.querySelector(s.element);
        });

        const tour = factory({
            showProgress: true,
            allowClose: true,
            overlayOpacity: 0.55,
            stagePadding: 6,
            stageRadius: 8,
            popoverClass: 'gpt-onboarding-popover',
            nextBtnText: tt('onboarding.next'),
            prevBtnText: tt('onboarding.prev'),
            doneBtnText: tt('onboarding.done'),
            onDestroyed: () => {
                try {
                    localStorage.setItem(STORAGE_KEY, '1');
                } catch (_) {
                    /* ignore quota / private mode */
                }
            },
            steps,
        });

        tour.drive();
    }

    /**
     * Wait for the PWA install wizard's outcome and report whether it actually
     * appeared this session.
     *
     *   { wizardShown: true }  — wizard rendered then closed (user finished or
     *                            dismissed it). Tour should run regardless of
     *                            the seen flag — wizard's presence signals a
     *                            fresh first-time-ish flow (TEST_MODE, or post-
     *                            install).
     *   { wizardShown: false } — APPEAR_DEADLINE_MS elapsed with no overlay
     *                            (snoozed / production-installed / disabled).
     *                            Tour respects the seen flag so it doesn't
     *                            re-run on every standalone launch.
     *
     * Three-phase wait:
     *   1. If overlay already exists  → watch for removal.
     *   2. Else MutationObserver on body up to APPEAR_DEADLINE_MS (covers the
     *      wizard's SHOW_DELAY_MS = 3 s + buffer). If it appears → phase 1.
     *   3. Deadline elapses → resolve as wizardShown:false.
     */
    function waitForWizardOutcome() {
        const APPEAR_DEADLINE_MS = 4500;

        return new Promise((resolve) => {
            const existing = document.getElementById('pwa-install-overlay');
            if (existing) {
                watchForRemoval(existing, () => resolve({ wizardShown: true }));
                return;
            }

            let resolved = false;
            const observer = new MutationObserver(() => {
                const o = document.getElementById('pwa-install-overlay');
                if (o && !resolved) {
                    resolved = true;
                    clearTimeout(deadline);
                    observer.disconnect();
                    watchForRemoval(o, () => resolve({ wizardShown: true }));
                }
            });
            const deadline = setTimeout(() => {
                if (resolved) return;
                resolved = true;
                observer.disconnect();
                resolve({ wizardShown: false });
            }, APPEAR_DEADLINE_MS);
            observer.observe(document.body, { childList: true, subtree: false });
        });
    }

    function watchForRemoval(overlay, resolve) {
        const tick = () => {
            if (!document.body.contains(overlay)) {
                resolve();
                return;
            }
            requestAnimationFrame(tick);
        };
        tick();
    }

    /**
     * True when the app is running as an installed PWA (standalone display
     * mode, or iOS Safari's legacy navigator.standalone). Tour only runs in
     * this mode — browser-tab visits get the install wizard instead.
     */
    function isPWAInstalled() {
        if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
        if (window.navigator.standalone === true) return true;
        return false;
    }

    function maybeAutoStart() {
        // Gate on PWA install. We want users to install first so we can keep
        // a persistent FileSystemDirectoryHandle for workflow outputs — the
        // tour only kicks in once they're running the standalone app.
        if (!isPWAInstalled()) {
            console.info('[onboarding-tour] skipped: PWA not installed (browser tab). Tour runs only in installed app.');
            // Belt-and-suspenders: if the user installs and somehow the same
            // page transitions to standalone (rare — usually the standalone
            // window is a fresh load), pick it up.
            window.addEventListener('appinstalled', () => {
                if (isPWAInstalled()) maybeAutoStart();
            }, { once: true });
            return;
        }

        waitForWizardOutcome().then(({ wizardShown }) => {
            let seen = false;
            try {
                seen = localStorage.getItem(STORAGE_KEY) === '1';
            } catch (_) {
                /* ignore */
            }
            // If the wizard was shown this session, treat it as a fresh first-
            // time-ish flow (TEST_MODE on, or post-install) and ignore the seen
            // flag — otherwise repeated tests would silently skip the tour.
            // When no wizard appeared at all, respect the flag so the tour
            // doesn't re-run on every standalone launch in production.
            if (seen && !wizardShown) {
                console.info('[onboarding-tour] skipped: already seen, no wizard this session. Use the Help button to replay.');
                return;
            }
            // Two rAFs so chat.js (DOMContentLoaded) has finished rendering
            // the sidebar/header before driver.js measures element rects.
            requestAnimationFrame(() => requestAnimationFrame(start));
        });
    }

    /**
     * Public entry point — useful for the Help button or manual replay.
     * Bypasses the standalone-mode check (so the tour can be inspected in any
     * context). Unlike auto-start, it does NOT wait for a hypothetical wizard
     * to appear — only defers if the wizard is currently visible. (Auto-start
     * runs at page load when the wizard's 3 s self-delay matters; a Help click
     * happens later, so any deadline-based wait would just be dead time.)
     */
    window.startOnboardingTour = function () {
        try {
            localStorage.removeItem(STORAGE_KEY);
        } catch (_) {
            /* ignore */
        }
        const visible = document.getElementById('pwa-install-overlay');
        if (visible) {
            watchForRemoval(visible, start);
        } else {
            start();
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', maybeAutoStart, { once: true });
    } else {
        maybeAutoStart();
    }
})();
