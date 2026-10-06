/** The role key in a route (PHP routes.php `{role:[a-z0-9]+(?:-[a-z0-9]+)*}`). */
export const ROLE_KEY_PATTERN = '[a-z0-9]+(?:-[a-z0-9]+)*';

/**
 * A route path ending in a role key, as a RegExp: Express 4's path-to-regexp (0.1.x) cannot hold a
 * nested group in a `:param(...)` pattern, and its string routes are case-insensitive, unlike FastRoute.
 * The key is capture group 1 (Express puts it in req.params[0]); use withRoleParam to name it `role`.
 */
export function roleKeyPath(prefix: string): RegExp {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return new RegExp(`^${escaped}\\/(${ROLE_KEY_PATTERN})\\/?$`);
}

/** Maps the RegExp route's capture (params[0]) to params.role, as the PHP controllers read it. */
export function withRoleParam<C extends { params: Record<string, string> }>(ctx: C): C {
  return { ...ctx, params: { ...ctx.params, role: String(ctx.params['0'] ?? '') } };
}
