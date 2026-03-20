/**
 * Conductor — TaskDetector.
 *
 * Watches JSONL session logs for new `assistant` entries and runs the
 * pattern matcher against each one.  High/medium confidence matches
 * are persisted as HumanTask objects; low confidence matches are
 * persisted with needsConfirmation flagged in metadata.
 *
 * PRD v1.1 §4d, Implementation Plan §7 Task 4.2
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import { v4 as uuid } from 'uuid';
import type { HumanTask, TaskEvent, ConductorSession } from '../types';
import type { SessionManager } from './SessionManager';
import type { TaskFeedback } from './TaskFeedback';
import { matchTasks, parseStructuredTask, isSimilarDescription } from '../utils/patternMatcher';
import { watchNewEntries } from '../utils/jsonlParser';
import { readJsonFile, writeJsonFile, ensureDir } from '../storage/FileStore';
import { getTasksFilePath } from '../storage/paths';
import { getProviderProjectsDir } from '../providers/ProviderPaths';
import * as path from 'path';
import * as crypto from 'crypto';

// ── Persisted format ─────────────────────────────────────────────

interface TasksFile {
  tasks: HumanTask[];
}

// ── Internal extended task ───────────────────────────────────────

interface InternalTask extends HumanTask {
  /** True if low-confidence match; surfaced but not highlighted */
  needsConfirmation?: boolean;
}

// ── TaskDetector ─────────────────────────────────────────────────

export class TaskDetector implements vscode.Disposable {
  private tasks = new Map<string, InternalTask>();
  private workspacePath: string;

  private readonly _onTaskEvent = new vscode.EventEmitter<TaskEvent>();
  readonly onTaskEvent = this._onTaskEvent.event;

  private readonly disposables: vscode.Disposable[] = [];
  /** Map sessionId → log-watcher disposable */
  private watchers = new Map<string, vscode.Disposable>();

  constructor(
    workspacePath: string,
    private readonly sessionManager: SessionManager,
    private readonly feedback: TaskFeedback,
  ) {
    this.workspacePath = workspacePath;
    this.disposables.push(this._onTaskEvent);

    // Subscribe to session lifecycle events
    this.disposables.push(
      sessionManager.onSessionEvent(ev => {
        if (ev.type === 'launched' || ev.type === 'created') {
          this.watchSession(ev.session);
        } else if (ev.type === 'completed' || ev.type === 'killed') {
          this.stopWatching(ev.sessionId);
        }
      }),
    );
  }

  // ── Initialisation ───────────────────────────────────────────

  async initialise(): Promise<void> {
    await ensureDir(path.dirname(getTasksFilePath(this.workspacePath)));
    await this.loadFromDisk();

    // Start watching all currently-known sessions
    for (const session of this.sessionManager.getAllSessions()) {
      if (session.status === 'running' || session.status === 'waiting') {
        this.watchSession(session);
      }
    }
  }

  // ── Queries ──────────────────────────────────────────────────

  getAllTasks(): InternalTask[] {
    return [...this.tasks.values()].sort(
      (a, b) => new Date(b.surfacedAt).getTime() - new Date(a.surfacedAt).getTime(),
    );
  }

  getPendingTasks(): InternalTask[] {
    return this.getAllTasks().filter(t => t.status === 'pending' || t.status === 'in-progress');
  }

  getTasksBySession(sessionId: string): InternalTask[] {
    return this.getAllTasks().filter(t => t.sessionId === sessionId);
  }

  // ── Task lifecycle ───────────────────────────────────────────

  async completeTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {return;}

    task.status = 'complete';
    task.completedAt = new Date().toISOString();
    await this.saveToDisk();

    this._onTaskEvent.fire({ type: 'completed', task });
  }

  async dismissTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {return;}

    this.tasks.delete(taskId);
    await this.saveToDisk();

    this._onTaskEvent.fire({ type: 'dismissed', task });
  }

  /**
   * Manually add a human task (captureMethod: 'manual').
   * Persists to disk and fires a task event so the inbox refreshes.
   */
  async addTask(description: string): Promise<void> {
    const task: InternalTask = {
      id: uuid(),
      sessionId: 'manual',
      sessionName: 'Manual',
      description,
      priority: 'normal',
      blocking: false,
      status: 'pending',
      captureMethod: 'manual',
      context: '',
      surfacedAt: new Date().toISOString(),
      completedAt: null,
    };

    this.tasks.set(task.id, task);
    await this.saveToDisk();
    this._onTaskEvent.fire({ type: 'detected', task });
  }

  // ── Watcher management ───────────────────────────────────────

  private watchSession(session: ConductorSession): void {
    if (this.watchers.has(session.id)) {return;}

    const logPath = this.resolveLogPath(session);
    if (!logPath) {return;}

    // Check file exists before watching
    try {
      fs.accessSync(logPath, fs.constants.R_OK);
    } catch {
      return;
    }

    const disposable = watchNewEntries(logPath, (entry: import('../utils/jsonlParser').JsonlEntry) => {
      if (entry.type !== 'assistant') {return;}
      const content = typeof entry.message?.content === 'string'
        ? entry.message.content
        : '';
      if (!content) {return;}
      void this.processEntry(session, content);
    });

    this.watchers.set(session.id, disposable);
    this.disposables.push(disposable);
  }

  private stopWatching(sessionId: string): void {
    const disposable = this.watchers.get(sessionId);
    if (disposable) {
      disposable.dispose();
      this.watchers.delete(sessionId);
    }
  }

  // ── Entry processing ─────────────────────────────────────────

  private async processEntry(
    session: ConductorSession,
    content: string,
  ): Promise<void> {
    const matches = matchTasks(content);
    if (matches.length === 0) {return;}

    for (const match of matches) {
      // Check ignore list before surfacing
      if (this.feedback.isIgnored(match.description, match.patternName)) {continue;}

      // Deduplication: skip if a ≥90% similar task already exists for this session
      const existing = this.getTasksBySession(session.id);
      if (existing.some(t => isSimilarDescription(t.description, match.description))) {continue;}

      // Parse structured fields if it's a tagged block
      const structured = parseStructuredTask(match.raw);

      const task: InternalTask = {
        id: uuid(),
        sessionId: session.id,
        sessionName: session.name,
        description: structured?.description ?? match.description,
        priority: structured?.priority ?? 'normal',
        blocking: structured?.blocking ?? false,
        status: 'pending',
        captureMethod: match.patternName.includes('tag') ? 'agent-tagged' : 'convention-parsed',
        context: content.slice(Math.max(0, match.offset - 100), match.offset + match.raw.length + 100),
        surfacedAt: new Date().toISOString(),
        completedAt: null,
        needsConfirmation: match.confidence === 'low',
      };

      this.tasks.set(task.id, task);
      this._onTaskEvent.fire({ type: 'detected', task });
    }

    await this.saveToDisk();
  }

  // ── Log path resolution ──────────────────────────────────────

  private resolveLogPath(session: ConductorSession): string | null {
    const projectsDir = getProviderProjectsDir('claude-code');
    const hash = hashPath(session.workspacePath);
    const projectDir = path.join(projectsDir, hash);
    const logFile = path.join(projectDir, `${session.id}.jsonl`);
    return logFile;
  }

  // ── Persistence ──────────────────────────────────────────────

  private async loadFromDisk(): Promise<void> {
    const filePath = getTasksFilePath(this.workspacePath);
    const data = await readJsonFile<TasksFile | null>(filePath, null);
    if (data?.tasks) {
      for (const t of data.tasks) {
        this.tasks.set(t.id, t as InternalTask);
      }
    }
  }

  private async saveToDisk(): Promise<void> {
    const filePath = getTasksFilePath(this.workspacePath);
    await writeJsonFile<TasksFile>(filePath, { tasks: [...this.tasks.values()] });
  }

  // ── Disposable ───────────────────────────────────────────────

  dispose(): void {
    for (const d of this.disposables) {d.dispose();}
    for (const w of this.watchers.values()) {w.dispose();}
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function hashPath(p: string): string {
  return crypto.createHash('sha256').update(p).digest('hex').slice(0, 16);
}
