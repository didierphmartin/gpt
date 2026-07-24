import { CorsMiddleware } from './CorsMiddleware';
import { AuthMiddleware, PublicRoute } from './AuthMiddleware';

/** Mirrors src/Middleware/MiddlewareProcessor.php: owns PUBLIC_ROUTES and wires the middleware. */
export class MiddlewareProcessor {
  static readonly PUBLIC_ROUTES: PublicRoute[] = [
    { method: 'POST', pattern: /^\/api\/v1\/auth$/ },
    { method: 'POST', pattern: /^\/api\/v1\/auth\/login$/ },
    { method: 'POST', pattern: /^\/api\/v1\/auth\/register$/ },
    { method: 'POST', pattern: /^\/api\/v1\/auth\/firebase$/ },
    { method: 'POST', pattern: /^\/api\/v1\/auth\/verify$/ },
    { method: 'POST', pattern: /^\/api\/v1\/auth\/logout$/ },
    { method: 'GET', pattern: /^\/api\/v1\/models\/catalog$/ },
    // MCP App UI proxy — serves HTML into an iframe that cannot send an auth header. Mirrors PHP.
    { method: 'GET', pattern: /^\/api\/v1\/mcp\/app$/ },
    // WebAuthn biometric login — challenge + authenticate must be public (no token yet).
    { method: 'POST', pattern: /^\/api\/v1\/webauthn\/challenge$/ },
    { method: 'POST', pattern: /^\/api\/v1\/webauthn\/authenticate$/ },
    // Scheduler cron trigger — public because it validates its own scheduler token for cron access.
    { method: 'POST', pattern: /^\/api\/v1\/scheduler\/run$/ },
    // EVI webhook — external callback from Hume; cannot carry our auth. Mirrors PHP.
    { method: 'POST', pattern: /^\/api\/v1\/evi\/webhook$/ },
    { method: 'GET', pattern: /^\/$/ },
  ];

  readonly cors = new CorsMiddleware();
  readonly auth = new AuthMiddleware(MiddlewareProcessor.PUBLIC_ROUTES);
}
