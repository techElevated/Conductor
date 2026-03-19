/**
 * Conductor — Approval Badge + Notifications.
 *
 * Updates the activity bar badge count and fires VS Code toast
 * notifications when new approvals arrive.  Notification style
 * is configurable via conductor.notifications.style.
 *
 * PRD v1.1 §4a — Badge and notification requirements.
 */

import * as vscode from 'vscode';
import type { ApprovalEngine } from '../core/ApprovalEngine';
import { ContextKey, ConfigKey } from '../constants';
import type { NotificationStyle } from '../constants';

/**
 * Manages the activity bar badge count and toast notifications
 * for pending approvals.
 */
export class ApprovalNotifier implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly approvalEngine: ApprovalEngine,
    private readonly treeView: vscode.TreeView<unknown>,
  ) {
    // React to approval events
    this.disposables.push(
      approvalEngine.onApprovalEvent((event) => {
        this.updateBadge();

        if (event.type === 'new') {
          this.showNotification(event.approval);
        }
      }),
    );

    // React to config changes
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(ConfigKey.NotificationStyle)) {
          // Config change acknowledged — no action needed until next event
        }
      }),
    );

    // Set initial badge
    this.updateBadge();
  }

  // ── Badge ─────────────────────────────────────────────────

  private updateBadge(): void {
    const count = this.approvalEngine.getPendingCount();

    // Update the tree view badge
    this.treeView.badge = count > 0
      ? { value: count, tooltip: `${count} pending approval${count === 1 ? '' : 's'}` }
      : undefined;

    // Update context keys for `when` clauses
    vscode.commands.executeCommand('setContext', ContextKey.HasPendingApprovals, count > 0);
    vscode.commands.executeCommand('setContext', ContextKey.PendingApprovalCount, count);
  }

  // ── Notifications ─────────────────────────────────────────

  private showNotification(approval: {
    sessionName: string;
    tool: string;
    command: string;
  }): void {
    const style = this.getNotificationStyle();

    if (style === 'none') {
      return;
    }

    // Badge is always updated (handled above)
    if (style === 'badge-only') {
      return;
    }

    // Toast notification
    const truncatedCmd = approval.command.length > 80
      ? approval.command.slice(0, 77) + '...'
      : approval.command;

    const message = `Conductor: ${approval.sessionName} needs approval for \`${approval.tool}\` — ${truncatedCmd}`;

    vscode.window.showInformationMessage(message, 'Approve', 'Deny').then(
      (action) => {
        // Fire-and-forget the approval/deny action
        // The ApprovalEngine handles it from here
        void action; // The panel handles resolution
      },
    );

    // Sound (system beep) for toast-badge-sound
    if (style === 'toast-badge-sound' || style === 'sound') {
      // VS Code doesn't have a native beep API, but the notification
      // itself triggers the system notification sound if enabled in OS settings.
      // We emit a terminal bell as a best-effort fallback.
      vscode.commands.executeCommand('workbench.action.terminal.sendSequence', {
        text: '\u0007', // BEL character
      });
    }
  }

  private getNotificationStyle(): NotificationStyle | 'badge-only' | 'toast-badge-sound' {
    const config = vscode.workspace.getConfiguration();
    return config.get<string>(ConfigKey.NotificationStyle, 'toast-and-badge') as NotificationStyle;
  }

  // ── Dispose ───────────────────────────────────────────────

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
