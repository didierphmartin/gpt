/**
 * Settings → Account → "App installation" panel.
 *
 * Tells the user whether they're running in a regular browser tab or the
 * installed PWA, and gives platform-specific copy-paste instructions for
 * removing the installed app. Browsers don't expose a JS API to uninstall
 * (security boundary — otherwise any site could nuke your installs), so the
 * only honest option is clear directions.
 *
 * Also exposes a "Reset install-prompt state" button that clears the
 * snooze/dismiss localStorage flags. Useful while we're iterating on the
 * install dialog wording / wizard.
 *
 * Language follows the install wizard's choice (localStorage key
 * `ufs-wizard-lang`). Falls back to English when unset or unknown.
 */

(function () {
    'use strict';

    const SNOOZE_KEY = 'pwa-install-prompt-snooze';
    const NEVER_KEY  = 'pwa-install-prompt-disabled';
    const LANG_KEY   = 'ufs-wizard-lang';

    function getLang() {
        try {
            const v = window.localStorage.getItem(LANG_KEY);
            if (v === 'fr' || v === 'es' || v === 'en') return v;
        } catch {}
        return 'en';
    }

    const isStandalone = () => {
        if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
        if (window.navigator.standalone === true) return true;
        return false;
    };

    /**
     * Detect the user's environment to pick the right instructions.
     * Order matters — Edge contains "chrome" in its UA, mobile Chrome differs
     * from desktop Chrome, etc.
     */
    function detectEnvironment() {
        const ua = window.navigator.userAgent;
        const isIOS = /iPad|iPhone|iPod/.test(ua);
        const isAndroid = /Android/.test(ua);
        const isEdge = /Edg\//.test(ua);
        const isFirefox = /Firefox\//.test(ua);
        const isSafariMacOS = !isIOS && /Safari\//.test(ua) && !/Chrome|Chromium|Edg\/|OPR\//.test(ua);
        const isChromium = !isFirefox && !isSafariMacOS && !isEdge && /Chrome\//.test(ua);

        if (isIOS) return 'ios';
        if (isAndroid) return 'android';
        if (isEdge) return 'edge-desktop';
        if (isFirefox) return 'firefox';
        if (isSafariMacOS) return 'safari-mac';
        if (isChromium) return 'chrome-desktop';
        return 'other';
    }

    // Per-language copy. HTML in `steps`/`altSteps` is rendered as-is.
    const I18N = {
        en: {
            statusInstalledTitle: 'Running as installed app',
            statusInstalledDesc:  "You're using the standalone PWA window. Use the steps below to remove it from your device.",
            statusBrowserTitle:   'Running in browser',
            statusBrowserDesc:    'If you previously installed the app, the steps below will remove that copy. The install prompt will offer it again on next reload.',
            cleared: '✓ Cleared',
            instructions: {
                'chrome-desktop': {
                    title: 'Uninstall on Chrome (desktop)',
                    steps: [
                        'Open the installed Synergy window.',
                        'Click the <strong>⋮</strong> menu in the top-right corner of that window.',
                        'Choose <strong>Uninstall Synergy AI Chat…</strong> and confirm.',
                    ],
                    altSteps: [
                        'Or, in any Chrome window, open <code>chrome://apps</code> in the address bar.',
                        'Right-click <strong>Synergy AI Chat</strong> → <strong>Remove from Chrome…</strong>.',
                    ],
                },
                'edge-desktop': {
                    title: 'Uninstall on Edge (desktop)',
                    steps: [
                        'Open the installed Synergy window.',
                        'Click the <strong>⋯</strong> menu in the top-right corner of that window.',
                        'Choose <strong>App settings</strong>, then click <strong>Uninstall</strong>.',
                    ],
                    altSteps: [
                        'Or, in any Edge window, open <code>edge://apps</code> in the address bar.',
                        'Click <strong>Details</strong> on Synergy → <strong>Uninstall</strong>.',
                    ],
                },
                'android': {
                    title: 'Uninstall on Android',
                    steps: [
                        'On your home screen, press and hold the <strong>Synergy</strong> app icon.',
                        'Drag it to <strong>Uninstall</strong> (or tap <strong>App info</strong> → <strong>Uninstall</strong>).',
                    ],
                },
                'ios': {
                    title: 'Remove on iOS',
                    steps: [
                        'On your home screen, press and hold the <strong>Synergy</strong> icon.',
                        'Tap <strong>Remove App</strong>, then <strong>Delete from Home Screen</strong>.',
                    ],
                },
                'firefox': {
                    title: 'Firefox',
                    steps: [
                        "Firefox doesn't install web apps the same way Chrome/Edge do — there's nothing to uninstall.",
                    ],
                },
                'safari-mac': {
                    title: 'Safari (macOS)',
                    steps: [
                        "Safari on macOS doesn't install web apps as standalone apps — nothing to uninstall here.",
                        'If you added Synergy via the <strong>File → Add to Dock</strong> menu (macOS Sonoma+), open the Dock entry, click the <strong>Synergy</strong> menu, then <strong>Quit & Remove from Dock</strong>.',
                    ],
                },
                'other': {
                    title: 'Uninstall',
                    steps: [
                        "Look for <strong>Synergy AI Chat</strong> in your operating system's installed apps list and remove it from there.",
                    ],
                },
            },
        },
        fr: {
            statusInstalledTitle: 'Application installée en cours d\'exécution',
            statusInstalledDesc:  'Vous utilisez la fenêtre autonome de la PWA. Suivez les étapes ci-dessous pour la retirer de votre appareil.',
            statusBrowserTitle:   'Exécution dans le navigateur',
            statusBrowserDesc:    "Si vous aviez précédemment installé l'application, les étapes ci-dessous supprimeront cette copie. L'invite d'installation la proposera à nouveau au prochain rechargement.",
            cleared: '✓ Effacé',
            instructions: {
                'chrome-desktop': {
                    title: 'Désinstaller sur Chrome (ordinateur)',
                    steps: [
                        'Ouvrez la fenêtre Synergy installée.',
                        'Cliquez sur le menu <strong>⋮</strong> en haut à droite de cette fenêtre.',
                        'Choisissez <strong>Désinstaller Synergy AI Chat…</strong> et confirmez.',
                    ],
                    altSteps: [
                        "Ou, dans n'importe quelle fenêtre Chrome, ouvrez <code>chrome://apps</code> dans la barre d'adresse.",
                        'Faites un clic droit sur <strong>Synergy AI Chat</strong> → <strong>Supprimer de Chrome…</strong>.',
                    ],
                },
                'edge-desktop': {
                    title: 'Désinstaller sur Edge (ordinateur)',
                    steps: [
                        'Ouvrez la fenêtre Synergy installée.',
                        'Cliquez sur le menu <strong>⋯</strong> en haut à droite de cette fenêtre.',
                        "Choisissez <strong>Paramètres de l'application</strong>, puis cliquez sur <strong>Désinstaller</strong>.",
                    ],
                    altSteps: [
                        "Ou, dans n'importe quelle fenêtre Edge, ouvrez <code>edge://apps</code> dans la barre d'adresse.",
                        'Cliquez sur <strong>Détails</strong> sur Synergy → <strong>Désinstaller</strong>.',
                    ],
                },
                'android': {
                    title: 'Désinstaller sur Android',
                    steps: [
                        "Sur votre écran d'accueil, appuyez longuement sur l'icône de l'application <strong>Synergy</strong>.",
                        "Faites-la glisser vers <strong>Désinstaller</strong> (ou appuyez sur <strong>Infos sur l'appli</strong> → <strong>Désinstaller</strong>).",
                    ],
                },
                'ios': {
                    title: 'Supprimer sur iOS',
                    steps: [
                        "Sur votre écran d'accueil, appuyez longuement sur l'icône <strong>Synergy</strong>.",
                        "Touchez <strong>Supprimer l'app</strong>, puis <strong>Supprimer de l'écran d'accueil</strong>.",
                    ],
                },
                'firefox': {
                    title: 'Firefox',
                    steps: [
                        "Firefox n'installe pas les applications web de la même manière que Chrome/Edge — il n'y a rien à désinstaller.",
                    ],
                },
                'safari-mac': {
                    title: 'Safari (macOS)',
                    steps: [
                        "Safari sur macOS n'installe pas les applications web comme des applications autonomes — il n'y a rien à désinstaller ici.",
                        'Si vous avez ajouté Synergy via le menu <strong>Fichier → Ajouter au Dock</strong> (macOS Sonoma+), ouvrez l\'entrée du Dock, cliquez sur le menu <strong>Synergy</strong>, puis <strong>Quitter et retirer du Dock</strong>.',
                    ],
                },
                'other': {
                    title: 'Désinstaller',
                    steps: [
                        "Cherchez <strong>Synergy AI Chat</strong> dans la liste des applications installées de votre système d'exploitation et supprimez-la depuis là.",
                    ],
                },
            },
        },
        es: {
            statusInstalledTitle: 'Ejecutándose como app instalada',
            statusInstalledDesc:  'Estás usando la ventana independiente de la PWA. Sigue los pasos siguientes para eliminarla de tu dispositivo.',
            statusBrowserTitle:   'Ejecutándose en el navegador',
            statusBrowserDesc:    'Si instalaste la app anteriormente, los pasos siguientes eliminarán esa copia. El aviso de instalación la ofrecerá de nuevo en la próxima recarga.',
            cleared: '✓ Borrado',
            instructions: {
                'chrome-desktop': {
                    title: 'Desinstalar en Chrome (escritorio)',
                    steps: [
                        'Abre la ventana de Synergy instalada.',
                        'Haz clic en el menú <strong>⋮</strong> en la esquina superior derecha de esa ventana.',
                        'Elige <strong>Desinstalar Synergy AI Chat…</strong> y confirma.',
                    ],
                    altSteps: [
                        'O, en cualquier ventana de Chrome, abre <code>chrome://apps</code> en la barra de direcciones.',
                        'Haz clic derecho en <strong>Synergy AI Chat</strong> → <strong>Quitar de Chrome…</strong>.',
                    ],
                },
                'edge-desktop': {
                    title: 'Desinstalar en Edge (escritorio)',
                    steps: [
                        'Abre la ventana de Synergy instalada.',
                        'Haz clic en el menú <strong>⋯</strong> en la esquina superior derecha de esa ventana.',
                        'Elige <strong>Configuración de la aplicación</strong>, luego haz clic en <strong>Desinstalar</strong>.',
                    ],
                    altSteps: [
                        'O, en cualquier ventana de Edge, abre <code>edge://apps</code> en la barra de direcciones.',
                        'Haz clic en <strong>Detalles</strong> en Synergy → <strong>Desinstalar</strong>.',
                    ],
                },
                'android': {
                    title: 'Desinstalar en Android',
                    steps: [
                        'En tu pantalla de inicio, mantén pulsado el icono de la app <strong>Synergy</strong>.',
                        'Arrástralo a <strong>Desinstalar</strong> (o toca <strong>Información de la app</strong> → <strong>Desinstalar</strong>).',
                    ],
                },
                'ios': {
                    title: 'Eliminar en iOS',
                    steps: [
                        'En tu pantalla de inicio, mantén pulsado el icono de <strong>Synergy</strong>.',
                        'Toca <strong>Eliminar app</strong>, luego <strong>Eliminar de la pantalla de inicio</strong>.',
                    ],
                },
                'firefox': {
                    title: 'Firefox',
                    steps: [
                        'Firefox no instala apps web de la misma manera que Chrome/Edge — no hay nada que desinstalar.',
                    ],
                },
                'safari-mac': {
                    title: 'Safari (macOS)',
                    steps: [
                        'Safari en macOS no instala apps web como apps independientes — no hay nada que desinstalar aquí.',
                        'Si añadiste Synergy mediante el menú <strong>Archivo → Añadir al Dock</strong> (macOS Sonoma+), abre la entrada del Dock, haz clic en el menú <strong>Synergy</strong>, y luego <strong>Salir y quitar del Dock</strong>.',
                    ],
                },
                'other': {
                    title: 'Desinstalar',
                    steps: [
                        'Busca <strong>Synergy AI Chat</strong> en la lista de aplicaciones instaladas de tu sistema operativo y elimínala desde allí.',
                    ],
                },
            },
        },
    };

    function dict() {
        return I18N[getLang()] || I18N.en;
    }

    function renderStatus(statusEl, installed) {
        const d = dict();
        if (installed) {
            statusEl.className = 'mb-4 p-3 rounded-lg border bg-green-50 border-green-200 text-green-800 text-sm';
            statusEl.innerHTML = `
                <div class="flex items-start gap-2">
                    <svg class="w-5 h-5 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
                    </svg>
                    <div>
                        <div class="font-medium">${d.statusInstalledTitle}</div>
                        <div class="text-green-700 text-xs mt-0.5">${d.statusInstalledDesc}</div>
                    </div>
                </div>
            `;
        } else {
            statusEl.className = 'mb-4 p-3 rounded-lg border bg-gray-50 border-gray-200 text-gray-700 text-sm';
            statusEl.innerHTML = `
                <div class="flex items-start gap-2">
                    <svg class="w-5 h-5 flex-shrink-0 mt-0.5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z M12 9v4 M12 17h.01"/>
                    </svg>
                    <div>
                        <div class="font-medium">${d.statusBrowserTitle}</div>
                        <div class="text-gray-500 text-xs mt-0.5">${d.statusBrowserDesc}</div>
                    </div>
                </div>
            `;
        }
    }

    function renderInstructions(panelEl, env) {
        const d = dict();
        const guide = d.instructions[env] || d.instructions['other'];
        const stepHtml = (steps) => steps.map((s, i) =>
            `<li class="text-sm text-gray-700"><span class="text-gray-400 mr-1">${i + 1}.</span>${s}</li>`
        ).join('');

        panelEl.classList.remove('hidden');
        panelEl.innerHTML = `
            <div class="border border-gray-200 rounded-lg p-4 bg-white">
                <div class="text-sm font-medium text-gray-900 mb-2">${guide.title}</div>
                <ol class="space-y-1 mb-2">
                    ${stepHtml(guide.steps)}
                </ol>
                ${guide.altSteps ? `
                    <div class="text-xs text-gray-500 mt-3 pt-3 border-t border-gray-100">
                        <ol class="space-y-1">${stepHtml(guide.altSteps)}</ol>
                    </div>
                ` : ''}
            </div>
        `;
    }

    function wireResetButton(btn) {
        if (!btn) return;
        btn.addEventListener('click', () => {
            try {
                window.localStorage.removeItem(SNOOZE_KEY);
                window.localStorage.removeItem(NEVER_KEY);
            } catch {}
            const original = btn.textContent;
            btn.textContent = dict().cleared;
            btn.disabled = true;
            setTimeout(() => {
                btn.textContent = original;
                btn.disabled = false;
            }, 1500);
        });
    }

    /**
     * Render the panel. Called once on DOMContentLoaded — content is static
     * per page load (the install state doesn't change without a full reload).
     */
    function init() {
        const statusEl = document.getElementById('pwa-install-status');
        const instructionsEl = document.getElementById('pwa-uninstall-instructions');
        const resetBtn = document.getElementById('pwa-reset-prompt-btn');

        if (!statusEl || !instructionsEl) return;

        const env = detectEnvironment();
        const installed = isStandalone();
        renderStatus(statusEl, installed);
        renderInstructions(instructionsEl, env);
        wireResetButton(resetBtn);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
