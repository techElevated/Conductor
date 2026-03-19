/**
 * Conductor — Centralized filesystem path resolution.
 *
 * Every path the extension reads or writes goes through this module.
 * All paths resolve under ~/.conductor/ (user-level) or
 * {workspace}/.conductor/ (project-level).
 */

import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { CONDUCTOR_DIR, StoragePath } from '../constants';

/** Absolute path to the user-level Conductor data directory. */
export function getConductorHome(): string {
  return path.join(os.homedir(), CONDUCTOR_DIR);
}

/** Hash a workspace path to a short, filesystem-safe string. */
export function hashWorkspacePath(workspacePath: string): string {
  return crypto.createHash('sha256').update(workspacePath).digest('hex').slice(0, 16);
}

// ── User-level paths ────────────────────────────────────────────

export function getSessionsFilePath(): string {
  return path.join(getConductorHome(), StoragePath.Sessions);
}

export function getApprovalsDir(): string {
  return path.join(getConductorHome(), StoragePath.Approvals);
}

export function getSessionApprovalsDir(sessionId: string): string {
  return path.join(getApprovalsDir(), sessionId);
}

export function getApprovalFilePath(sessionId: string, approvalId: string): string {
  return path.join(getSessionApprovalsDir(sessionId), `${approvalId}.json`);
}

export function getApprovalDecisionPath(sessionId: string, approvalId: string): string {
  return path.join(getSessionApprovalsDir(sessionId), `${approvalId}.decision.json`);
}

export function getTasksFilePath(workspacePath: string): string {
  const hash = hashWorkspacePath(workspacePath);
  return path.join(getConductorHome(), StoragePath.Tasks, `${hash}.json`);
}

export function getQueueFilePath(workspacePath: string): string {
  const hash = hashWorkspacePath(workspacePath);
  return path.join(getConductorHome(), StoragePath.Queue, `${hash}.json`);
}

export function getUserTemplatesDir(): string {
  return path.join(getConductorHome(), StoragePath.Templates);
}

export function getHooksDir(): string {
  return path.join(getConductorHome(), StoragePath.Hooks);
}

export function getBinDir(): string {
  return path.join(getConductorHome(), StoragePath.Bin);
}

// ── Project-level paths ─────────────────────────────────────────

export function getProjectConductorDir(workspacePath: string): string {
  return path.join(workspacePath, CONDUCTOR_DIR);
}

export function getProjectTemplatesDir(workspacePath: string): string {
  return path.join(getProjectConductorDir(workspacePath), StoragePath.Templates);
}

export function getProjectSettingsPath(workspacePath: string): string {
  return path.join(getProjectConductorDir(workspacePath), 'settings.json');
}
