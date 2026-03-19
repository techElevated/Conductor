/**
 * Conductor — ApprovalEngine.
 *
 * Core approval detection and routing.  Watches the filesystem for
 * new approval files written by the PreToolUse hook, maintains an
 * in-memory list of pending/resolved approvals, and provides
 * approve/deny/approveAll actions.
 *
 * PRD v1.1 §4a — Approval Panel functional requirements.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { PendingApproval, ApprovalEvent } from '../types';
import {
  getApprovalsDir,
  getSessionApprovalsDir,
  getApprovalDecisionPath,
} from '../storage/paths';
import { readJsonFile, writeJsonFile, ensureDir } from '../storage/FileStore';
import { isProcessAlive } from '../utils/processUtils';
import {
  APPROVAL_STALE_CHECK_INTERVAL_MS,
} from '../constants';

// ── History file ────────────────────────────────────────────

const HISTORY_FILE = 'approval-history.json';
const MAX_HISTORY = 20;

interface ApprovalHistory {
  entries: PendingApproval[];
}

// ── ApprovalEngine ──────────────────────────────────────────

export class ApprovalEngine implements vscode.Disposable {
  private pending = new Map<string, PendingApproval>();
  private history: PendingApproval[] = [];

  private readonly _onApprovalEvent = new vscode.EventEmitter<ApprovalEvent>();
  readonly onApprovalEvent = this._onApprovalEvent.event;

  private watcher: fs.FSWatcher | null = null;
  private sessionWatchers = new Map<string, fs.FSWatcher>();
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private readonly disposables: vscode.Disposable[] = [];

  /** Map sessionId → PID for stale-check */
  private sessionPids = new Map<string, number>();

  constructor() {
    this.disposables.push(this._onApprovalEvent);
  }

  // ── Initialisation ────────────────────────────────────────

  async initialise(): Promise<void> {
    const approvalsDir = getApprovalsDir();
    await ensureDir(approvalsDir);

    // Load history from disk
    await this.loadHistory();

    // Scan for any existing pending approvals
    await this.scanAllApprovals();

    // Watch the top-level approvals dir for new session subdirectories
    this.watchApprovalsDir(approvalsDir);

    // Start stale approval cleanup timer
    this.startStaleCheck();
  }

  // ── Queries ───────────────────────────────────────────────

  /** All pending approvals sorted by timestamp (oldest first). */
  getPendingApprovals(): PendingApproval[] {
    return [...this.pending.values()].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
  }

  /** Number of pending approvals. */
  getPendingCount(): number {
    return this.pending.size;
  }

  /** Recent resolved approvals (newest first). */
  getHistory(): PendingApproval[] {
    return [...this.history];
  }

  // ── Actions ───────────────────────────────────────────────

  /** Approve a single pending approval. */
  async approveAction(approvalId: string): Promise<void> {
    await this.resolveApproval(approvalId, 'approved');
  }

  /** Deny a single pending approval. */
  async denyAction(approvalId: string): Promise<void> {
    await this.resolveApproval(approvalId, 'denied');
  }

  /** Approve all pending approvals. */
  async approveAll(): Promise<void> {
    const ids = [...this.pending.keys()];
    await Promise.all(ids.map((id) => this.resolveApproval(id, 'approved')));
  }

  /** Deny all pending approvals. */
  async denyAll(): Promise<void> {
    const ids = [...this.pending.keys()];
    await Promise.all(ids.map((id) => this.resolveApproval(id, 'denied')));
  }

  /** Register a session PID for stale-check. */
  registerSessionPid(sessionId: string, pid: number): void {
    this.sessionPids.set(sessionId, pid);
  }

  /** Remove all approvals for a completed/errored session. */
  async dismissSessionApprovals(sessionId: string): Promise<void> {
    const toRemove = [...this.pending.values()].filter(
      (a) => a.sessionId === sessionId,
    );
    for (const approval of toRemove) {
      this.pending.delete(approval.id);
      this._onApprovalEvent.fire({ type: 'stale', approval });
    }
  }

  // ── Internal: resolve ─────────────────────────────────────

  private async resolveApproval(
    approvalId: string,
    status: 'approved' | 'denied',
  ): Promise<void> {
    const approval = this.pending.get(approvalId);
    if (!approval) { return; }

    // Write the decision file for the hook to pick up
    const decision = status === 'approved' ? 'allow' : 'deny';
    const decisionPath = getApprovalDecisionPath(approval.sessionId, approvalId);
    const decisionData = { decision, resolvedAt: new Date().toISOString() };
    await ensureDir(path.dirname(decisionPath));
    await fs.promises.writeFile(
      decisionPath,
      JSON.stringify(decisionData, null, 2),
      'utf-8',
    );

    // Update in-memory state
    approval.status = status;
    approval.resolvedAt = new Date().toISOString();
    this.pending.delete(approvalId);

    // Add to history (newest first, capped at MAX_HISTORY)
    this.history.unshift(approval);
    if (this.history.length > MAX_HISTORY) {
      this.history = this.history.slice(0, MAX_HISTORY);
    }
    await this.saveHistory();

    this._onApprovalEvent.fire({ type: 'resolved', approval });
  }

  // ── Internal: filesystem watching ─────────────────────────

  private watchApprovalsDir(approvalsDir: string): void {
    try {
      this.watcher = fs.watch(approvalsDir, { persistent: false }, async (eventType, filename) => {
        if (!filename) { return; }

        const sessionDir = path.join(approvalsDir, filename);
        try {
          const stat = await fs.promises.stat(sessionDir);
          if (stat.isDirectory()) {
            this.watchSessionDir(filename, sessionDir);
          }
        } catch {
          // Directory gone — stop watching
          const existing = this.sessionWatchers.get(filename);
          if (existing) {
            existing.close();
            this.sessionWatchers.delete(filename);
          }
        }
      });
    } catch {
      // fs.watch not supported — fall back to polling in scanAllApprovals
    }

    // Also set up watchers for existing session directories
    this.setupExistingSessionWatchers(approvalsDir);
  }

  private async setupExistingSessionWatchers(approvalsDir: string): Promise<void> {
    try {
      const entries = await fs.promises.readdir(approvalsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          this.watchSessionDir(entry.name, path.join(approvalsDir, entry.name));
        }
      }
    } catch {
      // No session dirs yet
    }
  }

  private watchSessionDir(sessionId: string, sessionDir: string): void {
    if (this.sessionWatchers.has(sessionId)) { return; }

    try {
      const watcher = fs.watch(sessionDir, { persistent: false }, async (_eventType, filename) => {
        if (!filename || !filename.endsWith('.json') || filename.includes('.decision.') || filename.startsWith('.tmp-')) {
          return;
        }

        const filePath = path.join(sessionDir, filename);
        await this.processApprovalFile(filePath);
      });

      this.sessionWatchers.set(sessionId, watcher);
    } catch {
      // Watch failed — approvals still detected via polling
    }
  }

  private async processApprovalFile(filePath: string): Promise<void> {
    try {
      const raw = await fs.promises.readFile(filePath, 'utf-8');
      const approval = JSON.parse(raw) as PendingApproval;

      if (!approval.id || !approval.sessionId || approval.status !== 'pending') {
        return;
      }

      // Skip if already known
      if (this.pending.has(approval.id)) { return; }

      this.pending.set(approval.id, approval);
      this._onApprovalEvent.fire({ type: 'new', approval });
    } catch {
      // Invalid JSON or file gone — ignore
    }
  }

  // ── Internal: scanning ────────────────────────────────────

  private async scanAllApprovals(): Promise<void> {
    const approvalsDir = getApprovalsDir();

    try {
      const sessionDirs = await fs.promises.readdir(approvalsDir, { withFileTypes: true });

      for (const dir of sessionDirs) {
        if (!dir.isDirectory()) { continue; }

        const sessionDir = path.join(approvalsDir, dir.name);
        const files = await fs.promises.readdir(sessionDir);

        for (const file of files) {
          if (!file.endsWith('.json') || file.includes('.decision.') || file.startsWith('.tmp-')) {
            continue;
          }

          await this.processApprovalFile(path.join(sessionDir, file));
        }
      }
    } catch {
      // Approvals dir doesn't exist or is empty
    }
  }

  // ── Internal: stale check ─────────────────────────────────

  private startStaleCheck(): void {
    this.staleTimer = setInterval(async () => {
      await this.cleanupStaleApprovals();
    }, APPROVAL_STALE_CHECK_INTERVAL_MS);
  }

  private async cleanupStaleApprovals(): Promise<void> {
    for (const [approvalId, approval] of this.pending) {
      const pid = this.sessionPids.get(approval.sessionId);
      if (pid !== undefined && !isProcessAlive(pid)) {
        this.pending.delete(approvalId);
        this._onApprovalEvent.fire({ type: 'stale', approval });
      }

      // Also check if the approval file still exists
      const approvalPath = path.join(
        getSessionApprovalsDir(approval.sessionId),
        `${approvalId}.json`,
      );
      try {
        await fs.promises.access(approvalPath);
      } catch {
        // Approval file gone (resolved externally)
        this.pending.delete(approvalId);
        this._onApprovalEvent.fire({ type: 'stale', approval });
      }
    }
  }

  // ── Internal: history persistence ─────────────────────────

  private getHistoryPath(): string {
    return path.join(getApprovalsDir(), '..', HISTORY_FILE);
  }

  private async loadHistory(): Promise<void> {
    const data = await readJsonFile<ApprovalHistory>(
      this.getHistoryPath(),
      { entries: [] },
    );
    this.history = data.entries.slice(0, MAX_HISTORY);
  }

  private async saveHistory(): Promise<void> {
    await writeJsonFile<ApprovalHistory>(this.getHistoryPath(), {
      entries: this.history,
    });
  }

  // ── Dispose ───────────────────────────────────────────────

  dispose(): void {
    if (this.staleTimer) {
      clearInterval(this.staleTimer);
      this.staleTimer = null;
    }

    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    for (const w of this.sessionWatchers.values()) {
      w.close();
    }
    this.sessionWatchers.clear();

    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
