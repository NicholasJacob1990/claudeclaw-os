/**
 * server.ts — Hono app factory for the skill dashboard.
 *
 * Testable: pass deps for DI (custom skillsDir / storeDir).
 * Start: use scripts/skill-dashboard.ts.
 *
 * Ported from ctx_monitor.py HTTP server (stdlib) → Hono (already a dep).
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';

import { registerRoutes } from './routes.js';
import type { DashboardDeps } from './types.js';

export { registerRoutes };
export type { DashboardDeps };

/**
 * Create the Hono application (without starting it).
 * Suitable for testing with fetch(app.fetch) or supertest.
 */
export function createApp(deps?: DashboardDeps): Hono {
  const app = new Hono();
  registerRoutes(app, deps);
  return app;
}

/**
 * Start the dashboard HTTP server.
 *
 * @param port - Port to listen on (default: 7777 or CLAUDECLAW_DASHBOARD_PORT).
 * @param deps - Optional DI overrides for skillsDir / storeDir.
 * @returns The server instance.
 */
export function startDashboard(
  port?: number,
  deps?: DashboardDeps,
): ReturnType<typeof serve> {
  const resolvedPort =
    port ??
    (process.env.CLAUDECLAW_DASHBOARD_PORT
      ? parseInt(process.env.CLAUDECLAW_DASHBOARD_PORT, 10)
      : 7777);

  const app = createApp(deps);

  const server = serve(
    {
      fetch: app.fetch,
      port: resolvedPort,
    },
    (info) => {
      console.log(`◈ skill-dashboard running at http://localhost:${info.port}`);
    },
  );

  return server;
}
