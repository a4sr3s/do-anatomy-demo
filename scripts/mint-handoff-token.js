#!/usr/bin/env node
/**
 * Dev helper: mint a hub-style handoff JWT and print a local URL.
 * Usage: DEMO_HANDOFF_SECRET=devsecret node scripts/mint-handoff-token.js [baseUrl]
 */
import { handoffConfig, mintHandoffToken } from '../server/handoff.js';

const base = (process.argv[2] || `http://localhost:${process.env.PORT || 8080}`).replace(/\/$/, '');
const cfg = handoffConfig(process.env);
if (!cfg.enabled) {
  console.error('Set DEMO_HANDOFF_SECRET in the environment (same value as the demos hub).');
  process.exit(1);
}
const token = await mintHandoffToken(cfg);
console.log(`${base}/auth/handoff?token=${token}`);
