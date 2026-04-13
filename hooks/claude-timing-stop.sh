#!/usr/bin/env bash
# Claude Code Stop hook for timing wrapper.
# Writes a millisecond timestamp to a temp file so the PTY wrapper
# knows exactly when the agent finished.

# If not running inside the timing wrapper, exit silently.
if [ -z "$CLAUDE_TIMING_SESSION" ]; then
  exit 0
fi

TMPFILE="/tmp/claude_timing_${CLAUDE_TIMING_SESSION}"

# Write current epoch milliseconds.
# Use python3 because BSD `date` (macOS) does not support the %N format
# specifier — `date +%s%3N` would write literal "3N" characters and the
# wrapper would parse the result with a ~100× scale error.
python3 -c 'import time; print(int(time.time()*1000))' > "$TMPFILE"
