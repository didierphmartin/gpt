import { Request, Response, Router } from 'express';

/**
 * The route-miss envelopes of index.php (FastRoute): a path some route serves under another method
 * answers 405 with the methods that path allows; any other path answers 404.
 */
export function routeMiss(router: Router) {
  return (req: Request, res: Response): void => {
    const allowed: string[] = [];
    for (const layer of (router as any).stack) {
      if (!layer.route) continue;
      let matches = false;
      try {
        matches = layer.match(req.path);
      } catch {
        matches = false; // a malformed %-escape in a param
      }
      if (!matches) continue;
      for (const [m, on] of Object.entries(layer.route.methods as Record<string, boolean>)) {
        const method = m.toUpperCase();
        if (on && method !== '_ALL' && !allowed.includes(method)) allowed.push(method);
      }
    }
    if (allowed.length > 0) {
      res.status(405).json({ success: false, error: 'Method not allowed', allowed_methods: allowed });
      return;
    }
    res.status(404).json({ success: false, error: 'Endpoint not found', uri: req.path });
  };
}
