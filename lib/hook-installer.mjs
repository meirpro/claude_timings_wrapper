import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync, chmodSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { CLAUDE_SETTINGS_PATH, HOOK_INSTALL_DIR, HOOK_SCRIPT_NAME } from './constants.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK_SOURCE = join(__dirname, '..', 'hooks', HOOK_SCRIPT_NAME);
const HOOK_DEST = join(HOOK_INSTALL_DIR, HOOK_SCRIPT_NAME);

const HOOK_ENTRY = {
  matcher: "",
  hooks: [
    {
      type: "command",
      command: HOOK_DEST,
    },
  ],
};

function readSettings() {
  if (!existsSync(CLAUDE_SETTINGS_PATH)) {
    return {};
  }
  return JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
}

function isHookInstalled(settings) {
  const stopHooks = settings?.hooks?.Stop;
  if (!Array.isArray(stopHooks)) return false;
  return stopHooks.some(entry =>
    entry?.hooks?.some(h => h?.command?.includes(HOOK_SCRIPT_NAME))
  );
}

export function install() {
  // Copy hook script
  mkdirSync(HOOK_INSTALL_DIR, { recursive: true });
  copyFileSync(HOOK_SOURCE, HOOK_DEST);
  chmodSync(HOOK_DEST, 0o755);
  console.log(`Hook script copied to ${HOOK_DEST}`);

  // Update settings
  const settings = readSettings();

  if (isHookInstalled(settings)) {
    console.log('Stop hook already present in settings — skipping.');
    return;
  }

  // Backup
  const backupPath = CLAUDE_SETTINGS_PATH + '.timing-bak';
  if (existsSync(CLAUDE_SETTINGS_PATH)) {
    copyFileSync(CLAUDE_SETTINGS_PATH, backupPath);
    console.log(`Settings backed up to ${backupPath}`);
  }

  // Add Stop hook
  if (!settings.hooks) settings.hooks = {};
  if (!Array.isArray(settings.hooks.Stop)) settings.hooks.Stop = [];
  settings.hooks.Stop.push(HOOK_ENTRY);

  mkdirSync(dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
  writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
  console.log('Stop hook added to Claude settings.');
}

export function uninstall() {
  const settings = readSettings();

  if (!isHookInstalled(settings)) {
    console.log('Stop hook not found in settings — nothing to remove.');
  } else {
    // Backup
    const backupPath = CLAUDE_SETTINGS_PATH + '.timing-bak';
    copyFileSync(CLAUDE_SETTINGS_PATH, backupPath);

    // Remove our entries from Stop hooks
    settings.hooks.Stop = settings.hooks.Stop.filter(entry =>
      !entry?.hooks?.some(h => h?.command?.includes(HOOK_SCRIPT_NAME))
    );

    // Clean up empty arrays/objects
    if (settings.hooks.Stop.length === 0) delete settings.hooks.Stop;
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

    writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
    console.log('Stop hook removed from Claude settings.');
  }

  // Remove hook script
  if (existsSync(HOOK_DEST)) {
    unlinkSync(HOOK_DEST);
    console.log(`Hook script removed: ${HOOK_DEST}`);
  }
}
