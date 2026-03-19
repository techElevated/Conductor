/**
 * Conductor — Layout Manager.
 *
 * Controls which VS Code view containers and panel locations are
 * active based on the user's chosen layout option.  Reads the
 * `conductor.layout` setting and sets context keys so `when`
 * clauses in package.json show/hide the right containers.
 *
 * PRD v1.1 §4h — Configurable Layout System
 *
 * Layout options:
 *   sidebar-left  → Activity bar sidebar (left)
 *   sidebar-right → Secondary sidebar / auxiliary bar (right)
 *   bottom        → Bottom panel tab
 *   split         → Activity bar for compact panels, editor/bottom for details
 */

import * as vscode from 'vscode';
import {
  ConfigKey,
  ContextKey,
  DEFAULT_LAYOUT,
  type LayoutOption,
} from '../constants';
import { getCompatibilityFlags } from '../platform/IdePaths';

export class LayoutManager implements vscode.Disposable {
  private currentLayout: LayoutOption;
  private disposables: vscode.Disposable[] = [];

  constructor() {
    this.currentLayout = this.readLayoutSetting();
    this.applyLayout(this.currentLayout);

    // Watch for settings changes
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration(ConfigKey.Layout)) {
          const newLayout = this.readLayoutSetting();
          if (newLayout !== this.currentLayout) {
            this.currentLayout = newLayout;
            this.applyLayout(newLayout);
          }
        }
      }),
    );
  }

  /** Get the currently active layout. */
  getLayout(): LayoutOption {
    return this.currentLayout;
  }

  /**
   * Programmatically change the layout.
   * Writes to settings and triggers the config change listener.
   */
  async setLayout(layout: LayoutOption): Promise<void> {
    const flags = getCompatibilityFlags();
    if (layout === 'sidebar-right' && !flags.hasSecondarySidebar) {
      vscode.window.showWarningMessage(
        'Your VS Code version does not support the secondary sidebar. Using "split" layout instead.',
      );
      layout = 'split';
    }

    await vscode.workspace.getConfiguration().update(
      ConfigKey.Layout,
      layout,
      vscode.ConfigurationTarget.Global,
    );
  }

  // ── Internals ─────────────────────────────────────────────

  private readLayoutSetting(): LayoutOption {
    const raw = vscode.workspace
      .getConfiguration()
      .get<string>(ConfigKey.Layout, DEFAULT_LAYOUT);

    const valid: LayoutOption[] = ['sidebar-left', 'sidebar-right', 'bottom', 'split'];
    return valid.includes(raw as LayoutOption) ? (raw as LayoutOption) : DEFAULT_LAYOUT;
  }

  /**
   * Set context keys that package.json `when` clauses use to
   * show/hide view containers and panels.
   */
  private applyLayout(layout: LayoutOption): void {
    vscode.commands.executeCommand('setContext', ContextKey.Layout, layout);

    // Individual flags for simpler `when` clause authoring
    vscode.commands.executeCommand(
      'setContext',
      'conductor.layout.sidebarLeft',
      layout === 'sidebar-left' || layout === 'split',
    );
    vscode.commands.executeCommand(
      'setContext',
      'conductor.layout.sidebarRight',
      layout === 'sidebar-right',
    );
    vscode.commands.executeCommand(
      'setContext',
      'conductor.layout.bottom',
      layout === 'bottom',
    );
    vscode.commands.executeCommand(
      'setContext',
      'conductor.layout.split',
      layout === 'split',
    );
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
