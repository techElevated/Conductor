/**
 * Conductor — First-Run Setup Wizard (WebviewPanel).
 *
 * Shown once on first activation.  Explains what Conductor does,
 * offers visual previews of the 4 layout options, and lets the
 * user pick one.  Writes the selection to settings and marks
 * setup as complete in global state.
 *
 * PRD v1.1 §4h — First-run wizard
 */

import * as vscode from 'vscode';
import type { LayoutManager } from './LayoutManager';
import { StateKey, type LayoutOption } from '../constants';

export class SetupWizard implements vscode.Disposable {
  private panel: vscode.WebviewPanel | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly layoutManager: LayoutManager,
  ) {}

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'conductor.setupWizard',
      'Welcome to Conductor',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: false },
    );

    this.panel.webview.html = this.getHtml();

    this.panel.webview.onDidReceiveMessage(
      async (msg: { command: string; layout?: string }) => {
        if (msg.command === 'selectLayout' && msg.layout) {
          await this.layoutManager.setLayout(msg.layout as LayoutOption);
          await this.context.globalState.update(StateKey.HasCompletedSetup, true);
          this.panel?.dispose();
        }
        if (msg.command === 'skip') {
          await this.context.globalState.update(StateKey.HasCompletedSetup, true);
          this.panel?.dispose();
        }
      },
      undefined,
      this.context.subscriptions,
    );

    this.panel.onDidDispose(() => {
      this.panel = null;
    });
  }

  private getHtml(): string {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      font-family: var(--vscode-font-family, system-ui, sans-serif);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 24px 32px;
      line-height: 1.6;
    }
    h1 { font-size: 1.8em; margin-bottom: 4px; }
    .subtitle { opacity: 0.7; font-size: 0.95em; margin-bottom: 24px; }
    .features {
      display: flex; flex-wrap: wrap; gap: 12px;
      margin-bottom: 28px;
    }
    .feature {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      padding: 4px 10px; border-radius: 4px;
      font-size: 0.85em;
    }
    h2 { font-size: 1.2em; margin-bottom: 16px; }
    .layouts {
      display: grid; grid-template-columns: 1fr 1fr;
      gap: 16px; margin-bottom: 28px;
    }
    .layout-card {
      border: 2px solid var(--vscode-panel-border, #444);
      border-radius: 8px; padding: 16px;
      cursor: pointer; transition: border-color 0.15s;
    }
    .layout-card:hover {
      border-color: var(--vscode-focusBorder);
    }
    .layout-card.selected {
      border-color: var(--vscode-focusBorder);
      background: var(--vscode-list-activeSelectionBackground);
    }
    .layout-card h3 { margin: 0 0 6px; font-size: 1em; }
    .layout-card p { margin: 0; opacity: 0.75; font-size: 0.85em; }
    .layout-card .diagram {
      font-family: monospace; font-size: 0.75em;
      background: var(--vscode-textBlockQuote-background);
      padding: 8px; border-radius: 4px; margin-top: 8px;
      white-space: pre; line-height: 1.4;
    }
    .actions { display: flex; gap: 12px; align-items: center; }
    button {
      padding: 8px 20px; border: none; border-radius: 4px;
      cursor: pointer; font-size: 0.9em;
    }
    .primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .primary:hover { background: var(--vscode-button-hoverBackground); }
    .secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .note { font-size: 0.8em; opacity: 0.6; margin-top: 16px; }
  </style>
</head>
<body>
  <h1>Welcome to Conductor</h1>
  <p class="subtitle">Session management for multi-agent AI coding workflows</p>

  <div class="features">
    <span class="feature">Session Status Board</span>
    <span class="feature">Approval Notifications</span>
    <span class="feature">Prompt Queue</span>
    <span class="feature">Human Task Inbox</span>
    <span class="feature">Dependency Chains</span>
    <span class="feature">Session Templates</span>
    <span class="feature">Inline Interaction</span>
  </div>

  <h2>Choose your layout</h2>

  <div class="layouts">
    <div class="layout-card selected" data-layout="split" onclick="selectLayout('split')">
      <h3>Split (recommended)</h3>
      <p>Compact panels in left sidebar, details open as editor tabs.</p>
      <div class="diagram">+------+----------+------+
|  E   | Editor   |  CC  |
|  x   | tabs     |  (R) |
|  p   +----------+      |
| [C]  | Terminal  |      |
+------+----------+------+</div>
    </div>

    <div class="layout-card" data-layout="sidebar-left" onclick="selectLayout('sidebar-left')">
      <h3>Activity Bar Sidebar</h3>
      <p>All Conductor panels in the left sidebar.</p>
      <div class="diagram">+-----------+----------+
| Sessions  | Editor   |
| Approvals | tabs     |
| Queue     +----------+
| Tasks     | Terminal  |
+-----------+----------+</div>
    </div>

    <div class="layout-card" data-layout="sidebar-right" onclick="selectLayout('sidebar-right')">
      <h3>Right Sidebar</h3>
      <p>All panels in the secondary sidebar (VS Code 1.64+).</p>
      <div class="diagram">+------+----------+------+
|  E   | Editor   | Sess |
|  x   | tabs     | Appr |
|  p   +----------+ Queu |
|      | Terminal  | Task |
+------+----------+------+</div>
    </div>

    <div class="layout-card" data-layout="bottom" onclick="selectLayout('bottom')">
      <h3>Bottom Panel</h3>
      <p>All panels as bottom panel tabs. Both sidebars stay free.</p>
      <div class="diagram">+------+-----------+
|  E   | Editor    |
|  x   | tabs      |
|  p   +-----------+
+------+-----------+
| Sessions | Queue  |
+------+-----------+</div>
    </div>
  </div>

  <div class="actions">
    <button class="primary" onclick="confirm()">Apply Layout</button>
    <button class="secondary" onclick="skip()">Skip for now</button>
  </div>

  <p class="note">You can change this anytime: Settings &rarr; Conductor &rarr; Layout</p>

  <script>
    const vscode = acquireVsCodeApi();
    let selectedLayout = 'split';

    function selectLayout(layout) {
      selectedLayout = layout;
      document.querySelectorAll('.layout-card').forEach(card => {
        card.classList.toggle('selected', card.dataset.layout === layout);
      });
    }

    function confirm() {
      vscode.postMessage({ command: 'selectLayout', layout: selectedLayout });
    }

    function skip() {
      vscode.postMessage({ command: 'skip' });
    }
  </script>
</body>
</html>`;
  }

  dispose(): void {
    this.panel?.dispose();
  }
}
