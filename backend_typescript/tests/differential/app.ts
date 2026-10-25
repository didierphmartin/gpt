/**
 * The TS Express app, built without listening — a mirror of src/index.ts (which builds the app
 * inline and calls app.listen(config.port) on import, so it cannot be mounted in-process).
 * Keep in step with src/index.ts: CORS, the PHP-style JSON body parser, global auth, the router,
 * the 404 envelope and the fallback error handler. Process-level handlers and file logging are
 * left out (the test process owns those).
 */
import express, { Request, Response, NextFunction, Express } from 'express';
import { MiddlewareProcessor } from '../../src/Middleware/MiddlewareProcessor';
import { router } from '../../src/routes';

export function buildApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  const middleware = new MiddlewareProcessor();

  app.use(middleware.cors.handle);

  app.use((req: Request, _res: Response, next: NextFunction) => {
    const ct = String(req.headers['content-type'] ?? '');
    if (ct.includes('multipart/form-data')) {
      next();
      return;
    }
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      (req as any).raw_body = data;
      try {
        req.body = data ? JSON.parse(data) : {};
      } catch {
        req.body = {};
      }
      next();
    });
    req.on('error', () => {
      req.body = {};
      next();
    });
  });

  app.use(middleware.auth.handle);
  app.use(router);

  app.use((req: Request, res: Response) => {
    res.status(404).json({ success: false, error: 'Endpoint not found', uri: req.path });
  });

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[app error]', err);
    res.status(500).json({ success: false, error: err?.message ?? 'Internal error' });
  });
  return app;
}
