/**
 * Conductor — SessionManager.
 *
 * Central session lifecycle management.  Owns the canonical list of
 * ConductorSession objects, persists them to disk, discovers sessions
 * from providers, and emits events on state transitions.
 *
 * PRD v1.1 §5.1 — SessionManager.ts
 */

import * as vscode from 'vscode';
import { v4 as uuid } from 'uuid';
import type {
  ConductorSession,
  SessionStatus,
  SessionEvent,
  DiscoveredSession,
  LaunchConfig,
  ManagedSession,
} from '../types';
import { readJsonFile, writeJsonFile } from '../storage/FileStore';
import { getSessionsFilePath } from '../storage/paths';
import { requireProvider, getAllProviders } from '../providers';
import { SESSION_POLL_INTERVAL_MS } from '../constants';

// ── Persisted format ────────────────────────────────────────────

interface SessionsFile {
  sessions: ConductorSession[];
}

// ── SessionManager ──────────────────────────────────────────────

export class SessionManager implements vscode.Disposable {
  private sessions = new Map<string, ConductorSession>();
  private readonly _onSessionEvent = new vscode.EventEmitter<SessionEvent>();
  readonly onSessionEvent = this._onSessionEvent.event;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(this._onSessionEvent);
  }

  // ── Initialisation ──────────────────────────────────────────

  /** Load persisted sessions and start the polling loop. */
  async initialise(): Promise<void> {
    await this.loadFromDisk();
    this.startPolling();
  }

  // ── Queries ─────────────────────────────────────────────────

  getSession(id: string): ConductorSession | undefined {
    return this.sessions.get(id);
  }

  getAllSessions(): ConductorSession[] {
    return [...this.sessions.values()];
  }

  getSessionsByStatus(status: SessionStatus): ConductorSession[] {
    return this.getAllSessions().filter(s => s.status === status);
  }

  getSessionsByWorkspace(workspacePath: string): ConductorSession[] {
    return this.getAllSessions().filter(s => s.workspacePath === workspacePath);
  }

  // ── Mutations ───────────────────────────────────────────────

  /**
   * Register a brand-new session (e.g. from the prompt queue).
   * Status starts as 'queued'.
   */
  async createSession(
    name: string,
    providerId: string,
    workspacePath: string,
    prompt: string,
    opts?: {
      dependsOn?: string[];
      templateId?: string;
    },
  ): Promise<ConductorSession> {
    const session: ConductorSession = {
      id: uuid(),
      name,
      providerId,
      workspacePath,
      prompt,
      status: 'queued',
      pid: null,
      terminalId: null,
      hookInstalled: false,
      dependsOn: opts?.dependsOn ?? [],
      templateId: opts?.templateId ?? null,
      createdAt: new Date().toISOString(),
      launchedAt: null,
      completedAt: null,
      exitCode: null,
      metadata: {},
    };

    this.sessions.set(session.id, session);
    await this.persistToDisk();
    this.emit('created', session);
    return session;
  }

  /**
   * Launch a queued session through its provider adapter.
   */
  async launchSession(sessionId: string, config: LaunchConfig): Promise<ManagedSession> {
    const session = this.requireSession(sessionId);
    const provider = requireProvider(session.providerId);
    const managed = await provider.launchSession(config);

    session.status = 'running';
    session.pid = managed.pid;
    session.launchedAt = new Date().toISOString();
    await this.persistToDisk();
    this.emit('launched', session);

    return managed;
  }

  /**
   * Update a session's status.  Emits a stateChanged event.
   */
  async updateStatus(
    sessionId: string,
    status: SessionStatus,
    extras?: Partial<Pick<ConductorSession, 'exitCode' | 'completedAt'>>,
  ): Promise<void> {
    const session = this.requireSession(sessionId);
    const prev = session.status;
    if (prev === status) { return; }

    session.status = status;
    if (extras?.exitCode !== undefined) { session.exitCode = extras.exitCode; }
    if (extras?.completedAt !== undefined) { session.completedAt = extras.completedAt; }
    if (status === 'complete' || status === 'error') {
      session.completedAt = session.completedAt ?? new Date().toISOString();
    }

    await this.persistToDisk();

    const type = status === 'complete' ? 'completed'
      : status === 'error' ? 'error'
      : 'stateChanged';
    this.emit(type, session, prev);
  }

  /**
   * Kill a running session through its provider adapter and update state.
   */
  async killSession(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    const provider = requireProvider(session.providerId);
    await provider.killSession(sessionId);
    await this.updateStatus(sessionId, 'error', {
      exitCode: -1,
      completedAt: new Date().toISOString(),
    });
    this.emit('killed', session);
  }

  /**
   * Remove a session from the registry entirely.
   */
  async removeSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    await this.persistToDisk();
  }

  /**
   * Merge externally discovered sessions (from provider adapters)
   * into the registry.  New sessions are added; known sessions have
   * their status refreshed.
   */
  async mergeDiscovered(discovered: DiscoveredSession[], providerId: string): Promise<void> {
    let changed = false;

    for (const disc of discovered) {
      const existing = this.sessions.get(disc.id);
      if (existing) {
        if (existing.status !== disc.status) {
          existing.status = disc.status;
          changed = true;
          this.emit('stateChanged', existing);
        }
      } else {
        const session: ConductorSession = {
          id: disc.id,
          name: disc.name,
          providerId,
          workspacePath: disc.workspacePath,
          prompt: '',
          status: disc.status,
          pid: disc.pid,
          terminalId: null,
          hookInstalled: disc.managed,
          dependsOn: [],
          templateId: null,
          createdAt: disc.startedAt,
          launchedAt: disc.startedAt,
          completedAt: null,
          exitCode: null,
          metadata: { discoveredExternally: true },
        };
        this.sessions.set(session.id, session);
        changed = true;
        this.emit('created', session);
      }
    }

    if (changed) {
      await this.persistToDisk();
    }
  }

  // ── Discovery polling ───────────────────────────────────────

  /**
   * Run a single discovery + state-refresh pass across all providers
   * for the given workspace path.
   */
  async refreshSessions(workspacePath: string): Promise<void> {
    const providers = getAllProviders();

    for (const provider of providers) {
      try {
        const discovered = await provider.discoverSessions(workspacePath);
        await this.mergeDiscovered(discovered, provider.providerId);
      } catch {
        // Provider discovery failure is non-fatal; log and continue
      }
    }

    // Refresh live state for running/waiting sessions
    for (const session of this.sessions.values()) {
      if (session.workspacePath !== workspacePath) { continue; }
      if (session.status !== 'running' && session.status !== 'waiting') { continue; }

      try {
        const provider = requireProvider(session.providerId);
        const state = await provider.readSessionState(session.id);
        if (state.status !== session.status) {
          await this.updateStatus(session.id, state.status, {
            exitCode: state.exitCode ?? undefined,
          });
        }
      } catch {
        // State read failure for a single session is non-fatal
      }
    }
  }

  // ── Persistence ─────────────────────────────────────────────

  private async loadFromDisk(): Promise<void> {
    const data = await readJsonFile<SessionsFile>(getSessionsFilePath(), { sessions: [] });
    this.sessions.clear();
    for (const s of data.sessions) {
      this.sessions.set(s.id, s);
    }
  }

  private async persistToDisk(): Promise<void> {
    const data: SessionsFile = { sessions: [...this.sessions.values()] };
    await writeJsonFile(getSessionsFilePath(), data);
  }

  // ── Polling loop ────────────────────────────────────────────

  private startPolling(): void {
    if (this.pollTimer) { return; }
    this.pollTimer = setInterval(() => {
      const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (workspacePath) {
        this.refreshSessions(workspacePath).catch(() => { /* swallow */ });
      }
    }, SESSION_POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // ── Helpers ─────────────────────────────────────────────────

  private requireSession(id: string): ConductorSession {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Session "${id}" not found`);
    }
    return session;
  }

  private emit(
    type: SessionEvent['type'],
    session: ConductorSession,
    previousStatus?: SessionStatus,
  ): void {
    this._onSessionEvent.fire({ type, sessionId: session.id, session, previousStatus });
  }

  // ── Dispose ─────────────────────────────────────────────────

  dispose(): void {
    this.stopPolling();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
