import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  sanitizeTimestamp,
  clampAgentMs,
  capSummaryAgentTotal,
  MAX_AGENT_PHASE_MS,
} from '../lib/sanitize.mjs';
import { readSessionSummary } from '../lib/timing-log.mjs';

const NOW = 1_751_000_000_000;      // a plausible 2025-era epoch-ms
const SESSION_START = NOW - 60_000; // session began a minute ago

test('sanitizeTimestamp rejects the near-zero epoch (the "55-year turn" bug)', () => {
  // A truncated read of the start-hook file parsed to a tiny int.
  assert.equal(sanitizeTimestamp(1751, SESSION_START, NOW), null);
  assert.equal(sanitizeTimestamp(0, SESSION_START, NOW), null);
});

test('sanitizeTimestamp rejects future timestamps beyond skew', () => {
  assert.equal(sanitizeTimestamp(NOW + 60 * 60 * 1000, SESSION_START, NOW), null);
});

test('sanitizeTimestamp rejects non-finite input', () => {
  assert.equal(sanitizeTimestamp(NaN, SESSION_START, NOW), null);
  assert.equal(sanitizeTimestamp(Infinity, SESSION_START, NOW), null);
});

test('sanitizeTimestamp accepts a plausible in-session timestamp', () => {
  assert.equal(sanitizeTimestamp(NOW - 5_000, SESSION_START, NOW), NOW - 5_000);
  // within skew tolerance on both edges
  assert.equal(sanitizeTimestamp(NOW + 1_000, SESSION_START, NOW), NOW + 1_000);
});

test('clampAgentMs caps a runaway turn and flags it', () => {
  const runaway = 55 * 365 * 24 * 60 * 60 * 1000; // ~55 years
  const r = clampAgentMs(runaway);
  assert.equal(r.ms, MAX_AGENT_PHASE_MS);
  assert.equal(r.clamped, true);
});

test('clampAgentMs passes normal durations through unflagged', () => {
  const r = clampAgentMs(90_000); // 90s
  assert.equal(r.ms, 90_000);
  assert.equal(r.clamped, false);
});

test('clampAgentMs floors negatives and non-finite to 0', () => {
  assert.deepEqual(clampAgentMs(-5), { ms: 0, clamped: false });
  assert.deepEqual(clampAgentMs(NaN), { ms: 0, clamped: false });
});

test('capSummaryAgentTotal heals a session_end that baked in a corrupt total', () => {
  const s = capSummaryAgentTotal({
    total_agent_ms: 488_412 * 60 * 60 * 1000, // the real 55-year outlier
    total_idle_ms: 10_000,
    total_typing_ms: 5_000,
    prompts: 3,
  });
  assert.equal(s.total_agent_ms, 3 * MAX_AGENT_PHASE_MS);
  assert.equal(s.total_user_ms, 15_000);
  assert.equal(s.agent_capped, true);
});

test('readSessionSummary clamps a corrupt agent_stop event (read-side heal)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timing-test-'));
  const file = join(dir, 'corrupt.jsonl');
  const runaway = 488_412 * 60 * 60 * 1000;
  writeFileSync(file, [
    JSON.stringify({ event: 'session_start', session: 'x', cwd: '/repo', ts: '2025-01-01T00:00:00Z' }),
    JSON.stringify({ event: 'prompt_submit', prompt: 1, typing_ms: 5000 }),
    JSON.stringify({ event: 'agent_stop', prompt: 1, agent_work_ms: runaway }),
  ].join('\n'));
  try {
    const summary = readSessionSummary(file);
    assert.ok(summary.total_agent_ms <= MAX_AGENT_PHASE_MS,
      `expected clamped agent time, got ${summary.total_agent_ms}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
