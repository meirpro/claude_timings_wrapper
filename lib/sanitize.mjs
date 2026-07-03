// Guards against corrupt timing durations.
//
// Shipped once — the "55-year agent turn" bug: a truncated/partial read of the
// UserPromptSubmit start-hook temp file parsed to a near-zero epoch, so
// `stopTimestamp - phaseStart` came out as ~1.75e12 ms (≈55 years). Just 15
// such events (0.1% of all agent_stop events) held 99.6% of the recorded agent
// time and made every `--stats` agent figure meaningless (e.g. "307h agent in
// 7 days"). Two failure classes, two guards:
//   1. Corrupt phaseStart (near-zero / future epoch) -> sanitizeTimestamp()
//      rejects implausible epochs so callers fall back to wall-clock.
//   2. Missed Stop hook / left-open session accumulating a real multi-hour gap
//      -> clampAgentMs() caps any single turn at MAX_AGENT_PHASE_MS.
//
// Deliberately NOT clamped: idle time (typing_start idle_ms) — being idle for
// hours is legitimate, not corruption. Only agent-phase durations are bounded.

export const CLOCK_SKEW_MS = 5 * 60 * 1000;           // tolerate clock jitter between hook + wrapper
export const MAX_AGENT_PHASE_MS = 6 * 60 * 60 * 1000; // no single agent turn counts as > 6h

// Return `ts` if it is a plausible epoch-ms for this session, else null.
//   floorMs = session start (a phase cannot begin before the session did)
//   nowMs   = current wall clock (a phase cannot begin in the future)
// A near-zero (truncated read) or future value is rejected; the caller then
// substitutes Date.now(). skewMs absorbs minor clock differences.
export function sanitizeTimestamp(ts, floorMs, nowMs, skewMs = CLOCK_SKEW_MS) {
  if (!Number.isFinite(ts)) return null;
  if (ts < floorMs - skewMs) return null;
  if (ts > nowMs + skewMs) return null;
  return ts;
}

// Cap a single agent-phase duration to a sane ceiling.
// Returns { ms, clamped } so callers can flag clamped entries for consumers.
export function clampAgentMs(ms, maxMs = MAX_AGENT_PHASE_MS) {
  const bounded = Math.max(0, Number.isFinite(ms) ? ms : 0);
  if (bounded > maxMs) return { ms: maxMs, clamped: true };
  return { ms: bounded, clamped: false };
}

// Cap an already-summed per-session agent total. A session cannot have logged
// more agent time than (its prompts) × the per-turn ceiling. Heals `session_end`
// totals that baked in a corrupt agent_work_ms before this guard existed.
// Returns the summary object (mutated) with `agent_capped: true` when it fires.
export function capSummaryAgentTotal(summary, maxPhaseMs = MAX_AGENT_PHASE_MS) {
  const cap = Math.max(1, summary.prompts || 0) * maxPhaseMs;
  if (Number.isFinite(summary.total_agent_ms) && summary.total_agent_ms > cap) {
    summary.total_agent_ms = cap;
    summary.total_user_ms = (summary.total_idle_ms || 0) + (summary.total_typing_ms || 0);
    summary.agent_capped = true;
  }
  return summary;
}
