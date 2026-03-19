/**
 * Conductor — Dependency Tree View (TreeDataProvider).
 *
 * Renders the dependency DAG as a compact hierarchical tree in the
 * sidebar.  Root nodes are prompts/sessions with no dependencies;
 * children are prompts that depend on the parent.  Color-coded by
 * status with a chain status summary at the top.
 *
 * PRD v1.1 §4e, Implementation Plan §6 Task 3.4
 */

import * as vscode from 'vscode';
import type { QueuedPrompt } from '../types';
import type { SessionManager } from '../core/SessionManager';
import type { QueueManager } from '../core/QueueManager';
import type { DependencyEngine, ChainStatus } from '../core/DependencyEngine';
import { CommandId, ViewId } from '../constants';

// ── Status display ──────────────────────────────────────────────

interface DepNodeDisplay {
  icon: string;
  color: vscode.ThemeColor;
  label: string;
}

function getPromptDisplay(prompt: QueuedPrompt, sessionManager: SessionManager): DepNodeDisplay {
  if (prompt.status === 'launched' && prompt.sessionId) {
    const session = sessionManager.getSession(prompt.sessionId);
    switch (session?.status) {
      case 'complete':
        return { icon: 'pass-filled', color: new vscode.ThemeColor('charts.green'), label: 'Complete' };
      case 'running':
      case 'waiting':
        return { icon: 'sync~spin', color: new vscode.ThemeColor('charts.yellow'), label: 'Running' };
      case 'error':
        return { icon: 'error', color: new vscode.ThemeColor('charts.red'), label: 'Error' };
      case 'blocked':
        return { icon: 'warning', color: new vscode.ThemeColor('charts.orange'), label: 'Blocked' };
      default:
        return { icon: 'play-circle', color: new vscode.ThemeColor('charts.green'), label: 'Launched' };
    }
  }

  if (prompt.status === 'cancelled') {
    return { icon: 'circle-slash', color: new vscode.ThemeColor('charts.red'), label: 'Blocked' };
  }

  return { icon: 'circle-outline', color: new vscode.ThemeColor('charts.blue'), label: 'Queued' };
}

// ── Tree item types ─────────────────────────────────────────────

type DepTreeElement = ChainSummaryItem | DepNodeItem | EmptyItem;

// ── Chain summary ───────────────────────────────────────────────

class ChainSummaryItem extends vscode.TreeItem {
  constructor(status: ChainStatus) {
    const parts: string[] = [];
    if (status.complete > 0) { parts.push(`${status.complete} complete`); }
    if (status.running > 0) { parts.push(`${status.running} running`); }
    if (status.queued > 0) { parts.push(`${status.queued} queued`); }
    if (status.failed > 0) { parts.push(`${status.failed} failed`); }
    if (status.blocked > 0) { parts.push(`${status.blocked} blocked`); }

    const label = status.total === 0
      ? 'No dependency chains'
      : `Chain: ${parts.join(', ')}`;

    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'dep-summary';
    this.description = status.total > 0 ? `${status.complete}/${status.total}` : '';
  }
}

// ── Dependency node ─────────────────────────────────────────────

class DepNodeItem extends vscode.TreeItem {
  readonly prompt: QueuedPrompt;

  constructor(
    prompt: QueuedPrompt,
    hasChildren: boolean,
    display: DepNodeDisplay,
  ) {
    super(
      prompt.name,
      hasChildren
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );

    this.prompt = prompt;
    this.description = display.label;
    this.iconPath = new vscode.ThemeIcon(
      display.icon.replace('~spin', ''),
      display.color,
    );

    this.tooltip = new vscode.MarkdownString(
      `**${prompt.name}**\n\nStatus: ${display.label}\n\n` +
      (prompt.dependsOn.length > 0 ? `Dependencies: ${prompt.dependsOn.length} upstream\n\n` : '') +
      (prompt.prompt ? `Prompt: ${prompt.prompt.slice(0, 200)}...` : ''),
    );

    // Click → jump to session or edit prompt
    if (prompt.sessionId) {
      this.command = {
        command: CommandId.JumpToSession,
        title: 'Jump to Session',
        arguments: [prompt.sessionId],
      };
    } else {
      this.command = {
        command: CommandId.EditPrompt,
        title: 'Edit Prompt',
        arguments: [prompt.id],
      };
    }

    this.contextValue = prompt.sessionId ? 'dep-node-session' : 'dep-node-prompt';
  }
}

// ── Empty state ─────────────────────────────────────────────────

class EmptyItem extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'dep-empty';
  }
}

// ── TreeDataProvider ────────────────────────────────────────────

export class DependencyTreeProvider implements vscode.TreeDataProvider<DepTreeElement> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<DepTreeElement | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly queueManager: QueueManager,
    private readonly dependencyEngine: DependencyEngine,
  ) {
    // Auto-refresh on queue and session events
    this.disposables.push(
      queueManager.onQueueEvent(() => this._onDidChangeTreeData.fire(undefined)),
      sessionManager.onSessionEvent(() => this._onDidChangeTreeData.fire(undefined)),
      dependencyEngine.onDependencyEvent(() => this._onDidChangeTreeData.fire(undefined)),
    );
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: DepTreeElement): vscode.TreeItem {
    return element;
  }

  getChildren(element?: DepTreeElement): DepTreeElement[] {
    if (!element) {
      return this.getRootChildren();
    }

    if (element instanceof DepNodeItem) {
      return this.getNodeChildren(element.prompt);
    }

    return [];
  }

  private getRootChildren(): DepTreeElement[] {
    const allPrompts = this.queueManager.getQueue();
    const chainStatus = this.dependencyEngine.getChainStatus();

    const items: DepTreeElement[] = [
      new ChainSummaryItem(chainStatus),
    ];

    if (chainStatus.total === 0) {
      items.push(new EmptyItem('Define dependencies between prompts to build chains'));
      return items;
    }

    // Root nodes: prompts with no dependencies (or dependencies outside the queue)
    const rootPrompts = allPrompts.filter(p => {
      if (p.dependsOn.length === 0) {
        // Only show as root if something depends on it
        return this.dependencyEngine.getDependents(p.id).length > 0;
      }
      return false;
    });

    for (const prompt of rootPrompts) {
      const dependents = this.dependencyEngine.getDependents(prompt.id);
      const display = getPromptDisplay(prompt, this.sessionManager);
      items.push(new DepNodeItem(prompt, dependents.length > 0, display));
    }

    return items;
  }

  private getNodeChildren(parent: QueuedPrompt): DepTreeElement[] {
    const dependents = this.dependencyEngine.getDependents(parent.id);
    if (dependents.length === 0) { return []; }

    return dependents.map(dep => {
      const children = this.dependencyEngine.getDependents(dep.id);
      const display = getPromptDisplay(dep, this.sessionManager);
      return new DepNodeItem(dep, children.length > 0, display);
    });
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

// ── Registration ────────────────────────────────────────────────

export function registerDependencyTreeView(
  context: vscode.ExtensionContext,
  sessionManager: SessionManager,
  queueManager: QueueManager,
  dependencyEngine: DependencyEngine,
): DependencyTreeProvider {
  const provider = new DependencyTreeProvider(sessionManager, queueManager, dependencyEngine);

  const treeView = vscode.window.createTreeView(ViewId.Dependencies, {
    treeDataProvider: provider,
    showCollapseAll: true,
  });

  context.subscriptions.push(treeView, provider);
  return provider;
}
