/**
 * Conductor — Task Inbox (TreeDataProvider).
 *
 * Renders human tasks detected from session output.  Tasks are split
 * into a "Pending" section (default expanded) and a "Completed"
 * section (default collapsed).  Blocking tasks show a ⛔ indicator.
 * Each task has inline 👍 👎 ❌ feedback buttons via contextValue.
 *
 * PRD v1.1 §4d, Implementation Plan §7 Task 4.4
 */

import * as vscode from 'vscode';
import type { HumanTask, TaskPriority } from '../types';
import type { TaskDetector } from '../core/TaskDetector';
import type { TaskFeedback } from '../core/TaskFeedback';
import { CommandId } from '../constants';

// ── Tree element union ───────────────────────────────────────────

type TaskTreeElement =
  | SectionHeader
  | TaskTreeItem
  | EmptyItem;

// ── Section header ───────────────────────────────────────────────

class SectionHeader extends vscode.TreeItem {
  readonly section: 'pending' | 'completed';

  constructor(section: 'pending' | 'completed', count: number) {
    const label =
      section === 'pending' ? `Pending (${count})` : `Completed (${count})`;
    super(
      label,
      section === 'pending'
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed,
    );
    this.section = section;
    this.contextValue = `task-section-${section}`;
    this.iconPath = new vscode.ThemeIcon(
      section === 'pending' ? 'tasklist' : 'check-all',
      section === 'pending'
        ? new vscode.ThemeColor('charts.yellow')
        : new vscode.ThemeColor('charts.green'),
    );
  }
}

// ── Task tree item ───────────────────────────────────────────────

class TaskTreeItem extends vscode.TreeItem {
  readonly task: HumanTask;

  constructor(task: HumanTask) {
    const label = (task.blocking ? '⛔ ' : '') + truncate(task.description, 60);
    super(label, vscode.TreeItemCollapsibleState.None);

    this.task = task;
    this.description = `${task.sessionName} · ${formatAge(task.surfacedAt)}`;
    this.tooltip = this.buildTooltip();
    this.iconPath = priorityIcon(task.priority);

    // contextValue drives inline actions in package.json menus
    this.contextValue =
      task.status === 'complete' ? 'task-completed' : 'task-pending';

    if (task.status !== 'complete') {
      this.checkboxState = vscode.TreeItemCheckboxState.Unchecked;
    } else {
      this.checkboxState = vscode.TreeItemCheckboxState.Checked;
    }
  }

  private buildTooltip(): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${this.task.description}**\n\n`);
    md.appendMarkdown(`Session: \`${this.task.sessionName}\`  \n`);
    md.appendMarkdown(`Priority: ${this.task.priority}  \n`);
    if (this.task.blocking) {md.appendMarkdown('⛔ **Blocking** — agent is waiting for this action  \n');}
    md.appendMarkdown(`Captured via: ${this.task.captureMethod}  \n`);
    md.appendMarkdown(`Detected: ${new Date(this.task.surfacedAt).toLocaleString()}  \n`);
    if (this.task.context) {
      md.appendMarkdown(`\n---\n**Context:**\n`);
      md.appendCodeblock(truncate(this.task.context, 400));
    }
    return md;
  }
}

// ── Empty state ──────────────────────────────────────────────────

class EmptyItem extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'task-empty';
    this.iconPath = new vscode.ThemeIcon('inbox');
  }
}

// ── TaskInboxProvider ────────────────────────────────────────────

export class TaskInboxProvider
  implements vscode.TreeDataProvider<TaskTreeElement>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    TaskTreeElement | undefined | null | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly detector: TaskDetector,
    private readonly feedback: TaskFeedback,
  ) {
    this.disposables.push(this._onDidChangeTreeData);

    this.disposables.push(
      detector.onTaskEvent(_ev => {
        this._onDidChangeTreeData.fire();
      }),
    );
  }

  // ── TreeDataProvider ─────────────────────────────────────────

  getTreeItem(element: TaskTreeElement): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TaskTreeElement): TaskTreeElement[] {
    if (!element) {
      return this.buildRoots();
    }

    if (element instanceof SectionHeader) {
      return this.buildSection(element.section);
    }

    return [];
  }

  // ── Root nodes ────────────────────────────────────────────────

  private buildRoots(): TaskTreeElement[] {
    const all = this.detector.getAllTasks();
    const pending = all.filter(t => t.status !== 'complete');
    const completed = all.filter(t => t.status === 'complete');

    if (all.length === 0) {
      return [new EmptyItem('No tasks detected yet')];
    }

    const roots: TaskTreeElement[] = [];
    roots.push(new SectionHeader('pending', pending.length));
    if (completed.length > 0) {
      roots.push(new SectionHeader('completed', completed.length));
    }
    return roots;
  }

  private buildSection(section: 'pending' | 'completed'): TaskTreeElement[] {
    const all = this.detector.getAllTasks();
    const tasks =
      section === 'pending'
        ? all.filter(t => t.status !== 'complete')
        : all.filter(t => t.status === 'complete');

    if (tasks.length === 0) {
      return [new EmptyItem(section === 'pending' ? 'All tasks complete!' : 'No completed tasks')];
    }

    // Sort: blocking first, then by priority, then by surfacedAt
    return tasks
      .sort((a, b) => {
        if (a.blocking !== b.blocking) {return a.blocking ? -1 : 1;}
        const pOrder: TaskPriority[] = ['urgent', 'normal', 'low'];
        const pd = pOrder.indexOf(a.priority) - pOrder.indexOf(b.priority);
        if (pd !== 0) {return pd;}
        return new Date(b.surfacedAt).getTime() - new Date(a.surfacedAt).getTime();
      })
      .map(t => new TaskTreeItem(t));
  }

  // ── Commands ─────────────────────────────────────────────────

  /** Register all task-inbox commands on the extension context. */
  registerCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.commands.registerCommand(CommandId.CompleteTask, async (item: unknown) => {
        const task = (item instanceof TaskTreeItem) ? item.task : undefined;
        if (!task) {return;}
        await this.detector.completeTask(task.id);
        this._onDidChangeTreeData.fire();
      }),

      vscode.commands.registerCommand(CommandId.DismissTask, async (item: unknown) => {
        const task = (item instanceof TaskTreeItem) ? item.task : undefined;
        if (!task) {return;}

        const answer = await vscode.window.showWarningMessage(
          `Dismiss task: "${truncate(task.description, 60)}"?`,
          { modal: false },
          'Dismiss',
          'Mark as false positive',
        );

        if (answer === 'Dismiss') {
          await this.detector.dismissTask(task.id);
        } else if (answer === 'Mark as false positive') {
          await this.detector.dismissTask(task.id);
          await this.feedback.addToIgnoreList(task.captureMethod, task.description);
          vscode.window.showInformationMessage(
            'Conductor: Added to ignore list. Similar tasks won\'t surface again.',
          );
        }

        this._onDidChangeTreeData.fire();
      }),

      vscode.commands.registerCommand(CommandId.AddTask, async () => {
        const description = await vscode.window.showInputBox({
          prompt: 'Describe the human action required',
          placeHolder: 'e.g. Restart the gateway service',
        });
        if (!description) {return;}
        await this.detector.addTask(description);
        this._onDidChangeTreeData.fire();
        vscode.window.showInformationMessage(`Conductor: Task "${description}" captured manually.`);
      }),
    );
  }

  /** Register checkbox change handler for the TreeView. */
  registerCheckboxHandler(treeView: vscode.TreeView<TaskTreeElement>): void {
    this.disposables.push(
      treeView.onDidChangeCheckboxState(async e => {
        for (const [item, state] of e.items) {
          if (!(item instanceof TaskTreeItem)) {continue;}
          if (state === vscode.TreeItemCheckboxState.Checked) {
            await this.detector.completeTask(item.task.id);
          }
        }
        this._onDidChangeTreeData.fire();
      }),
    );
  }

  // ── Refresh ───────────────────────────────────────────────────

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  // ── Title badge ───────────────────────────────────────────────

  /** Returns the number of pending tasks for the panel title badge. */
  get pendingCount(): number {
    return this.detector.getPendingTasks().length;
  }

  // ── Disposable ────────────────────────────────────────────────

  dispose(): void {
    for (const d of this.disposables) {d.dispose();}
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function formatAge(isoString: string): string {
  const ms = Date.now() - new Date(isoString).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) {return `${s}s ago`;}
  const m = Math.floor(s / 60);
  if (m < 60) {return `${m}m ago`;}
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

function priorityIcon(priority: TaskPriority): vscode.ThemeIcon {
  switch (priority) {
    case 'urgent':
      return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.red'));
    case 'normal':
      return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.yellow'));
    case 'low':
    default:
      return new vscode.ThemeIcon('circle-outline');
  }
}
