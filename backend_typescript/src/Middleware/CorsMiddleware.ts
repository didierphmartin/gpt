import { Request, Response, NextFunction } from 'express';
import { config } from '../config/env';

/**
 * Mirrors src/Middleware/CorsMiddleware.php, with one necessary divergence. The PHP backend is
 * SAME-ORIGIN to the frontend (served under the same host), so it can return `*` and never deals
 * with credentialed CORS. The TS backend runs on a different port (:3001), so the frontend reaches
 * it CROSS-ORIGIN — and parts of the frontend (the browser-driven workflow runner) fetch with
 * `credentials: 'include'`. Browsers FORBID `Access-Control-Allow-Origin: *` for credentialed
 * requests, which surfaces as "Failed to fetch". So when an Origin is present we echo it back and
 * set Access-Control-Allow-Credentials, which the browser accepts. (Auth here is Bearer-token, not
 * cookie-based, so echoing the origin doesn't widen the real attack surface.)
 */
export class CorsMiddleware {
  // Arrow property so it can be passed directly to app.use() while staying bound.
  handle = (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
    } else {
      res.setHeader('Access-Control-Allow-Origin', config.corsAllowOrigin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}
