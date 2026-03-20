/**
 * Conductor — Prompt Queue Panel (TreeDataProvider).
 *
 * Renders the persistent prompt queue in the Conductor sidebar.
 * Each prompt shows name, complexity indicator (S/M/L), parallel-safe
 * flag (🟢/🔴), status icon, and inline actions (Launch, Edit, Delete).
 *
 * PRD v1.1 §4c, Implementation Plan §6 Task 3.2
 */

import * as vscode from 'vscode';
import type { QueuedPrompt, PromptStatus, PromptComplexity } from '../types';
import type { QueueManager } from '../core/QueueManager';
import type { DependencyEngine } from '../core/DependencyEngine';
import { CommandId, ViewId } from '../constants';

// ── Display config ──────────────────────────────────────────────

interface PromptStatusDisplay {
  icon: string;
  color: vscode.ThemeColor;
  label: string;
}

const STATUS_MAP: Record<PromptStatus, PromptStatusDisplay> = {
  queued:    { icon: 'circle-outline',  color: new vscode.ThemeColor('charts.blue'),   label: 'Queued' },
  launched:  { icon: 'play-circle',     color: new vscode.ThemeColor('charts.green'),  label: 'Launched' },
  cancelled: { icon: 'circle-slash',    color: new vscode.ThemeColor('charts.red'),    label: 'Cancelled' },
};

const COMPLEXITY_LABEL: Record<PromptComplexity, string> = {
  small: 'S',
  medium: 'M',
  large: 'L',
};

// ── Tree item types ─────────────────────────────────────────────

type PromptQueueElement =
  | SectionHeaderItem
  | PromptTreeItem
  | EmptyItem;

// ── Section headers ─────────────────────────────────────────────

class SectionHeaderItem extends vscode.TreeItem {
  readonly section: 'queued' | 'launched';

  constructor(section: 'queued' | 'launched', count: number) {
    const label = section === 'queued'
      ? `Queue (${count})`
      : `Launched (${count})`;

    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.section = section;
    this.contextValue = `queue-section-${section}`;
    this.iconPath = new vscode.ThemeIcon(
      section === 'queued' ? 'list-ordered' : 'rocket',
      section === 'queued'
        ? new vscode.ThemeColor('charts.blue')
        : new vscode.ThemeColor('charts.green'),
    );
  }
}

// ── Prompt tree item ────────────────────────────────────────────

class PromptTreeItem extends vscode.TreeItem {
  readonly prompt: QueuedPrompt;

  constructor(prompt: QueuedPrompt) {
    super(prompt.name, vscode.TreeItemCollapsibleState.None);
    this.prompt = prompt;

    const display = STATUS_MAP[prompt.status];
    const safeFlag = prompt.parallelSafe ? '🟢' : '🔴';
    const complexity = COMPLEXITY_LABEL[prompt.complexity];

    this.description = `${complexity} ${safeFlag}`;

    this.tooltip = this.buildTooltip(prompt, display);

    this.iconPath = new vscode.ThemeIcon(display.icon, display.color);

    // Click → edit prompt
    if (prompt.status === 'queued') {
      this.command = {
        command: CommandId.EditPrompt,
        title: 'Edit Prompt',
        arguments: [prompt.id],
      };
    }

    this.contextValue = `prompt-${prompt.status}`;
  }

  private buildTooltip(prompt: QueuedPrompt, display: PromptStatusDisplay): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${prompt.name}**\n\n`);

    if (prompt.description) {
      md.appendMarkdown(`${prompt.description}\n\n`);
    }

    md.appendMarkdown(`Status: ${display.label}\n\n`);
    md.appendMarkdown(`Complexity: ${prompt.complexity}\n\n`);
    md.appendMarkdown(`Parallel-safe: ${prompt.parallelSafe ? 'Yes 🟢' : 'No 🔴'}\n\n`);

    if (prompt.dependsOn.length > 0) {
      md.appendMarkdown(`Dependencies: ${prompt.dependsOn.length} upstream\n\n`);
    }

    if (prompt.prompt) {
      const truncated = prompt.prompt.length > 300
        ? prompt.prompt.slice(0, 297) + '...'
        : prompt.prompt;
      md.appendMarkdown(`---\n\n**Prompt:**\n\n${truncated}`);
    }

    return md;
  }
}

// ── Empty state ─────────────────────────────────────────────────

class EmptyItem extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'queue-empty';
  }
}

// ── TreeDataProvider ────────────────────────────────────────────

export class PromptQueueProvider implements vscode.TreeDataProvider<PromptQueueElement> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<PromptQueueElement | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly queueManager: QueueManager) {
    // Auto-refresh when queue events fire
    this.disposables.push(
      queueManager.onQueueEvent(() => {
        this._onDidChangeTreeData.fire(undefined);
      }),
    );
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: PromptQueueElement): vscode.TreeItem {
    return element;
  }

  getChildren(element?: PromptQueueElement): PromptQueueElement[] {
    if (!element) {
      return this.getRootChildren();
    }

    if (element instanceof SectionHeaderItem) {
      return this.getSectionChildren(element.section);
    }

    return [];
  }

  private getRootChildren(): PromptQueueElement[] {
    const queued = this.queueManager.getQueueByStatus('queued');
    const launched = this.queueManager.getQueueByStatus('launched');

    const items: PromptQueueElement[] = [];

    items.push(new SectionHeaderItem('queued', queued.length));

    if (launched.length > 0) {
      items.push(new SectionHeaderItem('launched', launched.length));
    }

    return items;
  }

  private getSectionChildren(section: 'queued' | 'launched'): PromptQueueElement[] {
    const prompts = this.queueManager.getQueueByStatus(section);

    if (prompts.length === 0) {
      return [new EmptyItem(
        section === 'queued' ? 'No prompts in queue' : 'No launched prompts',
      )];
    }

    return prompts.map(p => new PromptTreeItem(p));
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

// ── Registration ────────────────────────────────────────────────

/**
 * Register the prompt queue tree view and queue commands.
 */
export function registerPromptQueue(
  context: vscode.ExtensionContext,
  queueManager: QueueManager,
  dependencyEngine?: DependencyEngine,
): { provider: PromptQueueProvider; treeView: vscode.TreeView<PromptQueueElement> } {
  const provider = new PromptQueueProvider(queueManager);

  const treeView = vscode.window.createTreeView(ViewId.PromptQueue, {
    treeDataProvider: provider,
    showCollapseAll: true,
    dragAndDropController: new PromptQueueDragDrop(queueManager, provider),
  });

  // ── Add Prompt ────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(CommandId.AddPrompt, async () => {
      const name = await vscode.window.showInputBox({
        prompt: 'Prompt name',
        placeHolder: 'e.g., 6.5A — API rate limiting',
      });
      if (!name) { return; }

      const promptText = await vscode.window.showInputBox({
        prompt: 'Prompt text',
        placeHolder: 'Enter the prompt for the Claude Code session...',
      });
      if (!promptText) { return; }

      const parallelSafe = await vscode.window.showQuickPick(
        [
          { label: '🟢 Parallel-safe', value: true, description: 'Can run alongside other sessions' },
          { label: '🔴 Not parallel-safe', value: false, description: 'Requires exclusive access' },
        ],
        { placeHolder: 'Is this prompt parallel-safe?' },
      );

      const complexity = await vscode.window.showQuickPick(
        [
          { label: 'Small', value: 'small' as const, description: 'Quick task' },
          { label: 'Medium', value: 'medium' as const, description: 'Standard task' },
          { label: 'Large', value: 'large' as const, description: 'Complex task' },
        ],
        { placeHolder: 'Estimated complexity' },
      );

      await queueManager.addPrompt({
        name,
        prompt: promptText,
        parallelSafe: parallelSafe?.value ?? true,
        complexity: complexity?.value ?? 'medium',
      });

      vscode.window.showInformationMessage(`Conductor: Added "${name}" to queue`);
    }),
  );

  // ── Add from Clipboard ────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(CommandId.AddPromptFromClipboard, async () => {
      const clipboard = await vscode.env.clipboard.readText();
      if (!clipboard.trim()) {
        vscode.window.showWarningMessage('Conductor: Clipboard is empty');
        return;
      }

      const name = await vscode.window.showInputBox({
        prompt: 'Name for this prompt',
        placeHolder: 'e.g., Task from clipboard',
        value: clipboard.split('\n')[0].slice(0, 60),
      });

      await queueManager.addPrompt({
        name: name ?? 'Clipboard Prompt',
        prompt: clipboard,
      });

      vscode.window.showInformationMessage(`Conductor: Added prompt from clipboard`);
    }),
  );

  // ── Launch Prompt ─────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(
      CommandId.LaunchPrompt,
      async (idOrItem?: string | PromptTreeItem) => {
        const id = resolvePromptId(idOrItem);
        if (!id) { return; }

        try {
          await queueManager.launchPrompt(id);
        } catch (err) {
          vscode.window.showErrorMessage(
            `Conductor: ${(err as Error).message}`,
          );
        }
      },
    ),
  );

  // ── Launch All Parallel-Safe ──────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(CommandId.LaunchAllPrompts, async () => {
      const safe = queueManager.getQueueByStatus('queued').filter(p => p.parallelSafe);
      if (safe.length === 0) {
        vscode.window.showInformationMessage('Conductor: No parallel-safe prompts to launch');
        return;
      }

      const confirm = await vscode.window.showInformationMessage(
        `Launch ${safe.length} parallel-safe prompts?`,
        'Launch All',
        'Cancel',
      );

      if (confirm === 'Launch All') {
        const sessions = await queueManager.launchAllParallelSafe();
        vscode.window.showInformationMessage(
          `Conductor: Launched ${sessions.length} sessions`,
        );
      }
    }),
  );

  // ── Edit Prompt ───────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(
      CommandId.EditPrompt,
      async (idOrItem?: string | PromptTreeItem) => {
        const id = resolvePromptId(idOrItem);
        if (!id) { return; }

        const prompt = queueManager.getPrompt(id);
        if (!prompt) { return; }

        const name = await vscode.window.showInputBox({
          prompt: 'Prompt name',
          value: prompt.name,
        });
        if (name === undefined) { return; } // cancelled

        const promptText = await vscode.window.showInputBox({
          prompt: 'Prompt text',
          value: prompt.prompt,
        });
        if (promptText === undefined) { return; }

        await queueManager.updatePrompt(id, {
          name: name || prompt.name,
          prompt: promptText || prompt.prompt,
        });
      },
    ),
  );

  // ── Delete Prompt ─────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(
      CommandId.DeletePrompt,
      async (idOrItem?: string | PromptTreeItem) => {
        const id = resolvePromptId(idOrItem);
        if (!id) { return; }

        const prompt = queueManager.getPrompt(id);
        if (!prompt) { return; }

        const confirm = await vscode.window.showWarningMessage(
          `Delete "${prompt.name}" from queue?`,
          { modal: true },
          'Delete',
        );

        if (confirm === 'Delete') {
          await queueManager.removePrompt(id);
        }
      },
    ),
  );

  // ── Set Dependency ────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(
      CommandId.SetDependency,
      async (idOrItem?: string | PromptTreeItem) => {
        const id = resolvePromptId(idOrItem);
        if (!id) { return; }

        const prompt = queueManager.getPrompt(id);
        if (!prompt) { return; }

        // Build list of candidate upstream prompts (all others in queue)
        const candidates = queueManager.getQueue().filter(p => p.id !== id);

        if (candidates.length === 0) {
          vscode.window.showInformationMessage(
            'Conductor: No other prompts available to set as dependencies.',
          );
          return;
        }

        const picks = await vscode.window.showQuickPick(
          candidates.map(p => ({
            label: p.name,
            description: `${p.complexity} · ${p.status}`,
            picked: prompt.dependsOn.includes(p.id),
            id: p.id,
          })),
          {
            placeHolder: `Select upstream dependencies for "${prompt.name}"`,
            canPickMany: true,
          },
        );

        if (picks === undefined) { return; } // cancelled

        const selectedIds = picks.map(p => p.id);

        try {
          if (dependencyEngine) {
            // Clear old deps and set the new ones through DependencyEngine (cycle-safe)
            await queueManager.updatePrompt(id, { dependsOn: [] });
            if (selectedIds.length > 0) {
              await dependencyEngine.addDependency(id, selectedIds);
            }
          } else {
            await queueManager.updatePrompt(id, { dependsOn: selectedIds });
          }
          vscode.window.showInformationMessage(
            selectedIds.length > 0
              ? `Conductor: Set ${selectedIds.length} dependency(s) for "${prompt.name}"`
              : `Conductor: Cleared dependencies for "${prompt.name}"`,
          );
        } catch (err) {
          vscode.window.showErrorMessage(`Conductor: ${(err as Error).message}`);
        }
      },
    ),
  );

  context.subscriptions.push(treeView, provider);
  return { provider, treeView };
}

// ── Drag & Drop ─────────────────────────────────────────────────

const DRAG_MIME = 'application/vnd.code.tree.conductor.promptQueue';

class PromptQueueDragDrop implements vscode.TreeDragAndDropController<PromptQueueElement> {
  readonly dropMimeTypes = [DRAG_MIME];
  readonly dragMimeTypes = [DRAG_MIME];

  constructor(
    private readonly queueManager: QueueManager,
    private readonly provider: PromptQueueProvider,
  ) {}

  handleDrag(
    source: readonly PromptQueueElement[],
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken,
  ): void {
    const promptItems = source.filter(
      (s): s is PromptTreeItem => s instanceof PromptTreeItem,
    );
    if (promptItems.length > 0) {
      dataTransfer.set(
        DRAG_MIME,
        new vscode.DataTransferItem(promptItems[0].prompt.id),
      );
    }
  }

  async handleDrop(
    target: PromptQueueElement | undefined,
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const transferItem = dataTransfer.get(DRAG_MIME);
    if (!transferItem) { return; }

    const draggedId = transferItem.value as string;
    let newPosition = 0;

    if (target instanceof PromptTreeItem) {
      newPosition = target.prompt.position;
    }

    await this.queueManager.reorderPrompt(draggedId, newPosition);
    this.provider.refresh();
  }
}

// ── Helpers ─────────────────────────────────────────────────────

function resolvePromptId(
  arg: string | PromptTreeItem | undefined,
): string | undefined {
  if (typeof arg === 'string') { return arg; }
  if (arg instanceof PromptTreeItem) { return arg.prompt.id; }
  return undefined;
}
