// ---------------------------------------------------------------------------
// EXECUTOR  (runs on YOUR laptop)
//
// Job: hold a WebSocket to the relay, receive order-signals, and place the
// trades on Topstep via the ProjectX Gateway API. All trading activity
// therefore originates from THIS machine / IP.
//
// Safety features:
//   - DRY_RUN mode (default true): logs the order it WOULD place, sends nothing.
//   - MAX_SIZE guard, ALLOWED_SYMBOLS whitelist.
//   - Idempotency: a signalId is executed at most once (dedupe).
//   - Auto re-auth on 401, auto-reconnect to relay with backoff.
// ---------------------------------------------------------------------------

require('dotenv').config();
const WebSocket = require('ws');

const {
  RELAY_URL,                       // wss://your-relay.up.railway.app
  RELAY_TOKEN,                     // must match EXECUTOR_TOKEN on the relay
  PROJECTX_BASE = 'https://api.topstepx.com',
  PROJECTX_USERNAME,
  PROJECTX_API_KEY,
  PROJECTX_ACCOUNT_ID = '',        // leave blank to auto-resolve first active account
  CONTRACTS = '{}',                // {"NQ":"CON.F.US.ENQ.U25","ES":"CON.F.US.EP.U25"}
  DRY_RUN = 'true',
  MAX_SIZE = '5',
  ALLOWED_SYMBOLS = '',            // "NQ,ES"  (empty = allow all)
} = process.env;

const dryRun = String(DRY_RUN).toLowerCase() === 'true';
const maxSize = parseInt(MAX_SIZE, 10) || 1;
const allowed = ALLOWED_SYMBOLS.split(',').map((s) => s.trim()).filter(Boolean);
const contractMap = safeJson(CONTRACTS, {});

let token = null;
let accountId = PROJECTX_ACCOUNT_ID ? parseInt(PROJECTX_ACCOUNT_ID, 10) : null;
const seenSignals = new Set();

function safeJson(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

// --- ProjectX API helpers ---------------------------------------------------
async function authenticate() {
  const res = await fetch(PROJECTX_BASE + '/api/Auth/loginKey', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userName: PROJECTX_USERNAME, apiKey: PROJECTX_API_KEY }),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.success || !json.token) {
    throw new Error('Auth failed: ' + JSON.stringify(json));
  }
  token = json.token;
  console.log('[auth] token acquired');
}

async function api(path, body, retryOn401 = true) {
  const res = await fetch(PROJECTX_BASE + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body || {}),
  });
  if (res.status === 401 && retryOn401) {
    console.log('[api] 401 — re-authenticating');
    await authenticate();
    return api(path, body, false);
  }
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// Resolve the first active account if PROJECTX_ACCOUNT_ID was not provided.
// NOTE: verify this endpoint/body against the live docs for your firm.
async function resolveAccount() {
  const { json } = await api('/api/Account/search', { onlyActiveAccounts: true });
  const acc = (json.accounts || [])[0];
  if (!acc) throw new Error('Could not resolve an active account. Set PROJECTX_ACCOUNT_ID.');
  accountId = acc.id;
  console.log('[account] resolved accountId', accountId);
}

// --- Signal -> order translation -------------------------------------------
function buildOrder(signal) {
  const contractId = signal.contractId || contractMap[signal.symbol];
  if (!contractId) {
    throw new Error(`No contractId for symbol "${signal.symbol}" (set it in CONTRACTS or send contractId).`);
  }

  const typeMap = { MARKET: 2, LIMIT: 1, STOP: 4, TRAILINGSTOP: 5 };
  const type = typeMap[String(signal.orderType || 'MARKET').toUpperCase()];
  if (!type) throw new Error(`Unknown orderType "${signal.orderType}".`);

  const sideRaw = String(signal.side || '').toUpperCase();
  const side = sideRaw === 'LONG' || sideRaw === 'BUY' ? 0
             : sideRaw === 'SHORT' || sideRaw === 'SELL' ? 1
             : null;
  if (side === null) throw new Error(`Unknown side "${signal.side}" (use LONG/SHORT).`);

  const order = { accountId, contractId, type, side, size: signal.size };
  if (signal.limitPrice != null) order.limitPrice = signal.limitPrice;
  if (signal.stopPrice != null) order.stopPrice = signal.stopPrice;
  if (signal.trailPrice != null) order.trailPrice = signal.trailPrice;
  // Attached brackets (in ticks). type 4=Stop, 1=Limit per ProjectX enums.
  if (signal.stopLossTicks) order.stopLossBracket = { ticks: signal.stopLossTicks, type: 4 };
  if (signal.takeProfitTicks) order.takeProfitBracket = { ticks: signal.takeProfitTicks, type: 1 };
  if (signal.signalId) order.customTag = String(signal.signalId).slice(0, 50);

  return order;
}

function validate(signal) {
  if (!signal || typeof signal !== 'object') throw new Error('empty signal');
  if (!signal.symbol) throw new Error('missing symbol');
  if (!signal.size || signal.size < 1) throw new Error('missing/invalid size');
  if (signal.size > maxSize) throw new Error(`size ${signal.size} exceeds MAX_SIZE ${maxSize}`);
  if (allowed.length && !allowed.includes(signal.symbol)) {
    throw new Error(`symbol ${signal.symbol} not in ALLOWED_SYMBOLS`);
  }
}

async function handleSignal(signal) {
  // Idempotency — never execute the same signalId twice.
  if (signal.signalId) {
    if (seenSignals.has(signal.signalId)) {
      console.log('[signal] duplicate, skipping', signal.signalId);
      return { skipped: 'duplicate' };
    }
    seenSignals.add(signal.signalId);
  }

  validate(signal);
  const order = buildOrder(signal);

  if (dryRun) {
    console.log('[DRY_RUN] would place order:', JSON.stringify(order));
    return { dryRun: true, order };
  }

  if (!token) await authenticate();
  if (!accountId) await resolveAccount();
  if (!order.accountId) order.accountId = accountId;

  const { json } = await api('/api/Order/place', order);
  if (json.success) {
    console.log('[order] PLACED orderId=', json.orderId, JSON.stringify(order));
    return { placed: true, orderId: json.orderId };
  }
  console.error('[order] FAILED:', JSON.stringify(json), 'order=', JSON.stringify(order));
  throw new Error('order rejected: ' + (json.errorMessage || json.errorCode));
}

// --- Relay connection with auto-reconnect ----------------------------------
let backoff = 1000;
function connect() {
  if (!RELAY_URL || !RELAY_TOKEN) {
    console.error('FATAL: set RELAY_URL and RELAY_TOKEN in .env');
    process.exit(1);
  }
  const url = `${RELAY_URL.replace(/\/$/, '')}/executor?token=${encodeURIComponent(RELAY_TOKEN)}`;
  const ws = new WebSocket(url);

  ws.on('open', () => {
    backoff = 1000;
    console.log(`[relay] connected${dryRun ? '  (DRY_RUN — no live orders)' : '  (LIVE)'}`);
  });

  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type !== 'signal') return;
    try {
      const result = await handleSignal(msg.signal);
      ws.send(JSON.stringify({ type: 'ack', signalId: msg.signal?.signalId, result }));
    } catch (e) {
      console.error('[signal] error:', e.message);
      ws.send(JSON.stringify({ type: 'error', signalId: msg.signal?.signalId, error: e.message }));
    }
  });

  ws.on('close', () => {
    console.log(`[relay] disconnected — reconnecting in ${backoff}ms`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30000);
  });
  ws.on('error', (e) => console.error('[relay] ws error:', e.message));
}

// --- boot -------------------------------------------------------------------
(async () => {
  console.log('Executor starting…');
  console.log(`  base=${PROJECTX_BASE}  dryRun=${dryRun}  maxSize=${maxSize}  allowed=${allowed.join(',') || '(all)'}`);
  try {
    await authenticate();          // fail fast on bad creds
    if (!accountId) await resolveAccount();
  } catch (e) {
    console.error('[boot] warning:', e.message, '\n(will retry lazily on first signal)');
  }
  connect();
})();
