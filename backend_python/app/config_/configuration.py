"""Configuration manager for AI Portfolio Assistant."""
import os
from copy import deepcopy
from app.exceptions import ConfigurationException
from app.support.phpcompat import php_empty


class Configuration:
    """Configuration manager for AI Portfolio Assistant."""

    DEFAULTS = {
        'claude': {
            'api_key': '',
            'model': 'claude-sonnet-4-5-20250929',
            'max_tokens': 4000,
            'temperature': 0.7,
            'base_url': 'https://api.anthropic.com',
            'api_version': '2023-06-01',
        },
        'openai': {
            'api_key': '',
            'model': 'gpt-4-turbo-preview',
            'max_tokens': 4000,
            'temperature': 0.7,
        },
        'search': {
            'serpapi': {'api_key': ''},
            'scrapingdog': {'api_key': ''},
            'brave': {'api_key': ''},
        },
        'financial': {
            'fmp': {'api_key': ''},  # Financial Modeling Prep
        },
        'sse': {
            'enabled': True,
            'hub_url': None,
        },
        'tracking': {
            'enabled': True,
            'track_costs': True,
        },
        'storage': {
            'default_provider': 'local',  # Options: 'local', 's3', 'gdrive', 'onedrive'
        },
        'debug': False,
        'default_provider': 'claude',
        'max_recursion_depth': 10,
    }

    def __init__(self, config: dict = None):
        """Initialize configuration with optional config dict."""
        if config is None:
            config = {}
        # Deep copy DEFAULTS so set() never mutates the class constant
        self.config = self._mergeWithDefaults(config)

    def _mergeWithDefaults(self, config: dict) -> dict:
        """Merge user config with defaults."""
        return self._arrayMergeRecursive(deepcopy(self.DEFAULTS), config)

    def _arrayMergeRecursive(self, default: dict, override: dict) -> dict:
        """
        Recursively merge arrays (user values override defaults).
        Recurse when both default and override values are dicts.
        A list override replaces (doesn't recurse into lists).
        """
        merged = default.copy()

        for key, value in override.items():
            if isinstance(value, dict) and key in merged and isinstance(merged[key], dict):
                # Both are dicts, recurse
                merged[key] = self._arrayMergeRecursive(merged[key], value)
            else:
                # Override completely (includes when value is a list or other type)
                merged[key] = value

        return merged

    def get(self, key: str, default=None):
        """
        Get a configuration value using dot notation.

        Args:
            key: Configuration key (e.g., 'claude.api_key')
            default: Default value if key not found

        Returns:
            The configuration value or default
        """
        keys = key.split('.')
        value = self.config

        for segment in keys:
            if not isinstance(value, dict) or segment not in value:
                return default
            value = value[segment]

        return value

    def set(self, key: str, value) -> 'Configuration':
        """
        Set a configuration value using dot notation.

        Args:
            key: Configuration key (e.g., 'claude.api_key')
            value: The value to set

        Returns:
            self for chaining
        """
        keys = key.split('.')
        config = self.config

        for i, segment in enumerate(keys):
            if i == len(keys) - 1:
                # Last segment, set the value
                config[segment] = value
            else:
                # Intermediate segment, ensure it's a dict
                if segment not in config or not isinstance(config[segment], dict):
                    config[segment] = {}
                config = config[segment]

        return self

    def has(self, key: str) -> bool:
        """Check if a configuration key exists."""
        return self.get(key) is not None

    def getClaude(self) -> dict:
        """
        Get Claude-specific configuration.

        Returns an empty dict when the key isn't present so callers can treat
        "no DB row + no file fallback" as "provider not configured" instead of
        getting an undefined-index error. Returns a deep copy so callers cannot
        mutate the Configuration.
        """
        # PHP ?? operator: None or missing → {}
        value = self.config.get('claude')
        value = {} if value is None else value
        return deepcopy(value)

    def getOpenAI(self) -> dict:
        """
        Get OpenAI-specific configuration.

        Same fallback semantics as getClaude. Returns a deep copy.
        """
        # PHP ?? operator: None or missing → {}
        value = self.config.get('openai')
        value = {} if value is None else value
        return deepcopy(value)

    def getSearch(self) -> dict:
        """Get search API configuration. Returns a deep copy."""
        value = self.config.get('search', {})
        return deepcopy(value)

    def getFinancial(self) -> dict:
        """Get financial API configuration. Returns a deep copy."""
        value = self.config.get('financial', {})
        return deepcopy(value)

    def isProviderConfigured(self, provider: str) -> bool:
        """Check if a provider is configured with an API key."""
        key = self.get(f'{provider}.api_key')
        return not php_empty(key)

    def getDefaultProvider(self) -> str:
        """Get the default provider."""
        return self.config.get('default_provider')

    def isDebugEnabled(self) -> bool:
        """Check if debug mode is enabled."""
        return bool(self.config.get('debug'))

    def toArray(self) -> dict:
        """Get all configuration as array. Returns a deep copy so callers cannot mutate."""
        return deepcopy(self.config)

    def validateProvider(self, provider: str) -> None:
        """
        Validate required configuration for a provider.

        Raises:
            ConfigurationException: If provider is not configured
        """
        if not self.isProviderConfigured(provider):
            raise ConfigurationException(
                f"Provider '{provider}' is not configured. Please set the API key."
            )

    @staticmethod
    def fromEnvironment():
        """Create configuration from environment variables."""
        # PHP (bool) getenv('AI_DEBUG') semantics: "0" and "" are false, any other non-empty string is true
        debug_value = os.environ.get('AI_DEBUG', '')
        debug_enabled = not php_empty(debug_value)

        return Configuration({
            'claude': {
                'api_key': os.getenv('CLAUDE_API_KEY') or '',
                'model': os.getenv('CLAUDE_MODEL') or 'claude-sonnet-4-5-20250929',
            },
            'openai': {
                'api_key': os.getenv('OPENAI_API_KEY') or '',
            },
            'search': {
                'serpapi': {'api_key': os.getenv('SERPAPI_API_KEY') or ''},
                'scrapingdog': {'api_key': os.getenv('SCRAPINGDOG_API_KEY') or ''},
                'brave': {'api_key': os.getenv('BRAVE_API_KEY') or ''},
            },
            'financial': {
                'fmp': {'api_key': os.getenv('FMP_API_KEY') or ''},
            },
            'storage': {
                'default_provider': os.getenv('STORAGE_PROVIDER') or 'local',
            },
            'debug': debug_enabled,
        })
