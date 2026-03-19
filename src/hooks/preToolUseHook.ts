/**
 * Conductor — PreToolUse hook module.
 *
 * Provides the path to the hook script and utilities for reading
 * hook-generated approval files.  The actual hook script is a
 * standalone Node.js file at hooks/conductor-pre-tool-use.js that
 * Claude Code executes as a subprocess.
 *
 * PRD v1.1 §4a, §5.2
 */

import * as path from 'path';
import { getHooksDir } from '../storage/paths';

/** Filename of the hook script (same in source and installed location). */
export const HOOK_SCRIPT_NAME = 'conductor-pre-tool-use.js';

/**
 * Return the path to the bundled hook script in the extension.
 * This is the source copy that gets installed to ~/.conductor/hooks/.
 */
export function getBundledHookPath(extensionPath: string): string {
  return path.join(extensionPath, 'hooks', HOOK_SCRIPT_NAME);
}

/**
 * Return the installed hook script path (~/.conductor/hooks/).
 */
export function getInstalledHookPath(): string {
  return path.join(getHooksDir(), HOOK_SCRIPT_NAME);
}

/**
 * Build the hook command string for Claude Code's settings.
 * This is the value written to the hooks[] array in .claude/settings.json.
 */
export function buildHookCommand(sessionId: string, sessionName: string): {
  type: 'command';
  event: 'PreToolUse';
  command: string;
} {
  const hookPath = getInstalledHookPath();
  return {
    type: 'command',
    event: 'PreToolUse',
    command: `CONDUCTOR_SESSION_ID="${sessionId}" CONDUCTOR_SESSION_NAME="${sessionName}" node "${hookPath}"`,
  };
}
