/**
 * Conductor — Extension entry point.
 *
 * Bootstraps all subsystems: storage initialisation, provider
 * registration, session manager, layout manager, tree views,
 * commands, and the setup wizard (on first run).
 */

import * as vscode from 'vscode';
import { initConductorDirs } from './storage/FileStore';
import { SessionManager } from './core/SessionManager';
import { registerNavigationCommands } from './core/NavigationManager';
import { ClaudeCodeAdapter } from './providers/ClaudeCodeAdapter';
import { registerProvider, clearProviders } from './providers';
import { registerStatusBoard } from './views/StatusBoard';
import { LayoutManager } from './views/LayoutManager';
import { providerDataExists } from './providers/ProviderPaths';
import { ContextKey, StateKey, CommandId } from './constants';

let sessionManager: SessionManager | undefined;
let layoutManager: LayoutManager | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel('Conductor');
  context.subscriptions.push(outputChannel);
  outputChannel.appendLine('Conductor: activating...');

  try {
    // 1. Ensure ~/.conductor/ directory tree exists
    await initConductorDirs();

    // 2. Check for provider data — stay dormant if nothing found
    const hasClaudeCode = await providerDataExists('claude-code');
    if (!hasClaudeCode) {
      outputChannel.appendLine('Conductor: no Claude Code data found — entering dormant mode');
      vscode.commands.executeCommand('setContext', ContextKey.IsActive, false);
      registerDormantWatcher(context, outputChannel);
      return;
    }

    // 3. Full activation
    await activateFull(context, outputChannel);
  } catch (err) {
    outputChannel.appendLine(`Conductor: activation error — ${err}`);
    vscode.window.showErrorMessage(`Conductor failed to activate: ${err}`);
  }
}

async function activateFull(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  vscode.commands.executeCommand('setContext', ContextKey.IsActive, true);

  // ── Layout manager ──────────────────────────────────────────
  layoutManager = new LayoutManager();
  context.subscriptions.push(layoutManager);

  // ── Register providers ──────────────────────────────────────
  const claudeAdapter = new ClaudeCodeAdapter();
  registerProvider(claudeAdapter);

  // ── Session manager ─────────────────────────────────────────
  sessionManager = new SessionManager();
  context.subscriptions.push(sessionManager);
  await sessionManager.initialise();

  // ── Views ───────────────────────────────────────────────────
  registerStatusBoard(context, sessionManager);

  // ── Commands ────────────────────────────────────────────────
  registerNavigationCommands(context, sessionManager);

  context.subscriptions.push(
    vscode.commands.registerCommand(CommandId.RefreshAll, () => {
      const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (wsPath) {
        sessionManager?.refreshSessions(wsPath);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(CommandId.OpenSettings, () => {
      vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'conductor',
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(CommandId.ChangeLayout, async () => {
      const pick = await vscode.window.showQuickPick(
        [
          { label: 'Split (default)', value: 'split', description: 'Compact sidebar + details in editor' },
          { label: 'Activity Bar Sidebar', value: 'sidebar-left', description: 'All panels in left sidebar' },
          { label: 'Right Sidebar', value: 'sidebar-right', description: 'All panels in secondary sidebar' },
          { label: 'Bottom Panel', value: 'bottom', description: 'All panels in bottom panel' },
        ],
        { placeHolder: 'Choose Conductor layout' },
      );
      if (pick) {
        await layoutManager?.setLayout(pick.value as 'split' | 'sidebar-left' | 'sidebar-right' | 'bottom');
      }
    }),
  );

  // ── First-run wizard check ──────────────────────────────────
  const hasCompletedSetup = context.globalState.get<boolean>(StateKey.HasCompletedSetup, false);
  if (!hasCompletedSetup) {
    context.subscriptions.push(
      vscode.commands.registerCommand(CommandId.ShowSetupWizard, () => {
        // Full wizard implementation in Task 1.15
        vscode.window.showInformationMessage(
          'Welcome to Conductor! Use the command palette to configure your layout.',
          'Configure Layout',
        ).then(selection => {
          if (selection === 'Configure Layout') {
            vscode.commands.executeCommand(CommandId.ChangeLayout);
          }
        });
        context.globalState.update(StateKey.HasCompletedSetup, true);
      }),
    );
    // Trigger wizard on first activation
    vscode.commands.executeCommand(CommandId.ShowSetupWizard);
  }

  // ── Initial session refresh ─────────────────────────────────
  const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (wsPath) {
    sessionManager.refreshSessions(wsPath).catch(() => { /* non-fatal */ });
  }

  outputChannel.appendLine('Conductor: fully activated');
}

/**
 * In dormant mode, watch for the appearance of provider data
 * directories and activate fully when one appears.
 */
function registerDormantWatcher(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
): void {
  // Check every 10 seconds for provider data appearing
  const interval = setInterval(async () => {
    const hasClaudeCode = await providerDataExists('claude-code');
    if (hasClaudeCode) {
      clearInterval(interval);
      outputChannel.appendLine('Conductor: Claude Code data detected — waking up');
      await activateFull(context, outputChannel);
    }
  }, 10_000);

  context.subscriptions.push(new vscode.Disposable(() => clearInterval(interval)));
}

export function deactivate(): void {
  clearProviders();
  sessionManager = undefined;
  layoutManager = undefined;
}
