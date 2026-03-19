#!/usr/bin/env node
/**
 * Conductor CLI — Programmatic queue management from the terminal.
 *
 * Allows other Claude Code sessions to add prompts to the queue,
 * list queued prompts, and trigger launches.  Reads/writes the same
 * JSON file that the VS Code extension uses.
 *
 * Usage:
 *   conductor queue add "prompt text" --name "6.5B-cache" --parallel-safe
 *   conductor queue list
 *   conductor queue launch <name-or-id>
 *   conductor queue remove <name-or-id>
 *
 * Implementation Plan §6 Task 3.6
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

// ── Types (duplicated from extension to keep CLI standalone) ─────

interface QueuedPrompt {
  id: string;
  name: string;
  description: string;
  prompt: string;
  providerId: string;
  parallelSafe: boolean;
  complexity: 'small' | 'medium' | 'large';
  dependsOn: string[];
  status: 'queued' | 'launched' | 'cancelled';
  sessionId: string | null;
  position: number;
  createdAt: string;
  launchedAt: string | null;
}

interface QueueFile {
  prompts: QueuedPrompt[];
}

// ── Path resolution ─────────────────────────────────────────────

function getConductorHome(): string {
  return path.join(os.homedir(), '.conductor');
}

function hashWorkspacePath(workspacePath: string): string {
  return crypto.createHash('sha256').update(workspacePath).digest('hex').slice(0, 16);
}

function getQueueFilePath(workspacePath: string): string {
  const hash = hashWorkspacePath(workspacePath);
  return path.join(getConductorHome(), 'queue', `${hash}.json`);
}

function resolveWorkspacePath(): string {
  // Use CONDUCTOR_WORKSPACE env var, or current working directory
  return process.env.CONDUCTOR_WORKSPACE ?? process.cwd();
}

// ── File I/O with locking ───────────────────────────────────────

function readQueue(filePath: string): QueueFile {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as QueueFile;
  } catch {
    return { prompts: [] };
  }
}

function writeQueue(filePath: string, data: QueueFile): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  // Atomic write: temp file + rename
  const tmpPath = path.join(dir, `.tmp-${path.basename(filePath)}-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

// ── Commands ────────────────────────────────────────────────────

function cmdAdd(args: string[]): void {
  const promptText = args[0];
  if (!promptText) {
    console.error('Error: prompt text is required');
    console.error('Usage: conductor queue add "prompt text" [--name NAME] [--parallel-safe] [--complexity small|medium|large]');
    process.exit(1);
  }

  // Parse flags
  let name = '';
  let parallelSafe = true;
  let complexity: 'small' | 'medium' | 'large' = 'medium';
  let description = '';
  let dependsOn: string[] = [];

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--name':
        name = args[++i] ?? '';
        break;
      case '--parallel-safe':
        parallelSafe = true;
        break;
      case '--no-parallel-safe':
        parallelSafe = false;
        break;
      case '--complexity':
        complexity = (args[++i] as 'small' | 'medium' | 'large') ?? 'medium';
        break;
      case '--description':
        description = args[++i] ?? '';
        break;
      case '--depends-on':
        dependsOn = (args[++i] ?? '').split(',').filter(Boolean);
        break;
    }
  }

  if (!name) {
    name = promptText.split('\n')[0].slice(0, 60);
  }

  const workspacePath = resolveWorkspacePath();
  const filePath = getQueueFilePath(workspacePath);
  const queue = readQueue(filePath);

  const prompt: QueuedPrompt = {
    id: crypto.randomUUID(),
    name,
    description,
    prompt: promptText,
    providerId: 'claude-code',
    parallelSafe,
    complexity,
    dependsOn,
    status: 'queued',
    sessionId: null,
    position: queue.prompts.length,
    createdAt: new Date().toISOString(),
    launchedAt: null,
  };

  queue.prompts.push(prompt);
  writeQueue(filePath, queue);

  console.log(`✓ Added "${prompt.name}" to queue (${prompt.id})`);
  console.log(`  Workspace: ${workspacePath}`);
  console.log(`  Queue file: ${filePath}`);
}

function cmdList(): void {
  const workspacePath = resolveWorkspacePath();
  const filePath = getQueueFilePath(workspacePath);
  const queue = readQueue(filePath);

  if (queue.prompts.length === 0) {
    console.log('Queue is empty');
    return;
  }

  console.log(`Queue for ${workspacePath}:\n`);
  const sorted = queue.prompts.sort((a, b) => a.position - b.position);

  for (const p of sorted) {
    const safe = p.parallelSafe ? '🟢' : '🔴';
    const status = p.status.toUpperCase().padEnd(9);
    console.log(`  ${safe} [${status}] ${p.name}`);
    console.log(`    ID: ${p.id}`);
    console.log(`    Complexity: ${p.complexity} | Prompt: ${p.prompt.slice(0, 80)}${p.prompt.length > 80 ? '...' : ''}`);
    if (p.dependsOn.length > 0) {
      console.log(`    Depends on: ${p.dependsOn.join(', ')}`);
    }
    console.log();
  }

  console.log(`Total: ${queue.prompts.length} prompts`);
}

function cmdRemove(args: string[]): void {
  const target = args[0];
  if (!target) {
    console.error('Error: name or ID required');
    process.exit(1);
  }

  const workspacePath = resolveWorkspacePath();
  const filePath = getQueueFilePath(workspacePath);
  const queue = readQueue(filePath);

  const idx = queue.prompts.findIndex(
    p => p.id === target || p.name.toLowerCase() === target.toLowerCase(),
  );

  if (idx === -1) {
    console.error(`Error: prompt "${target}" not found`);
    process.exit(1);
  }

  const removed = queue.prompts.splice(idx, 1)[0];
  writeQueue(filePath, queue);

  console.log(`✓ Removed "${removed.name}" from queue`);
}

function cmdLaunch(_args: string[]): void {
  // CLI can't directly launch (requires VS Code terminal API)
  // Instead, mark the prompt for launch — the extension picks it up
  console.log('Note: Direct launch from CLI is not supported.');
  console.log('Use the VS Code Conductor panel to launch prompts.');
  console.log('Or use the command palette: "Conductor: Launch Prompt"');
}

// ── Main ────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printUsage();
    return;
  }

  // Expect: conductor queue <subcommand> [args...]
  const command = args[0];
  const subcommand = args[1];
  const rest = args.slice(2);

  if (command !== 'queue') {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }

  switch (subcommand) {
    case 'add':
      cmdAdd(rest);
      break;
    case 'list':
    case 'ls':
      cmdList();
      break;
    case 'remove':
    case 'rm':
      cmdRemove(rest);
      break;
    case 'launch':
      cmdLaunch(rest);
      break;
    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      printUsage();
      process.exit(1);
  }
}

function printUsage(): void {
  console.log(`
Conductor CLI — Prompt queue management

Usage:
  conductor queue add "prompt text" [options]
  conductor queue list
  conductor queue remove <name-or-id>
  conductor queue launch <name-or-id>

Options for 'add':
  --name NAME             Prompt name (default: first line of prompt)
  --parallel-safe         Mark as parallel-safe (default)
  --no-parallel-safe      Mark as not parallel-safe
  --complexity SIZE       small, medium, or large (default: medium)
  --description TEXT      Short description
  --depends-on IDS        Comma-separated list of dependency IDs

Environment:
  CONDUCTOR_WORKSPACE     Workspace path (default: cwd)
`);
}

main();
