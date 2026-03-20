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
import * as os from 'os';
import * as crypto from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
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
  watchNewEntries,
  entryToOutputEvent,
} from '../utils/jsonlParser';
import { findAgentProcesses, isProcessAlive } from '../utils/processUtils';
import {
  createTerminal,
  type ConductorTerminal,
} from '../platform/TerminalManager';
import { readJsonFile } from '../storage/FileStore';
import { getSessionApprovalsDir, getApprovalDecisionPath, getApprovalsDir } from '../storage/paths';
import { listJsonFiles } from '../storage/FileStore';
import { installHook, isHookInstalled } from '../hooks/hookInstaller';

const execAsync = promisify(exec);

// ── Adapter implementation ──────────────────────────────────────

export class ClaudeCodeAdapter implements ProviderAdapter {
  readonly providerId = 'claude-code';
  readonly displayName = 'Claude Code';
  readonly iconPath = 'media/claude-code-icon.svg';

  /** Extension path for locating bundled assets */
  extensionPath = '';

  /** Map sessionId → ConductorTerminal for sessions launched through Conductor */
  private terminals = new Map<string, ConductorTerminal>();

  /** Map sessionId → Disposable for output watchers */
  private outputWatchers = new Map<string, vscode.Disposable>();

  /** Cached resolved path to the claude binary */
  private claudePathCache: string | null = null;

  // ── Discovery ─────────────────────────────────────────────

  async discoverSessions(workspacePath: string): Promise<DiscoveredSession[]> {
    const projectsDir = getProviderProjectsDir('claude-code');

    console.log(`[Conductor] discoverSessions: scanning "${projectsDir}" for workspace "${workspacePath}"`);

    const sessions: DiscoveredSession[] = [];

    // List all project directories — Claude Code may use various naming schemes
    // (path-encoded, hashed, or other) so we scan everything rather than predicting the name.
    let allDirs: fs.Dirent[];
    try {
      allDirs = await fs.promises.readdir(projectsDir, { withFileTypes: true });
    } catch {
      console.log(`[Conductor] discoverSessions: projects dir not found: "${projectsDir}"`);
      return sessions;
    }

    const projectDirs = allDirs.filter(e => e.isDirectory());
    console.log(
      `[Conductor] discoverSessions: found ${projectDirs.length} project dir(s): [${projectDirs.map(d => d.name).join(', ')}]`,
    );

    // Try known workspace-path → directory-name encoding schemes so we can
    // prefer sessions that belong to the current workspace.
    //   1. SHA-256 16-char hex (Conductor's own scheme)
    //   2. Absolute path with each '/' replaced by '-' (Claude Code's scheme)
    const sha256Hash = this.hashPath(workspacePath);
    const pathEncoded = workspacePath.replace(/\//g, '-');

    const matchingDirs = projectDirs.filter(
      d => d.name === sha256Hash || d.name === pathEncoded,
    );

    // If we found a recognised encoding, scope to those dirs only.
    // Otherwise, fall back to all dirs so we still surface running sessions
    // even when Claude Code uses an encoding scheme we haven't seen yet.
    const dirsToScan = matchingDirs.length > 0 ? matchingDirs : projectDirs;

    console.log(
      matchingDirs.length > 0
        ? `[Conductor] discoverSessions: matched ${matchingDirs.length} dir(s) for workspace (${sha256Hash} / ${pathEncoded})`
        : `[Conductor] discoverSessions: no exact match — falling back to all ${projectDirs.length} dir(s)`,
    );

    // Also discover via running processes
    const runningProcesses = await findAgentProcesses('claude');

    for (const dir of dirsToScan) {
      const dirPath = path.join(projectsDir, dir.name);

      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      } catch {
        continue;
      }

      const jsonlFiles = entries.filter(e => e.isFile() && e.name.endsWith('.jsonl'));
      console.log(`[Conductor] discoverSessions: dir "${dir.name}" → ${jsonlFiles.length} jsonl file(s)`);

      for (const file of jsonlFiles) {
        const filePath = path.join(dirPath, file.name);
        const sessionId = path.basename(file.name, '.jsonl');

        const jsonlEntries = await parseJsonlFile(filePath);
        const status = inferStatusFromEntries(jsonlEntries);
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
    }

    console.log(`[Conductor] discoverSessions: discovered ${sessions.length} total session(s)`);
    return sessions;
  }

  // ── Launch ────────────────────────────────────────────────

  async launchSession(config: LaunchConfig): Promise<ManagedSession> {
    const sessionId = crypto.randomUUID();
    const args: string[] = [];

    if (config.permissionMode && config.permissionMode !== 'default') {
      args.push('--permission-mode', config.permissionMode);
    }

    if (config.worktree) {
      args.push('--worktree');
    }

    // Set up environment with Conductor session ID for the hook
    const env: Record<string, string> = {
      ...config.env,
      CONDUCTOR_SESSION_ID: sessionId,
      CONDUCTOR_SESSION_NAME: config.sessionName,
    };

    // Resolve the claude binary path before creating the terminal
    let claudePath: string;
    try {
      claudePath = await this.resolveClaudePath();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Conductor: ${msg}`);
      throw err;
    }

    const terminal = await createTerminal(
      config.sessionName,
      config.terminalType,
      config.workspacePath,
      env,
    );

    // Append Conductor system context so the agent emits structured task tags
    const augmentedPrompt = appendConductorSystemContext(config.prompt);

    // Send the claude command with the prompt
    const escapedPrompt = augmentedPrompt.replace(/'/g, "'\\''");
    const cmd = `"${claudePath}" --prompt '${escapedPrompt}'${args.length ? ' ' + args.join(' ') : ''}`;
    terminal.sendText(cmd);
    terminal.show();

    this.terminals.set(sessionId, terminal);

    const managed: ManagedSession = {
      id: sessionId,
      pid: 0, // PID will be resolved on next poll
      terminal: terminal.vscodeTerminal,
      workspacePath: config.workspacePath,
    };

    // Install the approval hook
    try {
      await this.installApprovalHook(managed);
    } catch {
      // Hook installation failure is non-fatal — session still runs
    }

    return managed;
  }

  // ── Approval hooks ────────────────────────────────────────

  async installApprovalHook(session: ManagedSession): Promise<void> {
    const sessionName = this.terminals.get(session.id)?.id ?? session.id;
    await installHook(session.id, sessionName, this.extensionPath);
  }

  /** Check if the approval hook is currently installed. */
  async isApprovalHookInstalled(): Promise<boolean> {
    return isHookInstalled();
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

    // Clean up approval files for this session
    await this.cleanupSessionApprovals(sessionId);
  }

  getTerminal(sessionId: string): vscode.Terminal | null {
    const terminal = this.terminals.get(sessionId);
    return terminal?.vscodeTerminal ?? null;
  }

  // ── Session interaction ───────────────────────────────────

  async sendMessage(sessionId: string, message: string): Promise<void> {
    const terminal = this.terminals.get(sessionId);
    if (terminal) {
      terminal.sendText(message);
      return;
    }

    // For sessions discovered externally (not launched by Conductor), there is
    // no terminal reference in our map.  Try to find a matching VS Code terminal
    // by name, falling back to any visible Claude terminal.
    const allTerminals = vscode.window.terminals;
    const claudeTerminal = allTerminals.find(
      t => t.name.toLowerCase().includes('claude'),
    );
    if (claudeTerminal) {
      claudeTerminal.sendText(message, true);
      return;
    }

    throw new Error(
      'This session wasn\'t launched by Conductor. Open it in a terminal first, then try again.',
    );
  }

  onSessionOutput(
    sessionId: string,
    callback: (output: SessionOutputEvent) => void,
  ): vscode.Disposable {
    // Clean up any existing watcher for this session
    this.outputWatchers.get(sessionId)?.dispose();

    // Try to find the JSONL log file for this session
    const jsonlPath = this.resolveJsonlPath(sessionId);
    if (!jsonlPath) {
      // No log file found — return a no-op disposable
      const disposable = new vscode.Disposable(() => {
        this.outputWatchers.delete(sessionId);
      });
      this.outputWatchers.set(sessionId, disposable);
      return disposable;
    }

    // Watch for new JSONL entries and convert to SessionOutputEvents
    const watchDisposable = watchNewEntries(jsonlPath, (entry) => {
      const event = entryToOutputEvent(entry);
      if (event) {
        callback(event);
      }
    });

    const disposable = new vscode.Disposable(() => {
      watchDisposable.dispose();
      this.outputWatchers.delete(sessionId);
    });
    this.outputWatchers.set(sessionId, disposable);
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

  // ── JSONL path resolution ────────────────────────────────

  /**
   * Resolve the JSONL log file path for a session.
   * Searches across all project hash directories under ~/.claude/projects/.
   */
  private resolveJsonlPath(sessionId: string): string | null {
    const projectsDir = getProviderProjectsDir('claude-code');
    try {
      const dirs = fs.readdirSync(projectsDir, { withFileTypes: true });
      for (const dir of dirs) {
        if (!dir.isDirectory()) { continue; }
        const candidate = path.join(projectsDir, dir.name, `${sessionId}.jsonl`);
        try {
          fs.accessSync(candidate, fs.constants.R_OK);
          return candidate;
        } catch {
          continue;
        }
      }
    } catch {
      // Projects dir doesn't exist
    }
    return null;
  }

  // ── CLI path resolution ───────────────────────────────────

  /**
   * Resolve the absolute path to the claude binary.
   *
   * Resolution order:
   *  1. `conductor.claudePath` VS Code setting (manual override)
   *  2. Login-shell `which claude` (picks up user's ~/.zprofile / ~/.bash_profile PATH)
   *  3. Common install locations (npm global, Homebrew, ~/.claude/bin)
   *
   * Result is cached for the lifetime of the adapter instance.
   */
  private async resolveClaudePath(): Promise<string> {
    if (this.claudePathCache) { return this.claudePathCache; }

    // 1. User-configured path
    const config = vscode.workspace.getConfiguration('conductor');
    const userPath = (config.get<string>('claudePath') ?? '').trim();
    if (userPath) {
      try {
        fs.accessSync(userPath, fs.constants.X_OK);
        this.claudePathCache = userPath;
        return userPath;
      } catch {
        throw new Error(
          `conductor.claudePath "${userPath}" is not executable. Check your Conductor settings.`,
        );
      }
    }

    // 2. Ask the user's login shell — this loads ~/.zprofile / ~/.bash_profile
    //    so npm-global and Homebrew paths are visible.
    const shells = ['/bin/zsh', '/bin/bash', '/bin/sh'];
    for (const shell of shells) {
      try {
        const { stdout } = await execAsync(`${shell} -l -c 'which claude'`, { timeout: 5_000 });
        const resolved = stdout.trim();
        if (resolved) {
          this.claudePathCache = resolved;
          return resolved;
        }
      } catch { /* shell not available or claude not on that shell's PATH */ }
    }

    // 3. Common install locations
    const candidates = [
      '/usr/local/bin/claude',
      path.join(os.homedir(), '.npm-global', 'bin', 'claude'),
      path.join(os.homedir(), '.local', 'bin', 'claude'),
      '/opt/homebrew/bin/claude',
      path.join(os.homedir(), '.claude', 'bin', 'claude'),
      path.join(os.homedir(), '.nvm', 'current', 'bin', 'claude'),
    ];
    for (const p of candidates) {
      try {
        fs.accessSync(p, fs.constants.X_OK);
        this.claudePathCache = p;
        return p;
      } catch { continue; }
    }

    // 4. Not found
    throw new Error(
      'Claude Code CLI not found. Install it with: npm install -g @anthropic-ai/claude-code\n' +
      'Or set the path manually via the "conductor.claudePath" setting.',
    );
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
    const approvalsDir = getApprovalsDir();
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

  private async cleanupSessionApprovals(sessionId: string): Promise<void> {
    const sessionDir = getSessionApprovalsDir(sessionId);
    try {
      const files = await fs.promises.readdir(sessionDir);
      await Promise.all(
        files.map((f) => fs.promises.unlink(path.join(sessionDir, f)).catch(() => { /* ignore */ })),
      );
      await fs.promises.rmdir(sessionDir).catch(() => { /* ignore */ });
    } catch {
      // Directory doesn't exist or already cleaned up
    }
  }
}

// ── Module-level helpers ──────────────────────────────────────────

/**
 * Append the Conductor system context to a prompt so the agent emits
 * structured [CONDUCTOR_TASK] blocks when human action is required.
 *
 * Implementation Plan §7 Task 4.5 — system prompt injection.
 */
export function appendConductorSystemContext(prompt: string): string {
  const systemContext = `

---
CONDUCTOR SYSTEM CONTEXT:
When you need the human operator to perform an action (restart a service, configure a tool, run a command outside this session, etc.), output it in this exact format:
[CONDUCTOR_TASK]
description: <what the human needs to do>
priority: normal|urgent|low
blocking: true|false
[/CONDUCTOR_TASK]
Use this format instead of prose requests. This allows Conductor to surface the task in the operator's inbox.
---`;

  return prompt + systemContext;
}
