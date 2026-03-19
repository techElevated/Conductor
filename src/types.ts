/**
 * Conductor — Core type definitions.
 *
 * Every data structure persisted to disk or passed between major
 * subsystems is defined here.  Matches PRD v1.1 Section 5.3 / 5.4.
 *
 * Convention: interfaces that map 1-to-1 with JSON files on disk use
 * ISO-8601 strings for dates (`string`).  In-memory-only types may
 * use `Date`.
 */

import type { Disposable, Terminal } from 'vscode';
import type { PermissionMode } from './constants';

// ── Session status ──────────────────────────────────────────────

export type SessionStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'complete'
  | 'error'
  | 'blocked';

// ── Conductor session (persisted in sessions.json) ──────────────

export interface ConductorSession {
  id: string;
  name: string;
  providerId: string;
  workspacePath: string;
  prompt: string;
  status: SessionStatus;
  pid: number | null;
  terminalId: string | null;
  hookInstalled: boolean;
  dependsOn: string[];
  templateId: string | null;
  createdAt: string;
  launchedAt: string | null;
  completedAt: string | null;
  exitCode: number | null;
  metadata: Record<string, unknown>;
}

// ── Session state (live, returned by ProviderAdapter) ───────────

export interface SessionState {
  status: SessionStatus;
  lastOutput: string;
  lastActivityAt: Date;
  startedAt: Date;
  completedAt: Date | null;
  exitCode: number | null;
  pendingApprovals: PendingApproval[];
  tokenUsage?: TokenUsage;
}

export interface TokenUsage {
  input: number;
  output: number;
  cost: number;
}

// ── Session output event (streamed from provider) ───────────────

export type SessionOutputType =
  | 'assistant'
  | 'tool_use'
  | 'tool_result'
  | 'error'
  | 'system';

export interface SessionOutputEvent {
  type: SessionOutputType;
  content: string;
  timestamp: string;
  metadata?: SessionOutputMetadata;
}

export interface SessionOutputMetadata {
  toolName?: string;
  command?: string;
  exitCode?: number;
}

// ── Pending approval ────────────────────────────────────────────

export type ApprovalStatus = 'pending' | 'approved' | 'denied';

export interface PendingApproval {
  id: string;
  sessionId: string;
  sessionName: string;
  tool: string;
  command: string;
  context: string;
  timestamp: string;
  status: ApprovalStatus;
  resolvedAt: string | null;
}

// ── Human task ──────────────────────────────────────────────────

export type TaskPriority = 'urgent' | 'normal' | 'low';
export type TaskStatus = 'pending' | 'in-progress' | 'complete';
export type TaskCaptureMethod = 'agent-tagged' | 'convention-parsed' | 'manual';

export interface HumanTask {
  id: string;
  sessionId: string;
  sessionName: string;
  description: string;
  priority: TaskPriority;
  blocking: boolean;
  status: TaskStatus;
  captureMethod: TaskCaptureMethod;
  context: string;
  surfacedAt: string;
  completedAt: string | null;
}

// ── Queued prompt ───────────────────────────────────────────────

export type PromptComplexity = 'small' | 'medium' | 'large';
export type PromptStatus = 'queued' | 'launched' | 'cancelled';

export interface QueuedPrompt {
  id: string;
  name: string;
  description: string;
  prompt: string;
  providerId: string;
  parallelSafe: boolean;
  complexity: PromptComplexity;
  dependsOn: string[];
  status: PromptStatus;
  sessionId: string | null;
  position: number;
  createdAt: string;
  launchedAt: string | null;
}

// ── Session template ────────────────────────────────────────────

export type TemplateScope = 'user' | 'project';

export interface SessionTemplate {
  id: string;
  name: string;
  description: string;
  version: number;
  variables: TemplateVariable[];
  sessions: TemplateSession[];
  createdAt: string;
  lastUsedAt: string | null;
  scope: TemplateScope;
}

export interface TemplateVariable {
  name: string;
  description: string;
  default: string;
  required: boolean;
}

export interface TemplateSession {
  templateSessionId: string;
  name: string;
  prompt: string;
  providerId: string;
  parallelSafe: boolean;
  dependsOn: string[];
  permissionMode: PermissionMode;
}

// ── Launch config (passed to ProviderAdapter.launchSession) ─────

export interface LaunchConfig {
  prompt: string;
  sessionName: string;
  workspacePath: string;
  permissionMode: PermissionMode;
  worktree: boolean;
  terminalType: 'vscode' | 'tmux';
  env?: Record<string, string>;
}

// ── Discovered session (returned by ProviderAdapter.discoverSessions) ─

export interface DiscoveredSession {
  id: string;
  name: string;
  workspacePath: string;
  pid: number | null;
  status: SessionStatus;
  startedAt: string;
  managed: boolean;
}

// ── Managed session (returned by ProviderAdapter.launchSession) ─

export interface ManagedSession {
  id: string;
  pid: number;
  terminal: Terminal | null;
  workspacePath: string;
}

// ── Provider adapter interface ──────────────────────────────────
// Defined here for import convenience; the canonical location is
// providers/ProviderAdapter.ts which re-exports this.

export interface ProviderAdapter {
  readonly providerId: string;
  readonly displayName: string;
  readonly iconPath: string;

  discoverSessions(workspacePath: string): Promise<DiscoveredSession[]>;
  launchSession(config: LaunchConfig): Promise<ManagedSession>;
  installApprovalHook(session: ManagedSession): Promise<void>;
  readSessionState(sessionId: string): Promise<SessionState>;
  onStateChange(sessionId: string, callback: (state: SessionState) => void): Disposable;
  approveAction(approvalId: string): Promise<void>;
  denyAction(approvalId: string): Promise<void>;
  killSession(sessionId: string): Promise<void>;
  getTerminal(sessionId: string): Terminal | null;
  sendMessage(sessionId: string, message: string): Promise<void>;
  onSessionOutput(sessionId: string, callback: (output: SessionOutputEvent) => void): Disposable;
  getSessionHistory(sessionId: string, limit: number): Promise<SessionOutputEvent[]>;
}

// ── Event types (internal pub/sub) ──────────────────────────────

export interface SessionEvent {
  type: 'created' | 'launched' | 'stateChanged' | 'completed' | 'error' | 'killed';
  sessionId: string;
  session: ConductorSession;
  previousStatus?: SessionStatus;
}

export interface ApprovalEvent {
  type: 'new' | 'resolved' | 'stale';
  approval: PendingApproval;
}

export interface TaskEvent {
  type: 'detected' | 'completed' | 'dismissed';
  task: HumanTask;
}
