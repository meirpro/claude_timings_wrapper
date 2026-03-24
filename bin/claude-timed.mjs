#!/usr/bin/env node

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

const args = process.argv.slice(2);

// Handle wrapper-specific flags
if (args[0] === '--install-hook') {
  const { install } = await import('../lib/hook-installer.mjs');
  install();
  process.exit(0);
}

if (args[0] === '--uninstall-hook') {
  const { uninstall } = await import('../lib/hook-installer.mjs');
  uninstall();
  process.exit(0);
}

if (args[0] === '--version') {
  console.log(`claude-timed v${pkg.version}`);
  process.exit(0);
}

if (args[0] === '--stats') {
  const { showStats } = await import('../lib/stats.mjs');
  showStats(args.slice(1));
  process.exit(0);
}

if (args[0] === '--timing-help') {
  console.log(`claude-timed v${pkg.version} — Claude Code session timing wrapper

Usage:
  claude-timed [claude args...]       Start Claude with timing
  claude-timed --install-hook         Install the Stop hook in Claude settings
  claude-timed --uninstall-hook       Remove the Stop hook
  claude-timed --stats                Show current/most recent session stats
  claude-timed --stats today          Today's sessions
  claude-timed --stats week           Last 7 days
  claude-timed --stats month          Last 30 days
  claude-timed --stats YYYY-MM-DD     Since a specific date
  claude-timed --stats DATE1 DATE2    Custom date range
  claude-timed --stats all            All sessions
  claude-timed --stats [range] --project NAME   Filter by project name
  claude-timed --version              Show version
  claude-timed --timing-help          Show this help`);
  process.exit(0);
}

// Default: launch the wrapper with all args passed to claude
const { startWrapper } = await import('../lib/wrapper.mjs');
startWrapper(args);
