/**
 * Conductor — Approval Panel (TreeDataProvider).
 *
 * Renders pending and recently resolved approvals in the Conductor
 * sidebar.  Each pending approval shows session name, tool, command,
 * waiting duration, and inline Approve/Deny buttons.  Expandable
 * context shows full agent output.
 *
 * PRD v1.1 §4a — Approval card spec.
 */

import * as vscode from 'vscode';
import type { PendingApproval } from '../types';
import type { ApprovalEngine } from '../core/ApprovalEngine';
import { CommandId, ViewId } from '../constants';

// ── Tree item types ─────────────────────────────────────────

type ApprovalTreeElement =
  | SectionHeaderItem
  | ApprovalTreeItem
  | ApprovalDetailItem
  | EmptyItem;

// ── Section headers ─────────────────────────────────────────

class SectionHeaderItem extends vscode.TreeItem {
  readonly section: 'pending' | 'history';

  constructor(section: 'pending' | 'history', count: number) {
    const label = section === 'pending'
      ? `Pending Approvals (${count})`
      : `Recent Approvals (${count})`;

    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.section = section;
    this.contextValue = `approval-section-${section}`;
    this.iconPath = new vscode.ThemeIcon(
      section === 'pending' ? 'bell-dot' : 'history',
      section === 'pending'
        ? new vscode.ThemeColor('charts.yellow')
        : new vscode.ThemeColor('charts.blue'),
    );
  }
}

// ── Pending approval item ───────────────────────────────────

class ApprovalTreeItem extends vscode.TreeItem {
  readonly approval: PendingApproval;

  constructor(approval: PendingApproval) {
    const label = `${approval.sessionName}: ${approval.tool}`;
    const hasContext = approval.context && approval.context.length > 0;

    super(
      label,
      hasContext
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );

    this.approval = approval;
    this.description = approval.status === 'pending'
      ? `${truncate(approval.command, 60)} — ${formatWaitingDuration(approval.timestamp)}`
      : `${approval.status === 'approved' ? '✅' : '❌'} ${truncate(approval.command, 50)}`;

    this.tooltip = this.buildTooltip();

    if (approval.status === 'pending') {
      this.iconPath = new vscode.ThemeIcon(
        'warning',
        new vscode.ThemeColor('charts.yellow'),
      );
      this.contextValue = 'approval-pending';
    } else {
      this.iconPath = new vscode.ThemeIcon(
        approval.status === 'approved' ? 'check' : 'close',
        approval.status === 'approved'
          ? new vscode.ThemeColor('charts.green')
          : new vscode.ThemeColor('charts.red'),
      );
      this.contextValue = 'approval-resolved';
    }
  }

  private buildTooltip(): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${this.approval.sessionName}**\n\n`);
    md.appendMarkdown(`Tool: \`${this.approval.tool}\`\n\n`);
    md.appendMarkdown(`Command: \`${this.approval.command}\`\n\n`);
    md.appendMarkdown(`Status: ${this.approval.status}\n\n`);
    md.appendMarkdown(`Time: ${new Date(this.approval.timestamp).toLocaleTimeString()}\n\n`);

    if (this.approval.context) {
      md.appendMarkdown(`---\n\n`);
      md.appendMarkdown(`**Context:**\n\n${this.approval.context}`);
    }

    return md;
  }
}

// ── Detail item (expanded context) ──────────────────────────

class ApprovalDetailItem extends vscode.TreeItem {
  constructor(text: string) {
    super(text, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'approval-detail';
    this.iconPath = new vscode.ThemeIcon('info');
  }
}

// ── Empty state ─────────────────────────────────────────────

class EmptyItem extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'approval-empty';
  }
}

// ── TreeDataProvider ────────────────────────────────────────

export class ApprovalPanelProvider implements vscode.TreeDataProvider<ApprovalTreeElement> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<ApprovalTreeElement | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly approvalEngine: ApprovalEngine) {
    // Auto-refresh when approval events fire
    this.disposables.push(
      approvalEngine.onApprovalEvent(() => {
        this._onDidChangeTreeData.fire(undefined);
      }),
    );
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: ApprovalTreeElement): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ApprovalTreeElement): ApprovalTreeElement[] {
    if (!element) {
      return this.getRootChildren();
    }

    if (element instanceof SectionHeaderItem) {
      return this.getSectionChildren(element.section);
    }

    if (element instanceof ApprovalTreeItem && element.approval.context) {
      return this.getApprovalDetails(element.approval);
    }

    return [];
  }

  private getRootChildren(): ApprovalTreeElement[] {
    const pending = this.approvalEngine.getPendingApprovals();
    const history = this.approvalEngine.getHistory();

    const items: ApprovalTreeElement[] = [];

    items.push(new SectionHeaderItem('pending', pending.length));

    if (history.length > 0) {
      items.push(new SectionHeaderItem('history', history.length));
    }

    return items;
  }

  private getSectionChildren(section: 'pending' | 'history'): ApprovalTreeElement[] {
    if (section === 'pending') {
      const pending = this.approvalEngine.getPendingApprovals();
      if (pending.length === 0) {
        return [new EmptyItem('No pending approvals')];
      }
      return pending.map((a) => new ApprovalTreeItem(a));
    }

    const history = this.approvalEngine.getHistory();
    if (history.length === 0) {
      return [new EmptyItem('No recent approvals')];
    }
    return history.map((a) => new ApprovalTreeItem(a));
  }

  private getApprovalDetails(approval: PendingApproval): ApprovalTreeElement[] {
    if (!approval.context) { return []; }

    // Split context into lines, max 5 lines
    const lines = approval.context.split('\n').slice(0, 5);
    return lines.map((line) => new ApprovalDetailItem(truncate(line, 80)));
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

// ── Registration ────────────────────────────────────────────

/**
 * Register the approval panel tree view and approval commands.
 */
export function registerApprovalPanel(
  context: vscode.ExtensionContext,
  approvalEngine: ApprovalEngine,
): ApprovalPanelProvider {
  const provider = new ApprovalPanelProvider(approvalEngine);

  const treeView = vscode.window.createTreeView(ViewId.Approvals, {
    treeDataProvider: provider,
    showCollapseAll: true,
  });

  // Register approval commands
  context.subscriptions.push(
    vscode.commands.registerCommand(
      CommandId.ApproveAction,
      async (approvalIdOrItem?: string | ApprovalTreeItem) => {
        const approvalId = resolveApprovalId(approvalIdOrItem, approvalEngine);
        if (approvalId) {
          await approvalEngine.approveAction(approvalId);
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      CommandId.DenyAction,
      async (approvalIdOrItem?: string | ApprovalTreeItem) => {
        const approvalId = resolveApprovalId(approvalIdOrItem, approvalEngine);
        if (approvalId) {
          await approvalEngine.denyAction(approvalId);
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(CommandId.ApproveAll, async () => {
      const pending = approvalEngine.getPendingApprovals();
      if (pending.length === 0) { return; }

      const detail = pending
        .map((a) => `• ${a.sessionName}: ${a.tool} — ${truncate(a.command, 60)}`)
        .join('\n');

      const confirm = await vscode.window.showWarningMessage(
        `Approve all ${pending.length} pending actions?`,
        { detail, modal: true },
        'Approve All',
      );

      if (confirm === 'Approve All') {
        await approvalEngine.approveAll();
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(CommandId.DenyAll, async () => {
      const pending = approvalEngine.getPendingApprovals();
      if (pending.length === 0) { return; }

      const confirm = await vscode.window.showWarningMessage(
        `Deny all ${pending.length} pending actions?`,
        { modal: true },
        'Deny All',
      );

      if (confirm === 'Deny All') {
        await approvalEngine.denyAll();
      }
    }),
  );

  context.subscriptions.push(treeView, provider);
  return provider;
}

// ── Helpers ─────────────────────────────────────────────────

/**
 * Resolve the approval ID from a command argument.
 * Called from keybinding (no arg → oldest pending) or from tree item click.
 */
function resolveApprovalId(
  arg: string | ApprovalTreeItem | undefined,
  engine: ApprovalEngine,
): string | undefined {
  if (typeof arg === 'string') {
    return arg;
  }
  if (arg instanceof ApprovalTreeItem) {
    return arg.approval.id;
  }
  // No argument → approve/deny the oldest pending
  const pending = engine.getPendingApprovals();
  return pending[0]?.id;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) { return text; }
  return text.slice(0, maxLen - 3) + '...';
}

function formatWaitingDuration(timestamp: string): string {
  const ms = Date.now() - new Date(timestamp).getTime();
  if (ms < 0) { return 'just now'; }

  const seconds = Math.floor(ms / 1_000);
  if (seconds < 60) { return `${seconds}s ago`; }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) { return `${minutes}m ${seconds % 60}s ago`; }

  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}
