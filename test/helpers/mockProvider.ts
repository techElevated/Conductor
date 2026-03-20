/**
 * Conductor — Mock ProviderAdapter for integration tests.
 *
 * Returns a fully-typed ProviderAdapter stub with call tracking,
 * so tests can assert which methods were called and with what args.
 */

import type {
  ProviderAdapter,
  LaunchConfig,
  ManagedSession,
  DiscoveredSession,
  SessionState,
  SessionOutputEvent,
} from '../../src/types';

// ── Call log ──────────────────────────────────────────────────────

export interface MockProviderCallLog {
  launchSession: LaunchConfig[];
  killSession: string[];
  installApprovalHook: ManagedSession[];
  discoverSessions: string[];
}

// ── Factory ──────────────────────────────────────────────────────

export function createMockProvider(
  overrides: Partial<ProviderAdapter> = {},
): { provider: ProviderAdapter; calls: MockProviderCallLog } {
  let launchCount = 0;

  const calls: MockProviderCallLog = {
    launchSession: [],
    killSession: [],
    installApprovalHook: [],
    discoverSessions: [],
  };

  const provider: ProviderAdapter = {
    providerId: 'claude-code',
    displayName: 'Claude Code (Mock)',
    iconPath: '',

    async discoverSessions(workspacePath: string): Promise<DiscoveredSession[]> {
      calls.discoverSessions.push(workspacePath);
      return [];
    },

    async launchSession(config: LaunchConfig): Promise<ManagedSession> {
      calls.launchSession.push(config);
      launchCount++;
      return {
        id: `managed-${launchCount}`,
        pid: 10000 + launchCount,
        terminal: {
          sendText: () => { /* no-op */ },
          show: () => { /* no-op */ },
          dispose: () => { /* no-op */ },
        } as unknown as import('vscode').Terminal,
        workspacePath: config.workspacePath,
      };
    },

    async installApprovalHook(session: ManagedSession): Promise<void> {
      calls.installApprovalHook.push(session);
    },

    async readSessionState(): Promise<SessionState> {
      return {
        status: 'running',
        lastOutput: '',
        lastActivityAt: new Date(),
        startedAt: new Date(),
        completedAt: null,
        exitCode: null,
        pendingApprovals: [],
      };
    },

    onStateChange() {
      return { dispose: () => { /* no-op */ } };
    },

    async approveAction(): Promise<void> { /* no-op */ },
    async denyAction(): Promise<void> { /* no-op */ },
    async killSession(sessionId: string): Promise<void> {
      calls.killSession.push(sessionId);
    },

    getTerminal() { return null; },

    async sendMessage(): Promise<void> { /* no-op */ },

    onSessionOutput() {
      return { dispose: () => { /* no-op */ } };
    },

    async getSessionHistory(): Promise<SessionOutputEvent[]> {
      return [];
    },

    ...overrides,
  };

  return { provider, calls };
}
