import * as pty from 'node-pty';
import { watch, existsSync, readFileSync, unlinkSync, readdirSync, statSync } from 'fs';
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import { homedir } from 'os';
import { join, basename } from 'path';
import { STATE } from './constants.mjs';
import { createSession, appendEntry, endSession } from './timing-log.mjs';
import { startTitleBar, stopTitleBar } from './title-bar.mjs';
import { playCompletionSound } from './sound.mjs';
import { postEvent, postWrapup, flushQueue, postSnapshot } from './api-client.mjs';

const SESSIONS_DIR = join(homedir(), '.claude', 'sessions');
const WRAPUP_SCRIPT = join(homedir(), '.claude', 'hooks', 'session_wrapup.sh');

/**
 * Find overlapping Claude sessions by scanning ~/.claude/sessions/*.json
 * Returns array of session IDs that overlap with this session's lifetime.
 */
function detectParallelSessions(sessionStartTime) {
  const parallel = [];
  const now = new Date();
  try {
    const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const data = JSON.parse(readFileSync(join(SESSIONS_DIR, file), 'utf8'));
        const sid = data.session_id || data.sessionId || basename(file, '.json');
        const startIso = data.start || (data.startedAt ? new Date(data.startedAt).toISOString() : null);
        const lastSeen = data.last_seen || startIso;
        if (!startIso) continue;
        const oStart = new Date(startIso);
        const oLast = new Date(lastSeen);
        // Overlap: other session started before now AND was last seen after our start
        if (oStart <= now && oLast >= sessionStartTime) {
          parallel.push(sid);
        }
      } catch {}
    }
  } catch {}
  return parallel;
}

/**
 * Find the Claude session ID by matching cwd against ~/.claude/sessions/*.json
 * Returns the session_id string or null.
 */
function findClaudeSessionId(cwd) {
  try {
    const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
    let best = null;
    let bestMtime = 0;
    for (const file of files) {
      try {
        const fullPath = join(SESSIONS_DIR, file);
        const data = JSON.parse(readFileSync(fullPath, 'utf8'));
        const pp = (data.project_path || data.cwd || '').toLowerCase();
        if (pp === cwd.toLowerCase()) {
          const stat = statSync(fullPath);
          if (stat.mtimeMs > bestMtime) {
            bestMtime = stat.mtimeMs;
            best = data.session_id || data.sessionId || basename(file, '.json');
          }
        }
      } catch {}
    }
    return best;
  } catch {
    return null;
  }
}

/**
 * Call session_wrapup.sh with a deterministic summary on session exit.
 */
function autoWrapup(claudeSessionId, promptCount, agentMs, typingMs, idleMs) {
  if (!existsSync(WRAPUP_SCRIPT)) return;
  if (!claudeSessionId) return;

  const agentMin = Math.round(agentMs / 60000);
  const typingMin = Math.round(typingMs / 60000);
  const idleMin = Math.round(idleMs / 60000);
  const summary = `${promptCount} prompts | ${agentMin}m agent | ${typingMin}m typing | ${idleMin}m idle`;

  try {
    execFileSync('bash', [WRAPUP_SCRIPT, '--session-id', claudeSessionId, summary], {
      stdio: 'ignore',
      timeout: 10000,
    });
  } catch {}
}

function isTypingKeystroke(data) {
  const buf = Buffer.from(data);
  // Escape sequences (arrows, function keys, Alt+key, etc.)
  if (buf[0] === 0x1b) return false;
  // Control characters (Ctrl+key, Tab, Backspace, Enter, etc.)
  if (buf[0] < 32) return false;
  // DEL / Backspace
  if (buf[0] === 127) return false;
  // Printable ASCII (32-126) or UTF-8 multi-byte (>= 0xC0) or paste
  return true;
}

function cleanStaleTmpFiles() {
  try {
    const tmpFiles = readdirSync('/tmp').filter(f => f.startsWith('claude_timing_'));
    for (const f of tmpFiles) {
      try { unlinkSync(`/tmp/${f}`); } catch {}
    }
  } catch {}
}

/**
 * Verify that the timing hook scripts produce valid 13-digit ms timestamps.
 * Catches BSD `date` regressions where `%N` is unsupported and the wrapper
 * silently records broken timing data. Runs once at startup; warns to stderr
 * on failure but does NOT abort the wrapper.
 */
function verifyHookTimestamps() {
  const probeId = 'verify-' + randomUUID().slice(0, 8);
  const startScript = join(homedir(), 'Documents', 'GitHub', 'claude_timings_wrapper', 'hooks', 'claude-timing-start.sh');
  const stopScript = join(homedir(), 'Documents', 'GitHub', 'claude_timings_wrapper', 'hooks', 'claude-timing-stop.sh');
  const startTmp = `/tmp/claude_timing_start_${probeId}`;
  const stopTmp = `/tmp/claude_timing_${probeId}`;

  function checkOne(script, tmp, label) {
    try {
      execFileSync('bash', [script], {
        env: { ...process.env, CLAUDE_TIMING_SESSION: probeId },
        timeout: 3000,
      });
    } catch (err) {
      console.error(`[claude-timed] WARNING: ${label} hook failed to execute: ${err.message}`);
      return false;
    }
    if (!existsSync(tmp)) {
      console.error(`[claude-timed] WARNING: ${label} hook did not write ${tmp}`);
      return false;
    }
    const content = readFileSync(tmp, 'utf8').trim();
    try { unlinkSync(tmp); } catch {}

    // Valid: 13-digit integer within 10s of now
    if (!/^\d{13}$/.test(content)) {
      console.error(`[claude-timed] WARNING: ${label} hook output "${content}" is not a 13-digit ms timestamp.`);
      console.error(`[claude-timed] Timing data will be corrupt. Check ${script}.`);
      return false;
    }
    const value = parseInt(content, 10);
    const now = Date.now();
    if (Math.abs(now - value) > 10000) {
      console.error(`[claude-timed] WARNING: ${label} hook output ${content} is not within 10s of now (${now}).`);
      return false;
    }
    return true;
  }

  const startOk = checkOne(startScript, startTmp, 'start');
  const stopOk = checkOne(stopScript, stopTmp, 'stop');
  return startOk && stopOk;
}

export function startWrapper(claudeArgs) {
  const sessionId = randomUUID();
  const shortId = sessionId.slice(0, 8);
  const tmpFile = `/tmp/claude_timing_${sessionId}`;
  const startTmpFile = `/tmp/claude_timing_start_${sessionId}`;

  cleanStaleTmpFiles();
  verifyHookTimestamps();

  const sessionFilePath = createSession(sessionId);
  console.log(`Session: ${shortId} — logging to ${sessionFilePath}`);

  const sessionCwd = process.cwd();
  let sessionBranch = '';
  try {
    sessionBranch = execFileSync('git', ['-C', sessionCwd, 'branch', '--show-current'], {
      encoding: 'utf8',
      timeout: 2000,
    }).trim();
  } catch {}

  // Flush any queued events from previous sessions (non-blocking)
  flushQueue().catch(() => {});

  let state = STATE.INITIAL;
  let phaseStart = Date.now();
  let promptCount = 0;
  let typingStartTime = null;

  // Accumulated totals
  let totalIdleMs = 0;
  let totalTypingMs = 0;
  let totalAgentMs = 0;

  // Helper: post a snapshot of the current accumulated totals.
  // Called after every state transition that updates totals so the
  // API session row is always up-to-date with authoritative wrapper data.
  function pushSnapshot() {
    postSnapshot({
      sessionId,
      agentMs: totalAgentMs,
      typingMs: totalTypingMs,
      idleMs: totalIdleMs,
      totalActiveMs: totalAgentMs + totalTypingMs,
      cwd: sessionCwd,
      branch: sessionBranch,
    });
  }

  // Post session start
  postEvent({
    sessionId,
    eventType: 'start',
    cwd: sessionCwd,
    branch: sessionBranch,
    metadata: {},
  });
  pushSnapshot();

  // Tracks idle_ms from the most recent IDLE→USER_TYPING transition.
  // If a background agent Stop fires during USER_TYPING, this amount
  // is retroactively moved from idle to agent time.
  let lastPendingIdleMs = 0;

  function getState() { return state; }
  function getPhaseStart() { return phaseStart; }

  function transitionTo(newState, timestamp) {
    state = newState;
    phaseStart = timestamp || Date.now();
  }

  // Spawn claude in a PTY
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  const child = pty.spawn('claude', claudeArgs, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLAUDE_TIMING_SESSION: sessionId,
      CLAUDE_SESSION_ID: sessionId,
    },
  });

  // Pipe PTY output to stdout
  child.onData((data) => {
    process.stdout.write(data);
  });

  // Handle resize
  process.stdout.on('resize', () => {
    child.resize(process.stdout.columns || 80, process.stdout.rows || 24);
  });

  // Start title bar
  startTitleBar(getState, getPhaseStart);

  // Watch for hook temp files (UserPromptSubmit start, Stop)
  let watcher = null;
  function handleStopHook() {
    if (!existsSync(tmpFile)) return;

    let stopTimestamp;
    try {
      const content = readFileSync(tmpFile, 'utf8').trim();
      // fs.watch fires on file creation before content is written;
      // retry shortly if the file is still empty.
      if (!content) {
        setTimeout(handleStopHook, 50);
        return;
      }
      stopTimestamp = parseInt(content, 10);
      if (isNaN(stopTimestamp)) {
        try { unlinkSync(tmpFile); } catch {}
        return;
      }
      unlinkSync(tmpFile);
    } catch {
      return;
    }

    if (state === STATE.AGENT_WORKING) {
      const agentMs = Math.max(0, stopTimestamp - phaseStart);
      totalAgentMs += agentMs;
      promptCount++;

      appendEntry(sessionFilePath, {
        event: 'agent_stop',
        prompt: promptCount,
        agent_work_ms: agentMs,
      });

      postEvent({
        sessionId,
        eventType: 'stop',
        cwd: sessionCwd,
        branch: sessionBranch,
        metadata: { agent_work_ms: agentMs, prompt: promptCount },
      });
      pushSnapshot();

      lastPendingIdleMs = 0;
      transitionTo(STATE.IDLE);
      playCompletionSound();
    } else if (state === STATE.IDLE) {
      // Stop fired without UserPromptSubmit → background agent completed.
      // The time since entering IDLE was spent waiting for the background
      // agent, so count it as agent work rather than idle.
      const backgroundMs = Math.max(0, stopTimestamp - phaseStart);
      totalAgentMs += backgroundMs;

      appendEntry(sessionFilePath, {
        event: 'background_agent_stop',
        agent_work_ms: backgroundMs,
      });

      postEvent({
        sessionId,
        eventType: 'background_stop',
        cwd: sessionCwd,
        branch: sessionBranch,
        metadata: { agent_work_ms: backgroundMs },
      });
      pushSnapshot();

      lastPendingIdleMs = 0;
      transitionTo(STATE.IDLE, stopTimestamp);
      playCompletionSound();
    } else if (state === STATE.USER_TYPING) {
      // Background agent completed while user was typing.
      // The idle_ms logged at the IDLE→USER_TYPING transition was actually
      // time spent waiting for the background agent, not true idle time.
      // Retroactively correct the totals.
      const correctionMs = lastPendingIdleMs;
      if (correctionMs > 0) {
        totalIdleMs -= correctionMs;
        totalAgentMs += correctionMs;
        lastPendingIdleMs = 0;
      }

      appendEntry(sessionFilePath, {
        event: 'background_agent_stop',
        agent_work_ms: correctionMs,
        idle_correction_ms: correctionMs,
      });

      postEvent({
        sessionId,
        eventType: 'background_stop',
        cwd: sessionCwd,
        branch: sessionBranch,
        metadata: { agent_work_ms: correctionMs, idle_correction_ms: correctionMs },
      });
      pushSnapshot();

      playCompletionSound();
      // Stay in USER_TYPING — user is still composing their prompt
    }
  }

  function handleStartHook() {
    if (!existsSync(startTmpFile)) return;

    let startTimestamp;
    try {
      const content = readFileSync(startTmpFile, 'utf8').trim();
      if (!content) {
        setTimeout(handleStartHook, 50);
        return;
      }
      startTimestamp = parseInt(content, 10);
      if (isNaN(startTimestamp)) {
        try { unlinkSync(startTmpFile); } catch {}
        return;
      }
      unlinkSync(startTmpFile);
    } catch {
      return;
    }

    // Steering: user submitted while agent was working
    if (state === STATE.AGENT_WORKING) {
      if (typingStartTime !== null) {
        const typingMs = Math.max(0, startTimestamp - typingStartTime);
        totalTypingMs += typingMs;
        typingStartTime = null;

        appendEntry(sessionFilePath, {
          event: 'steering_submit',
          typing_ms: typingMs,
        });

        postEvent({
          sessionId,
          eventType: 'steering',
          cwd: sessionCwd,
          branch: sessionBranch,
          metadata: { typing_ms: typingMs },
        });
        pushSnapshot();
      }
      return;
    }

    // Normal prompt submission from INITIAL, USER_TYPING, or IDLE
    let typingMs = 0;
    if (typingStartTime !== null) {
      typingMs = Math.max(0, startTimestamp - typingStartTime);
      totalTypingMs += typingMs;
      typingStartTime = null;
    }

    if (state === STATE.IDLE) {
      const idleMs = Math.max(0, startTimestamp - phaseStart);
      totalIdleMs += idleMs;

      appendEntry(sessionFilePath, {
        event: 'typing_start',
        prompt: promptCount + 1,
        idle_ms: idleMs,
      });

      postEvent({
        sessionId,
        eventType: 'typing_start',
        cwd: sessionCwd,
        branch: sessionBranch,
        metadata: { idle_ms: idleMs, prompt: promptCount + 1 },
      });
      pushSnapshot();
    }

    appendEntry(sessionFilePath, {
      event: 'prompt_submit',
      prompt: promptCount + 1,
      typing_ms: typingMs,
    });

    postEvent({
      sessionId,
      eventType: 'prompt',
      cwd: sessionCwd,
      branch: sessionBranch,
      metadata: { typing_ms: typingMs, prompt: promptCount + 1 },
    });
    pushSnapshot();

    lastPendingIdleMs = 0;
    transitionTo(STATE.AGENT_WORKING, startTimestamp);
  }

  // Use fs.watch on /tmp directory for hook files
  try {
    watcher = watch('/tmp', (eventType, filename) => {
      if (filename === `claude_timing_start_${sessionId}`) {
        handleStartHook();
      } else if (filename === `claude_timing_${sessionId}`) {
        handleStopHook();
      }
    });
  } catch {
    // Fallback: poll every 500ms (start before stop to ensure correct ordering)
    setInterval(() => {
      handleStartHook();
      handleStopHook();
    }, 500);
  }

  // Enter raw mode and forward keystrokes
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  process.stdin.on('data', (data) => {
    // Forward everything to the PTY
    child.write(data);

    const buf = Buffer.from(data);

    // Check for Ctrl+C (0x03) — user interrupt
    if (buf.length === 1 && buf[0] === 0x03) {
      if (state === STATE.AGENT_WORKING) {
        const agentMs = Date.now() - phaseStart;
        totalAgentMs += agentMs;
        promptCount++;

        // Discard any in-progress steering typing
        typingStartTime = null;

        appendEntry(sessionFilePath, {
          event: 'agent_interrupt',
          prompt: promptCount,
          agent_work_ms: agentMs,
        });

        postEvent({
          sessionId,
          eventType: 'interrupt',
          cwd: sessionCwd,
          branch: sessionBranch,
          metadata: { agent_work_ms: agentMs, prompt: promptCount },
        });
        pushSnapshot();

        lastPendingIdleMs = 0;
        transitionTo(STATE.IDLE);
        playCompletionSound();
      } else if (state === STATE.USER_TYPING) {
        // User cancelled their input — discard partial typing
        typingStartTime = null;
        lastPendingIdleMs = 0;
        transitionTo(STATE.IDLE);
      }
      return;
    }

    // Check for typing keystroke
    if (isTypingKeystroke(data)) {
      if (state === STATE.INITIAL && typingStartTime === null) {
        typingStartTime = Date.now();
      } else if (state === STATE.IDLE) {
        const idleMs = Date.now() - phaseStart;
        totalIdleMs += idleMs;
        lastPendingIdleMs = idleMs;

        appendEntry(sessionFilePath, {
          event: 'typing_start',
          prompt: promptCount + 1,
          idle_ms: idleMs,
        });

        typingStartTime = Date.now();
        transitionTo(STATE.USER_TYPING);
      } else if (state === STATE.USER_TYPING && typingStartTime === null) {
        typingStartTime = Date.now();
      } else if (state === STATE.AGENT_WORKING && typingStartTime === null) {
        // User starts typing while agent is still working (steering).
        // Begin tracking typing time without interrupting the agent timer.
        typingStartTime = Date.now();
      }
    }
  });

  // Handle exit
  async function cleanup(exitCode) {
    stopTitleBar();

    if (watcher) {
      try { watcher.close(); } catch {}
    }

    // If agent was still working, record partial time
    if (state === STATE.AGENT_WORKING) {
      const partialAgent = Date.now() - phaseStart;
      totalAgentMs += partialAgent;
    } else if (state === STATE.IDLE) {
      const partialIdle = Date.now() - phaseStart;
      totalIdleMs += partialIdle;
    } else if (state === STATE.USER_TYPING && typingStartTime) {
      const partialTyping = Date.now() - typingStartTime;
      totalTypingMs += partialTyping;
    }

    // Detect parallel sessions
    const sessionStartTime = new Date(Date.now() - totalIdleMs - totalTypingMs - totalAgentMs);
    const parallelIds = detectParallelSessions(sessionStartTime);

    const endData = {
      total_user_ms: totalIdleMs + totalTypingMs,
      total_idle_ms: totalIdleMs,
      total_typing_ms: totalTypingMs,
      total_agent_ms: totalAgentMs,
      prompts: promptCount,
      cwd: process.cwd(),
    };
    if (parallelIds.length > 0) {
      endData.parallel_with = parallelIds;
    }

    endSession(sessionFilePath, endData);

    // Post wrapup to CC API with full timing breakdown.
    // Await briefly (max TIMEOUT_MS + RETRY_DELAY_MS ≈ 7s) so the POST
    // lands before process exit.
    const totalActiveMs = totalAgentMs + totalTypingMs;
    const wrapupSummary = `${promptCount} prompts | ${Math.round(totalAgentMs/60000)}m agent | ${Math.round(totalTypingMs/60000)}m typing | ${Math.round(totalIdleMs/60000)}m idle`;
    try {
      await postWrapup({
        sessionId,
        summary: wrapupSummary,
        agentMs: totalAgentMs,
        typingMs: totalTypingMs,
        idleMs: totalIdleMs,
        totalActiveMs,
      });
    } catch {}

    // Auto-wrapup: log to time-log.jsonl via session_wrapup.sh
    const claudeSessionId = findClaudeSessionId(process.cwd());
    autoWrapup(claudeSessionId, promptCount, totalAgentMs, totalTypingMs, totalIdleMs);

    // Clean up temp files
    try { unlinkSync(tmpFile); } catch {}
    try { unlinkSync(startTmpFile); } catch {}

    // Restore terminal
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch {}
    }

    process.exit(exitCode ?? 0);
  }

  child.onExit(({ exitCode }) => {
    cleanup(exitCode).catch(() => process.exit(exitCode ?? 0));
  });

  process.on('SIGINT', () => {
    // Forward to child; PTY will handle it
  });

  process.on('SIGTERM', () => {
    child.kill();
  });
}
