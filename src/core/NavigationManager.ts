/**
 * Conductor — Click-to-jump navigation.
 *
 * Registers the JumpToSession command and resolves a session ID
 * to its underlying terminal (VS Code integrated or tmux), then
 * focuses it.
 *
 * PRD v1.1 §4b — "Clicking a session card focuses the VS Code
 * terminal running that session."
 */

import * as vscode from 'vscode';
import type { SessionManager } from './SessionManager';
import { requireProvider } from '../providers';
import { findVscodeTerminal, focusTerminal } from '../platform/TerminalManager';
import { CommandId } from '../constants';

/**
 * Register the jump-to-session command and related navigation helpers.
 */
export function registerNavigationCommands(
  context: vscode.ExtensionContext,
  sessionManager: SessionManager,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      CommandId.JumpToSession,
      async (sessionId: string) => {
        await jumpToSession(sessionManager, sessionId);
      },
    ),
  );
}

/**
 * Focus the terminal associated with the given session.
 *
 * Resolution order:
 * 1. Ask the provider adapter for the terminal instance.
 * 2. Search VS Code terminals by session name.
 * 3. Show an info message if no terminal is found.
 */
async function jumpToSession(
  sessionManager: SessionManager,
  sessionId: string,
): Promise<void> {
  const session = sessionManager.getSession(sessionId);
  if (!session) {
    vscode.window.showWarningMessage(`Session not found: ${sessionId}`);
    return;
  }

  // 1. Try the provider adapter
  try {
    const provider = requireProvider(session.providerId);
    const terminal = provider.getTerminal(sessionId);
    if (terminal) {
      terminal.show(/* preserveFocus */ false);
      return;
    }
  } catch {
    // Provider not registered or getTerminal failed — fall through
  }

  // 2. Search by session name in VS Code terminals
  const namedTerminal = findVscodeTerminal(session.name);
  if (namedTerminal) {
    focusTerminal(namedTerminal);
    return;
  }

  // 3. No terminal found
  vscode.window.showInformationMessage(
    `No terminal found for "${session.name}". The session may have been started outside VS Code.`,
  );
}
