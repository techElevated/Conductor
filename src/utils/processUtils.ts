/**
 * Conductor — Process enumeration and monitoring.
 *
 * Scans running processes for AI coding agent CLIs to discover
 * sessions that were started outside Conductor.
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface AgentProcess {
  pid: number;
  command: string;
  cwd: string | null;
}

/**
 * Find running processes matching a given CLI name (e.g. "claude").
 * Uses `ps` on macOS/Linux.  Returns an empty array on failure.
 */
export async function findAgentProcesses(cliName: string): Promise<AgentProcess[]> {
  try {
    // -e: all processes, -o: custom output format
    const { stdout } = await execAsync(
      `ps -eo pid,comm,args | grep -i "${cliName}" | grep -v grep`,
      { timeout: 5_000 },
    );

    const results: AgentProcess[] = [];
    for (const line of stdout.trim().split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) { continue; }

      const parts = trimmed.split(/\s+/);
      const pid = parseInt(parts[0], 10);
      if (isNaN(pid)) { continue; }

      const command = parts.slice(1).join(' ');
      results.push({ pid, command, cwd: null });
    }

    return results;
  } catch {
    return [];
  }
}

/**
 * Check whether a process with the given PID is still alive.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0 = existence check, doesn't kill
    return true;
  } catch {
    return false;
  }
}

/**
 * Try to read the current working directory of a process by PID.
 * macOS uses `lsof`, Linux uses `/proc/{pid}/cwd`.
 */
export async function getProcessCwd(pid: number): Promise<string | null> {
  try {
    // Try /proc first (Linux)
    const { stdout: procCwd } = await execAsync(
      `readlink /proc/${pid}/cwd 2>/dev/null || lsof -p ${pid} -Fn 2>/dev/null | grep '^n/' | head -1 | cut -c2-`,
      { timeout: 3_000 },
    );
    const result = procCwd.trim();
    return result || null;
  } catch {
    return null;
  }
}
