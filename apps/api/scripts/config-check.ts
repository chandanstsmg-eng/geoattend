/**
 * Checks a production or staging environment BEFORE it is deployed, with the same rules the API applies
 * when it starts (productionConfigErrors), and lists which optional integrations are configured.
 *
 *   npm run config:check -w @geoattend/api
 *   docker compose run --rm --no-deps api node --import tsx apps/api/scripts/config-check.ts   (what deploy runs)
 *
 * It prints setting NAMES only, never values. Exit 1 when the API would refuse to start.
 * "Configured" means a value is present, not that it works: npm run integrations:check proves that.
 */
import { config, productionConfigErrors } from '../src/config.js';

const errors = [...productionConfigErrors(process.env)];
if (!config.isProduction) errors.unshift('NODE_ENV must be production on a staging or production server.');

const has = (...names: string[]) => names.every((n) => (process.env[n] ?? '').trim() !== '');
const integrations: [string, boolean][] = [
  ['SMTP e-mail (SMTP_URL)', has('SMTP_URL')],
  ['Alert delivery (ALERT_WEBHOOK_URL or OPS_ALERT_EMAILS)', has('ALERT_WEBHOOK_URL') || has('OPS_ALERT_EMAILS')],
  ['Monitoring token (OPS_TOKEN)', has('OPS_TOKEN')],
  ['Expo push (EXPO_PUSH_ENABLED, EXPO_ACCESS_TOKEN)', config.push.expoPushEnabled && has('EXPO_ACCESS_TOKEN')],
  ['WhatsApp (WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID)', has('WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID')],
  ['Admin browser push (VAPID keys)', has('VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY')],
];

console.log(errors.length ? `FAIL  ${errors.length} setting(s) would stop the API from starting:` : 'OK    the API will accept this environment');
for (const e of errors) console.log(`      - ${e}`);
console.log('Integrations (configured is not the same as working; run integrations:check):');
for (const [name, on] of integrations) console.log(`      ${on ? 'configured    ' : 'NOT configured'}  ${name}`);
console.log('      payroll ' + (config.payrollEnabled ? 'ON' : 'off') + ', automatic photo deletion ' + (config.photoAutoDeleteEnabled ? 'ON' : 'off'));
process.exit(errors.length ? 1 : 0);
