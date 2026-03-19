/**
 * Conductor — Terminal abstraction layer.
 *
 * Provides a unified API for creating, focusing, and sending text to
 * terminals regardless of whether the backing implementation is a
 * VS Code integrated terminal or a tmux session.
 *
 * PRD v1.1 §5.1 — TerminalManager (VS Code + tmux).
 */

import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { TerminalType } from '../constants';

const execAsync = promisify(exec);

const TMUX_SESSION_PREFIX = 'conductor-';

// ── Public API ──────────────────────────────────────────────────

export interface ConductorTerminal {
  id: string;
  type: TerminalType;
  /** Focus / bring to front */
  show(): void;
  /** Send text (followed by Enter unless suppressNewline is true) */
  sendText(text: string, suppressNewline?: boolean): void;
  /** Dispose / kill the terminal */
  dispose(): void;
  /** The underlying VS Code terminal, if applicable */
  vscodeTerminal: vscode.Terminal | null;
}

/**
 * Create a new terminal for a Conductor session.
 *
 * @param name   Human-readable name shown in the terminal tab
 * @param type   'vscode' or 'tmux'
 * @param cwd    Working directory for the terminal
 * @param env    Optional environment variables
 */
export async function createTerminal(
  name: string,
  type: TerminalType,
  cwd: string,
  env?: Record<string, string>,
): Promise<ConductorTerminal> {
  if (type === 'tmux') {
    return createTmuxTerminal(name, cwd, env);
  }
  return createVscodeTerminal(name, cwd, env);
}

/**
 * Find an existing VS Code terminal by name.
 */
export function findVscodeTerminal(name: string): vscode.Terminal | undefined {
  return vscode.window.terminals.find(t => t.name === name);
}

/**
 * Focus a VS Code terminal by instance reference.
 */
export function focusTerminal(terminal: vscode.Terminal): void {
  terminal.show(/* preserveFocus */ false);
}

// ── VS Code terminal implementation ─────────────────────────────

function createVscodeTerminal(
  name: string,
  cwd: string,
  env?: Record<string, string>,
): ConductorTerminal {
  const terminal = vscode.window.createTerminal({
    name,
    cwd,
    env,
  });

  const id = name; // VS Code doesn't expose a stable terminal ID

  return {
    id,
    type: 'vscode',
    vscodeTerminal: terminal,
    show() {
      terminal.show(false);
    },
    sendText(text: string, suppressNewline?: boolean) {
      terminal.sendText(text, !suppressNewline);
    },
    dispose() {
      terminal.dispose();
    },
  };
}

// ── tmux terminal implementation ────────────────────────────────

async function createTmuxTerminal(
  name: string,
  cwd: string,
  env?: Record<string, string>,
): Promise<ConductorTerminal> {
  const sessionName = `${TMUX_SESSION_PREFIX}${name}`;

  // Build env export prefix for the tmux session
  const envPrefix = env
    ? Object.entries(env)
      .map(([k, v]) => `export ${k}=${escapeShellArg(v)};`)
      .join(' ')
    : '';

  // Create a detached tmux session
  const startCmd = envPrefix
    ? `tmux new-session -d -s ${escapeShellArg(sessionName)} -c ${escapeShellArg(cwd)} "${envPrefix} $SHELL"`
    : `tmux new-session -d -s ${escapeShellArg(sessionName)} -c ${escapeShellArg(cwd)}`;

  await execAsync(startCmd);

  return {
    id: sessionName,
    type: 'tmux',
    vscodeTerminal: null,
    show() {
      // Open a VS Code terminal that attaches to the tmux session
      const attachTerminal = vscode.window.createTerminal({
        name: `tmux: ${name}`,
        shellPath: 'tmux',
        shellArgs: ['attach-session', '-t', sessionName],
      });
      attachTerminal.show(false);
    },
    sendText(text: string, suppressNewline?: boolean) {
      const suffix = suppressNewline ? '' : ' Enter';
      const cmd = `tmux send-keys -t ${escapeShellArg(sessionName)} ${escapeShellArg(text)}${suffix}`;
      execAsync(cmd).catch(() => { /* best-effort */ });
    },
    dispose() {
      execAsync(`tmux kill-session -t ${escapeShellArg(sessionName)}`).catch(() => { /* ignore */ });
    },
  };
}

/**
 * List running tmux sessions that belong to Conductor.
 */
export async function listConductorTmuxSessions(): Promise<string[]> {
  try {
    const { stdout } = await execAsync('tmux list-sessions -F "#{session_name}"');
    return stdout
      .trim()
      .split('\n')
      .filter(s => s.startsWith(TMUX_SESSION_PREFIX));
  } catch {
    return [];
  }
}

// ── Helpers ─────────────────────────────────────────────────────

function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
