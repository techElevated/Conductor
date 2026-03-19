/**
 * Conductor — Hook Installer.
 *
 * Auto-installs the Conductor PreToolUse hook into Claude Code's
 * configuration.  Handles detection of existing hooks and offers
 * chain / replace / skip options.
 *
 * PRD v1.1 §4a — Hook installation conflict handling.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ensureDir } from '../storage/FileStore';
import { getHooksDir } from '../storage/paths';
import {
  HOOK_SCRIPT_NAME,
  getBundledHookPath,
  getInstalledHookPath,
  buildHookCommand,
} from './preToolUseHook';

// ── Claude Code settings paths ──────────────────────────────

function getClaudeSettingsDir(): string {
  return path.join(os.homedir(), '.claude');
}

function getClaudeSettingsPath(): string {
  return path.join(getClaudeSettingsDir(), 'settings.json');
}

// ── Hook entry in Claude Code settings ──────────────────────

interface ClaudeHookEntry {
  type: 'command';
  event: string;
  command: string;
}

interface ClaudeSettings {
  hooks?: Record<string, ClaudeHookEntry[]>;
  [key: string]: unknown;
}

// ── Public API ──────────────────────────────────────────────

/**
 * Install the Conductor PreToolUse hook for a session.
 *
 * 1. Copies the hook script to ~/.conductor/hooks/
 * 2. Registers the hook in Claude Code's settings.json
 * 3. Handles existing hook conflicts (chain, replace, skip)
 */
export async function installHook(
  sessionId: string,
  sessionName: string,
  extensionPath: string,
): Promise<void> {
  // Step 1: Copy the hook script to ~/.conductor/hooks/
  await copyHookScript(extensionPath);

  // Step 2: Register in Claude Code's settings
  await registerHookInSettings(sessionId, sessionName);
}

/**
 * Uninstall the Conductor PreToolUse hook.
 * Removes the hook entry from Claude Code's settings.json.
 */
export async function uninstallHook(): Promise<void> {
  const settingsPath = getClaudeSettingsPath();
  const settings = await readClaudeSettings(settingsPath);

  if (!settings.hooks?.PreToolUse) {
    return;
  }

  // Remove Conductor hook entries
  settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(
    (h) => !isConductorHook(h),
  );

  // Clean up empty hooks object
  if (settings.hooks.PreToolUse.length === 0) {
    delete settings.hooks.PreToolUse;
  }
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  await writeClaudeSettings(settingsPath, settings);
}

/**
 * Check if the Conductor hook is currently installed.
 */
export async function isHookInstalled(): Promise<boolean> {
  const settingsPath = getClaudeSettingsPath();
  const settings = await readClaudeSettings(settingsPath);

  const hooks = settings.hooks?.PreToolUse ?? [];
  return hooks.some((h) => isConductorHook(h));
}

// ── Internal ────────────────────────────────────────────────

async function copyHookScript(extensionPath: string): Promise<void> {
  const source = getBundledHookPath(extensionPath);
  const dest = getInstalledHookPath();

  await ensureDir(getHooksDir());

  // Only copy if source exists and is newer or dest doesn't exist
  try {
    const destStat = await fs.promises.stat(dest);
    const srcStat = await fs.promises.stat(source);
    if (srcStat.mtimeMs <= destStat.mtimeMs) {
      return; // Already up to date
    }
  } catch {
    // Dest doesn't exist — proceed with copy
  }

  await fs.promises.copyFile(source, dest);
  // Make executable
  await fs.promises.chmod(dest, 0o755);
}

async function registerHookInSettings(
  sessionId: string,
  sessionName: string,
): Promise<void> {
  const settingsPath = getClaudeSettingsPath();
  const settings = await readClaudeSettings(settingsPath);

  // Initialise hooks structure
  if (!settings.hooks) {
    settings.hooks = {};
  }
  if (!settings.hooks.PreToolUse) {
    settings.hooks.PreToolUse = [];
  }

  const existingHooks = settings.hooks.PreToolUse;
  const existingConductorHook = existingHooks.find((h) => isConductorHook(h));

  if (existingConductorHook) {
    // Update the existing Conductor hook with new session info
    const newHook = buildHookCommand(sessionId, sessionName);
    existingConductorHook.command = newHook.command;
    await writeClaudeSettings(settingsPath, settings);
    return;
  }

  // Check for non-Conductor PreToolUse hooks
  const otherHooks = existingHooks.filter((h) => !isConductorHook(h));

  if (otherHooks.length > 0) {
    // Existing hooks detected — prompt user
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: 'Chain',
          description: 'Run Conductor hook alongside existing hooks',
          value: 'chain',
        },
        {
          label: 'Replace',
          description: 'Replace existing PreToolUse hooks with Conductor',
          value: 'replace',
        },
        {
          label: 'Skip',
          description: 'Do not install the hook (approvals won\'t work)',
          value: 'skip',
        },
      ],
      {
        placeHolder: 'Existing PreToolUse hooks detected. How should Conductor proceed?',
        ignoreFocusOut: true,
      },
    );

    if (!choice || choice.value === 'skip') {
      return;
    }

    if (choice.value === 'replace') {
      settings.hooks.PreToolUse = [];
    }
    // 'chain': keep existing hooks, add Conductor's
  }

  const hookEntry = buildHookCommand(sessionId, sessionName);
  settings.hooks.PreToolUse.push(hookEntry);
  await writeClaudeSettings(settingsPath, settings);
}

function isConductorHook(hook: ClaudeHookEntry): boolean {
  return hook.command?.includes(HOOK_SCRIPT_NAME) ?? false;
}

// ── Claude settings file I/O ────────────────────────────────

async function readClaudeSettings(settingsPath: string): Promise<ClaudeSettings> {
  try {
    const raw = await fs.promises.readFile(settingsPath, 'utf-8');
    return JSON.parse(raw) as ClaudeSettings;
  } catch {
    return {};
  }
}

async function writeClaudeSettings(
  settingsPath: string,
  settings: ClaudeSettings,
): Promise<void> {
  await ensureDir(path.dirname(settingsPath));

  // Atomic write
  const tmpPath = `${settingsPath}.tmp-${process.pid}`;
  try {
    await fs.promises.writeFile(
      tmpPath,
      JSON.stringify(settings, null, 2) + '\n',
      'utf-8',
    );
    await fs.promises.rename(tmpPath, settingsPath);
  } catch (err) {
    try { await fs.promises.unlink(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}
