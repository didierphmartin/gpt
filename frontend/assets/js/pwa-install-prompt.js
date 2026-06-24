/**
 * PWA install + setup wizard.
 *
 * Multi-step overlay shown after first paint settles. Steps:
 *   1. Language        — English / Français / Español. Drives the rest.
 *   2. Welcome         — quick overview of what's coming.
 *   3. Root folder     — showDirectoryPicker → handle stored in IndexedDB.
 *   4. Install         — deferredPrompt.prompt() → PWA install.
 *
 * iOS Safari has neither `beforeinstallprompt` nor `showDirectoryPicker`.
 * Folder step shows an unsupported notice; install step shows the manual
 * Share → Add to Home Screen instructions.
 *
 * TEST_MODE = true: wizard is shown on every session (even when already
 * installed) so the wording / flow can be iterated. Flip to false to enable
 * the 7-day snooze and skip-when-installed behavior.
 */

(function () {
    'use strict';

    // ---- constants -------------------------------------------------
    const SNOOZE_KEY = 'pwa-install-prompt-snooze';
    const NEVER_KEY  = 'pwa-install-prompt-disabled';
    const LANG_KEY   = 'ufs-wizard-lang';
    const SNOOZE_MS  = 7 * 24 * 60 * 60 * 1000;
    const SHOW_DELAY_MS = 3000;

    const HANDLE_DB    = 'universalfs';
    const HANDLE_STORE = 'handles';
    const HANDLE_KEY   = 'ufs-root-handle';

    // Show on every session during the test period.
    const TEST_MODE = false;

    // ---- translations ---------------------------------------------
    const STRINGS = {
        en: {
            'lang.title':     'Choose your language',
            'lang.continue':  'Continue',
            'welcome.title':  'Welcome to Synergy AI Chat',
            'welcome.intro':  "Let's set up Synergy in two quick steps.",
            'welcome.b1':     'Pick a root folder where Synergy will read and write files.',
            'welcome.b2':     'Install Synergy as a local app on your device.',
            'welcome.next':   'Get started',
            'folder.title':   'Choose a root folder',
            'folder.desc':    'All files Synergy creates or reads will live inside this folder.',
            'folder.pick':    'Choose folder…',
            'folder.change':  'Change folder…',
            'folder.picked':  'Selected:',
            'folder.unsup':   "Your browser doesn't support folder selection. Try Chrome or Edge.",
            'folder.next':    'Next',
            'install.title':  'Install Synergy as a local app',
            'install.desc':   'Launch from your dock or Start menu — and the folder permission persists across sessions.',
            'install.note':   'On first launch in the installed app, your browser will ask once to confirm folder access. Please choose "Allow on every visit".',
            'install.btn':    'Install app',
            'install.already':'✓ Already installed',
            'install.iosTitle':'To install on iOS',
            'install.iosStep1':'Tap the Share button',
            'install.iosStep2':"Choose 'Add to Home Screen'",
            'install.done':   'Done',
            'back':           'Back',
            'close':          'Close',
            'testBanner':     'Test mode — wizard shown every visit for iteration.'
        },
        fr: {
            'lang.title':     'Choisissez votre langue',
            'lang.continue':  'Continuer',
            'welcome.title':  'Bienvenue sur Synergy AI Chat',
            'welcome.intro':  'Configurons Synergy en deux étapes rapides.',
            'welcome.b1':     'Choisir un dossier racine où Synergy lira et écrira des fichiers.',
            'welcome.b2':     'Installer Synergy comme une application locale sur votre appareil.',
            'welcome.next':   'Commencer',
            'folder.title':   'Choisir un dossier racine',
            'folder.desc':    'Tous les fichiers que Synergy crée ou lit se trouveront dans ce dossier.',
            'folder.pick':    'Choisir un dossier…',
            'folder.change':  'Changer de dossier…',
            'folder.picked':  'Sélectionné :',
            'folder.unsup':   "Votre navigateur ne prend pas en charge la sélection de dossier. Essayez Chrome ou Edge.",
            'folder.next':    'Suivant',
            'install.title':  "Installer Synergy comme application locale",
            'install.desc':   "Lancez-la depuis votre dock ou menu Démarrer — et l'accès au dossier sera conservé entre les sessions.",
            'install.note':   "Au premier lancement de l'application installée, le navigateur demandera une fois de confirmer l'accès au dossier. Choisissez « Autoriser à chaque visite ».",
            'install.btn':    "Installer l'application",
            'install.already':'✓ Déjà installée',
            'install.iosTitle':'Pour installer sur iOS',
            'install.iosStep1':'Appuyez sur le bouton Partager',
            'install.iosStep2':"Choisissez « Sur l'écran d'accueil »",
            'install.done':   'Terminé',
            'back':           'Retour',
            'close':          'Fermer',
            'testBanner':     "Mode test — l'assistant s'affiche à chaque visite pour itération."
        },
        es: {
            'lang.title':     'Elige tu idioma',
            'lang.continue':  'Continuar',
            'welcome.title':  'Bienvenido a Synergy AI Chat',
            'welcome.intro':  'Configuremos Synergy en dos pasos rápidos.',
            'welcome.b1':     'Elegir una carpeta raíz donde Synergy leerá y escribirá archivos.',
            'welcome.b2':     'Instalar Synergy como una aplicación local en tu dispositivo.',
            'welcome.next':   'Empezar',
            'folder.title':   'Elige una carpeta raíz',
            'folder.desc':    'Todos los archivos que Synergy cree o lea estarán dentro de esta carpeta.',
            'folder.pick':    'Elegir carpeta…',
            'folder.change':  'Cambiar carpeta…',
            'folder.picked':  'Seleccionada:',
            'folder.unsup':   'Tu navegador no permite seleccionar carpetas. Prueba Chrome o Edge.',
            'folder.next':    'Siguiente',
            'install.title':  'Instalar Synergy como aplicación local',
            'install.desc':   'Lánzala desde tu dock o menú Inicio, y el permiso de la carpeta se mantendrá entre sesiones.',
            'install.note':   'Al abrir la app instalada por primera vez, el navegador pedirá confirmar el acceso a la carpeta una vez. Elige «Permitir en cada visita».',
            'install.btn':    'Instalar app',
            'install.already':'✓ Ya está instalada',
            'install.iosTitle':'Para instalar en iOS',
            'install.iosStep1':'Toca el botón Compartir',
            'install.iosStep2':'Selecciona «Añadir a pantalla de inicio»',
            'install.done':   'Listo',
            'back':           'Atrás',
            'close':          'Cerrar',
            'testBanner':     'Modo de prueba: el asistente se muestra en cada visita para iterar.'
        }
    };

    let currentLang = 'en';
    function t(key) {
        return (STRINGS[currentLang] && STRINGS[currentLang][key]) || STRINGS.en[key] || key;
    }
    function loadStoredLang() {
        try {
            const saved = window.localStorage.getItem(LANG_KEY);
            if (saved && STRINGS[saved]) currentLang = saved;
        } catch {}
    }
    function setLang(lang) {
        if (!STRINGS[lang]) return;
        currentLang = lang;
        try { window.localStorage.setItem(LANG_KEY, lang); } catch {}
        // Hand off to the app's i18n manager if present.
        if (window.i18n && typeof window.i18n.setLanguage === 'function') {
            try { window.i18n.setLanguage(lang); } catch {}
        }
    }

    // ---- IndexedDB: persist FileSystemDirectoryHandle -------------
    function openHandleDB() {
        return new Promise((resolve, reject) => {
            const req = window.indexedDB.open(HANDLE_DB, 1);
            req.onupgradeneeded = () => req.result.createObjectStore(HANDLE_STORE);
            req.onsuccess = () => resolve(req.result);
            req.onerror   = () => reject(req.error);
        });
    }
    async function saveRootHandle(handle) {
        const db = await openHandleDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(HANDLE_STORE, 'readwrite');
            tx.objectStore(HANDLE_STORE).put(handle, HANDLE_KEY);
            tx.oncomplete = () => resolve();
            tx.onerror    = () => reject(tx.error);
        });
    }
    async function loadRootHandle() {
        const db = await openHandleDB();
        return new Promise((resolve, reject) => {
            const tx  = db.transaction(HANDLE_STORE, 'readonly');
            const req = tx.objectStore(HANDLE_STORE).get(HANDLE_KEY);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror   = () => reject(req.error);
        });
    }
    // Expose for the rest of the app to consume on boot.
    window.UniversalFSWizard = window.UniversalFSWizard || {};
    window.UniversalFSWizard.loadRootHandle = loadRootHandle;
    window.UniversalFSWizard.saveRootHandle = saveRootHandle;

    // ---- capability detection -------------------------------------
    const isInstalled = () => {
        if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
        if (window.navigator.standalone === true) return true;
        return false;
    };
    const isIOSSafari = () => {
        const ua = window.navigator.userAgent;
        const isIOS    = /iPad|iPhone|iPod/.test(ua);
        const isSafari = /^((?!chrome|android|crios|fxios).)*safari/i.test(ua);
        return isIOS && isSafari;
    };
    const isFSASupported = () => 'showDirectoryPicker' in window;

    // ---- snooze ---------------------------------------------------
    const isSnoozed = () => {
        if (TEST_MODE) return false;
        try {
            if (window.localStorage.getItem(NEVER_KEY) === '1') return true;
            const ts = parseInt(window.localStorage.getItem(SNOOZE_KEY) || '0', 10);
            return ts > 0 && (Date.now() - ts) < SNOOZE_MS;
        } catch { return false; }
    };
    const setSnoozed = () => {
        if (TEST_MODE) return;
        try { window.localStorage.setItem(SNOOZE_KEY, String(Date.now())); } catch {}
    };
    // Permanently mark the wizard as seen so it never auto-shows again. Called
    // when the user finishes or dismisses the wizard, so it appears only on the
    // first run (per browser) and never afterwards.
    const dismissForever = () => {
        try { window.localStorage.setItem(NEVER_KEY, '1'); } catch {}
    };

    // ---- listeners ------------------------------------------------
    let deferredPrompt = null;
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredPrompt = e;
        // If the wizard is already on the install step, refresh so the
        // install button enables.
        if (document.getElementById('pwa-install-overlay') && wizardState.step === 'install') {
            render();
        }
    });
    window.addEventListener('appinstalled', () => {
        deferredPrompt = null;
        document.getElementById('pwa-install-overlay')?.remove();
    });

    // ---- wizard state + rendering ---------------------------------
    let wizardState = { step: 'lang', rootHandle: null, rootName: null };
    let abortCtl = null;

    function buildShell() {
        const existing = document.getElementById('pwa-install-overlay');
        if (existing) return existing;

        const overlay = document.createElement('div');
        overlay.id = 'pwa-install-overlay';
        overlay.className = 'fixed inset-0 z-[1000] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm';
        overlay.innerHTML = `
            <div class="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 sm:p-7">
                <div data-pwa-content></div>
                ${TEST_MODE ? '<p class="text-[10px] text-gray-400 mt-4 text-center" data-pwa-testbanner></p>' : ''}
            </div>
        `;
        document.body.appendChild(overlay);

        // Backdrop click closes (snooze in non-test mode; reopens next load in test mode).
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                setSnoozed();
                overlay.remove();
            }
        });

        return overlay;
    }

    function render() {
        const overlay = buildShell();
        const card    = overlay.querySelector('[data-pwa-content]');
        if (!card) return;

        const step = wizardState.step;
        if      (step === 'lang')    card.innerHTML = renderLang();
        else if (step === 'welcome') card.innerHTML = renderWelcome();
        else if (step === 'folder')  card.innerHTML = renderFolder();
        else if (step === 'install') card.innerHTML = renderInstall();

        const banner = overlay.querySelector('[data-pwa-testbanner]');
        if (banner) banner.textContent = t('testBanner');

        // Re-bind delegated click via a fresh AbortController so we never stack listeners.
        abortCtl?.abort();
        abortCtl = new AbortController();
        card.addEventListener('click', handleAction, { signal: abortCtl.signal });
    }

    function header(titleKey) {
        return `
            <div class="flex items-start gap-4 mb-4">
                <img src="assets/images/icon-192.png" alt="" class="w-14 h-14 rounded-xl shadow-sm flex-shrink-0" />
                <div class="flex-1 min-w-0">
                    <h2 class="text-lg font-semibold text-gray-900">${esc(t(titleKey))}</h2>
                </div>
                <button data-pwa-action="close" aria-label="${esc(t('close'))}"
                    class="text-gray-400 hover:text-gray-600 flex-shrink-0">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
                </button>
            </div>
        `;
    }

    function renderLang() {
        const opts = [
            { code: 'en', label: 'English' },
            { code: 'fr', label: 'Français' },
            { code: 'es', label: 'Español' }
        ];
        const buttons = opts.map(o => `
            <button data-pwa-action="lang" data-lang="${o.code}"
                class="w-full text-left px-4 py-3 text-sm font-medium border rounded-md transition
                       ${currentLang === o.code ? 'border-blue-600 bg-blue-50 text-blue-900' : 'border-gray-200 hover:bg-gray-50 text-gray-900'}">
                ${esc(o.label)}
            </button>
        `).join('');

        return `
            ${header('lang.title')}
            <div class="space-y-2 mb-5">${buttons}</div>
            <div class="flex justify-end">
                <button data-pwa-action="next" data-from="lang"
                    class="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-md transition">
                    ${esc(t('lang.continue'))}
                </button>
            </div>
        `;
    }

    function renderWelcome() {
        const num = (n) => `<span class="flex-shrink-0 w-6 h-6 rounded-full bg-blue-600 text-white text-xs font-semibold flex items-center justify-center mt-0.5">${n}</span>`;
        return `
            ${header('welcome.title')}
            <p class="text-sm text-gray-700 mb-4">${esc(t('welcome.intro'))}</p>
            <ol class="space-y-2 text-sm text-gray-700 mb-5">
                <li class="flex items-start gap-3">${num(1)}<span>${esc(t('welcome.b1'))}</span></li>
                <li class="flex items-start gap-3">${num(2)}<span>${esc(t('welcome.b2'))}</span></li>
            </ol>
            <div class="flex justify-between">
                <button data-pwa-action="back" data-from="welcome"
                    class="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-md transition">
                    ${esc(t('back'))}
                </button>
                <button data-pwa-action="next" data-from="welcome"
                    class="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-md transition">
                    ${esc(t('welcome.next'))}
                </button>
            </div>
        `;
    }

    function renderFolder() {
        const supported = isFSASupported();
        const picked    = wizardState.rootName;

        let body;
        if (!supported) {
            body = `
            <div class="bg-yellow-50 border border-yellow-200 rounded-lg p-3 mb-5 text-sm text-yellow-900">
                ${esc(t('folder.unsup'))}
            </div>
        `;
        } else if (picked) {
            // Folder chosen: drop the picker zone, show the selection prominently.
            body = `
            <p class="text-sm text-gray-700 mb-4">${esc(t('folder.desc'))}</p>
            <div class="mb-5">
                <div class="flex items-center gap-3 px-4 py-4 border-2 border-blue-500 bg-blue-50 rounded-lg">
                    <svg class="w-8 h-8 text-blue-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/></svg>
                    <div class="flex-1 min-w-0">
                        <p class="text-[11px] font-semibold uppercase tracking-wide text-blue-600">${esc(t('folder.picked'))}</p>
                        <p class="text-lg font-semibold text-gray-900 truncate" title="${esc(picked)}">${esc(picked)}</p>
                    </div>
                    <svg class="w-6 h-6 text-green-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
                </div>
                <button data-pwa-action="pick-folder"
                    class="mt-2 text-xs font-medium text-blue-600 hover:text-blue-800 underline">
                    ${esc(t('folder.change'))}
                </button>
            </div>
        `;
        } else {
            body = `
            <p class="text-sm text-gray-700 mb-4">${esc(t('folder.desc'))}</p>
            <div class="mb-5">
                <button data-pwa-action="pick-folder"
                    class="w-full px-4 py-3 text-sm font-medium border-2 border-dashed border-gray-300 hover:border-blue-500 hover:bg-blue-50 rounded-md transition text-gray-700">
                    ${esc(t('folder.pick'))}
                </button>
            </div>
        `;
        }

        const nextDisabled = supported && !picked;
        return `
            ${header('folder.title')}
            ${body}
            <div class="flex justify-between">
                <button data-pwa-action="back" data-from="folder"
                    class="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-md transition">
                    ${esc(t('back'))}
                </button>
                <button data-pwa-action="next" data-from="folder"
                    class="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-md transition disabled:opacity-50 disabled:cursor-not-allowed"
                    ${nextDisabled ? 'disabled' : ''}>
                    ${esc(t('folder.next'))}
                </button>
            </div>
        `;
    }

    function renderInstall() {
        const installed = isInstalled();
        const canInstall = !!deferredPrompt && !installed;

        const body = `
            <p class="text-sm text-gray-700 mb-3">${esc(t('install.desc'))}</p>
            <p class="text-xs text-gray-500 mb-5">${esc(t('install.note'))}</p>
            ${installed ? `
                <div class="bg-green-50 border border-green-200 rounded-lg p-3 mb-4 text-sm text-green-900 text-center font-medium">
                    ${esc(t('install.already'))}
                </div>
            ` : ''}
        `;

        const primaryBtn = installed
            ? `<button data-pwa-action="finish"
                    class="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-md transition">
                    ${esc(t('install.done'))}
                </button>`
            : `<button data-pwa-action="install"
                    class="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-md transition disabled:opacity-50 disabled:cursor-not-allowed"
                    ${canInstall ? '' : 'disabled'}>
                    ${esc(t('install.btn'))}
                </button>`;

        return `
            ${header('install.title')}
            ${body}
            <div class="flex justify-between">
                <button data-pwa-action="back" data-from="install"
                    class="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-md transition">
                    ${esc(t('back'))}
                </button>
                ${primaryBtn}
            </div>
        `;
    }

    // iOS Safari: simple, single-screen overlay (no wizard). Mirrors the
    // original UX — Share → Add to Home Screen. Uses the wizard's language
    // strings so it still respects whatever language the app i18n already set.
    function showIOSOverlay() {
        const overlay = document.createElement('div');
        overlay.id = 'pwa-install-overlay';
        overlay.className = 'fixed inset-0 z-[1000] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm';
        overlay.innerHTML = `
            <div class="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 sm:p-7">
                <div class="flex items-start gap-4 mb-4">
                    <img src="assets/images/icon-192.png" alt="" class="w-14 h-14 rounded-xl shadow-sm flex-shrink-0" />
                    <div class="flex-1 min-w-0">
                        <h2 class="text-lg font-semibold text-gray-900">${esc(t('welcome.title'))}</h2>
                    </div>
                    <button data-pwa-action="close" aria-label="${esc(t('close'))}"
                        class="text-gray-400 hover:text-gray-600 flex-shrink-0">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
                    </button>
                </div>
                <div class="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4 text-sm text-blue-900">
                    <p class="font-medium mb-1">${esc(t('install.iosTitle'))}:</p>
                    <ol class="list-decimal list-inside space-y-0.5 text-blue-800">
                        <li>${esc(t('install.iosStep1'))}</li>
                        <li>${esc(t('install.iosStep2'))}</li>
                    </ol>
                </div>
                <div class="flex justify-end">
                    <button data-pwa-action="finish"
                        class="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-md transition">
                        ${esc(t('install.done'))}
                    </button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        overlay.addEventListener('click', (e) => {
            const action = e.target.closest('[data-pwa-action]')?.dataset.pwaAction;
            if (action === 'finish' || action === 'close' || e.target === overlay) {
                dismissForever();
                overlay.remove();
            }
        });
    }

    // ---- action handler -------------------------------------------
    async function handleAction(e) {
        const target = e.target.closest('[data-pwa-action]');
        if (!target) return;
        const action = target.dataset.pwaAction;

        if (action === 'lang') {
            setLang(target.dataset.lang);
            render();
            return;
        }
        if (action === 'next') {
            const from = target.dataset.from;
            if      (from === 'lang')    wizardState.step = 'welcome';
            else if (from === 'welcome') wizardState.step = 'folder';
            else if (from === 'folder')  wizardState.step = 'install';
            render();
            return;
        }
        if (action === 'back') {
            const from = target.dataset.from;
            if      (from === 'welcome') wizardState.step = 'lang';
            else if (from === 'folder')  wizardState.step = 'welcome';
            else if (from === 'install') wizardState.step = 'folder';
            render();
            return;
        }
        if (action === 'pick-folder') {
            try {
                const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
                wizardState.rootHandle = handle;
                wizardState.rootName   = handle.name;
                await saveRootHandle(handle);
                // Auto-create the standard subdirectories the rest of the
                // app expects: `skills/` (folder-backed Skills) and
                // `outputs/` (skill-generated documents). Idempotent.
                if (window.localFs && typeof window.localFs.ensureStandardSubdirs === 'function') {
                    try {
                        await window.localFs.ensureStandardSubdirs(handle);
                    } catch (e) {
                        console.warn('[wizard] could not pre-create standard subdirs:', e);
                    }
                }
                render();
            } catch (err) {
                if (err && err.name !== 'AbortError') console.warn('[wizard] pick-folder failed:', err);
            }
            return;
        }
        if (action === 'install') {
            if (!deferredPrompt) return;
            try {
                deferredPrompt.prompt();
                const choice = await deferredPrompt.userChoice;
                if (!choice || choice.outcome !== 'accepted') setSnoozed();
                // 'appinstalled' handler removes the overlay on success.
            } catch (err) {
                console.warn('[wizard] install prompt failed:', err);
            } finally {
                deferredPrompt = null;
            }
            return;
        }
        if (action === 'finish' || action === 'close') {
            dismissForever();
            document.getElementById('pwa-install-overlay')?.remove();
            return;
        }
    }

    // ---- HTML escape ----------------------------------------------
    function esc(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // ---- entry ----------------------------------------------------
    function maybeShow() {
        if (!TEST_MODE && isInstalled()) return;
        if (isSnoozed()) return;

        loadStoredLang();

        // iOS Safari stays simple — single-screen "Share → Add to Home Screen"
        // overlay, no wizard. FSA isn't supported there anyway, so the folder
        // step would be moot.
        if (isIOSSafari()) {
            showIOSOverlay();
            return;
        }

        wizardState = { step: 'lang', rootHandle: null, rootName: null };
        render();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(maybeShow, SHOW_DELAY_MS));
    } else {
        setTimeout(maybeShow, SHOW_DELAY_MS);
    }
})();
