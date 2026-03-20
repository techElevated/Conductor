/**
 * Conductor — Extension-wide constants.
 *
 * Single source of truth for IDs, command names, view IDs,
 * configuration keys, and filesystem path segments used throughout
 * the extension.  Nothing here is provider-specific — provider
 * constants live in their own adapters.
 */

// ── Extension identity ──────────────────────────────────────────

export const EXTENSION_ID = 'techElevated.conductor';
export const EXTENSION_NAME = 'Conductor';

// ── View container & view IDs ───────────────────────────────────

export const VIEW_CONTAINER_ID = 'conductor';

export const ViewId = {
  Sessions: 'conductor.sessions',
  Approvals: 'conductor.approvals',
  PromptQueue: 'conductor.promptQueue',
  TaskInbox: 'conductor.taskInbox',
  Dependencies: 'conductor.dependencies',
  Templates: 'conductor.templates',
} as const;

// ── Command IDs ─────────────────────────────────────────────────

export const CommandId = {
  // Session lifecycle
  LaunchSession: 'conductor.launchSession',
  KillSession: 'conductor.killSession',
  RestartSession: 'conductor.restartSession',
  JumpToSession: 'conductor.jumpToSession',

  // Approvals
  ApproveAction: 'conductor.approveAction',
  DenyAction: 'conductor.denyAction',
  ApproveAll: 'conductor.approveAll',
  DenyAll: 'conductor.denyAll',

  // Prompt queue
  AddPrompt: 'conductor.addPrompt',
  AddPromptFromClipboard: 'conductor.addPromptFromClipboard',
  LaunchPrompt: 'conductor.launchPrompt',
  LaunchAllPrompts: 'conductor.launchAllPrompts',
  EditPrompt: 'conductor.editPrompt',
  DeletePrompt: 'conductor.deletePrompt',

  // Human tasks
  AddTask: 'conductor.addTask',
  CompleteTask: 'conductor.completeTask',
  DismissTask: 'conductor.dismissTask',

  // Templates
  CreateTemplate: 'conductor.createTemplate',
  LaunchTemplate: 'conductor.launchTemplate',
  ImportTemplate: 'conductor.importTemplate',
  ExportTemplate: 'conductor.exportTemplate',
  DeleteTemplate: 'conductor.deleteTemplate',

  // Interaction
  OpenInteraction: 'conductor.openInteraction',
  SendMessage: 'conductor.sendMessage',

  // Layout / setup
  ShowSetupWizard: 'conductor.showSetupWizard',
  ChangeLayout: 'conductor.changeLayout',

  // Misc
  RefreshAll: 'conductor.refreshAll',
  OpenSettings: 'conductor.openSettings',
} as const;

// ── Configuration keys (conductor.*) ────────────────────────────

export const ConfigKey = {
  Layout: 'conductor.layout',
  InteractionDefaultTarget: 'conductor.interaction.defaultTarget',
  InteractionClickBehavior: 'conductor.interaction.clickBehavior',
  NotificationStyle: 'conductor.notifications.style',
  DefaultPermissionMode: 'conductor.defaultPermissionMode',
  TerminalType: 'conductor.terminal.type',
  SessionPollIntervalMs: 'conductor.sessionPollIntervalMs',
  OutputHistoryLimit: 'conductor.outputHistoryLimit',
} as const;

// ── Layout options ──────────────────────────────────────────────

export type LayoutOption = 'sidebar-left' | 'sidebar-right' | 'bottom' | 'split';

export const DEFAULT_LAYOUT: LayoutOption = 'split';

// ── Permission modes (Claude Code) ──────────────────────────────

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'accept-all' | 'bypass';

export const DEFAULT_PERMISSION_MODE: PermissionMode = 'default';

// ── Terminal types ──────────────────────────────────────────────

export type TerminalType = 'vscode' | 'tmux';

export const DEFAULT_TERMINAL_TYPE: TerminalType = 'vscode';

// ── Notification styles ─────────────────────────────────────────

export type NotificationStyle = 'badge-only' | 'toast' | 'sound' | 'toast-and-badge' | 'toast-badge-sound' | 'none';

export const DEFAULT_NOTIFICATION_STYLE: NotificationStyle = 'toast-and-badge';

// ── Filesystem path segments ────────────────────────────────────
// Relative to the user home directory (~/).  Resolved at runtime
// by storage/paths.ts.

export const CONDUCTOR_DIR = '.conductor';

export const StoragePath = {
  Sessions: 'sessions.json',
  Approvals: 'approvals',
  Tasks: 'tasks',
  Queue: 'queue',
  Templates: 'templates',
  Hooks: 'hooks',
  Bin: 'bin',
} as const;

// ── Timing defaults ─────────────────────────────────────────────

export const SESSION_POLL_INTERVAL_MS = 2_000;
export const APPROVAL_STALE_CHECK_INTERVAL_MS = 30_000;
export const WAITING_THRESHOLD_MS = 5_000;
export const OUTPUT_HISTORY_LIMIT = 50;

// ── Global state keys ───────────────────────────────────────────

export const StateKey = {
  HasCompletedSetup: 'conductor.hasCompletedSetup',
} as const;

// ── Context keys (for `when` clauses) ───────────────────────────

export const ContextKey = {
  Layout: 'conductor.layout',
  HasPendingApprovals: 'conductor.hasPendingApprovals',
  PendingApprovalCount: 'conductor.pendingApprovalCount',
  IsActive: 'conductor.isActive',
} as const;
