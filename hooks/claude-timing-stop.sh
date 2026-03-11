#!/usr/bin/env bash
# Claude Code Stop hook for timing wrapper.
# Writes a millisecond timestamp to a temp file so the PTY wrapper
# knows exactly when the agent finished.

# If not running inside the timing wrapper, exit silently.
if [ -z "$CLAUDE_TIMING_SESSION" ]; then
  exit 0
fi

TMPFILE="/tmp/claude_timing_${CLAUDE_TIMING_SESSION}"

# Write current epoch milliseconds
date +%s%3N > "$TMPFILE"
