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
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  // SAFETY: only ONE executor may be active at a time. A second live executor
  // would place duplicate orders. So when a new one connects, kick any existing
  // ones (newest wins). This neutralises orphaned/duplicate executor processes.
  for (const old of executors) {
    try { old.send(JSON.stringify({ type: 'kicked', reason: 'replaced by a newer executor' })); } catch { /* ignore */ }
    try { old.close(4000, 'replaced'); } catch { /* ignore */ }
    executors.delete(old);
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
    return res.status(503).json({ error: 'no executor connected' });
  }

  const payload = JSON.stringify({ type: 'signal', signal, ts: Date.now() });
  let sent = 0;
  for (const ws of executors) {
    if (ws.readyState === ws.OPEN) { ws.send(payload); sent++; }
  }
  console.log(`[signal] relayed to ${sent} executor(s):`, JSON.stringify(signal));
  res.json({ ok: true, relayed: sent });
});

server.listen(PORT, () => console.log(`Relay listening on :${PORT}`));
