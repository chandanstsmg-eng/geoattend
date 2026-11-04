/**
 * First-time setup: creates .env from .env.example with freshly generated
 * secrets (never overwrites an existing .env), then migrates and seeds.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import webpush from 'web-push';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const envPath = path.join(root, '.env');
const examplePath = path.join(root, '.env.example');

const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');
const readable = () => `${crypto.randomBytes(4).toString('hex')}-${crypto.randomBytes(4).toString('hex')}-${crypto.randomInt(10, 99)}`;

if (fs.existsSync(envPath)) {
  console.log('  .env already exists — keeping it.');
} else {
  const vapid = webpush.generateVAPIDKeys();
  const demoPassword = `Demo-${readable()}`;
  const adminPassword = `Admin-${readable()}`;
  let env = fs.readFileSync(examplePath, 'utf8');
  const set = (key: string, value: string) => {
    env = env.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
  };
  set('PG_PASSWORD', rand(18));
  set('JWT_SECRET', rand(48));
  set('STORAGE_SIGNING_KEY', rand(48));
  set('VAPID_PUBLIC_KEY', vapid.publicKey);
  set('VAPID_PRIVATE_KEY', vapid.privateKey);
  set('DEMO_PASSWORD', demoPassword);
  set('ADMIN_PASSWORD', adminPassword);
  set('ADMIN_EMAIL', 'admin@geoattend.local');
  fs.writeFileSync(envPath, env, { mode: 0o600 });
  console.log('  Created .env with generated secrets.');
  console.log(`  Admin sign-in:  admin@geoattend.local / ${adminPassword}`);
  console.log(`  Demo password:  ${demoPassword}  (demo admin + demo employees, see README)`);
}

const here = path.dirname(fileURLToPath(import.meta.url));
for (const script of ['migrate.ts', 'seed.ts']) {
  execFileSync(process.execPath, ['--import', 'tsx', path.join(here, script)], { stdio: 'inherit' });
}
console.log('\n  Setup complete. Start everything with:  npm run dev');
