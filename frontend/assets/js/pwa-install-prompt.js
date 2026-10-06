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

    // Hosted users rent LLM time; they have no keys to enter. The individual
    // edition ships with no keys by design, so this is where its one user
    // supplies their own. Corporate ships with no keys either, but both
    // endpoints this step calls require admin -- an ordinary corporate user
    // would get 403s and be told to do it in Settings, which is also
    // admin-only -- so only the admin can add them there, not here.
    const SHOW_KEYS_STEP = !!(window.APP_CONFIG && window.APP_CONFIG.GPT_EDITION === 'individual');

    // The eight providers the container seeds into system_llm_settings with an
    // empty api_key. This step fills those rows in; it does not create them.
    const KEY_PROVIDERS = [
        { key: 'claude',   label: 'Claude',   where: 'console.anthropic.com' },
        { key: 'openai',   label: 'OpenAI',   where: 'platform.openai.com/api-keys' },
        { key: 'gemini',   label: 'Gemini',   where: 'aistudio.google.com/apikey' },
        { key: 'grok',     label: 'Grok',     where: 'console.x.ai' },
        { key: 'deepseek', label: 'DeepSeek', where: 'platform.deepseek.com' },
        { key: 'kimi',     label: 'Kimi',     where: 'platform.moonshot.ai' },
        { key: 'glm',      label: 'GLM 5.2',  where: 'z.ai' },
        { key: 'gamma4',   label: 'Gamma4',   where: 'self-hosted' },
    ];

    // ---- translations ---------------------------------------------
    const STRINGS = {
        en: {
            'welcome.what':   'Synergy brings two things together in one place: a chatbot that speaks to every major AI provider, and a visual workflow builder for the work that is too involved for a single conversation.',
            'welcome.chat':   'Chat with Claude, OpenAI, Gemini, Grok, DeepSeek, Kimi and more through one interface. Switch model mid-conversation, compare two answers side by side, attach documents, and talk to it out loud.',
            'welcome.flows':  'Then go further: build multi-step workflows on a canvas, where agents use tools, search the web, read your files and hand work to one another. Compile any of them to Python and run it on your own machine.',
            'welcome.bkeys':  'Add your own AI provider keys — nothing is shipped with this app.',
            'step.lang':      'Language',
            'step.welcome':   'Welcome',
            'step.folder':    'Folder',
            'step.keys':      'API keys',
            'step.install':   'Install',
            'lang.title':     'Choose your language',
            'lang.continue':  'Continue',
            'welcome.title':  'Welcome to Synergy AI Chat',
            'welcome.intro':  'A few quick steps and you are ready.',
            'welcome.b1':     'Pick a root folder where Synergy will read and write files.',
            'welcome.b2':     'Install Synergy as a local app on your device.',
            'welcome.next':   'Get started',
            'folder.title':   'Choose a root folder',
            'folder.desc':    'All files Synergy creates or reads will live inside this folder.',
            'folder.pick':    'Choose folder…',
            'folder.change':  'Change folder…',
            'folder.runnerOk':      'Python runner installed in this folder. One step left — run this in a terminal; it works from any directory:',
            'folder.runnerVenvNote':'Needed once. It builds the virtual environment; a browser cannot do that part.',
            'folder.runnerCopy':    'Copy',
            'folder.runnerCopied':  'Copied',
            'folder.runnerPartial': 'Some files could not be written:',
            'folder.runnerFailed':  'Could not install the Python runner here. Compiled workflows will not run until it is installed; the workflow editor\'s Setup item explains how.',
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
            'keys.title':     'Add your AI provider keys',
            'keys.intro':     'Add a key for each provider you want to use. You can skip this and add them later in Settings.',
            'keys.where':     'Keys are stored in your own database and never leave this machine.',
            'keys.skip':      'Skip for now',
            'keys.save':      'Save and finish',
            'keys.saved':     'Saved.',
            'keys.failed':    'Could not save those keys — you can add them later in Settings.',
            'back':           'Back',
            'close':          'Close',
            'testBanner':     'Test mode — wizard shown every visit for iteration.'
        },
        fr: {
            'welcome.what':   "Synergy réunit deux outils au même endroit : un agent conversationnel relié à tous les grands fournisseurs d'IA, et un constructeur visuel de workflows pour les tâches trop complexes pour une simple conversation.",
            'welcome.chat':   "Discutez avec Claude, OpenAI, Gemini, Grok, DeepSeek, Kimi et d'autres depuis une seule interface. Changez de modèle en cours de conversation, comparez deux réponses côte à côte, joignez des documents et parlez-lui à voix haute.",
            'welcome.flows':  "Allez plus loin : construisez des workflows en plusieurs étapes sur un canevas, où des agents utilisent des outils, cherchent sur le web, lisent vos fichiers et se transmettent le travail. Compilez-les en Python et exécutez-les sur votre machine.",
            'welcome.bkeys':  "Ajouter vos propres clés de fournisseur IA — aucune n'est fournie avec l'application.",
            'step.lang':      'Langue',
            'step.welcome':   'Bienvenue',
            'step.folder':    'Dossier',
            'step.keys':      'Clés API',
            'step.install':   'Installation',
            'lang.title':     'Choisissez votre langue',
            'lang.continue':  'Continuer',
            'welcome.title':  'Bienvenue sur Synergy AI Chat',
            'welcome.intro':  'Quelques étapes rapides et tout est prêt.',
            'welcome.b1':     'Choisir un dossier racine où Synergy lira et écrira des fichiers.',
            'welcome.b2':     'Installer Synergy comme une application locale sur votre appareil.',
            'welcome.next':   'Commencer',
            'folder.title':   'Choisir un dossier racine',
            'folder.desc':    'Tous les fichiers que Synergy crée ou lit se trouveront dans ce dossier.',
            'folder.pick':    'Choisir un dossier…',
            'folder.change':  'Changer de dossier…',
            'folder.runnerOk':      'Runner Python installé dans ce dossier. Une étape reste — exécutez ceci dans un terminal ; fonctionne depuis n\'importe quel dossier :',
            'folder.runnerVenvNote':'Une seule fois. Cela construit l\'environnement virtuel ; un navigateur ne peut pas le faire.',
            'folder.runnerCopy':    'Copier',
            'folder.runnerCopied':  'Copié',
            'folder.runnerPartial': 'Certains fichiers n\'ont pas pu être écrits :',
            'folder.runnerFailed':  'Impossible d\'installer le runner Python ici. Les workflows compilés ne fonctionneront pas tant qu\'il n\'est pas installé ; voir Setup dans l\'éditeur de workflow.',
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
            'keys.title':     'Ajoutez vos clés de fournisseur IA',
            'keys.intro':     'Ajoutez une clé pour chaque fournisseur que vous souhaitez utiliser. Vous pouvez passer cette étape et les ajouter plus tard dans les Paramètres.',
            'keys.where':     'Les clés sont enregistrées dans votre propre base de données et ne quittent jamais cette machine.',
            'keys.skip':      'Passer pour l\'instant',
            'keys.save':      'Enregistrer et terminer',
            'keys.saved':     'Enregistré.',
            'keys.failed':    'Impossible d\'enregistrer ces clés — vous pourrez les ajouter plus tard dans les Paramètres.',
            'back':           'Retour',
            'close':          'Fermer',
            'testBanner':     "Mode test — l'assistant s'affiche à chaque visite pour itération."
        },
        es: {
            'welcome.what':   'Synergy reúne dos herramientas en un mismo lugar: un chatbot conectado a los principales proveedores de IA y un constructor visual de flujos de trabajo para las tareas demasiado complejas para una sola conversación.',
            'welcome.chat':   'Conversa con Claude, OpenAI, Gemini, Grok, DeepSeek, Kimi y otros desde una sola interfaz. Cambia de modelo a mitad de conversación, compara dos respuestas lado a lado, adjunta documentos y háblale en voz alta.',
            'welcome.flows':  'Y ve más lejos: crea flujos de trabajo de varios pasos en un lienzo, donde los agentes usan herramientas, buscan en la web, leen tus archivos y se pasan el trabajo entre sí. Compílalos a Python y ejecútalos en tu propia máquina.',
            'welcome.bkeys':  'Añadir tus propias claves de proveedor de IA: la aplicación no incluye ninguna.',
            'step.lang':      'Idioma',
            'step.welcome':   'Bienvenida',
            'step.folder':    'Carpeta',
            'step.keys':      'Claves API',
            'step.install':   'Instalación',
            'lang.title':     'Elige tu idioma',
            'lang.continue':  'Continuar',
            'welcome.title':  'Bienvenido a Synergy AI Chat',
            'welcome.intro':  'Unos pocos pasos rápidos y estará listo.',
            'welcome.b1':     'Elegir una carpeta raíz donde Synergy leerá y escribirá archivos.',
            'welcome.b2':     'Instalar Synergy como una aplicación local en tu dispositivo.',
            'welcome.next':   'Empezar',
            'folder.title':   'Elige una carpeta raíz',
            'folder.desc':    'Todos los archivos que Synergy cree o lea estarán dentro de esta carpeta.',
            'folder.pick':    'Elegir carpeta…',
            'folder.change':  'Cambiar carpeta…',
            'folder.runnerOk':      'Runner de Python instalado en esta carpeta. Queda un paso — ejecute esto en un terminal; funciona desde cualquier carpeta:',
            'folder.runnerVenvNote':'Solo una vez. Crea el entorno virtual; un navegador no puede hacerlo.',
            'folder.runnerCopy':    'Copiar',
            'folder.runnerCopied':  'Copiado',
            'folder.runnerPartial': 'No se pudieron escribir algunos archivos:',
            'folder.runnerFailed':  'No se pudo instalar el runner de Python aquí. Los flujos compilados no se ejecutarán hasta instalarlo; vea Setup en el editor de flujos.',
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
            'keys.title':     'Añade tus claves de proveedor de IA',
            'keys.intro':     'Añade una clave para cada proveedor que quieras usar. Puedes omitir este paso y añadirlas más tarde en Ajustes.',
            'keys.where':     'Las claves se guardan en tu propia base de datos y nunca salen de esta máquina.',
            'keys.skip':      'Omitir por ahora',
            'keys.save':      'Guardar y terminar',
            'keys.saved':     'Guardado.',
            'keys.failed':    'No se pudieron guardar esas claves — puedes añadirlas más tarde en Ajustes.',
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
    // In a self-hosted edition this overlay is not an install nag — it is the
    // ONLY onboarding there is: it grants the local folder, installs the Python
    // runner, and collects the user's own provider keys. Without it the app is
    // unusable, so the install-prompt heuristics must not hide it. A 7-day
    // snooze from a casual dismissal, or an already-installed PWA, would leave
    // a first-time user staring at an app they cannot configure.
    //
    // Only an explicit "don't show me again" still suppresses it, and Settings
    // can re-open it from there.
    const isOnboardingEdition = () =>
        !!(window.APP_CONFIG && window.APP_CONFIG.GPT_EDITION);

    const isSnoozed = () => {
        if (TEST_MODE) return false;
        try {
            if (window.localStorage.getItem(NEVER_KEY) === '1') return true;
            if (isOnboardingEdition()) return false;
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
    let wizardState = { step: 'lang', rootHandle: null, rootName: null, runner: null };
    let abortCtl = null;

    function buildShell() {
        const existing = document.getElementById('pwa-install-overlay');
        if (existing) return existing;

        const overlay = document.createElement('div');
        overlay.id = 'pwa-install-overlay';
        overlay.className = 'fixed inset-0 z-[1000] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm';
        // Two columns, modelled on video-edit's first-run wizard: the flow on
        // the left, artwork on the right that drops away on narrow screens.
        // min-h keeps the card from resizing as steps change length, which
        // otherwise makes the whole dialog jump on every Next.
        overlay.innerHTML = `
            <div class="bg-zinc-800 rounded-2xl shadow-2xl max-w-5xl w-full overflow-hidden text-gray-200">
                <div class="px-7 pt-6" data-pwa-steps></div>
                <div class="flex gap-7 px-7 pt-6 pb-7 min-h-[24rem]">
                    <div class="flex-1 min-w-0 flex flex-col" data-pwa-content></div>
                    <div class="hidden md:flex w-[38%] items-center" aria-hidden="true">
                        <img src="assets/images/wizard_illustration.png" alt=""
                             class="w-full rounded-xl shadow-lg">
                    </div>
                </div>
                ${TEST_MODE ? '<p class="text-[10px] text-gray-500 pb-4 text-center" data-pwa-testbanner></p>' : ''}
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

    // The ordered flow, so the step strip and the strip alone decides what the
    // user is told the sequence is. `keys` only exists in a self-hosted
    // edition — hosted users rent LLM time and have no keys to enter.
    const stepOrder = () =>
        SHOW_KEYS_STEP
            ? ['lang', 'welcome', 'folder', 'keys', 'install']
            : ['lang', 'welcome', 'folder', 'install'];

    // A progress strip: one tab per step, underlined. Without it the wizard
    // gives no sense of how long it is or how far in you are — the single
    // biggest thing video-edit's version has that ours did not.
    function renderSteps() {
        const order = stepOrder();
        const at    = order.indexOf(wizardState.step);

        // Numbered, like video-edit's: "1. Welcome   2. Local storage   …".
        // The number is what tells someone how long the flow is before they
        // commit to starting it; an unnumbered strip does not.
        return `<div class="flex">` + order.map((s, i) => {
            const state = i === at
                ? 'text-white border-blue-500'
                : (i < at ? 'text-blue-300 border-blue-900' : 'text-gray-500 border-zinc-700');
            return `<span class="flex-1 text-center text-xs pb-2.5 border-b-2 ${state}">
                        ${i + 1}. ${esc(t('step.' + s))}
                    </span>`;
        }).join('') + `</div>`;
    }

    function render() {
        const overlay = buildShell();
        const card    = overlay.querySelector('[data-pwa-content]');
        if (!card) return;

        const strip = overlay.querySelector('[data-pwa-steps]');
        if (strip) strip.innerHTML = renderSteps();

        const step = wizardState.step;
        if      (step === 'lang')    card.innerHTML = renderLang();
        else if (step === 'welcome') card.innerHTML = renderWelcome();
        else if (step === 'folder')  card.innerHTML = renderFolder();
        else if (step === 'keys')    card.innerHTML = renderKeys();
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
                    <h2 class="text-lg font-semibold text-gray-100">${esc(t(titleKey))}</h2>
                </div>
                <button data-pwa-action="close" aria-label="${esc(t('close'))}"
                    class="text-gray-400 hover:text-gray-200 flex-shrink-0">
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
                       ${currentLang === o.code ? 'border-blue-500 bg-blue-500/15 text-blue-100' : 'border-zinc-700 hover:bg-zinc-700 text-gray-100'}">
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

            <p class="text-sm text-gray-300 leading-relaxed mb-3">${esc(t('welcome.what'))}</p>
            <p class="text-sm text-gray-400 leading-relaxed mb-3">${esc(t('welcome.chat'))}</p>
            <p class="text-sm text-gray-400 leading-relaxed mb-5">${esc(t('welcome.flows'))}</p>

            <p class="text-sm text-gray-300 mb-2">${esc(t('welcome.intro'))}</p>
            <ol class="space-y-2 text-sm text-gray-300 mb-5">
                <li class="flex items-start gap-3">${num(1)}<span>${esc(t('welcome.b1'))}</span></li>
                ${SHOW_KEYS_STEP ? `<li class="flex items-start gap-3">${num(2)}<span>${esc(t('welcome.bkeys'))}</span></li>` : ''}
                <li class="flex items-start gap-3">${num(SHOW_KEYS_STEP ? 3 : 2)}<span>${esc(t('welcome.b2'))}</span></li>
            </ol>
            <div class="flex justify-between">
                <button data-pwa-action="back" data-from="welcome"
                    class="px-4 py-2 text-sm font-medium text-gray-300 bg-zinc-700/60 hover:bg-zinc-700 rounded-md transition">
                    ${esc(t('back'))}
                </button>
                <button data-pwa-action="next" data-from="welcome"
                    class="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-md transition">
                    ${esc(t('welcome.next'))}
                </button>
            </div>
        `;
    }

    /**
     * What happened to the Python runner install, in one line.
     *
     * Reported rather than silent because the remaining step is manual: the
     * browser can write the runner's files but cannot create a virtualenv, so
     * the user has to run one command before a compiled workflow will run. A
     * wizard that says nothing here leaves them to discover that at the first
     * failed Run.
     */
    /** Quote a folder name for use as a single-quoted shell argument. */
    function shQuote(s) {
        return "'" + String(s).replace(/'/g, "'\\''") + "'";
    }

    /**
     * The one command the user still has to run, made self-locating.
     *
     * It used to be a bare `cd python && …`, which assumes the terminal is
     * already inside the granted folder. A terminal opens in $HOME, so the
     * paste produced `cd: no such file or directory: python` and the wizard
     * looked broken when the install had in fact succeeded.
     *
     * We cannot print an absolute path: the File System Access API withholds
     * it on purpose, and the directory handle exposes only a name. So the
     * command searches for the folder by that name and cds into it, which
     * makes it correct from any working directory. `-print -quit` stops at the
     * first match instead of walking all of $HOME, and the `-not -path` filter
     * skips dot-directories such as Library caches.
     *
     * Limitation worth knowing: a folder granted from outside $HOME (an
     * external volume, say) is not found by this search.
     */
    function venvCommand(folderName) {
        return 'cd "$(find ~ -maxdepth 6 -type d -name ' + shQuote(folderName || 'synergyAI') +
               " -not -path '*/.*' -print -quit)/python\" && " +
               'python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt';
    }

    function renderRunnerStatus() {
        const r = wizardState.runner;
        if (!r) return '';
        if (r.error || !r.written.length) {
            return `
                <div class="mt-3 rounded border-l-4 border-yellow-500 bg-yellow-50 p-2 text-xs text-yellow-900">
                    ${esc(t('folder.runnerFailed'))}${r.error ? ` (${esc(r.error)})` : ''}
                </div>`;
        }
        const partial = r.skipped.length
            ? `<div class="mt-1 text-[11px] text-yellow-800">${esc(t('folder.runnerPartial'))} ${esc(r.skipped.join(', '))}</div>`
            : '';
        const cmd = venvCommand(wizardState.rootName);
        return `
            <div class="mt-3 rounded border-l-4 border-green-500 bg-green-50 p-2">
                <p class="text-xs text-green-900">${esc(t('folder.runnerOk'))}</p>
                <div class="mt-1 flex items-start gap-2">
                    <pre class="flex-1 min-w-0 bg-gray-900 text-green-200 text-[11px] rounded p-2 select-all overflow-auto">${esc(cmd)}</pre>
                    <button type="button" data-pwa-action="copy-cmd" data-cmd="${esc(cmd)}"
                        class="flex-shrink-0 px-2 py-1 text-[11px] font-medium text-green-900 bg-green-200 hover:bg-green-300 border border-green-500 rounded transition">
                        ${esc(t('folder.runnerCopy'))}
                    </button>
                </div>
                <p class="mt-1 text-[11px] text-green-900">${esc(t('folder.runnerVenvNote'))}</p>
                ${partial}
            </div>`;
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
            <p class="text-sm text-gray-300 mb-4">${esc(t('folder.desc'))}</p>
            <div class="mb-5">
                <div class="flex items-center gap-3 px-4 py-4 border-2 border-blue-500 bg-blue-500/15 rounded-lg">
                    <svg class="w-8 h-8 text-blue-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/></svg>
                    <div class="flex-1 min-w-0">
                        <p class="text-[11px] font-semibold uppercase tracking-wide text-blue-400">${esc(t('folder.picked'))}</p>
                        <p class="text-lg font-semibold text-gray-100 truncate" title="${esc(picked)}">${esc(picked)}</p>
                    </div>
                    <svg class="w-6 h-6 text-green-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
                </div>
                <button data-pwa-action="pick-folder"
                    class="mt-2 text-xs font-medium text-blue-400 hover:text-blue-200 underline">
                    ${esc(t('folder.change'))}
                </button>
                ${renderRunnerStatus()}
            </div>
        `;
        } else {
            body = `
            <p class="text-sm text-gray-300 mb-4">${esc(t('folder.desc'))}</p>
            <div class="mb-5">
                <button data-pwa-action="pick-folder"
                    class="w-full px-4 py-3 text-sm font-medium border-2 border-dashed border-zinc-600 hover:border-blue-500 hover:bg-blue-500/10 rounded-md transition text-gray-300">
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
                    class="px-4 py-2 text-sm font-medium text-gray-300 bg-zinc-700/60 hover:bg-zinc-700 rounded-md transition">
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

    function renderKeys() {
        const rows = KEY_PROVIDERS.map((p) => `
            <div class="mb-3">
                <label for="pwa-key-${esc(p.key)}" class="block text-xs font-medium text-gray-300 mb-1">
                    ${esc(p.label)} <span class="text-gray-400 font-normal">— ${esc(p.where)}</span>
                </label>
                <input id="pwa-key-${esc(p.key)}" type="password" autocomplete="off" spellcheck="false" data-provider="${esc(p.key)}"
                    class="w-full px-3 py-2 text-sm bg-zinc-900 text-gray-100 placeholder-gray-500 border border-zinc-600 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
        `).join('');

        return `
            ${header('keys.title')}
            <p class="text-sm text-gray-300 mb-2">${esc(t('keys.intro'))}</p>
            <p class="text-xs text-gray-400 mb-4">${esc(t('keys.where'))}</p>
            <div class="max-h-64 overflow-y-auto pr-1 mb-2">${rows}</div>
            <p class="text-xs mb-3 min-h-[1em]" data-pwa-keys-msg></p>
            <div class="flex justify-between items-center">
                <button data-pwa-action="back" data-from="keys"
                    class="px-4 py-2 text-sm font-medium text-gray-300 bg-zinc-700/60 hover:bg-zinc-700 rounded-md transition">
                    ${esc(t('back'))}
                </button>
                <div class="flex gap-2">
                    <button data-pwa-action="next" data-from="keys"
                        class="px-4 py-2 text-sm font-medium text-gray-300 bg-zinc-700/60 hover:bg-zinc-700 rounded-md transition">
                        ${esc(t('keys.skip'))}
                    </button>
                    <button data-pwa-action="save-keys"
                        class="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-md transition">
                        ${esc(t('keys.save'))}
                    </button>
                </div>
            </div>
        `;
    }

    function renderInstall() {
        const installed = isInstalled();
        const canInstall = !!deferredPrompt && !installed;

        const body = `
            <p class="text-sm text-gray-300 mb-3">${esc(t('install.desc'))}</p>
            <p class="text-xs text-gray-400 mb-5">${esc(t('install.note'))}</p>
            ${installed ? `
                <div class="bg-green-500/15 border border-green-500/40 rounded-lg p-3 mb-4 text-sm text-green-300 text-center font-medium">
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
                    class="px-4 py-2 text-sm font-medium text-gray-300 bg-zinc-700/60 hover:bg-zinc-700 rounded-md transition">
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
            <div class="bg-zinc-800 rounded-2xl shadow-2xl max-w-md w-full p-6 sm:p-7">
                <div class="flex items-start gap-4 mb-4">
                    <img src="assets/images/icon-192.png" alt="" class="w-14 h-14 rounded-xl shadow-sm flex-shrink-0" />
                    <div class="flex-1 min-w-0">
                        <h2 class="text-lg font-semibold text-gray-100">${esc(t('welcome.title'))}</h2>
                    </div>
                    <button data-pwa-action="close" aria-label="${esc(t('close'))}"
                        class="text-gray-400 hover:text-gray-200 flex-shrink-0">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
                    </button>
                </div>
                <div class="bg-blue-500/15 border border-blue-500/40 rounded-lg p-3 mb-4 text-sm text-blue-100">
                    <p class="font-medium mb-1">${esc(t('install.iosTitle'))}:</p>
                    <ol class="list-decimal list-inside space-y-0.5 text-blue-200">
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
            else if (from === 'folder')  wizardState.step = SHOW_KEYS_STEP ? 'keys' : 'install';
            else if (from === 'keys')    wizardState.step = 'install';
            render();
            return;
        }
        if (action === 'back') {
            const from = target.dataset.from;
            if      (from === 'welcome') wizardState.step = 'lang';
            else if (from === 'folder')  wizardState.step = 'welcome';
            else if (from === 'keys')    wizardState.step = 'folder';
            else if (from === 'install') wizardState.step = SHOW_KEYS_STEP ? 'keys' : 'folder';
            render();
            return;
        }
        if (action === 'copy-cmd') {
            const cmd = target.dataset.cmd || '';
            let ok = false;
            // navigator.clipboard exists only in a secure context. localhost
            // qualifies, but a container reached over the LAN at
            // http://192.168.x.x:8080 does not -- and that is a normal way to
            // run this. Fall back to the execCommand trick there rather than
            // silently doing nothing.
            try {
                if (navigator.clipboard && window.isSecureContext) {
                    await navigator.clipboard.writeText(cmd);
                    ok = true;
                }
            } catch (e) { /* fall through to the fallback */ }
            if (!ok) {
                try {
                    const ta = document.createElement('textarea');
                    ta.value = cmd;
                    ta.setAttribute('readonly', '');
                    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
                    document.body.appendChild(ta);
                    ta.select();
                    ok = document.execCommand('copy');
                    ta.remove();
                } catch (e) { ok = false; }
            }
            // Confirm on the button itself. Re-rendering the step would rebuild
            // the card and lose the feedback immediately, so touch only this
            // label; the text is restored whether or not the copy worked, so a
            // failure leaves the button usable (and the <pre> is select-all).
            if (ok) {
                const original = target.textContent;
                target.textContent = t('folder.runnerCopied');
                setTimeout(() => { target.textContent = original; }, 1500);
            }
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
                // Install the local Python runner into <this folder>/python/.
                // Doing it HERE is what makes compiled workflows work at all: a
                // page cannot learn this folder's absolute path, so it could
                // never tell setup.py where to install, and the editor writes
                // packages to python/scripts/ under this same handle. Writing
                // the runner here makes both halves address one folder by
                // construction. The venv step still needs a terminal; the
                // Setup item in the workflow editor prints that command.
                if (window.localFs && typeof window.localFs.deployRunner === 'function') {
                    try {
                        wizardState.runner = await window.localFs.deployRunner(handle);
                    } catch (e) {
                        console.warn('[wizard] could not deploy the python runner:', e);
                        wizardState.runner = { written: [], skipped: [], error: e?.message || String(e) };
                    }
                }
                render();
            } catch (err) {
                if (err && err.name !== 'AbortError') console.warn('[wizard] pick-folder failed:', err);
            }
            return;
        }
        if (action === 'save-keys') {
            const msgEl = e.currentTarget?.querySelector('[data-pwa-keys-msg]');
            if (msgEl) msgEl.textContent = '…';

            const inputs = document.querySelectorAll('#pwa-install-overlay input[data-provider]');
            const pending = [];
            inputs.forEach((el) => {
                const v = (el.value || '').trim();
                if (v) pending.push({ provider_key: el.dataset.provider, api_key: v });
            });

            if (!pending.length) {
                wizardState.step = 'install';
                render();
                return;
            }

            const base = (window.APP_CONFIG && window.APP_CONFIG.API_BASE_URL) || '/gpt/backend/api/v1';
            let token = '';
            try { token = window.localStorage.getItem('token') || ''; } catch {}

            // saveLLMProvider is a full upsert -- it 400s without a `model`
            // and otherwise overwrites the row's other columns wholesale. The
            // container already seeded every provider with a working model /
            // base_url / etc., so read each row back first and send it
            // straight through with only api_key replaced, instead of
            // clobbering the seeded config down to just the key.
            let ok = true;
            try {
                const results = await Promise.all(pending.map(async ({ provider_key, api_key }) => {
                    try {
                        const getRes = await fetch(`${base}/admin/llm-settings/${encodeURIComponent(provider_key)}`, {
                            headers: { 'Authorization': `Bearer ${token}` },
                        });
                        if (!getRes.ok) return { ok: false };
                        const got = await getRes.json();
                        const provider = got && got.provider;
                        if (!provider) return { ok: false };

                        const putRes = await fetch(`${base}/admin/llm-settings`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${token}`,
                            },
                            body: JSON.stringify({ ...provider, api_key }),
                        });
                        return { ok: putRes.ok };
                    } catch {
                        return { ok: false };
                    }
                }));
                ok = results.every((r) => r && r.ok);
            } catch {
                ok = false;
            }

            if (msgEl) msgEl.textContent = ok ? t('keys.saved') : t('keys.failed');
            setTimeout(() => { wizardState.step = 'install'; render(); }, ok ? 400 : 1600);
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
        // isInstalled() suppresses the INSTALL nag, which is right for the
        // hosted app. In a self-hosted edition the same overlay carries the
        // folder / runner / API-key setup, and someone who installed the PWA
        // first still needs all of it — so only the explicit never-flag applies.
        if (!TEST_MODE && !isOnboardingEdition() && isInstalled()) return;
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
