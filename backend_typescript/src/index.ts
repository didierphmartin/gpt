import express, { Request, Response, NextFunction } from 'express';
import { config } from './config/env';
import { MiddlewareProcessor } from './Middleware/MiddlewareProcessor';
import { router } from './routes';

// PHP runs each request in its own process, so one request's fatal error never takes down the
// server. Node is a single shared process: an unhandled promise rejection or uncaught exception
// (e.g. a workflow branch that rejects before it's awaited) would otherwise kill the whole server
// and make every in-flight + subsequent request fail with "Failed to fetch". Log and keep serving.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

const app = express();
app.disable('x-powered-by');

const middleware = new MiddlewareProcessor();

// CORS first (also short-circuits OPTIONS with 204).
app.use(middleware.cors.handle);

// Body parser that mirrors PHP exactly: always attempt JSON, empty/invalid → {} (never 500).
// Skip multipart/form-data (file uploads) so multer can read the raw stream on those routes.
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

// Global auth (JWT + uak_ app keys) with PUBLIC_ROUTES allowlist.
app.use(middleware.auth.handle);

// Routes.
app.use(router);

// 404 — matches index.php route-miss envelope.
app.use((req: Request, res: Response) => {
  res.status(404).json({ success: false, error: 'Endpoint not found', uri: req.path });
});

// Fallback error handler.
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[app error]', err);
  res.status(500).json({ success: false, error: err?.message ?? 'Internal error' });
});

app.listen(config.port, () => {
  console.log(`[gpt-backend-ts] listening on http://localhost:${config.port}`);
});
