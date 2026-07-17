// ---------------------------------------------------------------------------
// RELAY SERVER  (runs in the cloud, e.g. Railway)
//
// Job: receive order-signals from your friend's algo (HTTP POST) and push them
// in real time over a WebSocket to your laptop's executor.
//
// Two secrets:
//   SENDER_SECRET   -> the algo must send this (header "x-secret") to POST signals
//   EXECUTOR_TOKEN  -> your laptop must send this (?token=...) to subscribe
// ---------------------------------------------------------------------------

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const SENDER_SECRET = process.env.SENDER_SECRET;
const EXECUTOR_TOKEN = process.env.EXECUTOR_TOKEN;

if (!SENDER_SECRET || !EXECUTOR_TOKEN) {
  console.error('FATAL: set SENDER_SECRET and EXECUTOR_TOKEN env vars.');
  process.exit(1);
}

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

/** Connected laptop executors. */
const executors = new Set();

/** Signal history so you can see whether the friend's algo is actually sending. */
let signalCount = 0;
let lastSignalAt = null;
const recentSignals = []; // newest first, max 20

function recordSignal(signal, relayed, note) {
  signalCount++;
  lastSignalAt = Date.now();
  recentSignals.unshift({ at: new Date().toISOString(), signal, relayed, note });
  if (recentSignals.length > 20) recentSignals.pop();
}

// --- WebSocket auth on upgrade ---------------------------------------------
server.on('upgrade', (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    socket.destroy();
    return;
  }
  const token = url.searchParams.get('token');
  if (url.pathname !== '/executor' || token !== EXECUTOR_TOKEN) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  const instanceId = url.searchParams.get('instance') || 'unknown';
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.instanceId = instanceId;
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  // SAFETY: only ONE executor process may be active at a time — two would place
  // duplicate orders. But distinguish the two cases by instanceId, otherwise an
  // executor reconnecting after a blip would kick (and thereby kill) itself:
  //   same instanceId  -> same process reconnecting: drop the stale socket quietly
  //   different id     -> a genuine second process: kick the old one
  for (const old of executors) {
    if (old.instanceId === ws.instanceId) {
      try { old.terminate(); } catch { /* ignore */ }
      executors.delete(old);
      console.log(`[ws] same instance ${ws.instanceId} reconnected — dropped stale socket`);
    } else {
      try { old.send(JSON.stringify({ type: 'kicked', reason: 'replaced by a newer executor' })); } catch { /* ignore */ }
      try { old.close(4000, 'replaced'); } catch { /* ignore */ }
      executors.delete(old);
      console.log(`[ws] kicked older executor instance ${old.instanceId}`);
    }
  }

  ws.isAlive = true;
  executors.add(ws);
  console.log(`[ws] executor connected — total ${executors.size}`);

  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => {
    // Executor sends back {type:'ack'|'error', ...} — just log it.
    console.log('[ws] from executor:', data.toString().slice(0, 500));
  });
  ws.on('close', () => {
    executors.delete(ws);
    console.log(`[ws] executor disconnected — total ${executors.size}`);
  });
  ws.on('error', (e) => console.error('[ws] error:', e.message));
});

// Heartbeat: drop dead connections so a hung socket can't swallow signals.
setInterval(() => {
  for (const ws of executors) {
    if (ws.isAlive === false) {
      ws.terminate();
      executors.delete(ws);
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 15000);

// --- HTTP endpoints ---------------------------------------------------------
app.get('/health', (_req, res) => res.json({ ok: true, executors: executors.size }));

app.post('/signal', (req, res) => {
  const secret = req.headers['x-secret'] || req.body?.secret;
  if (secret !== SENDER_SECRET) {
    return res.status(401).json({ error: 'bad secret' });
  }

  const signal = { ...req.body };
  delete signal.secret;

  if (executors.size === 0) {
    // Tell the algo nobody is listening rather than silently dropping the trade.
    console.warn('[signal] REJECTED — no executor connected:', JSON.stringify(signal));
    recordSignal(signal, 0, 'REJECTED — no executor connected');
    return res.status(503).json({ error: 'no executor connected' });
  }

  const payload = JSON.stringify({ type: 'signal', signal, ts: Date.now() });
  let sent = 0;
  for (const ws of executors) {
    if (ws.readyState === ws.OPEN) { ws.send(payload); sent++; }
  }
  console.log(`[signal] relayed to ${sent} executor(s):`, JSON.stringify(signal));
  recordSignal(signal, sent, 'relayed');
  res.json({ ok: true, relayed: sent });
});

// --- Status page ------------------------------------------------------------
// Protected: it shows trading signals. Open with ?token=<EXECUTOR_TOKEN>
app.get('/status', (req, res) => {
  if (req.query.token !== EXECUTOR_TOKEN) {
    return res.status(401).send('Unauthorized — append ?token=<EXECUTOR_TOKEN> to the URL.');
  }

  const secs = lastSignalAt ? Math.round((Date.now() - lastSignalAt) / 1000) : null;
  const ago = secs === null ? 'never'
    : secs < 60 ? `${secs}s ago`
    : secs < 3600 ? `${Math.round(secs / 60)}min ago`
    : `${Math.round(secs / 3600)}h ago`;

  const rows = recentSignals.map((s) => `
    <tr>
      <td>${s.at.replace('T', ' ').slice(0, 19)}</td>
      <td>${s.signal?.symbol ?? '—'}</td>
      <td>${s.signal?.side ?? '—'}</td>
      <td>${s.signal?.size ?? '—'}</td>
      <td class="${s.relayed > 0 ? 'ok' : 'bad'}">${s.note}</td>
    </tr>`).join('') || '<tr><td colspan="5" class="muted">No signals received yet.</td></tr>';

  res.set('Content-Type', 'text/html').send(`<!doctype html>
<meta charset="utf-8"><meta http-equiv="refresh" content="5">
<title>Relay status</title>
<style>
  body{font:14px system-ui,sans-serif;margin:2rem;background:#0f1116;color:#e6e6e6}
  h1{font-size:1.2rem} .card{background:#181b23;border-radius:10px;padding:1rem;margin-bottom:1rem}
  .big{font-size:1.6rem;font-weight:600} .ok{color:#4ade80} .bad{color:#f87171} .muted{color:#8b93a5}
  table{border-collapse:collapse;width:100%} td,th{padding:.4rem .6rem;border-bottom:1px solid #262b36;text-align:left}
</style>
<h1>Topstep Relay — Status <span class="muted">(auto-refresh 5s)</span></h1>
<div class="card">
  <div>Laptop executor connected</div>
  <div class="big ${executors.size > 0 ? 'ok' : 'bad'}">
    ${executors.size > 0 ? '✅ YES' : '❌ NO — start the executor!'} <span class="muted">(${executors.size})</span>
  </div>
</div>
<div class="card">
  <div>Signals received from the algo</div>
  <div class="big">${signalCount}</div>
  <div class="muted">Last signal: ${ago}</div>
</div>
<div class="card">
  <div style="margin-bottom:.5rem">Recent signals (newest first)</div>
  <table><tr><th>Time (UTC)</th><th>Symbol</th><th>Side</th><th>Size</th><th>Result</th></tr>${rows}</table>
</div>`);
});

server.listen(PORT, () => console.log(`Relay listening on :${PORT}`));
