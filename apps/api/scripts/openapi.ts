/** Writes docs/openapi.json from the route registry. */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../src/config.js';
import { createApp } from '../src/app.js';
import { buildOpenApi } from '../src/lib/openapi.js';

createApp(); // registers all routes
const out = path.join(REPO_ROOT, 'docs', 'openapi.json');
fs.writeFileSync(out, JSON.stringify(buildOpenApi(), null, 2));
console.log(`  Wrote ${out}`);
