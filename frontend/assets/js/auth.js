/**
 * Authentication Logic for GPT Multi-Provider Chat
 *
 * Handles:
 * - Email/password login
 * - Google OAuth login
 * - Facebook OAuth login
 * - JWT token management
 * - Session persistence
 */

class AuthManager {
    constructor() {
        this.apiBaseUrl = '/gpt/backend/api/v1';
        // One-time migration of the legacy flat 'user' key into the email-keyed store.
        window.accountStore.migrateLegacyUser();
        this.token = window.accountStore.getToken();
        this.user = window.accountStore.getActiveUser();
        this.authVerified = false;
        this.authPromise = null;
        this.tokenCheckInterval = null; // Store interval ID for token validation

        // Embed mode: gpt/frontend is loaded inside an iframe by another app
        // (e.g. PortfolioManagement). Parent passes the JWT via postMessage
        // instead of the normal login flow. Origin allowlist below must stay
        // in sync with the CSP frame-ancestors directive in /gpt/frontend/.htaccess.
        this.isEmbedMode = new URLSearchParams(window.location.search).get('embed') === '1';
        this.embedAllowedOrigins = [
            'http://localhost:3000',
            'https://finmind.org',
        ];
        this._embedTokenResolver = null;

        this.init();
    }

    init() {
        // Check if we're on login page
        const isLoginPage = window.location.pathname.includes('login.html');

        if (this.isEmbedMode) {
            this.applyEmbedMode();
            this.setupEmbedAuth();
        }

        if (isLoginPage) {
            this.setupLoginPage();
        } else {
            // Check authentication for all other pages
            // Store the promise so other modules can wait for it
            this.authPromise = this.checkAuth();
        }
    }

    applyEmbedMode() {
        // body may not be parsed yet when auth.js runs in <head>; guard for both.
        if (document.body) {
            document.body.classList.add('embed-mode');
        } else {
            document.addEventListener('DOMContentLoaded', () => {
                document.body && document.body.classList.add('embed-mode');
            });
        }
    }

    setupEmbedAuth() {
        // Listen for the parent iframe to post the JWT.
        // Expected payload: {type: 'gpt-embed-auth', token: '<jwt>', user: {...}}
        // Origins not in the allowlist are silently ignored.
        window.addEventListener('message', (event) => {
            if (!this.embedAllowedOrigins.includes(event.origin)) return;
            const data = event.data;
            if (!data || data.type !== 'gpt-embed-auth' || !data.token) return;

            this.token = data.token;
            if (data.user) {
                window.accountStore.setActiveAccount(data.user, data.token);
                this.user = data.user;
            } else {
                // Deliberate fallback: a token with no user object can't be keyed
                // by email, so it's stored as a bare active-session token. The
                // store still returns it via getToken(); getActiveUser() stays null.
                localStorage.setItem('token', data.token);
            }

            if (this._embedTokenResolver) {
                this._embedTokenResolver();
                this._embedTokenResolver = null;
            }
        });

        // Tell the parent we're ready to receive the JWT. Posting to '*' is
        // safe here because the payload is just a "ready" ping with no secrets;
        // the parent applies its own origin check before sending the token.
        if (window.parent && window.parent !== window) {
            try {
                window.parent.postMessage({ type: 'gpt-embed-ready' }, '*');
            } catch {}
        }
    }

    waitForEmbedToken(timeoutMs = 10000) {
        return new Promise((resolve) => {
            this._embedTokenResolver = resolve;
            setTimeout(() => {
                if (this._embedTokenResolver) {
                    console.warn('Embed JWT timeout — no token from parent');
                    this._embedTokenResolver = null;
                    resolve();
                }
            }, timeoutMs);
        });
    }

    async setupLoginPage() {
        // Email/Password login form
        const loginForm = document.getElementById('login-form');
        if (loginForm) {
            loginForm.addEventListener('submit', (e) => this.handleEmailLogin(e));
        }

        // Forgot-password link → triggers a Firebase-hosted reset email.
        const forgot = document.getElementById('forgot-password-link');
        if (forgot) {
            forgot.addEventListener('click', (e) => this.handleForgotPassword(e));
        }

        // Google login button
        const googleBtn = document.getElementById('google-login-btn');
        if (googleBtn) {
            googleBtn.addEventListener('click', () => this.handleGoogleLogin());
        }

        // Facebook login button
        const facebookBtn = document.getElementById('facebook-login-btn');
        if (facebookBtn) {
            facebookBtn.addEventListener('click', () => this.handleFacebookLogin());
        }

        // Phone login button and modal
        this.setupPhoneLogin();

        // WebAuthn (biometric) login button
        this.setupWebAuthnLogin();

        // If already logged in, verify token before redirecting
        if (this.token && this.user) {
            // First check if token is expired locally (faster than API call)
            if (this.isTokenExpired(this.token)) {
                console.log('Token expired, clearing auth data');
                this.clearAuthData();
                return;
            }

            try {
                // Verify the token is still valid with the server
                await this.verifyToken();
                // Token is valid, redirect to main app
                window.location.href = 'index.html';
            } catch (error) {
                // Token is invalid, clear it and stay on login page
                console.log('Token verification failed, clearing auth data');
                this.clearAuthData();
            }
        }
    }

    async handleEmailLogin(e) {
        e.preventDefault();

        const email = document.getElementById('email').value;
        const password = document.getElementById('password').value;
        const loginButton = document.getElementById('login-button');

        // Show loading state
        loginButton.disabled = true;
        loginButton.innerHTML = `
            <svg class="animate-spin -ml-1 mr-3 h-5 w-5 text-white inline-block" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            Signing In...
        `;

        try {
            // Try Firebase first. Falls back to legacy local bcrypt only when
            // Firebase doesn't recognize the credentials (user not yet imported,
            // or the hashes don't match). All other Firebase errors — disabled
            // account, rate-limit, network — surface directly because the
            // local fallback wouldn't fix them.
            let used = 'firebase';
            let result;
            try {
                result = await firebase.auth().signInWithEmailAndPassword(email, password);
            } catch (fbErr) {
                const credentialErrors = new Set([
                    'auth/user-not-found',
                    'auth/wrong-password',
                    'auth/invalid-credential',
                    'auth/invalid-login-credentials',
                ]);
                if (credentialErrors.has(fbErr?.code)) {
                    used = 'local';
                } else {
                    throw fbErr;
                }
            }

            let data;
            if (used === 'firebase') {
                const idToken = await result.user.getIdToken();
                const displayName = result.user.displayName || '';
                const nameParts = displayName.split(' ');
                const userData = {
                    email: result.user.email,
                    first_name: nameParts[0] || '',
                    last_name: nameParts.length > 1 ? nameParts.slice(1).join(' ') : '',
                    firebase_uid: result.user.uid,
                    provider: 'email',
                };
                const response = await fetch(`${this.apiBaseUrl}/auth`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        action: 'firebase',
                        provider: 'email',
                        idToken,
                        userData,
                    })
                });
                data = await response.json();
            } else {
                // Legacy bcrypt path — kept until all users are imported into Firebase.
                const response = await fetch(`${this.apiBaseUrl}/auth`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'login', email, password })
                });
                data = await response.json();
            }

            if (data.success) {
                this.saveAuthData(data.data);
                sessionStorage.setItem('showSplash', 'true');
                window.location.href = 'index.html';
            } else {
                this.showError(data.message || 'Login failed. Please check your credentials.');
            }
        } catch (error) {
            console.error('Login error:', error);
            // Friendly mapping for the most common Firebase errors.
            const map = {
                'auth/too-many-requests': 'Too many attempts — please wait a few minutes and try again.',
                'auth/user-disabled': 'This account has been disabled. Contact support.',
                'auth/invalid-email': 'That doesn\'t look like a valid email address.',
                'auth/network-request-failed': 'Network error — check your connection and try again.',
            };
            this.showError(map[error?.code] || 'Login failed. Please try again.');
        } finally {
            loginButton.disabled = false;
            loginButton.textContent = 'Sign In';
        }
    }

    /**
     * Trigger a Firebase password-reset email. Firebase delivers the email
     * (template editable in Firebase Console → Authentication → Templates)
     * and hosts the reset page itself, so we don't need an SMTP setup.
     */
    async handleForgotPassword(e) {
        if (e) e.preventDefault();

        // Pre-fill from the email field if the user already typed it.
        const emailField = document.getElementById('email');
        const prefill = emailField?.value?.trim() || '';
        const email = (window.prompt('Enter your account email and we\'ll send a reset link:', prefill) || '').trim();
        if (!email) return;

        try {
            await firebase.auth().sendPasswordResetEmail(email);
            // Always show the same message regardless of whether the email
            // matched a real account — prevents account enumeration.
            this.showSuccess
                ? this.showSuccess('If that email is registered, a reset link is on its way. Check your inbox (and spam).')
                : alert('If that email is registered, a reset link is on its way. Check your inbox (and spam).');
        } catch (error) {
            const map = {
                'auth/invalid-email': 'That doesn\'t look like a valid email address.',
                'auth/missing-email': 'Please enter your email address.',
                'auth/too-many-requests': 'Too many attempts — please wait a few minutes and try again.',
                'auth/network-request-failed': 'Network error — check your connection and try again.',
            };
            // 'auth/user-not-found' is intentionally treated as success above
            // (anti-enumeration), so we only land here on technical errors.
            if (error?.code === 'auth/user-not-found') {
                this.showSuccess
                    ? this.showSuccess('If that email is registered, a reset link is on its way. Check your inbox (and spam).')
                    : alert('If that email is registered, a reset link is on its way. Check your inbox (and spam).');
                return;
            }
            this.showError(map[error?.code] || 'Could not send the reset email. Please try again.');
        }
    }

    async handleGoogleLogin() {
        try {
            const provider = new firebase.auth.GoogleAuthProvider();
            const result = await firebase.auth().signInWithPopup(provider);

            // Get Firebase ID token
            const idToken = await result.user.getIdToken();

            // Extract user data
            const displayName = result.user.displayName || '';
            const nameParts = displayName.split(' ');
            const userData = {
                email: result.user.email,
                first_name: nameParts[0] || '',
                last_name: nameParts.length > 1 ? nameParts.slice(1).join(' ') : '',
                firebase_uid: result.user.uid,
                provider: 'google',
                photoURL: result.user.photoURL
            };

            // Send to backend
            await this.handleSocialLogin('google', idToken, userData);

        } catch (error) {
            console.error('Google login error:', error);
            this.showError('Google login failed. Please try again.');
        }
    }

    async handleFacebookLogin() {
        try {
            const provider = new firebase.auth.FacebookAuthProvider();
            const result = await firebase.auth().signInWithPopup(provider);

            // Get Firebase ID token
            const idToken = await result.user.getIdToken();

            // Extract user data
            const displayName = result.user.displayName || '';
            const nameParts = displayName.split(' ');
            const userData = {
                email: result.user.email,
                first_name: nameParts[0] || '',
                last_name: nameParts.length > 1 ? nameParts.slice(1).join(' ') : '',
                firebase_uid: result.user.uid,
                provider: 'facebook',
                photoURL: result.user.photoURL
            };

            // Send to backend
            await this.handleSocialLogin('facebook', idToken, userData);

        } catch (error) {
            console.error('Facebook login error:', error);
            this.showError('Facebook login failed. Please try again.');
        }
    }

    async handleSocialLogin(provider, idToken, userData) {
        try {
            const response = await fetch(`${this.apiBaseUrl}/auth`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    action: 'firebase',
                    provider,
                    idToken,
                    userData
                })
            });

            const data = await response.json();

            if (data.success) {
                // Store token and user data
                this.saveAuthData(data.data);

                // Show splash screen on redirect
                sessionStorage.setItem('showSplash', 'true');

                // Redirect to main app
                window.location.href = 'index.html';
            } else {
                this.showError(data.message || 'Social login failed. Please try again.');
            }
        } catch (error) {
            console.error('Social login error:', error);
            this.showError('Social login failed. Please try again.');
        }
    }

    // ==========================================
    // PHONE LOGIN METHODS
    // ==========================================

    /**
     * Setup phone login UI and event listeners
     */
    setupPhoneLogin() {
        this.phoneConfirmationResult = null;
        this.phoneRecaptchaVerifier = null;

        // Phone login button
        const phoneLoginBtn = document.getElementById('phone-login-btn');
        if (phoneLoginBtn) {
            phoneLoginBtn.addEventListener('click', () => this.showPhoneModal());
        }

        // Close modal button
        const closeModalBtn = document.getElementById('close-phone-modal');
        if (closeModalBtn) {
            closeModalBtn.addEventListener('click', () => this.hidePhoneModal());
        }

        // Close modal on backdrop click
        const modal = document.getElementById('phone-login-modal');
        if (modal) {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) this.hidePhoneModal();
            });
        }

        // Send code button
        const sendCodeBtn = document.getElementById('send-code-btn');
        if (sendCodeBtn) {
            sendCodeBtn.addEventListener('click', () => this.sendPhoneLoginCode());
        }

        // Back button
        const backBtn = document.getElementById('back-to-phone-btn');
        if (backBtn) {
            backBtn.addEventListener('click', () => this.backToPhoneInput());
        }

        // Verify button
        const verifyBtn = document.getElementById('verify-login-btn');
        if (verifyBtn) {
            verifyBtn.addEventListener('click', () => this.verifyPhoneLoginCode());
        }

        // Resend code button
        const resendBtn = document.getElementById('resend-code-btn');
        if (resendBtn) {
            resendBtn.addEventListener('click', () => {
                this.backToPhoneInput();
                this.sendPhoneLoginCode();
            });
        }

        // Auto-submit on 6 digits
        const codeInput = document.getElementById('verification-code-login');
        if (codeInput) {
            codeInput.addEventListener('input', (e) => {
                e.target.value = e.target.value.replace(/\D/g, '');
                if (e.target.value.length === 6) {
                    this.verifyPhoneLoginCode();
                }
            });
        }
    }

    /**
     * Show phone login modal
     */
    showPhoneModal() {
        const modal = document.getElementById('phone-login-modal');
        if (modal) {
            modal.classList.remove('hidden');
            this.initPhoneRecaptcha();
        }
    }

    /**
     * Hide phone login modal
     */
    hidePhoneModal() {
        const modal = document.getElementById('phone-login-modal');
        if (modal) {
            modal.classList.add('hidden');
        }
        this.hidePhoneError();
        this.backToPhoneInput();
    }

    /**
     * Initialize reCAPTCHA for phone login
     */
    initPhoneRecaptcha() {
        if (this.phoneRecaptchaVerifier) return;

        const container = document.getElementById('recaptcha-container-login');
        if (!container || !window.firebase?.auth) return;

        try {
            this.phoneRecaptchaVerifier = new firebase.auth.RecaptchaVerifier('recaptcha-container-login', {
                'size': 'invisible',
                'callback': () => {
                    console.log('[Auth] Phone reCAPTCHA solved');
                },
                'expired-callback': () => {
                    console.log('[Auth] Phone reCAPTCHA expired');
                    this.phoneRecaptchaVerifier = null;
                }
            });
        } catch (error) {
            console.error('Error initializing phone reCAPTCHA:', error);
        }
    }

    /**
     * Send SMS verification code for phone login
     */
    async sendPhoneLoginCode() {
        const countryCode = document.getElementById('phone-country-code-login')?.value || '+1';
        const phoneInput = document.getElementById('phone-number-login')?.value.trim();

        if (!phoneInput) {
            this.showPhoneError('Please enter a phone number');
            return;
        }

        const cleanNumber = phoneInput.replace(/\D/g, '');
        const fullPhoneNumber = countryCode + cleanNumber;

        const sendBtn = document.getElementById('send-code-btn');
        const originalHtml = sendBtn?.innerHTML;
        if (sendBtn) {
            sendBtn.disabled = true;
            sendBtn.innerHTML = '<svg class="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg> Sending...';
        }

        try {
            if (!this.phoneRecaptchaVerifier) {
                this.initPhoneRecaptcha();
            }

            const confirmationResult = await firebase.auth().signInWithPhoneNumber(
                fullPhoneNumber,
                this.phoneRecaptchaVerifier
            );

            this.phoneConfirmationResult = confirmationResult;

            // Show verification step
            document.getElementById('phone-step-1')?.classList.add('hidden');
            document.getElementById('phone-step-2')?.classList.remove('hidden');
            document.getElementById('phone-display-login').textContent = fullPhoneNumber;
            document.getElementById('verification-code-login')?.focus();

            this.hidePhoneError();

        } catch (error) {
            console.error('Error sending phone code:', error);

            this.phoneRecaptchaVerifier = null;

            let errorMessage = 'Failed to send verification code';
            if (error.code === 'auth/invalid-phone-number') {
                errorMessage = 'Invalid phone number format';
            } else if (error.code === 'auth/too-many-requests') {
                errorMessage = 'Too many requests. Please try again later';
            } else if (error.message) {
                errorMessage = error.message;
            }

            this.showPhoneError(errorMessage);
        } finally {
            if (sendBtn) {
                sendBtn.disabled = false;
                sendBtn.innerHTML = originalHtml;
            }
        }
    }

    /**
     * Verify SMS code and login
     */
    async verifyPhoneLoginCode() {
        const code = document.getElementById('verification-code-login')?.value.trim();

        if (!code || code.length !== 6) {
            this.showPhoneError('Please enter a 6-digit code');
            return;
        }

        if (!this.phoneConfirmationResult) {
            this.showPhoneError('Verification session expired. Please try again.');
            this.backToPhoneInput();
            return;
        }

        const verifyBtn = document.getElementById('verify-login-btn');
        const originalText = verifyBtn?.textContent;
        if (verifyBtn) {
            verifyBtn.disabled = true;
            verifyBtn.textContent = 'Verifying...';
        }

        try {
            // Verify the code with Firebase
            const credential = await this.phoneConfirmationResult.confirm(code);
            const idToken = await credential.user.getIdToken();
            const phoneNumber = credential.user.phoneNumber;

            // Send to backend for authentication
            const userData = {
                phone_number: phoneNumber,
                firebase_uid: credential.user.uid,
                provider: 'phone'
            };

            await this.handleSocialLogin('phone', idToken, userData);

        } catch (error) {
            console.error('Error verifying phone code:', error);

            let errorMessage = 'Verification failed';
            if (error.code === 'auth/invalid-verification-code') {
                errorMessage = 'Invalid verification code';
            } else if (error.code === 'auth/code-expired') {
                errorMessage = 'Code expired. Please request a new one';
            } else if (error.message?.includes('No account linked')) {
                errorMessage = 'No account is linked to this phone number. Please login with email first and link your phone in Settings.';
            } else if (error.message) {
                errorMessage = error.message;
            }

            this.showPhoneError(errorMessage);
        } finally {
            if (verifyBtn) {
                verifyBtn.disabled = false;
                verifyBtn.textContent = originalText;
            }
        }
    }

    /**
     * Go back to phone input step
     */
    backToPhoneInput() {
        document.getElementById('phone-step-1')?.classList.remove('hidden');
        document.getElementById('phone-step-2')?.classList.add('hidden');
        document.getElementById('verification-code-login').value = '';
        this.phoneConfirmationResult = null;
    }

    /**
     * Show phone error message
     */
    showPhoneError(message) {
        const errorDiv = document.getElementById('phone-error-message');
        const errorText = document.getElementById('phone-error-text');
        if (errorDiv && errorText) {
            errorText.textContent = message;
            errorDiv.classList.remove('hidden');
        }
    }

    /**
     * Hide phone error message
     */
    hidePhoneError() {
        const errorDiv = document.getElementById('phone-error-message');
        if (errorDiv) {
            errorDiv.classList.add('hidden');
        }
    }

    // ==========================================
    // WEBAUTHN (BIOMETRIC) LOGIN METHODS
    // ==========================================

    /**
     * Setup WebAuthn (biometric) login UI and event listeners
     */
    setupWebAuthnLogin() {
        const biometricBtn = document.getElementById('biometric-login-btn');
        if (!biometricBtn) return;

        // Check if WebAuthn is supported
        if (!window.PublicKeyCredential) {
            console.log('[Auth] WebAuthn not supported in this browser');
            biometricBtn.style.display = 'none';
            return;
        }

        // Check platform authenticator availability
        PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().then(available => {
            if (!available) {
                console.log('[Auth] No platform authenticator available');
                biometricBtn.style.display = 'none';
                return;
            }

            // Only show the button if the user has registered a biometric credential
            const storedCredentialId = localStorage.getItem('webauthn_credential_id');
            if (!storedCredentialId) {
                biometricBtn.style.display = 'none';
                return;
            }

            // Platform authenticator is available and credential exists - set up the button
            biometricBtn.addEventListener('click', () => this.handleWebAuthnLogin());

            // Update button text based on platform
            this.updateBiometricButtonText();
        }).catch(error => {
            console.log('[Auth] Error checking platform authenticator:', error);
            biometricBtn.style.display = 'none';
        });
    }

    /**
     * Update biometric button text based on platform capabilities
     */
    async updateBiometricButtonText() {
        const btnText = document.getElementById('biometric-btn-text');
        if (!btnText) return;

        try {
            // Check if platform authenticator is available
            const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();

            if (available) {
                // Detect platform for appropriate label
                const userAgent = navigator.userAgent.toLowerCase();
                if (/iphone|ipad|ipod|mac/.test(userAgent)) {
                    btnText.textContent = 'Login with Face ID / Touch ID';
                } else if (/android/.test(userAgent)) {
                    btnText.textContent = 'Login with Fingerprint';
                } else if (/win/.test(userAgent)) {
                    btnText.textContent = 'Login with Windows Hello';
                } else {
                    btnText.textContent = 'Login with Biometric';
                }
            }
        } catch (error) {
            console.log('[Auth] Could not detect platform authenticator:', error);
        }
    }

    /**
     * Handle WebAuthn (biometric) login
     */
    async handleWebAuthnLogin() {
        const biometricBtn = document.getElementById('biometric-login-btn');
        const storedCredentialId = localStorage.getItem('webauthn_credential_id');

        if (!storedCredentialId) {
            this.showError('Biometric login not set up yet. Please sign in with email/password first, then enable biometric login in Settings > Account.');
            return;
        }

        // Show loading state
        const originalHtml = biometricBtn?.innerHTML;
        if (biometricBtn) {
            biometricBtn.disabled = true;
            biometricBtn.innerHTML = `
                <svg class="animate-spin -ml-1 mr-3 h-5 w-5 text-white inline-block" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                Authenticating...
            `;
        }

        try {
            // Step 1: Get challenge from server
            const challengeResponse = await fetch(`${this.apiBaseUrl}/webauthn/challenge`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'authenticate',
                    credential_id: storedCredentialId
                })
            });

            const challengeData = await challengeResponse.json();
            if (!challengeData.success) {
                throw new Error(challengeData.message || 'Failed to get authentication challenge');
            }

            // Step 2: Create credential request options
            const publicKeyCredentialRequestOptions = {
                challenge: this.base64UrlDecode(challengeData.challenge),
                rpId: challengeData.rp_id,
                timeout: 60000,
                userVerification: 'required',
                allowCredentials: [{
                    id: this.base64UrlDecode(storedCredentialId),
                    type: 'public-key',
                    transports: ['internal']  // Only use local platform authenticator (fingerprint/Face ID)
                }]
            };

            // Step 3: Get credential (triggers biometric prompt)
            const credential = await navigator.credentials.get({
                publicKey: publicKeyCredentialRequestOptions
            });

            if (!credential) {
                throw new Error('No credential returned from authenticator');
            }

            // Step 4: Send credential to server for verification
            const authResponse = await fetch(`${this.apiBaseUrl}/webauthn/authenticate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    credential_id: storedCredentialId,
                    client_data_json: this.base64UrlEncode(new Uint8Array(credential.response.clientDataJSON)),
                    authenticator_data: this.base64UrlEncode(new Uint8Array(credential.response.authenticatorData)),
                    signature: this.base64UrlEncode(new Uint8Array(credential.response.signature))
                })
            });

            const authData = await authResponse.json();

            if (authData.success) {
                // Store token and user data (format from WebAuthn controller)
                this.saveAuthData({
                    access_token: authData.token,
                    user: authData.user
                });

                // Show splash screen on redirect
                sessionStorage.setItem('showSplash', 'true');

                // Redirect to main app
                window.location.href = 'index.html';
            } else {
                throw new Error(authData.message || 'Biometric authentication failed');
            }

        } catch (error) {
            console.error('WebAuthn login error:', error);

            let errorMessage = 'Biometric login failed';
            if (error.name === 'NotAllowedError') {
                errorMessage = 'Biometric authentication was cancelled or not allowed';
            } else if (error.name === 'SecurityError') {
                errorMessage = 'Security error. Please ensure you are using HTTPS';
            } else if (error.name === 'InvalidStateError') {
                errorMessage = 'Invalid credential state. Please try again';
            } else if (error.message) {
                errorMessage = error.message;
            }

            // If credential not found on server, clear local storage
            if (error.message?.includes('not found') || error.message?.includes('CREDENTIAL_NOT_FOUND')) {
                localStorage.removeItem('webauthn_credential_id');
                biometricBtn?.classList.add('hidden');
                errorMessage = 'Biometric credential not found. Please set up biometric login again in Settings.';
            }

            this.showError(errorMessage);
        } finally {
            // Reset button
            if (biometricBtn) {
                biometricBtn.disabled = false;
                biometricBtn.innerHTML = originalHtml;
            }
        }
    }

    /**
     * Base64URL encode (for WebAuthn)
     */
    base64UrlEncode(buffer) {
        let binary = '';
        const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary)
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=/g, '');
    }

    /**
     * Base64URL decode (for WebAuthn)
     */
    base64UrlDecode(str) {
        // Add padding if necessary
        let padded = str.replace(/-/g, '+').replace(/_/g, '/');
        while (padded.length % 4) {
            padded += '=';
        }
        const binary = atob(padded);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes.buffer;
    }

    saveAuthData(authData) {
        this.token = authData.access_token;
        this.user = authData.user;
        // Persist under the active email; one active session at a time.
        window.accountStore.setActiveAccount(
            authData.user,
            authData.access_token,
            authData.refresh_token
        );
        console.log('✅ Authentication data saved');
    }

    async checkAuth() {
        // Embed mode: wait for the parent app to postMessage the JWT before
        // falling back to the login redirect. The host is responsible for
        // sending {type:'gpt-embed-auth', token, user} after our ready ping.
        if (this.isEmbedMode && (!this.token || !this.user)) {
            console.log('⏳ Embed mode: waiting for parent to post JWT...');
            await this.waitForEmbedToken();
        }

        // If not authenticated, redirect to login (embed mode skips this so
        // the iframe doesn't navigate the parent page to login.html).
        if (!this.token || !this.user) {
            if (this.isEmbedMode) {
                console.warn('Embed mode: no JWT received from parent');
                return;
            }
            window.location.href = 'login.html';
            return;
        }

        // First check if token is expired locally (faster than API call)
        if (this.isTokenExpired(this.token)) {
            console.log('❌ Token expired, logging out');
            this.logout();
            return;
        }

        // Token exists and not expired locally, verify with server
        try {
            await this.verifyToken();
            // Token is valid, user can proceed
            this.authVerified = true;
            console.log('✅ Authentication verified');

            // Start periodic token validation after successful authentication
            this.startTokenValidationTimer();

            // Run post-login startup tasks (catalog refresh, future wizard
            // steps, etc.). Drives the #splash-screen overlay on fresh
            // logins and runs silently on resumed sessions. Fire-and-forget:
            // failures inside individual tasks are logged but never block
            // the boot path.
            window.startupTasks?.runAll({
                token: this.token,
                user: this.user,
                apiBase: this.apiBaseUrl
            }).catch(err => console.warn('[Auth] startupTasks.runAll failed:', err));
        } catch (error) {
            // Token invalid or expired, logout and redirect
            console.log('❌ Token verification failed, logging out');
            this.logout();
        }
    }

    /**
     * Start a recurring timer to validate token every 30 seconds
     * This prevents users from continuing to work with an expired token
     */
    startTokenValidationTimer() {
        // Clear any existing timer first
        this.stopTokenValidationTimer();

        // Check token every 30 seconds (30000 milliseconds)
        this.tokenCheckInterval = setInterval(() => {
            // Re-read the active session token from the store (it may have been
            // cleared by a logout in another tab).
            this.token = window.accountStore.getToken();

            // If no token, logout
            if (!this.token) {
                console.log('❌ No token found, logging out');
                this.logout();
                return;
            }

            // Check if token is expired
            if (this.isTokenExpired(this.token)) {
                console.log('❌ Token expired during session, logging out');
                this.logout();
            }
        }, 30000); // 30 seconds
    }

    /**
     * Stop the token validation timer (cleanup)
     */
    stopTokenValidationTimer() {
        if (this.tokenCheckInterval) {
            clearInterval(this.tokenCheckInterval);
            this.tokenCheckInterval = null;
            console.log('⏰ Token validation timer stopped');
        }
    }

    /**
     * Check if JWT token is expired by decoding it client-side
     */
    isTokenExpired(token) {
        try {
            // Decode JWT token (it's base64 encoded)
            const payload = JSON.parse(atob(token.split('.')[1]));

            // Check expiration time (exp is in seconds, Date.now() is in milliseconds)
            if (payload.exp) {
                const now = Math.floor(Date.now() / 1000);
                return payload.exp < now;
            }

            // If no expiration in token, assume it's valid
            return false;
        } catch (error) {
            // If we can't decode the token, assume it's invalid/expired
            console.error('Error decoding token:', error);
            return true;
        }
    }

    /**
     * Clear authentication data from localStorage and instance
     */
    clearAuthData() {
        // Clears the active session (activeEmail + tokens) but keeps the
        // per-email cache so the account can be logged into again.
        window.accountStore.clearActiveAccount();
        this.token = null;
        this.user = null;
    }

    async verifyToken() {
        const response = await fetch(`${this.apiBaseUrl}/auth`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.token}`
            },
            body: JSON.stringify({
                action: 'verify'
            })
        });

        const data = await response.json();

        if (!data.success) {
            throw new Error('Token verification failed');
        }

        return data;
    }

    logout() {
        // Stop token validation timer
        this.stopTokenValidationTimer();

        // Clear all auth data
        this.clearAuthData();

        // In embed mode, don't navigate the iframe to login.html — let the
        // parent decide what to do (e.g. show its own re-auth prompt). We post
        // a logout signal so the host can react.
        if (this.isEmbedMode) {
            if (window.parent && window.parent !== window) {
                try {
                    window.parent.postMessage({ type: 'gpt-embed-logout' }, '*');
                } catch {}
            }
            return;
        }

        // Redirect to login
        window.location.href = 'login.html';
    }

    showError(message) {
        const errorDiv = document.getElementById('error-message');
        const errorText = document.getElementById('error-text');

        if (errorDiv && errorText) {
            errorText.textContent = message;
            errorDiv.classList.remove('hidden');

            // Auto-hide after 5 seconds
            setTimeout(() => {
                errorDiv.classList.add('hidden');
            }, 5000);
        }
    }

    getToken() {
        return this.token;
    }

    getUser() {
        return this.user;
    }

    isAuthenticated() {
        return !!(this.token && this.user);
    }

    /**
     * Get authorization headers for API requests
     * @returns {Object} Headers object with Authorization and Content-Type
     */
    getAuthHeaders() {
        const headers = {
            'Content-Type': 'application/json'
        };
        if (this.token) {
            headers['Authorization'] = `Bearer ${this.token}`;
        }
        return headers;
    }

    /**
     * Make an authenticated API request
     * @param {string} url - The API endpoint URL
     * @param {Object} options - Fetch options
     * @returns {Promise<Response>} Fetch response
     */
    async authFetch(url, options = {}) {
        const headers = {
            ...this.getAuthHeaders(),
            ...(options.headers || {})
        };
        return fetch(url, {
            ...options,
            headers
        });
    }
}

// Initialize auth manager when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.authManager = new AuthManager();
});
