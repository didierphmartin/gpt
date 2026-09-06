import pytest
from app.config import load_config, ConfigError, default_env_file
import app.config

REQUIRED = {
    'DB_HOST': 'h', 'DB_NAME': 'n', 'DB_USER': 'u', 'DB_PASS': 'p',
    'CTX_DB_HOST': 'ch', 'CTX_DB_NAME': 'cn', 'CTX_DB_USER': 'cu', 'CTX_DB_PASS': 'cp',
    'JWT_SECRET': 'jwt-secret', 'APP_KEY_SECRET': 'ak-secret',
}


def _env(monkeypatch, overrides=None):
    for k in list(REQUIRED) + ['PORT', 'PHP_TIMEZONE', 'LOGIN_DB_NAME', 'FIREBASE_PROJECT_ID']:
        monkeypatch.delenv(k, raising=False)
    for k, v in {**REQUIRED, **(overrides or {})}.items():
        monkeypatch.setenv(k, v)


def test_config_mirrors_ai_config_shape(monkeypatch):
    _env(monkeypatch)
    cfg = load_config(env_file=None)
    assert cfg['database'] == {'host': 'h', 'database': 'n', 'username': 'u', 'password': 'p', 'charset': 'utf8mb4'}
    assert cfg['contexts_database']['database'] == 'cn'
    assert cfg['auth'] == {
        'jwt_secret': 'jwt-secret', 'jwt_expiry': 28800, 'refresh_expiry': 604800,
        'app_key_secret': 'ak-secret', 'login_jwt_secret': '',
    }
    assert cfg['login_db']['database'] == 'netfo587_login'   # PHP default when LOGIN_DB_NAME unset
    assert cfg['login_db']['host'] == 'h'                     # falls back to DB_HOST
    assert cfg['login_database']['database'] == ''            # no default in this block (PHP quirk)
    assert cfg['default_provider'] == 'kimi'
    assert cfg['max_recursion_depth'] == 10
    assert cfg['scheduler']['max_concurrent'] == 5
    assert cfg['port'] == 3002
    assert cfg['firebase']['project_id'] == 'transledgersite'


def test_missing_required_raises_php_message(monkeypatch):
    _env(monkeypatch)
    monkeypatch.delenv('JWT_SECRET')
    monkeypatch.delenv('DB_PASS')
    with pytest.raises(ConfigError) as ei:
        load_config(env_file=None)
    assert str(ei.value) == (
        'Missing required env vars: DB_PASS, JWT_SECRET. '
        'Copy backend/.env.example to backend/.env and fill it in.'
    )


def test_missing_vars_preserve_required_order(monkeypatch):
    """Verify error message lists missing vars in REQUIRED declaration order, not sorted."""
    _env(monkeypatch)
    monkeypatch.delenv('APP_KEY_SECRET')
    monkeypatch.delenv('DB_HOST')
    with pytest.raises(ConfigError) as ei:
        load_config(env_file=None)
    # REQUIRED order: DB_HOST at position 0, APP_KEY_SECRET at position 9
    assert str(ei.value) == (
        'Missing required env vars: DB_HOST, APP_KEY_SECRET. '
        'Copy backend/.env.example to backend/.env and fill it in.'
    )


def test_default_env_file_resolution(tmp_path, monkeypatch):
    """Test default_env_file() resolution order: own .env → PHP .env → None."""
    # Scenario (a): own .env exists
    own_dir = tmp_path / 'own'
    own_dir.mkdir()
    own_env = own_dir / '.env'
    own_env.write_text('TEST=1')
    monkeypatch.setattr(app.config, 'ROOT', own_dir)
    monkeypatch.setattr(app.config, 'PHP_BACKEND', tmp_path / 'nonexistent_php')
    result = default_env_file()
    assert result == str(own_env)

    # Scenario (b): own .env doesn't exist, PHP .env does
    php_dir = tmp_path / 'php_backend'
    php_dir.mkdir()
    php_env = php_dir / '.env'
    php_env.write_text('TEST=2')
    own_dir_no_env = tmp_path / 'own_no_env'
    own_dir_no_env.mkdir()
    monkeypatch.setattr(app.config, 'ROOT', own_dir_no_env)
    monkeypatch.setattr(app.config, 'PHP_BACKEND', php_dir)
    result = default_env_file()
    assert result == str(php_env)

    # Scenario (c): neither exist
    monkeypatch.setattr(app.config, 'ROOT', tmp_path / 'nonexistent_own')
    monkeypatch.setattr(app.config, 'PHP_BACKEND', tmp_path / 'nonexistent_php2')
    result = default_env_file()
    assert result is None
