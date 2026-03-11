# claude-timed

Track how time is spent during Claude Code sessions: how long you're idle after the agent finishes, how long you spend typing, and how long the agent works.

## How it works

`claude-timed` is a Node.js PTY wrapper that sits between your terminal and the `claude` process. It uses two mechanisms to track timing:

1. **Keystroke interception** — The wrapper intercepts stdin in raw mode to detect when you start typing (only real text input — arrow keys, Ctrl combos, Tab, etc. are ignored).
2. **Stop hook** — A Claude Code [Stop hook](https://docs.anthropic.com/en/docs/claude-code/hooks) writes a millisecond timestamp to a temp file when the agent finishes working. The wrapper watches for this file to know exactly when the agent completed.

These two signals drive a state machine:

```
INITIAL  --(first keystroke)--> typing started
         --(Enter)-----------> AGENT_WORKING

AGENT_WORKING --(Stop hook)--> IDLE

IDLE --(first keystroke)-----> USER_TYPING

USER_TYPING --(Enter)-------> AGENT_WORKING
```

Each transition is logged to a per-session JSONL file in `~/.claude/timings/`.

## Requirements

- **Node.js** >= 18
- **Claude Code** CLI (`claude`) installed and on your PATH
- A C/C++ toolchain for compiling `node-pty` (build-essential / Xcode CLI tools)

## Installation

```bash
git clone <this-repo>
cd claude_timings_wrapper
npm install
```

### Install the Stop hook

This adds a Stop hook entry to `~/.claude/settings.json` and copies the hook script to `~/.claude/hooks/`. Your existing settings (other hooks, plugins, statusLine, etc.) are preserved. A `.timing-bak` backup is created before any modification.

```bash
node bin/claude-timed.mjs --install-hook
```

### Optional: make it globally available

```bash
npm link
```

Then you can use `claude-timed` from anywhere instead of `node bin/claude-timed.mjs`.

## Usage

### Start a timed session

```bash
claude-timed
# or with arguments passed through to claude:
claude-timed --model sonnet
```

The terminal title bar shows a live timer indicating the current phase (Idle, Typing, or Agent).

All Claude Code functionality works exactly as normal — the wrapper is transparent.

### View stats

```bash
claude-timed --stats                          # Current/most recent session
claude-timed --stats today                    # Today's sessions
claude-timed --stats week                     # Last 7 days
claude-timed --stats month                    # Last 30 days
claude-timed --stats 2026-03-01               # Since a specific date
claude-timed --stats 2026-03-01 2026-03-11    # Custom date range
claude-timed --stats all                      # All sessions
```

Example output:

```
=== Claude Code Timing Stats ===
Period: Today (2026-03-11)
Sessions: 3 | Prompts: 22

             Total        Average/prompt
  User:      12m 30s      34.1s
    Idle:    8m 15s       22.5s
    Typing:  4m 15s       11.6s
  Agent:     1h 5m        2m 58s

Time distribution:
  User:  16.1%  ███░░░░░░░░░░░░░░░░░
  Agent: 83.9%  █████████████████░░░
```

### Uninstall the hook

Removes the Stop hook from settings and deletes the hook script. Other settings are untouched.

```bash
claude-timed --uninstall-hook
```

### Help

```bash
claude-timed --timing-help
```

## Data storage

Session data is stored as JSONL files in `~/.claude/timings/`:

```
~/.claude/timings/
├── 2026-03-11T10-30-00_a1b2c3d4.jsonl
├── 2026-03-11T14-15-22_d4e5f6a7.jsonl
└── ...
```

Each file contains one JSON object per line:

```jsonl
{"ts":"...","event":"session_start","session":"a1b2c3d4"}
{"ts":"...","event":"prompt_submit","prompt":1,"typing_ms":5230}
{"ts":"...","event":"agent_stop","prompt":1,"agent_work_ms":45000}
{"ts":"...","event":"typing_start","prompt":2,"idle_ms":30000}
{"ts":"...","event":"prompt_submit","prompt":2,"typing_ms":10000}
{"ts":"...","event":"agent_stop","prompt":2,"agent_work_ms":35000}
{"ts":"...","event":"session_end","total_user_ms":45230,"total_idle_ms":30000,"total_typing_ms":15230,"total_agent_ms":80000,"prompts":2}
```

## Project structure

```
claude_timings_wrapper/
├── package.json
├── bin/
│   └── claude-timed.mjs          # Entry point, flag parsing
├── lib/
│   ├── constants.mjs             # Paths and state enum
│   ├── wrapper.mjs               # PTY spawn, state machine, keystroke detection
│   ├── timing-log.mjs            # Per-session JSONL read/write
│   ├── stats.mjs                 # --stats display with date filtering
│   ├── title-bar.mjs             # Terminal title bar timer
│   └── hook-installer.mjs        # Install/uninstall Stop hook
└── hooks/
    └── claude-timing-stop.sh     # Stop hook script
```

## Limitations

- **Enter = submit**: A bare Enter keystroke (byte `0x0d`, length 1) is treated as prompt submission. Multi-line input via Shift+Enter or paste is not distinguished in v1.
- **First prompt idle time**: The very first prompt has no idle time measurement since there's no prior agent completion to measure from.
- **Abrupt termination**: If the process is killed (SIGKILL, power loss), the `session_end` summary won't be written. Stats will recompute totals from individual events in this case.

## License

MIT
