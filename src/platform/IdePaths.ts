/**
 * Conductor — IDE detection and path resolution.
 *
 * Abstracts differences between VS Code, Cursor, Windsurf, VS Codium,
 * and code-server so the rest of the codebase never references
 * IDE-specific paths directly.  See PRD v1.1 §5.6.
 */

import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';

export type IdeType = 'vscode' | 'cursor' | 'windsurf' | 'vscodium' | 'code-server';

export interface IdeCompatibilityFlags {
  /** VS Code 1.64+ secondary sidebar (auxiliaryBar) */
  hasSecondarySidebar: boolean;
  /** WebviewViewProvider support */
  hasWebviewViewProvider: boolean;
}

/**
 * Detect which IDE is running by inspecting the `vscode.env.appName`
 * and `vscode.env.uriScheme` values.
 */
export function getIdeType(): IdeType {
  const appName = (vscode.env.appName ?? '').toLowerCase();
  const uriScheme = (vscode.env.uriScheme ?? '').toLowerCase();

  if (appName.includes('cursor') || uriScheme.includes('cursor')) {
    return 'cursor';
  }
  if (appName.includes('windsurf') || uriScheme.includes('windsurf')) {
    return 'windsurf';
  }
  if (appName.includes('codium') || uriScheme.includes('vscodium')) {
    return 'vscodium';
  }
  if (appName.includes('code-server') || uriScheme.includes('code-server')) {
    return 'code-server';
  }
  return 'vscode';
}

/** Map IDE type → the hidden config directory name under $HOME. */
const IDE_DIR_MAP: Record<IdeType, string> = {
  vscode: '.vscode',
  cursor: '.cursor',
  windsurf: '.windsurf',
  vscodium: '.vscode-oss',
  'code-server': '.local/share/code-server',
};

/**
 * Returns the IDE-specific global settings directory.
 * e.g. `~/.vscode/`, `~/.cursor/`
 */
export function getGlobalSettingsPath(): string {
  return path.join(os.homedir(), IDE_DIR_MAP[getIdeType()]);
}

/**
 * Returns the IDE-specific extension data path.
 * Uses the VS Code API when available, falls back to a sensible default.
 */
export function getExtensionDataPath(context: vscode.ExtensionContext): string {
  return context.globalStorageUri.fsPath;
}

/**
 * Feature-flag compatibility checks based on VS Code engine version.
 */
export function getCompatibilityFlags(): IdeCompatibilityFlags {
  const ver = vscode.version; // e.g. "1.87.0"
  const [major, minor] = ver.split('.').map(Number);

  return {
    hasSecondarySidebar: major > 1 || (major === 1 && minor >= 64),
    hasWebviewViewProvider: major > 1 || (major === 1 && minor >= 64),
  };
}
