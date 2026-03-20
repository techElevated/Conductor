/**
 * Conductor — Template Library (TreeDataProvider).
 *
 * Renders the template library in the Conductor sidebar.  Templates
 * are grouped by scope: user-level (🔒) and project-level (📂).
 * Each template shows session count, last-used date, and inline
 * Launch / Edit / Export / Delete actions.
 *
 * PRD v1.1 §4f, Implementation Plan §7 Task 4.7
 */

import * as vscode from 'vscode';
import type { SessionTemplate } from '../types';
import type { TemplateManager } from '../core/TemplateManager';
import { CommandId } from '../constants';

// ── Tree element union ───────────────────────────────────────────

type TemplateTreeElement = ScopeHeader | TemplateTreeItem | EmptyItem;

// ── Scope header ─────────────────────────────────────────────────

class ScopeHeader extends vscode.TreeItem {
  readonly scope: 'user' | 'project';

  constructor(scope: 'user' | 'project', count: number) {
    const label =
      scope === 'user' ? `🔒 User Templates (${count})` : `📂 Project Templates (${count})`;
    super(
      label,
      count > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed,
    );
    this.scope = scope;
    this.contextValue = `template-scope-${scope}`;
    this.iconPath = new vscode.ThemeIcon(
      scope === 'user' ? 'account' : 'folder-library',
    );
  }
}

// ── Template tree item ───────────────────────────────────────────

class TemplateTreeItem extends vscode.TreeItem {
  readonly template: SessionTemplate;

  constructor(template: SessionTemplate) {
    super(template.name, vscode.TreeItemCollapsibleState.None);

    this.template = template;

    const sessionCount = template.sessions.length;
    const lastUsed = template.lastUsedAt
      ? `used ${formatAge(template.lastUsedAt)}`
      : 'never used';

    this.description = `${sessionCount} session${sessionCount !== 1 ? 's' : ''} · ${lastUsed}`;
    this.tooltip = this.buildTooltip();
    this.iconPath = new vscode.ThemeIcon('circuit-board');
    this.contextValue = 'template';
  }

  private buildTooltip(): vscode.MarkdownString {
    const t = this.template;
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${t.name}**\n\n`);
    if (t.description) {md.appendMarkdown(`${t.description}\n\n`);}
    md.appendMarkdown(`Sessions: ${t.sessions.length}  \n`);
    if (t.variables.length > 0) {
      md.appendMarkdown(`Variables: ${t.variables.map(v => `\`{{${v.name}}}\``).join(', ')}  \n`);
    }
    md.appendMarkdown(`Created: ${new Date(t.createdAt).toLocaleDateString()}  \n`);
    if (t.lastUsedAt) {
      md.appendMarkdown(`Last used: ${new Date(t.lastUsedAt).toLocaleString()}  \n`);
    }
    return md;
  }
}

// ── Empty state ──────────────────────────────────────────────────

class EmptyItem extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'template-empty';
    this.iconPath = new vscode.ThemeIcon('circuit-board');
  }
}

// ── TemplateLibraryProvider ──────────────────────────────────────

export class TemplateLibraryProvider
  implements vscode.TreeDataProvider<TemplateTreeElement>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    TemplateTreeElement | undefined | null | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly manager: TemplateManager) {
    this.disposables.push(this._onDidChangeTreeData);

    this.disposables.push(
      manager.onTemplateEvent(_ev => {
        this._onDidChangeTreeData.fire();
      }),
    );
  }

  // ── TreeDataProvider ─────────────────────────────────────────

  getTreeItem(element: TemplateTreeElement): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TemplateTreeElement): TemplateTreeElement[] {
    if (!element) {
      return this.buildRoots();
    }

    if (element instanceof ScopeHeader) {
      return this.buildScopeChildren(element.scope);
    }

    return [];
  }

  // ── Root nodes ────────────────────────────────────────────────

  private buildRoots(): TemplateTreeElement[] {
    const user = this.manager.getUserTemplates();
    const project = this.manager.getProjectTemplates();

    if (user.length === 0 && project.length === 0) {
      return [new EmptyItem('No templates yet — create one to get started')];
    }

    const roots: TemplateTreeElement[] = [];
    roots.push(new ScopeHeader('user', user.length));
    if (project.length > 0) {
      roots.push(new ScopeHeader('project', project.length));
    }
    return roots;
  }

  private buildScopeChildren(scope: 'user' | 'project'): TemplateTreeElement[] {
    const templates =
      scope === 'user'
        ? this.manager.getUserTemplates()
        : this.manager.getProjectTemplates();

    if (templates.length === 0) {
      return [new EmptyItem(`No ${scope} templates`)];
    }

    return templates.map(t => new TemplateTreeItem(t));
  }

  // ── Commands ─────────────────────────────────────────────────

  registerCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      // Launch a template
      vscode.commands.registerCommand(
        CommandId.LaunchTemplate,
        async (item: unknown) => {
          const template = (item instanceof TemplateTreeItem) ? item.template : undefined;
          if (!template) {
            await this.pickAndLaunch();
            return;
          }
          await this.launchTemplateWithVariables(template);
        },
      ),

      // Create a new template
      vscode.commands.registerCommand(CommandId.CreateTemplate, async () => {
        const name = await vscode.window.showInputBox({
          prompt: 'Template name',
          placeHolder: 'e.g. Full-stack feature sprint',
        });
        if (!name) {return;}

        const description = await vscode.window.showInputBox({
          prompt: 'Template description (optional)',
          placeHolder: 'What does this template do?',
        });

        await this.manager.createTemplate({ name, description: description ?? '' });
        vscode.window.showInformationMessage(`Conductor: Template "${name}" created.`);
        this._onDidChangeTreeData.fire();
      }),

      // Export a template
      vscode.commands.registerCommand(
        CommandId.ExportTemplate,
        async (item: unknown) => {
          const template = (item instanceof TemplateTreeItem) ? item.template : undefined;
          if (!template) {return;}

          const json = this.manager.exportTemplate(template.id);
          const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(`${template.name.replace(/\s+/g, '-')}.conductor-template.json`),
            filters: { 'Conductor Template': ['json'] },
          });
          if (!uri) {return;}

          await vscode.workspace.fs.writeFile(uri, Buffer.from(json, 'utf8'));
          vscode.window.showInformationMessage(`Conductor: Template exported to ${uri.fsPath}`);
        },
      ),

      // Import a template
      vscode.commands.registerCommand(CommandId.ImportTemplate, async () => {
        const uris = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectMany: false,
          filters: { 'Conductor Template': ['json'] },
          title: 'Import Conductor Template',
        });
        if (!uris || uris.length === 0) {return;}

        const bytes = await vscode.workspace.fs.readFile(uris[0]);
        const json = Buffer.from(bytes).toString('utf8');

        const scopePick = await vscode.window.showQuickPick(
          [
            { label: '🔒 User Template', description: 'Available in all workspaces', value: 'user' as const },
            { label: '📂 Project Template', description: 'Committed to this workspace', value: 'project' as const },
          ],
          { placeHolder: 'Where should this template be stored?' },
        );
        if (!scopePick) {return;}

        try {
          const imported = await this.manager.importTemplate(json, scopePick.value);
          vscode.window.showInformationMessage(`Conductor: Template "${imported.name}" imported.`);
          this._onDidChangeTreeData.fire();
        } catch (err) {
          vscode.window.showErrorMessage(`Conductor: Import failed — ${String(err)}`);
        }
      }),

      // Delete a template
      vscode.commands.registerCommand(
        CommandId.DeleteTemplate,
        async (item: unknown) => {
          const template = (item instanceof TemplateTreeItem) ? item.template : undefined;
          if (!template) {return;}

          const confirm = await vscode.window.showWarningMessage(
            `Delete template "${template.name}"?`,
            { modal: true },
            'Delete',
          );
          if (confirm !== 'Delete') {return;}

          await this.manager.deleteTemplate(template.id);
          this._onDidChangeTreeData.fire();
        },
      ),
    );
  }

  // ── Launch with variable resolution ──────────────────────────

  private async launchTemplateWithVariables(template: SessionTemplate): Promise<void> {
    const vars: Record<string, string> = {};

    for (const variable of template.variables) {
      const value = await vscode.window.showInputBox({
        prompt: variable.description || `Value for {{${variable.name}}}`,
        placeHolder: variable.default || `Enter ${variable.name}`,
        value: variable.default,
        ignoreFocusOut: true,
      });

      if (value === undefined) {return;} // user cancelled

      if (variable.required && !value) {
        vscode.window.showErrorMessage(
          `Conductor: Variable "{{${variable.name}}}" is required.`,
        );
        return;
      }

      vars[variable.name] = value || variable.default;
    }

    try {
      const sessions = await this.manager.launchTemplate(template.id, vars);
      vscode.window.showInformationMessage(
        `Conductor: Launched ${sessions.length} session(s) from template "${template.name}".`,
      );
    } catch (err) {
      vscode.window.showErrorMessage(`Conductor: Template launch failed — ${String(err)}`);
    }
  }

  private async pickAndLaunch(): Promise<void> {
    const all = this.manager.getAllTemplates();
    if (all.length === 0) {
      vscode.window.showInformationMessage('Conductor: No templates available. Create one first.');
      return;
    }

    const pick = await vscode.window.showQuickPick(
      all.map(t => ({
        label: t.name,
        description: `${t.sessions.length} sessions · ${t.scope}`,
        template: t,
      })),
      { placeHolder: 'Select a template to launch' },
    );
    if (!pick) {return;}
    await this.launchTemplateWithVariables(pick.template);
  }

  // ── Refresh ───────────────────────────────────────────────────

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  // ── Disposable ────────────────────────────────────────────────

  dispose(): void {
    for (const d of this.disposables) {d.dispose();}
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function formatAge(isoString: string): string {
  const ms = Date.now() - new Date(isoString).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) {return `${s}s ago`;}
  const m = Math.floor(s / 60);
  if (m < 60) {return `${m}m ago`;}
  const h = Math.floor(m / 60);
  if (h < 24) {return `${h}h ago`;}
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
