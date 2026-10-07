/** Decision-model protocols (twin of backend/src/Services/DecisionProtocols.php; no adapters here). */
export const DECISION_PROTOCOLS: Record<string, { label: string; url: string; model: string; console_url: string;
  legacy_env: { key: string; url: string } }> = {
  typesafe: {
    label: 'TypeSafe (Jev)',
    url: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-latest',
    console_url: 'https://console.typesafe.ai/',
    legacy_env: { key: 'TYPESAFE_API_KEY', url: 'TYPESAFE_BASE_URL' },
  },
};

export function decisionProtocolCatalog() {
  return Object.entries(DECISION_PROTOCOLS).map(([id, p]) => ({ id, label: p.label, url: p.url, model: p.model, console_url: p.console_url }));
}

/** Env var stem for a row key: upper case, every char outside A-Z0-9 -> '_'. */
export function envStem(key: string): string {
  return key.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}
