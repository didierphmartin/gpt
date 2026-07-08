import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { config } from '../config/env';
import { db } from '../db/pools';

export interface PublicRoute {
  method: string;
  pattern: RegExp;
}

type Scheme = 'bearer' | 'appkey' | null;

/**
 * Mirrors src/Middleware/AuthMiddleware.php. JWT bearer + per-user `uak_` app keys (Bearer or
 * AppKey scheme). Scoped `AppKey ak_…` keys are deferred (resolve to no identity → 401 on
 * protected routes, matching PHP when app_key_secret is unset).
 */
export class AuthMiddleware {
  constructor(private readonly publicRoutes: PublicRoute[]) {}

  private appKeyPepper(): string {
    const explicit = process.env.USER_APP_KEY_SECRET ?? '';
    if (explicit !== '') return explicit;
    return crypto.createHmac('sha256', config.auth.jwtSecret).update('user_app_key.v1').digest('hex');
  }

  private hashAppKey(fullKey: string): string {
    return crypto.createHmac('sha256', this.appKeyPepper()).update(fullKey).digest('hex');
  }

  private async validateUserAppKey(key: string): Promise<number | null> {
    try {
      const row = await db.selectFrom('users').select('id').where('app_key_hash', '=', this.hashAppKey(key)).limit(1).executeTakeFirst();
      return row ? row.id : null;
    } catch {
      return null;
    }
  }

  private isPublicRoute(method: string, uri: string): boolean {
    return this.publicRoutes.some((r) => r.method === method && r.pattern.test(uri));
  }

  private extractAuth(authHeader: unknown): { scheme: Scheme; token: string | null } {
    if (typeof authHeader !== 'string') return { scheme: null, token: null };
    let m = /^Bearer\s+(.+)$/i.exec(authHeader);
    if (m) return { scheme: 'bearer', token: m[1].trim() };
    m = /^AppKey\s+(.+)$/i.exec(authHeader);
    if (m) return { scheme: 'appkey', token: m[1].trim() };
    return { scheme: null, token: null };
  }

  handle = (req: Request, res: Response, next: NextFunction): void => {
    void (async () => {
      try {
        const header = req.headers['authorization'] ?? req.headers['Authorization'];
        const { scheme, token } = this.extractAuth(header);

        let userId: number | null = null;
        let authType: 'jwt' | 'user_app_key' | null = null;

        if (token) {
          if (token.startsWith('uak_')) {
            userId = await this.validateUserAppKey(token);
            if (userId !== null) authType = 'user_app_key';
          } else if (scheme === 'bearer') {
            try {
              const decoded = jwt.verify(token, config.auth.jwtSecret, { algorithms: ['HS256'] }) as any;
              const parsed = parseInt(String(decoded.sub), 10);
              if (!Number.isNaN(parsed)) {
                userId = parsed;
                authType = 'jwt';
              }
            } catch {
              userId = null;
            }
          }
        }

        if (this.isPublicRoute(req.method, req.path)) {
          (req as any).user_id = userId;
          (req as any).auth_type = authType;
          (req as any).authenticated = userId !== null;
          next();
          return;
        }

        if (scheme === null || !token) {
          res.status(401).json({ success: false, message: 'Authorization token required' });
          return;
        }
        if (userId === null) {
          res.status(401).json({ success: false, message: 'Invalid or expired credential' });
          return;
        }

        (req as any).user_id = userId;
        (req as any).auth_type = authType;
        (req as any).authenticated = true;
        next();
      } catch (e) {
        next(e);
      }
    })();
  };
}
