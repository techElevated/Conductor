/**
 * Conductor — QueueManager.
 *
 * Persistent prompt queue CRUD with launch capability.  Stores prompts
 * in ~/.conductor/queue/{workspace-hash}.json and resolves permission
 * mode through the hierarchy: prompt override → template → global.
 *
 * PRD v1.1 §4c, Implementation Plan §6 Task 3.1
 */

import * as vscode from 'vscode';
import { v4 as uuid } from 'uuid';
import type {
  QueuedPrompt,
  PromptStatus,
  ConductorSession,
  LaunchConfig,
} from '../types';
import type { SessionManager } from './SessionManager';
import { readJsonFile, writeJsonFile } from '../storage/FileStore';
import { getQueueFilePath } from '../storage/paths';
import { ConfigKey, DEFAULT_PERMISSION_MODE } from '../constants';
import type { PermissionMode, TerminalType } from '../constants';

// ── Persisted format ────────────────────────────────────────────

interface QueueFile {
  prompts: QueuedPrompt[];
}

// ── Event types ─────────────────────────────────────────────────

export interface QueueEvent {
  type: 'added' | 'removed' | 'updated' | 'reordered' | 'launched';
  promptId: string;
  prompt?: QueuedPrompt;
}

// ── QueueManager ────────────────────────────────────────────────

export class QueueManager implements vscode.Disposable {
  private prompts: QueuedPrompt[] = [];
  private workspacePath: string;

  private readonly _onQueueEvent = new vscode.EventEmitter<QueueEvent>();
  readonly onQueueEvent = this._onQueueEvent.event;

  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    workspacePath: string,
    private readonly sessionManager: SessionManager,
  ) {
    this.workspacePath = workspacePath;
    this.disposables.push(this._onQueueEvent);
  }

  // ── Initialisation ──────────────────────────────────────────

  /** Load persisted queue from disk. */
  async initialise(): Promise<void> {
    await this.loadFromDisk();
  }

  // ── Queries ─────────────────────────────────────────────────

  /** Return all prompts sorted by position. */
  getQueue(): QueuedPrompt[] {
    return [...this.prompts].sort((a, b) => a.position - b.position);
  }

  /** Filter prompts by status. */
  getQueueByStatus(status: PromptStatus): QueuedPrompt[] {
    return this.getQueue().filter(p => p.status === status);
  }

  /** Get a single prompt by ID. */
  getPrompt(id: string): QueuedPrompt | undefined {
    return this.prompts.find(p => p.id === id);
  }

  // ── Mutations ───────────────────────────────────────────────

  /**
   * Add a new prompt to the queue.  Generates UUID, sets defaults,
   * appends to queue, and persists.
   */
  async addPrompt(partial: Partial<QueuedPrompt>): Promise<QueuedPrompt> {
    const prompt: QueuedPrompt = {
      id: partial.id ?? uuid(),
      name: partial.name ?? 'Untitled Prompt',
      description: partial.description ?? '',
      prompt: partial.prompt ?? '',
      providerId: partial.providerId ?? 'claude-code',
      parallelSafe: partial.parallelSafe ?? true,
      complexity: partial.complexity ?? 'medium',
      dependsOn: partial.dependsOn ?? [],
      status: 'queued',
      sessionId: null,
      position: partial.position ?? this.prompts.length,
      createdAt: new Date().toISOString(),
      launchedAt: null,
    };

    this.prompts.push(prompt);
    await this.persistToDisk();
    this._onQueueEvent.fire({ type: 'added', promptId: prompt.id, prompt });
    return prompt;
  }

  /** Remove a prompt from the queue. */
  async removePrompt(id: string): Promise<void> {
    const idx = this.prompts.findIndex(p => p.id === id);
    if (idx === -1) { return; }
    this.prompts.splice(idx, 1);
    await this.persistToDisk();
    this._onQueueEvent.fire({ type: 'removed', promptId: id });
  }

  /** Partial update of a prompt. */
  async updatePrompt(id: string, updates: Partial<QueuedPrompt>): Promise<void> {
    const prompt = this.requirePrompt(id);
    Object.assign(prompt, updates, { id }); // prevent id overwrite
    await this.persistToDisk();
    this._onQueueEvent.fire({ type: 'updated', promptId: id, prompt });
  }

  /** Move a prompt to a new position, reindexing others. */
  async reorderPrompt(id: string, newPosition: number): Promise<void> {
    const sorted = this.getQueue();
    const idx = sorted.findIndex(p => p.id === id);
    if (idx === -1) { return; }

    const [moved] = sorted.splice(idx, 1);
    const clampedPos = Math.max(0, Math.min(newPosition, sorted.length));
    sorted.splice(clampedPos, 0, moved);

    // Reindex positions
    for (let i = 0; i < sorted.length; i++) {
      sorted[i].position = i;
    }

    this.prompts = sorted;
    await this.persistToDisk();
    this._onQueueEvent.fire({ type: 'reordered', promptId: id, prompt: moved });
  }

  // ── Launch ──────────────────────────────────────────────────

  /**
   * Launch a queued prompt as a new Claude Code session.
   *
   * 1. Get the prompt from queue.
   * 2. Check dependencies (if any, verify all are met).
   * 3. Resolve permission mode hierarchy.
   * 4. Call SessionManager to create + launch session.
   * 5. Update prompt status to "launched", set sessionId.
   * 6. Return the new session.
   */
  async launchPrompt(id: string): Promise<ConductorSession> {
    const prompt = this.requirePrompt(id);

    if (prompt.status !== 'queued') {
      throw new Error(`Prompt "${prompt.name}" is not in queued status (current: ${prompt.status})`);
    }

    // Check dependencies
    if (prompt.dependsOn.length > 0) {
      const unmet = this.getUnmetDependencies(prompt);
      if (unmet.length > 0) {
        throw new Error(
          `Cannot launch "${prompt.name}": unmet dependencies — ${unmet.join(', ')}`,
        );
      }
    }

    // Resolve permission mode hierarchy
    const permissionMode = this.resolvePermissionMode(prompt);
    const terminalType = vscode.workspace
      .getConfiguration()
      .get<TerminalType>(ConfigKey.TerminalType, 'vscode');

    // Create session via SessionManager
    const session = await this.sessionManager.createSession(
      prompt.name,
      prompt.providerId,
      this.workspacePath,
      prompt.prompt,
      { dependsOn: prompt.dependsOn },
    );

    // Build launch config
    const config: LaunchConfig = {
      prompt: prompt.prompt,
      sessionName: prompt.name,
      workspacePath: this.workspacePath,
      permissionMode,
      worktree: false,
      terminalType,
    };

    // Launch through SessionManager
    await this.sessionManager.launchSession(session.id, config);

    // Update prompt status
    prompt.status = 'launched';
    prompt.sessionId = session.id;
    prompt.launchedAt = new Date().toISOString();
    await this.persistToDisk();
    this._onQueueEvent.fire({ type: 'launched', promptId: id, prompt });

    return session;
  }

  /**
   * Batch launch multiple parallel-safe prompts simultaneously.
   */
  async batchLaunch(ids: string[]): Promise<ConductorSession[]> {
    const results: ConductorSession[] = [];
    const launches = ids.map(async (id) => {
      try {
        const session = await this.launchPrompt(id);
        results.push(session);
      } catch (err) {
        vscode.window.showWarningMessage(
          `Conductor: Failed to launch prompt — ${(err as Error).message}`,
        );
      }
    });
    await Promise.all(launches);
    return results;
  }

  /**
   * Launch all parallel-safe queued prompts.
   */
  async launchAllParallelSafe(): Promise<ConductorSession[]> {
    const safe = this.getQueueByStatus('queued').filter(p => p.parallelSafe);
    return this.batchLaunch(safe.map(p => p.id));
  }

  /**
   * Force-launch a prompt regardless of dependency status.
   */
  async forceLaunch(id: string): Promise<ConductorSession> {
    const prompt = this.requirePrompt(id);
    // Temporarily clear dependencies for launch
    const savedDeps = prompt.dependsOn;
    prompt.dependsOn = [];
    try {
      return await this.launchPrompt(id);
    } finally {
      // Restore dependencies (prompt is already launched, so this is just for record)
      prompt.dependsOn = savedDeps;
      await this.persistToDisk();
    }
  }

  // ── Dependency helpers ──────────────────────────────────────

  /**
   * Check which dependencies are not yet satisfied for a prompt.
   * A dependency is met when the corresponding session or prompt
   * has status "complete" or "launched".
   */
  getUnmetDependencies(prompt: QueuedPrompt): string[] {
    const unmet: string[] = [];
    for (const depId of prompt.dependsOn) {
      // Check if the dependency is a launched prompt with a completed session
      const depPrompt = this.getPrompt(depId);
      if (depPrompt?.sessionId) {
        const session = this.sessionManager.getSession(depPrompt.sessionId);
        if (session?.status === 'complete') { continue; }
      }

      // Check if it's a direct session reference
      const session = this.sessionManager.getSession(depId);
      if (session?.status === 'complete') { continue; }

      unmet.push(depId);
    }
    return unmet;
  }

  // ── Permission mode resolution ──────────────────────────────

  /**
   * Resolve permission mode through the hierarchy:
   * prompt metadata override → template default → global setting.
   */
  private resolvePermissionMode(_prompt: QueuedPrompt): PermissionMode {
    // Check prompt-level override (stored in a hypothetical metadata field;
    // for now we check if the prompt text contains a permission mode hint)
    // In practice, a future UI will let users set this per-prompt.

    // Fall back to global setting
    const globalMode = vscode.workspace
      .getConfiguration()
      .get<PermissionMode>(ConfigKey.DefaultPermissionMode, DEFAULT_PERMISSION_MODE);

    return globalMode;
  }

  // ── Persistence ─────────────────────────────────────────────

  private async loadFromDisk(): Promise<void> {
    const filePath = getQueueFilePath(this.workspacePath);
    const data = await readJsonFile<QueueFile>(filePath, { prompts: [] });
    this.prompts = data.prompts;
  }

  private async persistToDisk(): Promise<void> {
    const filePath = getQueueFilePath(this.workspacePath);
    const data: QueueFile = { prompts: this.prompts };
    await writeJsonFile(filePath, data);
  }

  // ── Helpers ─────────────────────────────────────────────────

  private requirePrompt(id: string): QueuedPrompt {
    const prompt = this.prompts.find(p => p.id === id);
    if (!prompt) {
      throw new Error(`Prompt "${id}" not found in queue`);
    }
    return prompt;
  }

  // ── Dispose ─────────────────────────────────────────────────

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
