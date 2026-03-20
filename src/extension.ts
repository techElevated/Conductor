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
import { QueueManager } from './core/QueueManager';
import { DependencyEngine } from './core/DependencyEngine';
import { TaskFeedback } from './core/TaskFeedback';
import { TaskDetector } from './core/TaskDetector';
import { TemplateManager } from './core/TemplateManager';
import { registerPromptQueue } from './views/PromptQueue';
import { registerDependencyTreeView } from './views/DependencyTreeView';
import { TaskInboxProvider } from './views/TaskInbox';
import { TemplateLibraryProvider } from './views/TemplateLibrary';
import { LayoutManager } from './views/LayoutManager';
import { SetupWizard } from './views/SetupWizard';
import { providerDataExists } from './providers/ProviderPaths';
import { ContextKey, StateKey, CommandId, ViewId } from './constants';

let sessionManager: SessionManager | undefined;
let layoutManager: LayoutManager | undefined;
let approvalEngine: ApprovalEngine | undefined;
let queueManager: QueueManager | undefined;
let dependencyEngine: DependencyEngine | undefined;
let taskDetector: TaskDetector | undefined;
let templateManager: TemplateManager | undefined;

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

  const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

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

  // ── Queue manager + dependency engine (Sprint 3) ─────────────
  queueManager = new QueueManager(wsPath ?? '', sessionManager);
  context.subscriptions.push(queueManager);
  await queueManager.initialise();

  dependencyEngine = new DependencyEngine(sessionManager, queueManager);
  context.subscriptions.push(dependencyEngine);
  await dependencyEngine.initialise();

  // ── Task feedback + detector (Sprint 4) ─────────────────────
  const taskFeedback = new TaskFeedback();
  await taskFeedback.initialise();

  taskDetector = new TaskDetector(wsPath ?? '', sessionManager, taskFeedback);
  context.subscriptions.push(taskDetector);
  await taskDetector.initialise();

  // ── Template manager (Sprint 4) ──────────────────────────────
  templateManager = new TemplateManager(wsPath ?? '', queueManager, dependencyEngine);
  context.subscriptions.push(templateManager);
  await templateManager.initialise();

  // ── Views ───────────────────────────────────────────────────
  registerStatusBoard(context, sessionManager);
  const { treeView: approvalTreeView } = registerApprovalPanel(context, approvalEngine);

  // ── Approval notifications (badge + toast) ──────────────────
  const approvalNotifier = new ApprovalNotifier(approvalEngine, approvalTreeView);
  context.subscriptions.push(approvalNotifier);

  // ── Sprint 3 views ───────────────────────────────────────────
  registerPromptQueue(context, queueManager);
  registerDependencyTreeView(context, sessionManager, queueManager, dependencyEngine);

  // ── Sprint 4 views ───────────────────────────────────────────
  const taskInboxProvider = new TaskInboxProvider(taskDetector, taskFeedback);
  context.subscriptions.push(taskInboxProvider);
  const taskInboxView = vscode.window.createTreeView(ViewId.TaskInbox, {
    treeDataProvider: taskInboxProvider,
    showCollapseAll: true,
    manageCheckboxStateManually: true,
  });
  context.subscriptions.push(taskInboxView);
  taskInboxProvider.registerCommands(context);
  taskInboxProvider.registerCheckboxHandler(taskInboxView);

  const templateLibraryProvider = new TemplateLibraryProvider(templateManager);
  context.subscriptions.push(templateLibraryProvider);
  const templateLibraryView = vscode.window.createTreeView(ViewId.Templates, {
    treeDataProvider: templateLibraryProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(templateLibraryView);
  templateLibraryProvider.registerCommands(context);

  // ── Commands ────────────────────────────────────────────────
  registerNavigationCommands(context, sessionManager);

  context.subscriptions.push(
    vscode.commands.registerCommand(CommandId.RefreshAll, () => {
      const currentWsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (currentWsPath) {
        sessionManager?.refreshSessions(currentWsPath);
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
  queueManager = undefined;
  dependencyEngine = undefined;
  taskDetector = undefined;
  templateManager = undefined;
}
