#!/usr/bin/env tsx
/**
 * skill-dashboard.ts — Start the skill dashboard HTTP server.
 *
 * Usage:
 *   npx tsx scripts/skill-dashboard.ts
 *   npx tsx scripts/skill-dashboard.ts --port 8080
 *   CLAUDECLAW_DASHBOARD_PORT=8080 npx tsx scripts/skill-dashboard.ts
 */

import { startDashboard } from '../src/skill-dashboard/server.js';

// Parse --port from argv
let port: number | undefined;
const portArgIdx = process.argv.indexOf('--port');
if (portArgIdx !== -1 && process.argv[portArgIdx + 1]) {
  const parsed = parseInt(process.argv[portArgIdx + 1], 10);
  if (!isNaN(parsed) && parsed > 0 && parsed < 65536) {
    port = parsed;
  } else {
    console.error(`Invalid --port value: ${process.argv[portArgIdx + 1]}`);
    process.exit(1);
  }
}

startDashboard(port);
