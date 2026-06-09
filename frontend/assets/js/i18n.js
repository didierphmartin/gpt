/**
 * i18n (Internationalization) Module
 * Handles multi-language support for the AI Assistant
 */

class I18nManager {
    constructor() {
        // Define supported languages FIRST (before calling detectBrowserLanguage)
        this.supportedLanguages = [
            { code: 'en', name: 'English', flag: '🇺🇸' },
            { code: 'fr', name: 'Français', flag: '🇫🇷' },
            { code: 'es', name: 'Español', flag: '🇪🇸' }
        ];
        this.translations = {};
        this.onLanguageChangeCallbacks = [];

        // Now detect/load language (after supportedLanguages is defined)
        this.currentLanguage = this.getSavedLanguage() || this.detectBrowserLanguage();
    }

    /**
     * Initialize i18n by loading all translation files
     */
    async init() {
        try {
            // Load all translation files
            const loadPromises = this.supportedLanguages.map(lang =>
                this.loadTranslation(lang.code)
            );

            await Promise.all(loadPromises);

            // Apply current language
            await this.setLanguage(this.currentLanguage);

            console.log(`i18n initialized with language: ${this.currentLanguage}`);
            return true;
        } catch (error) {
            console.error('Failed to initialize i18n:', error);
            // Fallback to English
            this.currentLanguage = 'en';
            return false;
        }
    }

    /**
     * Load translation file for a specific language
     */
    async loadTranslation(languageCode) {
        try {
            // Add cache-busting parameter to ensure fresh translations
            const cacheBuster = Date.now();
            const response = await fetch(`assets/i18n/${languageCode}.json?v=${cacheBuster}`);
            if (!response.ok) {
                throw new Error(`Failed to load ${languageCode}.json`);
            }
            this.translations[languageCode] = await response.json();
        } catch (error) {
            console.error(`Error loading translation for ${languageCode}:`, error);
            throw error;
        }
    }

    /**
     * Get translation for a key using dot notation (e.g., "header.title")
     */
    t(key, params = {}) {
        const keys = key.split('.');
        let value = this.translations[this.currentLanguage];

        for (const k of keys) {
            if (value && typeof value === 'object') {
                value = value[k];
            } else {
                console.warn(`Translation key not found: ${key}`);
                return key;
            }
        }

        // Replace parameters in translation (e.g., {{name}})
        if (typeof value === 'string' && Object.keys(params).length > 0) {
            return value.replace(/\{\{(\w+)\}\}/g, (match, paramKey) => {
                return params[paramKey] !== undefined ? params[paramKey] : match;
            });
        }

        return value || key;
    }

    /**
     * Set the current language
     */
    async setLanguage(languageCode) {
        if (!this.supportedLanguages.find(l => l.code === languageCode)) {
            console.warn(`Language ${languageCode} not supported, falling back to English`);
            languageCode = 'en';
        }

        // Load translation if not already loaded
        if (!this.translations[languageCode]) {
            await this.loadTranslation(languageCode);
        }

        this.currentLanguage = languageCode;
        this.saveLanguage(languageCode);

        // Update HTML lang attribute
        document.documentElement.lang = languageCode;

        // Update page title
        document.title = this.t('title');

        // Update all elements with data-i18n attribute
        this.updateAllTranslations();

        // Notify listeners
        this.onLanguageChangeCallbacks.forEach(callback => callback(languageCode));

        console.log(`Language changed to: ${languageCode}`);
    }

    /**
     * Update all DOM elements with data-i18n attributes
     */
    updateAllTranslations() {
        // Update elements with data-i18n (text content)
        document.querySelectorAll('[data-i18n]').forEach(element => {
            const key = element.getAttribute('data-i18n');
            const translation = this.t(key);
            element.textContent = translation;
        });

        // Update elements with data-i18n-placeholder (placeholder attribute)
        document.querySelectorAll('[data-i18n-placeholder]').forEach(element => {
            const key = element.getAttribute('data-i18n-placeholder');
            const translation = this.t(key);
            element.placeholder = translation;
        });

        // Update elements with data-i18n-title (title attribute)
        document.querySelectorAll('[data-i18n-title]').forEach(element => {
            const key = element.getAttribute('data-i18n-title');
            const translation = this.t(key);
            element.title = translation;
        });
    }

    /**
     * Get current language code
     */
    getLanguage() {
        return this.currentLanguage;
    }

    /**
     * Get all supported languages
     */
    getSupportedLanguages() {
        return this.supportedLanguages;
    }

    /**
     * Register callback for language change events
     */
    onLanguageChange(callback) {
        this.onLanguageChangeCallbacks.push(callback);
    }

    /**
     * Detect browser language
     */
    detectBrowserLanguage() {
        const browserLang = navigator.language || navigator.userLanguage;
        const langCode = browserLang.split('-')[0]; // Get 'en' from 'en-US'

        // Check if detected language is supported
        const isSupported = this.supportedLanguages.find(l => l.code === langCode);
        return isSupported ? langCode : 'en';
    }

    /**
     * Save language preference to localStorage
     * Uses 'app-language' key shared with Voice app for consistency
     */
    saveLanguage(languageCode) {
        try {
            localStorage.setItem('app-language', languageCode);
        } catch (error) {
            console.warn('Failed to save language preference:', error);
        }
    }

    /**
     * Get saved language preference from localStorage
     * Uses 'app-language' key shared with Voice app for consistency
     */
    getSavedLanguage() {
        try {
            // Check new shared key first, fall back to legacy key for migration
            return localStorage.getItem('app-language') || localStorage.getItem('chatbot_language');
        } catch (error) {
            console.warn('Failed to get saved language preference:', error);
            return null;
        }
    }

    /**
     * Update speech recognition language based on current language
     */
    getSpeechRecognitionLanguage() {
        const languageMap = {
            'en': 'en-US',
            'fr': 'fr-FR',
            'es': 'es-ES'
        };
        return languageMap[this.currentLanguage] || 'en-US';
    }

    /**
     * Create language switcher UI element
     */
    createLanguageSwitcher() {
        const container = document.createElement('div');
        container.className = 'language-switcher flex items-center gap-2';

        const label = document.createElement('span');
        label.className = 'text-sm text-blue-200';
        label.textContent = '🌐';
        label.title = 'Language / Langue / Idioma';
        container.appendChild(label);

        const select = document.createElement('select');
        select.className = 'bg-white/20 text-white rounded px-2 py-1 text-sm border-0 cursor-pointer hover:bg-white/30 transition';
        select.id = 'language-select';

        this.supportedLanguages.forEach(lang => {
            const option = document.createElement('option');
            option.value = lang.code;
            option.textContent = `${lang.flag} ${lang.name}`;
            option.selected = lang.code === this.currentLanguage;
            select.appendChild(option);
        });

        select.addEventListener('change', (e) => {
            this.setLanguage(e.target.value);
        });

        container.appendChild(select);
        return container;
    }
}

// Create global instance
window.i18n = new I18nManager();
