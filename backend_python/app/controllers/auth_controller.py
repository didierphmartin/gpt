"""Port of Controllers/AuthController.php. Method names and response dicts are kept
verbatim; key order matters (it is the JSON key order)."""
from __future__ import annotations

import os
import re
import secrets
import time

import bcrypt
import jwt

from app.db import Db
from app.middleware.auth import decode_hs256, hash_user_app_key, user_app_key_pepper
from app.services.firebase_tokens import verify_firebase_id_token
from app.support.logger import error_log
from app.support.phpcompat import is_numeric, php_now, validate_email

FREE_TRIAL_TOKEN_QUOTA = 50000
PHP_VERSION = '8.2.4'   # debugAuth reports PHP_VERSION; mirrored constant (XAMPP's PHP)


def _to_int(v) -> int:
    """PHP (int) cast semantics: numeric -> int(v), everything else -> 0."""
    return int(v) if is_numeric(v) else 0


def normalize_plan(plan) -> str:
    p = str(plan or '').strip().lower()
    if '_' in p:
        p = p.split('_', 1)[1]
    return p if p in ('standard', 'premium') else 'free'


def role_for_plan(plan: str) -> str:
    return 'prospect' if plan == 'free' else 'user'


def plan_rank(plan) -> int:
    return {'free': 0, 'standard': 1, 'premium': 2}.get(normalize_plan(plan), 0)


def generate_tokens(user_id: int, secret: str, jwt_expiry: int, refresh_expiry: int) -> dict:
    now = int(time.time())
    access = {'iss': 'gpt-chat', 'iat': now, 'exp': now + jwt_expiry, 'sub': user_id, 'type': 'access'}
    refresh = {'iss': 'gpt-chat', 'iat': now, 'exp': now + refresh_expiry, 'sub': user_id, 'type': 'refresh'}
    return {'access_token': jwt.encode(access, secret, algorithm='HS256'),
            'refresh_token': jwt.encode(refresh, secret, algorithm='HS256')}


def password_verify(password: str, stored_hash) -> bool:
    """PHP password_verify(): accepts $2y$/$2a$/$2b$ bcrypt hashes."""
    if not stored_hash:
        return False
    h = str(stored_hash)
    if h.startswith('$2y$'):
        h = '$2b$' + h[4:]
    try:
        return bcrypt.checkpw(password.encode('utf-8'), h.encode('utf-8'))
    except ValueError:
        return False


def password_hash(password: str) -> str:
    """PHP password_hash(PASSWORD_BCRYPT) (cost 10). Emits $2b$; PHP verifies $2b$ fine."""
    return bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt(rounds=10)).decode('ascii')


def _user_payload(user: dict, user_id: int, provider_default: str, provider_override: str | None = None) -> dict:
    return {
        'id': user_id,
        'email': user['email'],
        'first_name': user['first_name'],
        'last_name': user['last_name'],
        'role': user.get('role') or 'prospect',
        'plan': user.get('plan') or 'free',
        'provider': provider_override if provider_override is not None else (user.get('provider') or provider_default),
        'last_login': php_now(),
        'created_at': user.get('created_at'),
        'app_key_prefix': user.get('app_key_prefix'),
        'app_key_created_at': user.get('app_key_created_at'),
    }


class AuthController:
    def __init__(self, db, config: dict):
        self.db = db
        self.config = config
        auth = config.get('auth') or {}
        self.jwt_secret = str(auth.get('jwt_secret', '') or '')
        if self.jwt_secret == '':
            raise RuntimeError('JWT secret is not configured (set JWT_SECRET).')
        self.jwt_expiry = int(auth.get('jwt_expiry', 28800))
        self.refresh_expiry = int(auth.get('refresh_expiry', 604800))

    # ---- helpers -------------------------------------------------------------
    def _tokens(self, user_id: int) -> dict:
        return generate_tokens(user_id, self.jwt_secret, self.jwt_expiry, self.refresh_expiry)

    def _firebase_project_id(self) -> str:
        from_config = str((self.config.get('firebase') or {}).get('project_id', '') or '')
        if from_config:
            return from_config
        from_env = os.environ.get('FIREBASE_PROJECT_ID', '')
        return from_env or 'transledgersite'

    def _app_key_pepper(self) -> str:
        return user_app_key_pepper(self.config, self.jwt_secret)

    def _generate_app_key_material(self) -> dict:
        key = 'uak_' + secrets.token_bytes(16).hex()
        return {'key': key, 'prefix': key[:12], 'hash': hash_user_app_key(key, self._app_key_pepper())}

    @staticmethod
    def _auth_required() -> dict:
        return {'success': False, 'message': 'Authentication required', 'status_code': 401}

    # ---- legacy action dispatcher ------------------------------------------
    def handleAction(self, request) -> dict:
        action = request['body'].get('action', '')
        protected = ['link_phone', 'unlink_phone', 'upgrade_plan', 'generate_app_key', 'revoke_app_key',
                     'admin_generate_app_key', 'admin_revoke_app_key']
        if action in protected and not request.get('user_id'):
            return self._auth_required()
        table = {
            'login': self.login, 'register': self.register, 'firebase': self.firebaseAuth, 'verify': self.verify,
            'sso_exchange': self.ssoExchange, 'logout': self.logout, 'link_phone': self.linkPhone,
            'unlink_phone': self.unlinkPhone, 'upgrade_plan': self.upgradePlan,
            'generate_app_key': self.generateAppKey, 'revoke_app_key': self.revokeAppKey,
            'admin_generate_app_key': self.adminGenerateAppKeyForUser,
            'admin_revoke_app_key': self.adminRevokeAppKeyForUser,
        }
        fn = table.get(action)
        if fn is None:
            return {'success': False, 'message': 'Invalid action', 'status_code': 400}
        return fn(request)

    # ---- login / sso / register --------------------------------------------
    def login(self, request) -> dict:
        email = request['body'].get('email', '') or ''
        password = request['body'].get('password', '') or ''
        if not email or not password:
            return {'success': False, 'message': 'Email and password are required', 'status_code': 400}
        user = self.db.fetch_one("SELECT * FROM users WHERE email = ?", [str(email).strip().lower()])
        if not user or not password_verify(str(password), user.get('password')):
            return {'success': False, 'message': 'Invalid email or password', 'status_code': 401}
        tokens = self._tokens(int(user['id']))
        self.db.execute("UPDATE users SET last_login = NOW() WHERE id = ?", [user['id']])
        return {
            'success': True, 'message': 'Login successful',
            'data': {'user': _user_payload(user, int(user['id']), 'email'),
                     'access_token': tokens['access_token'], 'refresh_token': tokens['refresh_token'],
                     'expires_in': self.jwt_expiry},
            'status_code': 200,
        }

    def ssoExchange(self, request) -> dict:
        login_token = str(request['body'].get('login_token', '') or '')
        if login_token == '':
            return {'success': False, 'message': 'login_token is required', 'status_code': 400}
        secret = str((self.config.get('auth') or {}).get('login_jwt_secret', '') or '')
        if secret == '':
            return {'success': False, 'message': 'SSO is not configured (LOGIN_JWT_SECRET missing)', 'status_code': 500}
        claims = decode_hs256(login_token, secret)
        if claims is None:
            return {'success': False, 'message': 'Invalid SSO token', 'status_code': 401}
        if claims.get('iss') != 'login-service':
            return {'success': False, 'message': 'Invalid SSO token', 'status_code': 401}
        if claims.get('type') != 'access' or 'sub' not in claims:
            return {'success': False, 'message': 'Invalid SSO token', 'status_code': 401}
        ld = self.config.get('login_db') or {}
        try:
            ldb = Db.connect({'host': ld.get('host', ''), 'database': ld.get('database', ''),
                              'username': ld.get('username', ''), 'password': ld.get('password', ''),
                              'charset': 'utf8mb4'}, timeout=5)
            try:
                login_user = ldb.fetch_one('SELECT email, email_verified FROM users WHERE id = ?',
                                           [int(claims['sub'])]) or {}
            finally:
                ldb.close()
            email = str(login_user.get('email', '') or '').strip().lower()
        except Exception:  # noqa: BLE001
            return {'success': False, 'message': 'SSO temporarily unavailable', 'status_code': 503}
        if email == '':
            return {'success': False, 'message': 'Unknown SSO user', 'status_code': 401}
        if not login_user.get('email_verified'):
            return {'success': False, 'message': 'SSO account email not verified', 'status_code': 403}
        user = self.db.fetch_one('SELECT * FROM users WHERE email = ?', [email])
        if not user:
            return {'success': False, 'message': f'No account for {email} — sign up first', 'status_code': 403}
        tokens = self._tokens(int(user['id']))
        self.db.execute('UPDATE users SET last_login = NOW() WHERE id = ?', [user['id']])
        return {
            'success': True, 'message': 'Login successful',
            'data': {'user': _user_payload(user, int(user['id']), 'sso', provider_override='sso'),
                     'access_token': tokens['access_token'], 'refresh_token': tokens['refresh_token'],
                     'expires_in': self.jwt_expiry},
            'status_code': 200,
        }

    def register(self, request) -> dict:
        b = request['body']
        email = str(b.get('email', '') or '').strip().lower()
        password = b.get('password', '') or ''
        first_name = str(b.get('first_name', '') or '').strip()
        last_name = str(b.get('last_name', '') or '').strip()
        ledger_user_id = str(b.get('ledger_user_id', '') or '').strip()
        plan = str(b.get('plan', 'free') or 'free').strip()
        if not email or not password:
            return {'success': False, 'message': 'Email and password are required', 'status_code': 400}
        if not validate_email(email):
            return {'success': False, 'message': 'Invalid email format', 'status_code': 400}
        if not ledger_user_id:
            return {'success': False,
                    'message': 'Registration requires a valid subscription. Please register through synergyaichat.com',
                    'code': 'LEDGER_ACCOUNT_REQUIRED', 'status_code': 400}
        plan = normalize_plan(plan)
        role = role_for_plan(plan)
        if self.db.fetch_one("SELECT id FROM users WHERE email = ?", [email]):
            return {'success': False, 'message': 'Email already registered', 'status_code': 409}
        user_id = self.db.insert(
            "INSERT INTO users (email, password, first_name, last_name, role, ledger_user_id, plan, provider, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, 'email', NOW(), NOW())",
            [email, password_hash(str(password)), first_name, last_name, role, ledger_user_id, plan])
        tokens = self._tokens(user_id)
        now = php_now()
        return {
            'success': True, 'message': 'Registration successful',
            'data': {'user': {'id': user_id, 'email': email, 'first_name': first_name, 'last_name': last_name,
                              'role': role, 'plan': plan, 'provider': 'email', 'last_login': now, 'created_at': now,
                              'app_key_prefix': None, 'app_key_created_at': None},
                     'access_token': tokens['access_token'], 'refresh_token': tokens['refresh_token'],
                     'expires_in': self.jwt_expiry},
            'status_code': 200,
        }

    # ---- firebase ------------------------------------------------------------
    def firebaseAuth(self, request) -> dict:
        b = request['body']
        provider = b.get('provider', '') or ''
        id_token = b.get('idToken', '') or ''
        user_data = b.get('userData') or {}
        if not id_token:
            return {'success': False, 'message': 'Invalid authentication data', 'status_code': 400}
        claims = verify_firebase_id_token(str(id_token), self._firebase_project_id())
        if claims is None:
            return {'success': False, 'message': 'Invalid or expired authentication token', 'status_code': 401}
        verified_email = str(claims.get('email', '')).strip().lower() if 'email' in claims else ''
        verified_phone = str(claims.get('phone_number', '')).strip() if 'phone_number' in claims else ''
        firebase_uid = str(claims.get('sub', ''))
        if not verified_email and not verified_phone:
            return {'success': False, 'message': 'Invalid authentication data', 'status_code': 400}
        email = verified_email if verified_email else verified_phone.lower() + '@phone.auth'
        phone_number = verified_phone if verified_phone else None
        first_name = user_data.get('first_name', '') or ''
        last_name = user_data.get('last_name', '') or ''
        user = self.db.fetch_one("SELECT * FROM users WHERE email = ? OR firebase_uid = ? OR phone = ?",
                                 [email, firebase_uid, phone_number])
        ledger_user_id = str(user_data.get('ledger_user_id') or b.get('ledger_user_id') or '').strip()
        plan = normalize_plan(user_data.get('plan') or b.get('plan') or 'free')
        role = role_for_plan(plan)
        if user:
            self.db.execute(
                "UPDATE users SET last_login = NOW(), firebase_uid = COALESCE(firebase_uid, ?), provider = ?,"
                " phone = COALESCE(phone, ?) WHERE id = ?", [firebase_uid, provider, phone_number, user['id']])
            user_id = int(user['id'])
            if plan != 'free' and (user.get('role') or '') != 'admin' and plan_rank(plan) > plan_rank(user.get('plan') or 'free'):
                self.db.execute("UPDATE users SET plan = ?, role = ?, updated_at = NOW() WHERE id = ?", [plan, role, user_id])
                user = dict(user); user['plan'] = plan; user['role'] = role
        else:
            if not ledger_user_id:
                return {'success': False,
                        'message': 'Registration requires a valid subscription. Please register through synergyaichat.com',
                        'code': 'LEDGER_ACCOUNT_REQUIRED', 'status_code': 400}
            user_id = self.db.insert(
                "INSERT INTO users (email, first_name, last_name, firebase_uid, provider, phone, role, ledger_user_id, plan, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())",
                [email, first_name, last_name, firebase_uid, provider, phone_number, role, ledger_user_id, plan])
            user = self.db.fetch_one("SELECT * FROM users WHERE id = ?", [user_id])
        tokens = self._tokens(user_id)
        return {
            'success': True, 'message': 'Authentication successful',
            'data': {'user': _user_payload(user, user_id, 'firebase'),
                     'access_token': tokens['access_token'], 'refresh_token': tokens['refresh_token'],
                     'expires_in': self.jwt_expiry},
            'status_code': 200,
        }

    # ---- verify / logout -----------------------------------------------------
    def verify(self, request) -> dict:
        value = request['headers'].get('Authorization') or request['headers'].get('authorization') or ''
        m = re.search(r'Bearer\s+(.*)$', value, re.I)
        if not m:
            return {'success': False, 'message': 'Authorization token required', 'status_code': 401}
        claims = decode_hs256(m.group(1), self.jwt_secret)
        if claims is None:
            return {'success': False, 'message': 'Invalid or expired token', 'status_code': 401}
        return {'success': True, 'message': 'Token is valid', 'data': {'user_id': claims.get('sub')}, 'status_code': 200}

    def logout(self, request) -> dict:
        return {'success': True, 'message': 'Logout successful', 'status_code': 200}

    # ---- phone / plan --------------------------------------------------------
    def linkPhone(self, request) -> dict:
        user_id = request.get('user_id')
        phone_number = request['body'].get('phone_number', '') or ''
        if not user_id:
            return self._auth_required()
        if not phone_number:
            return {'success': False, 'message': 'Phone number is required', 'status_code': 400}
        if self.db.fetch_one("SELECT id FROM users WHERE phone = ? AND id != ?", [phone_number, user_id]):
            return {'success': False, 'message': 'Phone number is already linked to another account', 'status_code': 409}
        self.db.execute("UPDATE users SET phone = ?, updated_at = NOW() WHERE id = ?", [phone_number, user_id])
        error_log(f'[AuthController] Phone linked: user_id={user_id}, phone={phone_number}')
        return {'success': True, 'message': 'Phone number linked successfully', 'status_code': 200}

    def unlinkPhone(self, request) -> dict:
        user_id = request.get('user_id')
        if not user_id:
            return self._auth_required()
        self.db.execute("UPDATE users SET phone = NULL, updated_at = NOW() WHERE id = ?", [user_id])
        error_log(f'[AuthController] Phone unlinked: user_id={user_id}')
        return {'success': True, 'message': 'Phone number unlinked successfully', 'status_code': 200}

    def upgradePlan(self, request) -> dict:
        user_id = request.get('user_id')
        plan = str(request['body'].get('plan', '') or '').strip()
        if not user_id:
            return self._auth_required()
        plan = normalize_plan(plan)
        if plan not in ('standard', 'premium'):
            return {'success': False, 'message': 'Invalid plan. Must be standard or premium.', 'status_code': 400}
        role = role_for_plan(plan)
        self.db.execute("UPDATE users SET plan = ?, role = ?, updated_at = NOW() WHERE id = ?", [plan, role, user_id])
        error_log(f'[AuthController] Plan upgraded: user_id={user_id}, plan={plan}, role={role}')
        return {'success': True, 'message': f'Plan upgraded to {plan}', 'plan': plan, 'role': role, 'status_code': 200}

    def debugAuth(self, request) -> dict:
        has_header = bool(request['headers'].get('Authorization') or request['headers'].get('authorization'))
        return {'success': True, 'user_id': request.get('user_id'), 'authenticated': request.get('authenticated', False),
                'has_auth_header': has_header, 'php_version': PHP_VERSION, 'status_code': 200}

    # ---- per-user app keys ---------------------------------------------------
    def generateAppKey(self, request) -> dict:
        user_id = request.get('user_id')
        if not user_id or request.get('auth_type') != 'jwt':
            return self._auth_required()
        m = self._generate_app_key_material()
        self.db.execute("UPDATE users SET app_key_hash = ?, app_key_prefix = ?, app_key_created_at = NOW(), updated_at = NOW() WHERE id = ?",
                        [m['hash'], m['prefix'], user_id])
        return {'success': True, 'message': 'App key generated. Save it now — it will not be shown again.',
                'data': {'app_key': m['key'], 'app_key_prefix': m['prefix'], 'app_key_created_at': php_now()},
                'status_code': 200}

    def revokeAppKey(self, request) -> dict:
        user_id = request.get('user_id')
        if not user_id or request.get('auth_type') != 'jwt':
            return self._auth_required()
        self.db.execute("UPDATE users SET app_key_hash = NULL, app_key_prefix = NULL, app_key_created_at = NULL, updated_at = NOW() WHERE id = ?",
                        [user_id])
        return {'success': True, 'message': 'App key revoked.', 'status_code': 200}

    def _require_admin_caller(self, request) -> dict | None:
        caller_id = request.get('user_id')
        if not caller_id or request.get('auth_type') != 'jwt':
            return self._auth_required()
        caller = self.db.fetch_one("SELECT role FROM users WHERE id = ?", [caller_id])
        if not caller or (caller.get('role') or '') != 'admin':
            return {'success': False, 'message': 'Admin privileges required', 'status_code': 403}
        return None

    def adminGenerateAppKeyForUser(self, request) -> dict:
        err = self._require_admin_caller(request)
        if err:
            return err
        target = _to_int(request['body'].get('user_id'))
        if target <= 0:
            return {'success': False, 'message': 'user_id is required', 'status_code': 400}
        if not self.db.fetch_one("SELECT id FROM users WHERE id = ?", [target]):
            return {'success': False, 'message': 'User not found', 'status_code': 404}
        m = self._generate_app_key_material()
        self.db.execute("UPDATE users SET app_key_hash = ?, app_key_prefix = ?, app_key_created_at = NOW(), updated_at = NOW() WHERE id = ?",
                        [m['hash'], m['prefix'], target])
        error_log(f"[AuthController] Admin user_id={request.get('user_id')} generated app key for user_id={target}")
        return {'success': True, 'message': 'App key generated for user. Save it now — it will not be shown again.',
                'data': {'user_id': target, 'app_key': m['key'], 'app_key_prefix': m['prefix'],
                         'app_key_created_at': php_now()}, 'status_code': 200}

    def adminRevokeAppKeyForUser(self, request) -> dict:
        err = self._require_admin_caller(request)
        if err:
            return err
        target = _to_int(request['body'].get('user_id'))
        if target <= 0:
            return {'success': False, 'message': 'user_id is required', 'status_code': 400}
        self.db.execute("UPDATE users SET app_key_hash = NULL, app_key_prefix = NULL, app_key_created_at = NULL, updated_at = NOW() WHERE id = ?",
                        [target])
        error_log(f"[AuthController] Admin user_id={request.get('user_id')} revoked app key for user_id={target}")
        return {'success': True, 'message': 'App key revoked.', 'data': {'user_id': target}, 'status_code': 200}
