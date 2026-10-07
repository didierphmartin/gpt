import { PackageResolver } from './PackageResolver';

/**
 * The package allowlist rule as an `allowed(key)` callback: no provider allowlist = everything
 * allowed; otherwise a provider missing or not enabled is refused. Same rule as the LLM provider
 * list (fails open on a lookup error, like getKeys).
 */
export async function packageAllowed(userId: unknown): Promise<(key: string) => boolean> {
  try {
    const id = /^\d+$/.test(String(userId)) ? Number(userId) : null;
    const providers = (await new PackageResolver().resolveForUser(id)).capabilities?.providers;
    if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return () => true;
    return (key) => {
      const entry = (providers as Record<string, any>)[key];
      return !!entry && typeof entry === 'object' && !!entry.enabled;
    };
  } catch {
    return () => true;
  }
}
