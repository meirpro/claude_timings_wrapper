// API client for posting events and session wrapups to cc.meir.pro.
// Non-blocking — all POSTs are fire-and-forget with 1 retry.
// Failed events queue to ~/.claude/tracking-queue.jsonl for later flush.

import { readFileSync, appendFileSync, existsSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';

const API_BASE = 'https://cc.meir.pro';
const TRACK_KEY_FILE = join(homedir(), '.claude', 'track-key');
const QUEUE_FILE = join(homedir(), '.claude', 'tracking-queue.jsonl');
const INSTALL_ID_FILE = join(homedir(), '.claude', 'installation-id');
const TIMEOUT_MS = 5000;
const RETRY_DELAY_MS = 2000;

let trackKey = null;
let keyLoaded = false;

function loadKey() {
  if (keyLoaded) return trackKey;
  keyLoaded = true;
  try {
    trackKey = readFileSync(TRACK_KEY_FILE, 'utf8').trim();
  } catch {
    trackKey = null;
  }
  return trackKey;
}

let installId = null;
let installIdLoaded = false;

function loadInstallId() {
  if (installIdLoaded) return installId;
  installIdLoaded = true;
  try {
    installId = readFileSync(INSTALL_ID_FILE, 'utf8').trim();
    if (!installId) throw new Error('empty');
  } catch {
    // Generate a fresh installation ID and persist it
    installId = randomUUID();
    try {
      writeFileSync(INSTALL_ID_FILE, installId + '\n');
    } catch {
      // If we can't persist it, the wrapper will generate a new one next run.
      // Not ideal but not fatal — the column accepts null and untagged sources
      // are still tracked in /api/installations.
    }
  }
  return installId;
}

function queueEvent(payload) {
  try {
    appendFileSync(QUEUE_FILE, JSON.stringify(payload) + '\n');
  } catch {}
}

async function postJson(path, payload, { retry = true } = {}) {
  const key = loadKey();
  if (!key) return { ok: false, reason: 'no-key' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const installIdHeader = loadInstallId();
    const headers = {
      'Content-Type': 'application/json',
      'X-Track-Key': key,
    };
    if (installIdHeader) {
      headers['X-Install-Id'] = installIdHeader;
    }

    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.ok) return { ok: true };
    if (retry) {
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      return postJson(path, payload, { retry: false });
    }
    return { ok: false, reason: `http-${res.status}` };
  } catch (err) {
    clearTimeout(timer);
    if (retry) {
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      return postJson(path, payload, { retry: false });
    }
    return { ok: false, reason: err.name || 'fetch-error' };
  }
}

/**
 * Post a tracking event. Non-blocking — returns immediately, the POST
 * runs in the background and queues on failure.
 */
export function postEvent({ sessionId, eventType, cwd, branch, metadata }) {
  const payload = {
    session_id: sessionId,
    event_type: eventType,
    timestamp: new Date().toISOString(),
    cwd: cwd || process.cwd(),
    branch: branch || '',
    metadata: metadata || {},
  };

  // Fire and forget — do not await
  postJson('/api/event', payload).then(result => {
    if (!result.ok) queueEvent(payload);
  });
}

/**
 * Post a session wrapup. Awaited (briefly) so the process can exit
 * after the POST completes or times out.
 */
export async function postWrapup({ sessionId, summary, agentMs, typingMs, idleMs, totalActiveMs, commits, filesChanged }) {
  const payload = {
    session_id: sessionId,
    summary,
    agent_ms: agentMs,
    typing_ms: typingMs,
    idle_ms: idleMs,
    total_active_ms: totalActiveMs,
    commits: commits || [],
    files_changed: filesChanged || 0,
  };

  const result = await postJson('/api/session/wrapup', payload);
  if (!result.ok) {
    // Wrapup failures don't queue to the event queue — they're one-shot.
    // The session is already closed locally; manual flush would need a separate path.
  }
  return result;
}

/**
 * Post a wrapper-pushed timing snapshot. Non-blocking — fire-and-forget.
 * Failed snapshots do NOT queue (snapshots are idempotent and superseded
 * by the next one, so a missed snapshot is self-healing).
 */
export function postSnapshot({ sessionId, agentMs, typingMs, idleMs, totalActiveMs, cwd, branch }) {
  const payload = {
    session_id: sessionId,
    agent_ms: agentMs,
    typing_ms: typingMs,
    idle_ms: idleMs,
    total_active_ms: totalActiveMs,
    cwd: cwd || process.cwd(),
    branch: branch || '',
  };

  postJson('/api/session/snapshot', payload).catch(() => {});
}

/**
 * Flush the event queue via /api/event/batch. Called at session start.
 * Non-blocking — if flush fails, queue stays for next session.
 */
export async function flushQueue() {
  if (!existsSync(QUEUE_FILE)) return { ok: true, flushed: 0 };

  let content;
  try {
    content = readFileSync(QUEUE_FILE, 'utf8');
  } catch {
    return { ok: false, reason: 'read-error' };
  }

  const lines = content.split('\n').filter(l => l.trim().length > 0);
  if (lines.length === 0) {
    try { unlinkSync(QUEUE_FILE); } catch {}
    return { ok: true, flushed: 0 };
  }

  const events = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {}
  }

  const result = await postJson('/api/event/batch', { events });
  if (result.ok) {
    try { unlinkSync(QUEUE_FILE); } catch {}
    return { ok: true, flushed: events.length };
  }
  return { ok: false, reason: result.reason, queued: events.length };
}
