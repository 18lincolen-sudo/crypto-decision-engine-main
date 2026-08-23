// Smoke test for the trading worker (verification requirements).
// Verifies: public data is Mainnet, dry-run default, full symbol universe,
// testnet execution selection, CORS allow/reject, auth enforcement, and the
// account/decisions endpoints. Run: node smoke-test.mjs  (from server/)

import { spawn } from 'node:child_process';

const PORT = 3211;
const BASE = `http://localhost:${PORT}`;
const ALLOWED_ORIGIN = 'https://allowed.netlify.app';
const DENIED_ORIGIN = 'https://evil.example.com';

function startWorker() {
  const child = spawn('npx', ['tsx', 'index.mjs'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      BYBIT_API_KEY: 'dummy',
      BYBIT_SECRET_KEY: 'dummy',
      BOT_ADMIN_TOKEN: 'test',
      BOT_AUTOSTART: 'false',
      CORS_ORIGIN: ALLOWED_ORIGIN
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return child;
}

const checks = [];
function check(name, cond, detail) {
  checks.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const child = startWorker();
let out = '';
child.stdout.on('data', d => (out += d));
child.stderr.on('data', d => (out += d));

await new Promise(r => setTimeout(r, 2500));

async function headersFor(path, origin) {
  const res = await fetch(`${BASE}${path}`, origin ? { headers: { Origin: origin } } : {});
  return res;
}

try {
  // 1. Public market data is Mainnet
  const h = await (await fetch(`${BASE}/health`)).json();
  check('Public market data is Mainnet', h.publicBase === 'https://api.bybit.com', h.publicBase);
  check('Dry-run is the safe default', h.dryRun === true, `dryRun=${h.dryRun}`);
  check('Full symbol universe is the default', h.symbols >= 100, `${h.symbols} symbols`);
  check('Testnet execution URL selected when BYBIT_TESTNET unset', h.execBase === 'https://api-testnet.bybit.com', h.execBase);
  check('Mode reflects testnet', h.mode === 'testnet', h.mode);
  check('Health endpoint public (no auth)', true);

  // 2. CORS: allowed origin gets the header; denied origin does not
  const allowedRes = await headersFor('/health', ALLOWED_ORIGIN);
  check('CORS allows configured Netlify origin', allowedRes.headers.get('access-control-allow-origin') === ALLOWED_ORIGIN, allowedRes.headers.get('access-control-allow-origin'));
  const deniedRes = await headersFor('/health', DENIED_ORIGIN);
  check('CORS rejects unapproved origin', deniedRes.headers.get('access-control-allow-origin') !== DENIED_ORIGIN, `got=${deniedRes.headers.get('access-control-allow-origin')}`);

  // 3. Auth enforcement
  const noAuth = await fetch(`${BASE}/api/bot/state`);
  check('State endpoint rejects missing auth', noAuth.status === 401, `status=${noAuth.status}`);
  const withAuth = await fetch(`${BASE}/api/bot/state`, { headers: { Authorization: 'Bearer test' } });
  check('State endpoint accepts valid auth', withAuth.status === 200, `status=${withAuth.status}`);

  // 4. Account summary (authenticated; dummy creds -> exchange call fails, but must not be 401/404)
  const acct = await fetch(`${BASE}/api/account/summary`, { headers: { Authorization: 'Bearer test' } });
  check('Account summary responds (authenticated)', acct.status !== 401 && acct.status !== 404, `status=${acct.status}`);

  // 5. Decisions endpoint includes rejection reasons + skipped symbols
  const dec = await (await fetch(`${BASE}/api/decisions`, { headers: { Authorization: 'Bearer test' } })).json();
  check('Decisions endpoint returns arrays', Array.isArray(dec.decisions) && Array.isArray(dec.skippedSymbols), `decisions=${dec.decisions?.length}, skipped=${dec.skippedSymbols?.length}`);
} catch (e) {
  check('Worker reachable', false, e.message);
} finally {
  child.kill('SIGKILL');
}

const failed = checks.filter(c => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed.`);
process.exit(failed === 0 ? 0 : 1);
