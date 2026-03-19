/**
 * Conductor — DependencyEngine.
 *
 * DAG management for prompt/session dependency chains.  Validates
 * acyclic structure using Kahn's algorithm, auto-launches downstream
 * prompts when upstream sessions complete, and blocks dependents on
 * upstream failure.
 *
 * PRD v1.1 §4e, Implementation Plan §6 Task 3.3
 */

import * as vscode from 'vscode';
import type { QueuedPrompt, ConductorSession } from '../types';
import type { SessionManager } from './SessionManager';
import type { QueueManager } from './QueueManager';

// ── Event types ─────────────────────────────────────────────────

export interface DependencyEvent {
  type: 'auto-launched' | 'blocked' | 'dependency-added' | 'dependency-removed';
  promptId: string;
  prompt?: QueuedPrompt;
  upstreamId?: string;
}

// ── Chain status summary ────────────────────────────────────────

export interface ChainStatus {
  total: number;
  complete: number;
  running: number;
  queued: number;
  failed: number;
  blocked: number;
}

// ── DAG validation result ───────────────────────────────────────

export interface DagValidation {
  valid: boolean;
  cycles?: string[][];
}

// ── DependencyEngine ────────────────────────────────────────────

export class DependencyEngine implements vscode.Disposable {
  private readonly _onDependencyEvent = new vscode.EventEmitter<DependencyEvent>();
  readonly onDependencyEvent = this._onDependencyEvent.event;

  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly queueManager: QueueManager,
  ) {
    // Subscribe to session completion and error events
    this.disposables.push(this._onDependencyEvent);
    this.disposables.push(
      sessionManager.onSessionEvent(async (event) => {
        if (event.type === 'completed') {
          await this.onSessionComplete(event.sessionId);
        } else if (event.type === 'error') {
          await this.onSessionError(event.sessionId);
        }
      }),
    );
  }

  // ── Initialisation ──────────────────────────────────────────

  /** No-op for now; dependencies are stored in prompt queue. */
  async initialise(): Promise<void> {
    // Dependencies are persisted as part of QueuedPrompt.dependsOn
    // and reconstructed from the queue on load.
  }

  // ── Dependency CRUD ─────────────────────────────────────────

  /**
   * Add dependency edges: promptId depends on each ID in dependsOn.
   * Validates no cycles would be introduced.
   */
  async addDependency(promptId: string, dependsOn: string[]): Promise<void> {
    const prompt = this.queueManager.getPrompt(promptId);
    if (!prompt) {
      throw new Error(`Prompt "${promptId}" not found`);
    }

    // Tentatively add the dependencies
    const newDeps = [...new Set([...prompt.dependsOn, ...dependsOn])];
    const tentative = { ...prompt, dependsOn: newDeps };

    // Validate no cycles
    const allPrompts = this.queueManager.getQueue();
    const promptsMap = new Map(allPrompts.map(p => [p.id, p]));
    promptsMap.set(promptId, tentative as QueuedPrompt);

    const validation = this.validateDAGFromPrompts(promptsMap);
    if (!validation.valid) {
      throw new Error(
        `Adding dependency would create a cycle: ${validation.cycles?.map(c => c.join(' → ')).join('; ')}`,
      );
    }

    // Commit the change
    await this.queueManager.updatePrompt(promptId, { dependsOn: newDeps });
    this._onDependencyEvent.fire({
      type: 'dependency-added',
      promptId,
      prompt: this.queueManager.getPrompt(promptId),
    });
  }

  /**
   * Remove a single dependency edge.
   */
  async removeDependency(promptId: string, upstreamId: string): Promise<void> {
    const prompt = this.queueManager.getPrompt(promptId);
    if (!prompt) { return; }

    const newDeps = prompt.dependsOn.filter(id => id !== upstreamId);
    await this.queueManager.updatePrompt(promptId, { dependsOn: newDeps });
    this._onDependencyEvent.fire({
      type: 'dependency-removed',
      promptId,
      upstreamId,
    });
  }

  // ── DAG validation ──────────────────────────────────────────

  /**
   * Validate the full DAG for cycles using Kahn's algorithm.
   */
  validateDAG(): DagValidation {
    const allPrompts = this.queueManager.getQueue();
    const promptsMap = new Map(allPrompts.map(p => [p.id, p]));
    return this.validateDAGFromPrompts(promptsMap);
  }

  private validateDAGFromPrompts(promptsMap: Map<string, QueuedPrompt>): DagValidation {
    // Build adjacency list and in-degree counts
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>(); // upstream → [downstreams]

    for (const [id] of promptsMap) {
      inDegree.set(id, 0);
      if (!adjacency.has(id)) {
        adjacency.set(id, []);
      }
    }

    for (const [id, prompt] of promptsMap) {
      for (const dep of prompt.dependsOn) {
        // Only count edges within known prompts
        if (promptsMap.has(dep)) {
          adjacency.get(dep)!.push(id);
          inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
        }
      }
    }

    // Kahn's algorithm: topological sort
    const queue: string[] = [];
    for (const [id, degree] of inDegree) {
      if (degree === 0) {
        queue.push(id);
      }
    }

    const sorted: string[] = [];
    while (queue.length > 0) {
      const node = queue.shift()!;
      sorted.push(node);

      for (const downstream of (adjacency.get(node) ?? [])) {
        const newDegree = (inDegree.get(downstream) ?? 1) - 1;
        inDegree.set(downstream, newDegree);
        if (newDegree === 0) {
          queue.push(downstream);
        }
      }
    }

    if (sorted.length === promptsMap.size) {
      return { valid: true };
    }

    // Detect cycle members (nodes not in sorted output)
    const cycleNodes = [...promptsMap.keys()].filter(id => !sorted.includes(id));
    return {
      valid: false,
      cycles: [cycleNodes],
    };
  }

  // ── Dependency queries ──────────────────────────────────────

  /**
   * Get all prompts that depend on a given session/prompt ID.
   */
  getDependents(sessionOrPromptId: string): QueuedPrompt[] {
    const allPrompts = this.queueManager.getQueue();

    return allPrompts.filter(p => {
      // Direct dependency on the ID
      if (p.dependsOn.includes(sessionOrPromptId)) { return true; }

      // Check if dependency is via a prompt whose sessionId matches
      for (const depId of p.dependsOn) {
        const depPrompt = this.queueManager.getPrompt(depId);
        if (depPrompt?.sessionId === sessionOrPromptId) { return true; }
      }

      return false;
    });
  }

  /**
   * Check if all upstream dependencies are satisfied (complete) for a prompt.
   */
  allDependenciesMet(promptId: string): boolean {
    const prompt = this.queueManager.getPrompt(promptId);
    if (!prompt) { return false; }
    if (prompt.dependsOn.length === 0) { return true; }

    return this.queueManager.getUnmetDependencies(prompt).length === 0;
  }

  /**
   * Get the topological ordering of all prompts.
   */
  getTopologicalOrder(): QueuedPrompt[] {
    const allPrompts = this.queueManager.getQueue();
    const promptsMap = new Map(allPrompts.map(p => [p.id, p]));

    // Build in-degree
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();

    for (const [id] of promptsMap) {
      inDegree.set(id, 0);
      adjacency.set(id, []);
    }

    for (const [id, prompt] of promptsMap) {
      for (const dep of prompt.dependsOn) {
        if (promptsMap.has(dep)) {
          adjacency.get(dep)!.push(id);
          inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
        }
      }
    }

    const queue: string[] = [];
    for (const [id, degree] of inDegree) {
      if (degree === 0) { queue.push(id); }
    }

    const result: QueuedPrompt[] = [];
    while (queue.length > 0) {
      const node = queue.shift()!;
      const prompt = promptsMap.get(node);
      if (prompt) { result.push(prompt); }

      for (const downstream of (adjacency.get(node) ?? [])) {
        const newDegree = (inDegree.get(downstream) ?? 1) - 1;
        inDegree.set(downstream, newDegree);
        if (newDegree === 0) { queue.push(downstream); }
      }
    }

    return result;
  }

  /**
   * Chain status summary across all prompts with dependencies.
   */
  getChainStatus(): ChainStatus {
    const allPrompts = this.queueManager.getQueue();
    const withDeps = allPrompts.filter(
      p => p.dependsOn.length > 0 || this.getDependents(p.id).length > 0,
    );

    const status: ChainStatus = {
      total: withDeps.length,
      complete: 0,
      running: 0,
      queued: 0,
      failed: 0,
      blocked: 0,
    };

    for (const prompt of withDeps) {
      if (prompt.status === 'launched' && prompt.sessionId) {
        const session = this.sessionManager.getSession(prompt.sessionId);
        switch (session?.status) {
          case 'complete':
            status.complete++;
            break;
          case 'running':
          case 'waiting':
            status.running++;
            break;
          case 'error':
            status.failed++;
            break;
          case 'blocked':
            status.blocked++;
            break;
          default:
            status.running++;
        }
      } else if (prompt.status === 'queued') {
        status.queued++;
      } else if (prompt.status === 'cancelled') {
        status.failed++;
      }
    }

    return status;
  }

  // ── Auto-launch listeners ───────────────────────────────────

  /**
   * Called when a session completes. Check if any dependent prompts
   * can now be auto-launched.
   */
  private async onSessionComplete(sessionId: string): Promise<void> {
    const dependents = this.getDependents(sessionId);

    for (const dependent of dependents) {
      if (dependent.status !== 'queued') { continue; }

      if (this.allDependenciesMet(dependent.id)) {
        try {
          await this.queueManager.launchPrompt(dependent.id);
          vscode.window.showInformationMessage(
            `Conductor: Auto-launching "${dependent.name}" (dependency completed)`,
          );
          this._onDependencyEvent.fire({
            type: 'auto-launched',
            promptId: dependent.id,
            prompt: dependent,
            upstreamId: sessionId,
          });
        } catch (err) {
          vscode.window.showWarningMessage(
            `Conductor: Failed to auto-launch "${dependent.name}" — ${(err as Error).message}`,
          );
        }
      }
    }
  }

  /**
   * Called when a session errors. Block all dependent prompts.
   */
  private async onSessionError(sessionId: string): Promise<void> {
    const dependents = this.getDependents(sessionId);

    for (const dependent of dependents) {
      if (dependent.status !== 'queued') { continue; }

      // Find the upstream prompt name for the message
      const upstreamPrompt = this.findPromptBySessionId(sessionId);
      const upstreamName = upstreamPrompt?.name ?? sessionId;

      await this.queueManager.updatePrompt(dependent.id, {
        status: 'cancelled',
      });

      vscode.window.showWarningMessage(
        `Conductor: "${dependent.name}" blocked — dependency "${upstreamName}" failed`,
      );

      this._onDependencyEvent.fire({
        type: 'blocked',
        promptId: dependent.id,
        prompt: dependent,
        upstreamId: sessionId,
      });
    }
  }

  // ── Manual override ─────────────────────────────────────────

  /**
   * Force-launch a prompt regardless of dependency state.
   */
  async forceLaunch(promptId: string): Promise<ConductorSession> {
    return this.queueManager.forceLaunch(promptId);
  }

  // ── Helpers ─────────────────────────────────────────────────

  private findPromptBySessionId(sessionId: string): QueuedPrompt | undefined {
    return this.queueManager.getQueue().find(p => p.sessionId === sessionId);
  }

  // ── Dispose ─────────────────────────────────────────────────

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
