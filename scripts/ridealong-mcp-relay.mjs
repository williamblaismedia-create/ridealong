#!/usr/bin/env node
/**
 * Ridealong — local MCP relay (runs on the Mac, launched BY Claude Code).
 *
 * Claude Code speaks MCP over stdio to a child it spawns. Today that child
 * is `ssh will@w-agent scry-mcp.sh`: when the SSH link dies (Mac asleep,
 * network change, Tailscale reroute) the child exits, Claude Code marks the
 * server dead, and William has to /mcp reconnect by hand.
 *
 * This relay sits in between: Claude Code <-> relay <-> ssh <-> scry.
 * It forwards stdio byte-for-byte, and when the child dies it respawns it
 * (backoff 1s -> 30s), REPLAYS the client's `initialize` handshake to the
 * new server (the client never sees a restart), then flushes whatever the
 * client sent meanwhile. From Claude Code's point of view the server never
 * went away.
 *
 * What it keeps in memory: the `initialize` request (protocol version +
 * client capabilities — no secrets) and, while the child is down, the
 * client's pending JSON-RPC lines. Nothing is logged to stdout (that is the
 * JSON-RPC channel); diagnostics go to stderr.
 *
 * Child command: SCRY_RELAY_CMD (a shell line) overrides the default ssh
 * line; SCRY_RELAY_HOST overrides the host only.
 */
import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Marker for the Claude Code status line (~/.claude/ridealong-statusline.sh):
// present while this relay has a live scry session, removed on exit.
const MARKER = process.env.SCRY_RELAY_MARKER ?? join(homedir(), '.claude', 'ridealong-live.json');
function mark(on) {
  try {
    if (on) { mkdirSync(join(homedir(), '.claude'), { recursive: true }); writeFileSync(MARKER, JSON.stringify({ pid: process.pid, at: Date.now(), host: HOST })); }
    else unlinkSync(MARKER);
  } catch { /* cosmetic */ }
}

const HOST = process.env.SCRY_RELAY_HOST ?? 'will@w-agent';
const REMOTE = process.env.SCRY_RELAY_REMOTE ?? '/home/will/scry/scripts/scry-mcp.sh';
const CMD = process.env.SCRY_RELAY_CMD
  ?? `ssh -o BatchMode=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o ConnectTimeout=15 ${HOST} ${REMOTE}`;
const MAX_BACKOFF_MS = 30_000;

const log = (msg) => process.stderr.write(`[ridealong-relay] ${msg}\n`);

let child = null;
let ready = false;          // child up AND handshake replayed (or first-run passthrough)
let initRequest = null;     // the client's initialize request line (string)
let initialized = false;    // client has sent notifications/initialized
let queue = [];             // client lines buffered while not ready
let backoff = 1000;
let closing = false;
let replayId = 0;           // id of the in-flight replayed initialize
let childBuf = '';

function write(line) {
  if (child && child.stdin.writable) child.stdin.write(line + '\n');
}

function startChild() {
  if (closing) return;
  childBuf = '';
  child = spawn(CMD, { shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const c = child;
  mark(true);
  c.stderr.on('data', (d) => process.stderr.write(d));
  c.stdout.on('data', (d) => onChildData(c, d));
  c.on('exit', (code, signal) => {
    if (c !== child) return;
    child = null;
    ready = false;
    if (closing) return;
    log(`serveur distant termine (code=${code} signal=${signal}) — relance dans ${backoff / 1000}s`);
    setTimeout(startChild, backoff);
    backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
  });
  c.on('error', (e) => log(`spawn: ${e.message}`));

  if (initRequest) {
    // Reconnect: replay the handshake before anything else reaches the server.
    replayId = -1 - Math.floor(Math.random() * 1e6);
    const req = JSON.parse(initRequest);
    req.id = replayId;
    c.stdin.write(JSON.stringify(req) + '\n');
    log('handshake rejoue vers le nouveau serveur');
  } else {
    // First run: plain passthrough until the client's own initialize completes.
    ready = true;
    flush();
  }
}

function onChildData(c, d) {
  childBuf += d.toString();
  let i;
  while ((i = childBuf.indexOf('\n')) >= 0) {
    const line = childBuf.slice(0, i);
    childBuf = childBuf.slice(i + 1);
    if (!line.trim()) continue;
    if (!ready && replayId !== 0) {
      // Waiting for the replayed initialize's response: swallow it, then
      // complete the handshake and release the queue.
      let msg;
      try { msg = JSON.parse(line); } catch { process.stdout.write(line + '\n'); continue; }
      if (msg.id === replayId) {
        replayId = 0;
        if (initialized) c.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        ready = true;
        backoff = 1000;
        log('reconnecte — session reprise');
        flush();
        continue;
      }
    }
    process.stdout.write(line + '\n');
  }
}

function flush() {
  if (!ready) return;
  const q = queue; queue = [];
  for (const line of q) write(line);
}

// Client -> relay: newline-delimited JSON-RPC.
let inBuf = '';
process.stdin.on('data', (d) => {
  inBuf += d.toString();
  let i;
  while ((i = inBuf.indexOf('\n')) >= 0) {
    const line = inBuf.slice(0, i);
    inBuf = inBuf.slice(i + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.method === 'initialize') initRequest = line;
      else if (msg.method === 'notifications/initialized') initialized = true;
    } catch { /* forward as-is */ }
    if (ready) write(line); else queue.push(line);
  }
});
process.stdin.on('end', () => shutdown());
for (const s of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(s, () => shutdown());

function shutdown() {
  if (closing) return;
  closing = true;
  mark(false);
  try { child?.stdin.end(); } catch { /* ignore */ }
  const c = child;
  setTimeout(() => { try { c?.kill('SIGTERM'); } catch { /* ignore */ } process.exit(0); }, 500);
}

startChild();
