/**
 * Conductor — Provider-specific path resolution.
 *
 * Each AI coding agent stores session data in its own directory
 * layout.  This module abstracts those differences so adapters
 * can ask "where is the session log for Claude Code?" without
 * hard-coding paths.  See PRD v1.1 §5.6.
 */

import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fileExists } from '../storage/FileStore';

const execAsync = promisify(exec);

export type ProviderId = 'claude-code' | 'codex' | 'gemini-cli';

interface ProviderPathConfig {
  /** Hidden directory under $HOME where the provider stores data */
  homeDir: string;
  /** Subdirectory (relative to homeDir) containing project/session data */
  projectsSubDir: string;
  /** CLI binary name used for version detection */
  cliBinary: string;
}

const PROVIDER_CONFIG: Record<ProviderId, ProviderPathConfig> = {
  'claude-code': {
    homeDir: '.claude',
    projectsSubDir: 'projects',
    cliBinary: 'claude',
  },
  codex: {
    homeDir: '.codex',
    projectsSubDir: 'projects',
    cliBinary: 'codex',
  },
  'gemini-cli': {
    homeDir: '.gemini',
    projectsSubDir: 'projects',
    cliBinary: 'gemini',
  },
};

/**
 * Returns the provider's home data directory.
 * e.g. `~/.claude/` for claude-code
 */
export function getProviderHomeDir(provider: ProviderId): string {
  const cfg = PROVIDER_CONFIG[provider];
  return path.join(os.homedir(), cfg.homeDir);
}

/**
 * Returns the provider's session/project data directory.
 * e.g. `~/.claude/projects/` for claude-code
 */
export function getProviderProjectsDir(provider: ProviderId): string {
  const cfg = PROVIDER_CONFIG[provider];
  return path.join(os.homedir(), cfg.homeDir, cfg.projectsSubDir);
}

/**
 * Returns the session log path for a specific project hash.
 * Claude Code uses `~/.claude/projects/{hash}/` with JSONL files inside.
 */
export function getSessionLogDir(provider: ProviderId, projectHash: string): string {
  return path.join(getProviderProjectsDir(provider), projectHash);
}

/**
 * Detect the installed version of a provider's CLI tool.
 * Returns the version string or null if not installed.
 */
export async function detectProviderVersion(provider: ProviderId): Promise<string | null> {
  const cfg = PROVIDER_CONFIG[provider];
  try {
    const { stdout } = await execAsync(`${cfg.cliBinary} --version`, {
      timeout: 5_000,
    });
    // Most CLIs output "tool vX.Y.Z" or just "X.Y.Z"
    const match = stdout.trim().match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Check whether a provider's data directory exists on disk.
 * Useful for dormant-mode activation: if no provider dirs exist,
 * Conductor stays idle.
 */
export async function providerDataExists(provider: ProviderId): Promise<boolean> {
  return fileExists(getProviderHomeDir(provider));
}

/**
 * Returns all known provider home directories.
 * Used on startup to decide whether to activate immediately or
 * stay dormant until a session is detected.
 */
export function getAllProviderHomeDirs(): string[] {
  return (Object.keys(PROVIDER_CONFIG) as ProviderId[]).map(getProviderHomeDir);
}

/**
 * Returns the list of registered provider IDs.
 */
export function getRegisteredProviderIds(): ProviderId[] {
  return Object.keys(PROVIDER_CONFIG) as ProviderId[];
}
