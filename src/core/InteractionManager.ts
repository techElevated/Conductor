/**
 * Conductor — InteractionManager.
 *
 * Session I/O routing layer.  Routes messages and output events
 * between the interaction surface (WebviewPanel) and the provider
 * adapters.  Manages active/background streaming optimisation:
 * only the actively-visible session streams in real-time; background
 * tabs update on a 5-second poll.
 *
 * PRD v1.1 §4g, Implementation Plan §8 Task 5.1
 */

import * as vscode from 'vscode';
import type {
  SessionOutputEvent,
  ConductorSession,
} from '../types';
import { requireProvider } from '../providers';
import type { SessionManager } from './SessionManager';

// ── Constants ────────────────────────────────────────────────────

const BACKGROUND_POLL_INTERVAL_MS = 5_000;

// ── Types ────────────────────────────────────────────────────────

export interface OutputSubscription {
  sessionId: string;
  callback: (event: SessionOutputEvent) => void;
}

interface TrackedSession {
  sessionId: string;
  providerId: string;
  active: boolean;
  /** Live stream disposable (real-time via provider adapter) */
  streamDisposable: vscode.Disposable | null;
  /** Cached events for quick tab-switch rendering */
  cachedEvents: SessionOutputEvent[];
  /** Subscribers to output events */
  subscribers: Set<OutputSubscription>;
  /** Last poll timestamp for background tabs */
  lastPollAt: number;
}

// ── InteractionManager ──────────────────────────────────────────

export class InteractionManager implements vscode.Disposable {
  private tracked = new Map<string, TrackedSession>();
  private backgroundPollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly disposables: vscode.Disposable[] = [];

  private readonly _onSessionOpened = new vscode.EventEmitter<string>();
  readonly onSessionOpened = this._onSessionOpened.event;

  private readonly _onSessionClosed = new vscode.EventEmitter<string>();
  readonly onSessionClosed = this._onSessionClosed.event;

  constructor(private readonly sessionManager: SessionManager) {
    this.disposables.push(this._onSessionOpened, this._onSessionClosed);
    this.startBackgroundPoll();
  }

  // ── Public API ───────────────────────────────────────────────

  /**
   * Register a session for interaction.  Starts real-time streaming
   * if the session is marked active (visible tab).
   */
  openSession(sessionId: string): void {
    if (this.tracked.has(sessionId)) {
      return; // already open
    }

    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found`);
    }

    const entry: TrackedSession = {
      sessionId,
      providerId: session.providerId,
      active: true, // new sessions open as the active tab
      streamDisposable: null,
      cachedEvents: [],
      subscribers: new Set(),
      lastPollAt: Date.now(),
    };

    this.tracked.set(sessionId, entry);
    this.startRealTimeStream(entry);
    this._onSessionOpened.fire(sessionId);
  }

  /**
   * Unregister a session from interaction.  Stops streaming and
   * cleans up subscribers.
   */
  closeSession(sessionId: string): void {
    const entry = this.tracked.get(sessionId);
    if (!entry) { return; }

    entry.streamDisposable?.dispose();
    entry.subscribers.clear();
    this.tracked.delete(sessionId);
    this._onSessionClosed.fire(sessionId);
  }

  /**
   * Send a message to a session via its provider adapter.
   */
  async sendMessage(sessionId: string, message: string): Promise<void> {
    const entry = this.tracked.get(sessionId);
    if (!entry) {
      // Allow sending to sessions not explicitly opened in the panel
      const session = this.sessionManager.getSession(sessionId);
      if (!session) {
        throw new Error(`Session "${sessionId}" not found`);
      }
      const provider = requireProvider(session.providerId);
      await provider.sendMessage(sessionId, message);
      return;
    }

    const provider = requireProvider(entry.providerId);
    await provider.sendMessage(sessionId, message);
  }

  /**
   * Subscribe to output events for a session.  Returns a Disposable
   * that removes the subscription when disposed.
   */
  subscribeToOutput(
    sessionId: string,
    callback: (event: SessionOutputEvent) => void,
  ): vscode.Disposable {
    let entry = this.tracked.get(sessionId);
    if (!entry) {
      // Auto-open the session if not already tracked
      this.openSession(sessionId);
      entry = this.tracked.get(sessionId)!;
    }

    const sub: OutputSubscription = { sessionId, callback };
    entry.subscribers.add(sub);

    // Replay cached events immediately so the subscriber sees history
    for (const event of entry.cachedEvents) {
      callback(event);
    }

    return new vscode.Disposable(() => {
      entry!.subscribers.delete(sub);
    });
  }

  /**
   * Get session output history from the provider adapter.
   */
  async getHistory(
    sessionId: string,
    limit: number,
  ): Promise<SessionOutputEvent[]> {
    const session = this.resolveSession(sessionId);
    const provider = requireProvider(session.providerId);
    return provider.getSessionHistory(sessionId, limit);
  }

  /**
   * Mark a session tab as the actively-visible one.
   * Switches it to real-time streaming and demotes the previous
   * active session to background polling.
   */
  setActiveSession(sessionId: string): void {
    for (const [id, entry] of this.tracked) {
      if (id === sessionId) {
        if (!entry.active) {
          entry.active = true;
          this.startRealTimeStream(entry);
        }
      } else if (entry.active) {
        entry.active = false;
        this.stopRealTimeStream(entry);
      }
    }
  }

  /**
   * Get the currently active (foreground) session ID, if any.
   */
  getActiveSessionId(): string | null {
    for (const [id, entry] of this.tracked) {
      if (entry.active) { return id; }
    }
    return null;
  }

  /**
   * Get all open (tracked) session IDs.
   */
  getOpenSessionIds(): string[] {
    return [...this.tracked.keys()];
  }

  /**
   * Check if a session is currently open in the interaction panel.
   */
  isSessionOpen(sessionId: string): boolean {
    return this.tracked.has(sessionId);
  }

  /**
   * Get cached events for a session (for instant tab switching).
   */
  getCachedEvents(sessionId: string): SessionOutputEvent[] {
    return this.tracked.get(sessionId)?.cachedEvents ?? [];
  }

  // ── Real-time streaming ──────────────────────────────────────

  private startRealTimeStream(entry: TrackedSession): void {
    // Dispose any existing stream first
    entry.streamDisposable?.dispose();

    try {
      const provider = requireProvider(entry.providerId);
      entry.streamDisposable = provider.onSessionOutput(
        entry.sessionId,
        (event: SessionOutputEvent) => {
          this.handleOutputEvent(entry, event);
        },
      );
    } catch {
      // Provider not available — will rely on background polling
      entry.streamDisposable = null;
    }
  }

  private stopRealTimeStream(entry: TrackedSession): void {
    entry.streamDisposable?.dispose();
    entry.streamDisposable = null;
  }

  private handleOutputEvent(entry: TrackedSession, event: SessionOutputEvent): void {
    // Cache the event (keep last 200 for scroll-back)
    entry.cachedEvents.push(event);
    if (entry.cachedEvents.length > 200) {
      entry.cachedEvents = entry.cachedEvents.slice(-200);
    }

    // Notify all subscribers
    for (const sub of entry.subscribers) {
      try {
        sub.callback(event);
      } catch {
        // Subscriber error is non-fatal
      }
    }
  }

  // ── Background polling ────────────────────────────────────────

  private startBackgroundPoll(): void {
    this.backgroundPollTimer = setInterval(() => {
      this.pollBackgroundSessions();
    }, BACKGROUND_POLL_INTERVAL_MS);
  }

  private async pollBackgroundSessions(): Promise<void> {
    for (const [, entry] of this.tracked) {
      if (entry.active) { continue; } // active sessions use real-time

      const now = Date.now();
      if (now - entry.lastPollAt < BACKGROUND_POLL_INTERVAL_MS) { continue; }
      entry.lastPollAt = now;

      try {
        const provider = requireProvider(entry.providerId);
        const events = await provider.getSessionHistory(entry.sessionId, 10);

        // Find new events (after the last cached timestamp)
        const lastCachedTs = entry.cachedEvents.length > 0
          ? entry.cachedEvents[entry.cachedEvents.length - 1].timestamp
          : '';

        for (const event of events) {
          if (event.timestamp > lastCachedTs) {
            this.handleOutputEvent(entry, event);
          }
        }
      } catch {
        // Poll failure is non-fatal
      }
    }
  }

  // ── Helpers ───────────────────────────────────────────────────

  private resolveSession(sessionId: string): ConductorSession {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found`);
    }
    return session;
  }

  // ── Disposal ──────────────────────────────────────────────────

  dispose(): void {
    if (this.backgroundPollTimer) {
      clearInterval(this.backgroundPollTimer);
      this.backgroundPollTimer = null;
    }

    for (const [, entry] of this.tracked) {
      entry.streamDisposable?.dispose();
      entry.subscribers.clear();
    }
    this.tracked.clear();

    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
