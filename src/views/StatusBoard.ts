/**
 * Conductor — Session Status Board (TreeDataProvider).
 *
 * Renders the live session status board in the Conductor sidebar.
 * Each session is a tree item showing name, status icon, duration,
 * and last activity.  Sorted: waiting first, then running, then
 * the rest.
 *
 * PRD v1.1 §4b
 */

import * as vscode from 'vscode';
import type { ConductorSession, SessionStatus } from '../types';
import type { SessionManager } from '../core/SessionManager';
import { CommandId, ViewId } from '../constants';

// ── Status display config ───────────────────────────────────────

interface StatusDisplay {
  icon: string;
  color: vscode.ThemeColor;
  label: string;
  sortOrder: number;
}

const STATUS_MAP: Record<SessionStatus, StatusDisplay> = {
  waiting:  { icon: '$(bell)',          color: new vscode.ThemeColor('charts.yellow'),  label: 'Waiting',  sortOrder: 0 },
  running:  { icon: '$(sync~spin)',     color: new vscode.ThemeColor('charts.green'),   label: 'Running',  sortOrder: 1 },
  blocked:  { icon: '$(warning)',       color: new vscode.ThemeColor('charts.orange'),  label: 'Blocked',  sortOrder: 2 },
  error:    { icon: '$(error)',         color: new vscode.ThemeColor('charts.red'),     label: 'Error',    sortOrder: 3 },
  queued:   { icon: '$(clock)',         color: new vscode.ThemeColor('charts.blue'),    label: 'Queued',   sortOrder: 4 },
  complete: { icon: '$(check)',         color: new vscode.ThemeColor('charts.blue'),    label: 'Complete', sortOrder: 5 },
};

// ── Tree items ──────────────────────────────────────────────────

export class SessionTreeItem extends vscode.TreeItem {
  constructor(
    public readonly session: ConductorSession,
  ) {
    super(session.name, vscode.TreeItemCollapsibleState.None);

    const display = STATUS_MAP[session.status];
    this.description = `${display.label} — ${formatDuration(session)}`;
    this.tooltip = this.buildTooltip(session, display);
    this.iconPath = new vscode.ThemeIcon(
      display.icon.replace('$(', '').replace(')', '').replace('~spin', ''),
      display.color,
    );

    // Click → open interaction panel
    this.command = {
      command: CommandId.OpenInteraction,
      title: 'Open Session Interaction',
      arguments: [session.id],
    };

    this.contextValue = `session-${session.status}`;
  }

  private buildTooltip(session: ConductorSession, display: StatusDisplay): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${session.name}**\n\n`);
    md.appendMarkdown(`Status: ${display.icon} ${display.label}\n\n`);
    md.appendMarkdown(`Provider: ${session.providerId}\n\n`);

    if (session.launchedAt) {
      md.appendMarkdown(`Started: ${new Date(session.launchedAt).toLocaleTimeString()}\n\n`);
    }

    if (session.prompt) {
      const truncated = session.prompt.length > 200
        ? session.prompt.slice(0, 197) + '...'
        : session.prompt;
      md.appendMarkdown(`Prompt: ${truncated}\n\n`);
    }

    if (!session.hookInstalled) {
      md.appendMarkdown(`*Not managed — hooks not installed*\n\n`);
    }

    return md;
  }
}

// ── Summary tree item ───────────────────────────────────────────

class SummaryTreeItem extends vscode.TreeItem {
  constructor(sessions: ConductorSession[]) {
    const counts = buildStatusCounts(sessions);
    const summaryParts: string[] = [];
    if (counts.running > 0)  { summaryParts.push(`${counts.running} running`); }
    if (counts.waiting > 0)  { summaryParts.push(`${counts.waiting} waiting`); }
    if (counts.blocked > 0)  { summaryParts.push(`${counts.blocked} blocked`); }
    if (counts.queued > 0)   { summaryParts.push(`${counts.queued} queued`); }
    if (counts.complete > 0) { summaryParts.push(`${counts.complete} complete`); }
    if (counts.error > 0)    { summaryParts.push(`${counts.error} error`); }

    const label = sessions.length === 0
      ? 'No sessions'
      : `${sessions.length} sessions: ${summaryParts.join(', ')}`;

    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = '';
    this.contextValue = 'session-summary';
  }
}

// ── TreeDataProvider ────────────────────────────────────────────

export class StatusBoardProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private disposables: vscode.Disposable[] = [];

  constructor(private readonly sessionManager: SessionManager) {
    // Auto-refresh when session events fire
    this.disposables.push(
      sessionManager.onSessionEvent(() => {
        this._onDidChangeTreeData.fire(undefined);
      }),
    );
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(_element?: vscode.TreeItem): vscode.TreeItem[] {
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspacePath) {
      return [new vscode.TreeItem('Open a workspace to see sessions')];
    }

    const sessions = this.sessionManager.getSessionsByWorkspace(workspacePath);

    if (sessions.length === 0) {
      return [new vscode.TreeItem('No sessions detected')];
    }

    // Sort: waiting first (needs attention), then running, etc.
    const sorted = [...sessions].sort((a, b) => {
      const orderA = STATUS_MAP[a.status]?.sortOrder ?? 99;
      const orderB = STATUS_MAP[b.status]?.sortOrder ?? 99;
      return orderA - orderB;
    });

    const items: vscode.TreeItem[] = [
      new SummaryTreeItem(sessions),
      ...sorted.map(s => new SessionTreeItem(s)),
    ];

    return items;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

/**
 * Register the status board tree view.
 */
export function registerStatusBoard(
  context: vscode.ExtensionContext,
  sessionManager: SessionManager,
): StatusBoardProvider {
  const provider = new StatusBoardProvider(sessionManager);
  const treeView = vscode.window.createTreeView(ViewId.Sessions, {
    treeDataProvider: provider,
    showCollapseAll: false,
  });
  context.subscriptions.push(treeView, provider);
  return provider;
}

// ── Helpers ─────────────────────────────────────────────────────

function formatDuration(session: ConductorSession): string {
  const start = session.launchedAt ?? session.createdAt;
  const end = session.completedAt ?? new Date().toISOString();

  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 0) { return '0s'; }

  const seconds = Math.floor(ms / 1_000);
  if (seconds < 60) { return `${seconds}s`; }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) { return `${minutes}m ${seconds % 60}s`; }

  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function buildStatusCounts(sessions: ConductorSession[]): Record<SessionStatus, number> {
  const counts: Record<string, number> = {
    queued: 0, running: 0, waiting: 0, complete: 0, error: 0, blocked: 0,
  };
  for (const s of sessions) {
    counts[s.status] = (counts[s.status] ?? 0) + 1;
  }
  return counts as Record<SessionStatus, number>;
}
