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
import { registerApprovalPanel } from './views/ApprovalPanel';
import { ApprovalNotifier } from './views/ApprovalNotifier';
import { ApprovalEngine } from './core/ApprovalEngine';
import { LayoutManager } from './views/LayoutManager';
import { SetupWizard } from './views/SetupWizard';
import { providerDataExists } from './providers/ProviderPaths';
import { ContextKey, StateKey, CommandId } from './constants';

let sessionManager: SessionManager | undefined;
let layoutManager: LayoutManager | undefined;
let approvalEngine: ApprovalEngine | undefined;

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
  claudeAdapter.extensionPath = context.extensionPath;
  registerProvider(claudeAdapter);

  // ── Session manager ─────────────────────────────────────────
  sessionManager = new SessionManager();
  context.subscriptions.push(sessionManager);
  await sessionManager.initialise();

  // ── Approval engine ─────────────────────────────────────────
  approvalEngine = new ApprovalEngine();
  context.subscriptions.push(approvalEngine);
  await approvalEngine.initialise();

  // Auto-dismiss approvals when sessions complete or error
  context.subscriptions.push(
    sessionManager.onSessionEvent((event) => {
      if (event.type === 'completed' || event.type === 'error' || event.type === 'killed') {
        approvalEngine?.dismissSessionApprovals(event.sessionId);
      }
    }),
  );

  // ── Views ───────────────────────────────────────────────────
  registerStatusBoard(context, sessionManager);
  const { treeView: approvalTreeView } = registerApprovalPanel(context, approvalEngine);

  // ── Approval notifications (badge + toast) ──────────────────
  const approvalNotifier = new ApprovalNotifier(approvalEngine, approvalTreeView);
  context.subscriptions.push(approvalNotifier);

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

  // ── Setup wizard ─────────────────────────────────────────────
  const wizard = new SetupWizard(context, layoutManager);
  context.subscriptions.push(wizard);
  context.subscriptions.push(
    vscode.commands.registerCommand(CommandId.ShowSetupWizard, () => {
      wizard.show();
    }),
  );

  const hasCompletedSetup = context.globalState.get<boolean>(StateKey.HasCompletedSetup, false);
  if (!hasCompletedSetup) {
    wizard.show();
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
  approvalEngine = undefined;
}
