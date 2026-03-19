/**
 * Conductor — JSON file store with atomic writes.
 *
 * Provides typed read/write helpers for the JSON files Conductor
 * persists to disk (~/.conductor/**).  Writes use a temp-file +
 * rename strategy to avoid partial-write corruption.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Read and parse a JSON file.  Returns `defaultValue` if the file
 * does not exist or contains invalid JSON.
 */
export async function readJsonFile<T>(filePath: string, defaultValue: T): Promise<T> {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return defaultValue;
  }
}

/**
 * Atomically write a value as pretty-printed JSON.
 *
 * 1. Writes to a temporary file in the same directory.
 * 2. Renames the temp file over the target path.
 *
 * This guarantees the target file is always valid JSON, even if the
 * process crashes mid-write.
 */
export async function writeJsonFile<T>(filePath: string, data: T): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });

  const tmpPath = path.join(
    dir,
    `.tmp-${path.basename(filePath)}-${process.pid}-${Date.now()}`,
  );

  try {
    const content = JSON.stringify(data, null, 2) + '\n';
    await fs.promises.writeFile(tmpPath, content, 'utf-8');
    await fs.promises.rename(tmpPath, filePath);
  } catch (err) {
    // Clean up temp file on failure
    try { await fs.promises.unlink(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Ensure a directory exists, creating it recursively if needed.
 */
export async function ensureDir(dirPath: string): Promise<void> {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

/**
 * Check whether a file exists.
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete a file if it exists.  No error if already gone.
 */
export async function removeFile(filePath: string): Promise<void> {
  try {
    await fs.promises.unlink(filePath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
}

/**
 * List JSON files in a directory (non-recursive).
 * Returns absolute paths.
 */
export async function listJsonFiles(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter(e => e.isFile() && e.name.endsWith('.json') && !e.name.startsWith('.tmp-'))
      .map(e => path.join(dirPath, e.name));
  } catch {
    return [];
  }
}

/**
 * Initialize the top-level Conductor data directories under ~/.conductor/.
 * Safe to call multiple times — uses `mkdir -p` semantics.
 */
export async function initConductorDirs(): Promise<void> {
  const home = path.join(os.homedir(), '.conductor');
  const dirs = [
    home,
    path.join(home, 'approvals'),
    path.join(home, 'tasks'),
    path.join(home, 'queue'),
    path.join(home, 'templates'),
    path.join(home, 'hooks'),
    path.join(home, 'bin'),
  ];
  await Promise.all(dirs.map(d => fs.promises.mkdir(d, { recursive: true })));
}
