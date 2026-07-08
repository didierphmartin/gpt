import { Request, Response } from 'express';

/** Request context handed to controllers — mirrors the PHP `$request` array. */
export interface Ctx {
  method: string;
  uri: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, unknown>;
  body: Record<string, any>;
  user_id: number | null;
  auth_type: 'jwt' | 'user_app_key' | 'app_key' | null;
  params: Record<string, string>;
  /** Remote peer address from the TCP socket — mirrors PHP $_SERVER['REMOTE_ADDR']. */
  remote_addr: string;
}

/** A controller returns a plain object that IS the JSON body, optionally carrying status_code. */
export type ControllerResult = { status_code?: number } & Record<string, any>;

export function buildCtx(req: Request): Ctx {
  return {
    method: req.method,
    uri: req.path,
    headers: req.headers,
    query: req.query as Record<string, unknown>,
    body: req.body && typeof req.body === 'object' ? req.body : {},
    user_id: (req as any).user_id ?? null,
    auth_type: (req as any).auth_type ?? null,
    params: req.params as Record<string, string>,
    remote_addr: req.socket?.remoteAddress ?? '',
  };
}

/** Wraps a controller method into an Express handler, applying the PHP response convention. */
export function handle(fn: (ctx: Ctx) => Promise<ControllerResult> | ControllerResult) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const result = await fn(buildCtx(req));
      const { status_code = 200, ...body } = result;
      res.status(status_code).json(body);
    } catch (e: any) {
      console.error('[controller error]', e);
      res.status(500).json({ success: false, error: e?.message ?? 'Internal error' });
    }
  };
}
