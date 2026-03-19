/**
 * Conductor — Claude Code provider adapter.
 *
 * Implements the ProviderAdapter interface for Claude Code.  Handles
 * session discovery via ~/.claude/projects/, JSONL log parsing for
 * state detection, process enumeration for liveness, and terminal-
 * based session launch.
 *
 * PRD v1.1 §5.2, §5.3
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type {
  ProviderAdapter,
  DiscoveredSession,
  ManagedSession,
  LaunchConfig,
  SessionState,
  SessionOutputEvent,
  PendingApproval,
} from '../types';
import { getProviderProjectsDir } from './ProviderPaths';
import {
  parseJsonlFile,
  entriesToOutputEvents,
  inferStatusFromEntries,
} from '../utils/jsonlParser';
import { findAgentProcesses, isProcessAlive } from '../utils/processUtils';
import {
  createTerminal,
  type ConductorTerminal,
} from '../platform/TerminalManager';
import { readJsonFile } from '../storage/FileStore';
import { getSessionApprovalsDir, getApprovalDecisionPath } from '../storage/paths';
import { listJsonFiles } from '../storage/FileStore';

// ── Adapter implementation ──────────────────────────────────────

export class ClaudeCodeAdapter implements ProviderAdapter {
  readonly providerId = 'claude-code';
  readonly displayName = 'Claude Code';
  readonly iconPath = 'media/claude-code-icon.svg';

  /** Map sessionId → ConductorTerminal for sessions launched through Conductor */
  private terminals = new Map<string, ConductorTerminal>();

  /** Map sessionId → Disposable for output watchers */
  private outputWatchers = new Map<string, vscode.Disposable>();

  // ── Discovery ─────────────────────────────────────────────

  async discoverSessions(workspacePath: string): Promise<DiscoveredSession[]> {
    const projectsDir = getProviderProjectsDir('claude-code');
    const hash = this.hashPath(workspacePath);
    const projectDir = path.join(projectsDir, hash);

    const sessions: DiscoveredSession[] = [];

    // Check if the project directory exists
    try {
      await fs.promises.access(projectDir, fs.constants.R_OK);
    } catch {
      return sessions;
    }

    // Scan for JSONL files (each represents a session conversation)
    const entries = await fs.promises.readdir(projectDir, { withFileTypes: true });
    const jsonlFiles = entries.filter(
      e => e.isFile() && e.name.endsWith('.jsonl'),
    );

    // Also discover via running processes
    const runningProcesses = await findAgentProcesses('claude');

    for (const file of jsonlFiles) {
      const filePath = path.join(projectDir, file.name);
      const sessionId = path.basename(file.name, '.jsonl');

      const jsonlEntries = await parseJsonlFile(filePath);
      const status = inferStatusFromEntries(jsonlEntries);

      // Check if a matching process is running
      const pid = this.findMatchingProcess(runningProcesses, workspacePath);

      sessions.push({
        id: sessionId,
        name: this.deriveSessionName(jsonlEntries, sessionId),
        workspacePath,
        pid,
        status: pid !== null && isProcessAlive(pid) ? status : 'complete',
        startedAt: this.getFileCreationTime(filePath),
        managed: false,
      });
    }

    return sessions;
  }

  // ── Launch ────────────────────────────────────────────────

  async launchSession(config: LaunchConfig): Promise<ManagedSession> {
    const args: string[] = [];

    // Build the claude CLI command
    if (config.prompt) {
      args.push('--print'); // Non-interactive mode with prompt
      // We'll send the prompt via terminal input instead
    }

    if (config.permissionMode && config.permissionMode !== 'default') {
      args.push('--permission-mode', config.permissionMode);
    }

    if (config.worktree) {
      args.push('--worktree');
    }

    const terminal = await createTerminal(
      config.sessionName,
      config.terminalType,
      config.workspacePath,
      config.env,
    );

    // Send the claude command with the prompt
    const escapedPrompt = config.prompt.replace(/"/g, '\\"');
    const cmd = `claude --prompt "${escapedPrompt}"${args.length ? ' ' + args.join(' ') : ''}`;
    terminal.sendText(cmd);
    terminal.show();

    const sessionId = crypto.randomUUID();
    this.terminals.set(sessionId, terminal);

    return {
      id: sessionId,
      pid: 0, // PID will be resolved on next poll
      terminal: terminal.vscodeTerminal,
      workspacePath: config.workspacePath,
    };
  }

  // ── Approval hooks ────────────────────────────────────────

  async installApprovalHook(_session: ManagedSession): Promise<void> {
    // Full implementation in Sprint 2 (Approvals + Hooks)
    // Stub: hook installation will write a PreToolUse hook script
    // and configure it for the session
  }

  // ── State reading ─────────────────────────────────────────

  async readSessionState(sessionId: string): Promise<SessionState> {
    // Check pending approvals from the filesystem
    const approvals = await this.readPendingApprovals(sessionId);

    // Try to determine status from approvals
    const hasPendingApprovals = approvals.some(a => a.status === 'pending');

    const now = new Date();
    return {
      status: hasPendingApprovals ? 'waiting' : 'running',
      lastOutput: '',
      lastActivityAt: now,
      startedAt: now,
      completedAt: null,
      exitCode: null,
      pendingApprovals: approvals,
    };
  }

  onStateChange(
    _sessionId: string,
    _callback: (state: SessionState) => void,
  ): vscode.Disposable {
    // Full reactive implementation in Sprint 2
    // For now, the SessionManager polling loop handles state refresh
    return new vscode.Disposable(() => { /* no-op */ });
  }

  // ── Approval resolution ───────────────────────────────────

  async approveAction(approvalId: string): Promise<void> {
    await this.writeApprovalDecision(approvalId, 'allow');
  }

  async denyAction(approvalId: string): Promise<void> {
    await this.writeApprovalDecision(approvalId, 'deny');
  }

  // ── Session control ───────────────────────────────────────

  async killSession(sessionId: string): Promise<void> {
    const terminal = this.terminals.get(sessionId);
    if (terminal) {
      terminal.dispose();
      this.terminals.delete(sessionId);
    }

    // Clean up output watcher
    const watcher = this.outputWatchers.get(sessionId);
    if (watcher) {
      watcher.dispose();
      this.outputWatchers.delete(sessionId);
    }
  }

  getTerminal(sessionId: string): vscode.Terminal | null {
    const terminal = this.terminals.get(sessionId);
    return terminal?.vscodeTerminal ?? null;
  }

  // ── Session interaction ───────────────────────────────────

  async sendMessage(sessionId: string, message: string): Promise<void> {
    const terminal = this.terminals.get(sessionId);
    if (!terminal) {
      throw new Error(`No terminal found for session "${sessionId}"`);
    }
    terminal.sendText(message);
  }

  onSessionOutput(
    sessionId: string,
    callback: (output: SessionOutputEvent) => void,
  ): vscode.Disposable {
    // Watch the session's JSONL log for new entries
    // Full implementation will use fs.watch on the JSONL file
    // For now, return a disposable stub
    const disposable = new vscode.Disposable(() => {
      this.outputWatchers.delete(sessionId);
    });
    this.outputWatchers.set(sessionId, disposable);

    // Suppress unused parameter warnings — callback will be used
    // when the fs.watch implementation is wired in Sprint 5
    void callback;

    return disposable;
  }

  async getSessionHistory(
    sessionId: string,
    limit: number,
  ): Promise<SessionOutputEvent[]> {
    // Find the JSONL file for this session
    const projectsDir = getProviderProjectsDir('claude-code');

    // Search all project dirs for the session file
    try {
      const projectDirs = await fs.promises.readdir(projectsDir, { withFileTypes: true });
      for (const dir of projectDirs) {
        if (!dir.isDirectory()) { continue; }
        const jsonlPath = path.join(projectsDir, dir.name, `${sessionId}.jsonl`);
        try {
          await fs.promises.access(jsonlPath, fs.constants.R_OK);
          const entries = await parseJsonlFile(jsonlPath);
          const events = entriesToOutputEvents(entries);
          return events.slice(-limit);
        } catch {
          continue;
        }
      }
    } catch {
      // Projects dir doesn't exist
    }

    return [];
  }

  // ── Private helpers ───────────────────────────────────────

  private hashPath(workspacePath: string): string {
    return crypto.createHash('sha256').update(workspacePath).digest('hex').slice(0, 16);
  }

  private deriveSessionName(
    entries: Array<{ type: string; message?: { role?: string; content?: string | unknown[] } }>,
    fallback: string,
  ): string {
    // Try to extract the first user message as the session name
    for (const entry of entries) {
      if (
        (entry.type === 'user' || entry.message?.role === 'user') &&
        typeof entry.message?.content === 'string'
      ) {
        const firstLine = entry.message.content.split('\n')[0].trim();
        return firstLine.length > 60 ? firstLine.slice(0, 57) + '...' : firstLine;
      }
    }
    return fallback;
  }

  private findMatchingProcess(
    processes: Array<{ pid: number; command: string }>,
    _workspacePath: string,
  ): number | null {
    // Simple match: find any claude process.
    // Full implementation will cross-reference PIDs with session data.
    if (processes.length > 0) {
      return processes[0].pid;
    }
    return null;
  }

  private getFileCreationTime(filePath: string): string {
    try {
      const stat = fs.statSync(filePath);
      return stat.birthtime.toISOString();
    } catch {
      return new Date().toISOString();
    }
  }

  private async readPendingApprovals(sessionId: string): Promise<PendingApproval[]> {
    const dir = getSessionApprovalsDir(sessionId);
    const files = await listJsonFiles(dir);

    const approvals: PendingApproval[] = [];
    for (const file of files) {
      if (file.endsWith('.decision.json')) { continue; }
      const approval = await readJsonFile<PendingApproval | null>(file, null);
      if (approval) {
        approvals.push(approval);
      }
    }

    return approvals;
  }

  private async writeApprovalDecision(
    approvalId: string,
    decision: 'allow' | 'deny',
  ): Promise<void> {
    // Find the approval across all session directories
    const approvalsDir = path.dirname(getSessionApprovalsDir(''));
    try {
      const sessionDirs = await fs.promises.readdir(approvalsDir, { withFileTypes: true });
      for (const dir of sessionDirs) {
        if (!dir.isDirectory()) { continue; }
        const decisionPath = getApprovalDecisionPath(dir.name, approvalId);
        const approvalPath = path.join(approvalsDir, dir.name, `${approvalId}.json`);

        try {
          await fs.promises.access(approvalPath, fs.constants.R_OK);
          // Found the approval — write the decision
          const decisionData = { decision, resolvedAt: new Date().toISOString() };
          await fs.promises.writeFile(decisionPath, JSON.stringify(decisionData, null, 2));
          return;
        } catch {
          continue;
        }
      }
    } catch {
      // Approvals dir doesn't exist yet
    }
  }
}
