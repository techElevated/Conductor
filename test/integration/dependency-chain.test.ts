/**
 * Conductor — Integration test: Dependency Chain Flow.
 *
 * Tests the complete dependency chain flow:
 * 1. Create 3 prompts: A, B (depends on A), C (depends on B).
 * 2. Verify DAG validation rejects cycles.
 * 3. Simulate completion and verify auto-launch would fire.
 * 4. Verify blocking on error.
 * 5. Verify diamond dependency (A → B, A → C, B → D, C → D).
 *
 * This test exercises the queue JSON and dependency logic without
 * VS Code APIs by directly manipulating the filesystem.
 *
 * Run: npx mocha --require ts-node/register test/integration/dependency-chain.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as assert from 'assert';
import * as crypto from 'crypto';
import { v4 as uuid } from 'uuid';

// ── Types (matching extension types) ────────────────────────────

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

interface SessionsFile {
  sessions: Array<{
    id: string;
    name: string;
    status: string;
    [key: string]: unknown;
  }>;
}

// ── Test helpers ────────────────────────────────────────────────

const TEST_DIR = path.join(os.tmpdir(), `conductor-dep-test-${process.pid}`);
const QUEUE_DIR = path.join(TEST_DIR, 'queue');
const SESSIONS_PATH = path.join(TEST_DIR, 'sessions.json');

function hashPath(p: string): string {
  return crypto.createHash('sha256').update(p).digest('hex').slice(0, 16);
}

const WORKSPACE_PATH = '/test/workspace';
const QUEUE_PATH = path.join(QUEUE_DIR, `${hashPath(WORKSPACE_PATH)}.json`);

function makePrompt(overrides: Partial<QueuedPrompt> = {}): QueuedPrompt {
  return {
    id: overrides.id ?? uuid(),
    name: overrides.name ?? 'Test Prompt',
    description: overrides.description ?? '',
    prompt: overrides.prompt ?? 'test prompt text',
    providerId: 'claude-code',
    parallelSafe: overrides.parallelSafe ?? true,
    complexity: overrides.complexity ?? 'medium',
    dependsOn: overrides.dependsOn ?? [],
    status: overrides.status ?? 'queued',
    sessionId: overrides.sessionId ?? null,
    position: overrides.position ?? 0,
    createdAt: new Date().toISOString(),
    launchedAt: overrides.launchedAt ?? null,
  };
}

function readQueue(): QueueFile {
  try {
    const raw = fs.readFileSync(QUEUE_PATH, 'utf-8');
    return JSON.parse(raw) as QueueFile;
  } catch {
    return { prompts: [] };
  }
}

function writeQueue(data: QueueFile): void {
  fs.mkdirSync(path.dirname(QUEUE_PATH), { recursive: true });
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(data, null, 2) + '\n');
}

/**
 * Kahn's algorithm for cycle detection (mirrors DependencyEngine logic).
 */
function validateDAG(prompts: QueuedPrompt[]): { valid: boolean; cycleNodes?: string[] } {
  const promptsMap = new Map(prompts.map(p => [p.id, p]));
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const [id] of promptsMap) {
    inDegree.set(id, 0);
    adjacency.set(id, []);
  }

  for (const [id, prompt] of promptsMap) {
    for (const dep of prompt.dependsOn) {
      if (promptsMap.has(dep)) {
        adjacency.get(dep)!.push(id);
        inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
      }
    }
  }

  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) { queue.push(id); }
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(node);
    for (const downstream of (adjacency.get(node) ?? [])) {
      const newDeg = (inDegree.get(downstream) ?? 1) - 1;
      inDegree.set(downstream, newDeg);
      if (newDeg === 0) { queue.push(downstream); }
    }
  }

  if (sorted.length === promptsMap.size) {
    return { valid: true };
  }

  const cycleNodes = [...promptsMap.keys()].filter(id => !sorted.includes(id));
  return { valid: false, cycleNodes };
}

/**
 * Simulate checking if all dependencies are met for a prompt.
 */
function allDependenciesMet(
  prompt: QueuedPrompt,
  prompts: QueuedPrompt[],
  sessions: SessionsFile,
): boolean {
  for (const depId of prompt.dependsOn) {
    // Check if dependency is a prompt whose session is complete
    const depPrompt = prompts.find(p => p.id === depId);
    if (depPrompt?.sessionId) {
      const session = sessions.sessions.find(s => s.id === depPrompt.sessionId);
      if (session?.status === 'complete') { continue; }
    }
    // Check direct session reference
    const session = sessions.sessions.find(s => s.id === depId);
    if (session?.status === 'complete') { continue; }
    return false;
  }
  return true;
}

/**
 * Get all prompts that depend on a given ID.
 */
function getDependents(targetId: string, prompts: QueuedPrompt[]): QueuedPrompt[] {
  return prompts.filter(p => {
    if (p.dependsOn.includes(targetId)) { return true; }
    // Check via sessionId
    const depPrompts = prompts.filter(dp => dp.sessionId === targetId);
    return depPrompts.some(dp => p.dependsOn.includes(dp.id));
  });
}

async function cleanup(): Promise<void> {
  await fs.promises.rm(TEST_DIR, { recursive: true, force: true });
}

// ── Tests ───────────────────────────────────────────────────────

describe('Dependency Chain Integration', () => {
  beforeEach(async () => {
    await fs.promises.mkdir(QUEUE_DIR, { recursive: true });
    await fs.promises.mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await cleanup();
  });

  // ── 1. Linear chain: A → B → C ─────────────────────────

  it('should create a 3-step linear chain A → B → C', () => {
    const a = makePrompt({ name: 'A — Route definitions', position: 0 });
    const b = makePrompt({ name: 'B — Auth middleware', position: 1, dependsOn: [a.id] });
    const c = makePrompt({ name: 'C — Integration tests', position: 2, dependsOn: [b.id] });

    const queue: QueueFile = { prompts: [a, b, c] };
    writeQueue(queue);

    const loaded = readQueue();
    assert.strictEqual(loaded.prompts.length, 3);

    // Verify dependency structure
    assert.deepStrictEqual(loaded.prompts[0].dependsOn, []);
    assert.deepStrictEqual(loaded.prompts[1].dependsOn, [a.id]);
    assert.deepStrictEqual(loaded.prompts[2].dependsOn, [b.id]);

    // Validate DAG
    const validation = validateDAG(loaded.prompts);
    assert.ok(validation.valid, 'Linear chain should be a valid DAG');
  });

  // ── 2. Cycle detection: A → B → A ──────────────────────

  it('should detect circular dependency A → B → A', () => {
    const aId = uuid();
    const bId = uuid();

    const a = makePrompt({ id: aId, name: 'A', dependsOn: [bId] });
    const b = makePrompt({ id: bId, name: 'B', dependsOn: [aId] });

    const validation = validateDAG([a, b]);
    assert.ok(!validation.valid, 'Circular dependency should be detected');
    assert.ok(validation.cycleNodes, 'Should identify cycle nodes');
    assert.ok(validation.cycleNodes!.length === 2, 'Both nodes should be in the cycle');
  });

  it('should detect 3-node cycle: A → B → C → A', () => {
    const aId = uuid();
    const bId = uuid();
    const cId = uuid();

    const a = makePrompt({ id: aId, name: 'A', dependsOn: [cId] });
    const b = makePrompt({ id: bId, name: 'B', dependsOn: [aId] });
    const c = makePrompt({ id: cId, name: 'C', dependsOn: [bId] });

    const validation = validateDAG([a, b, c]);
    assert.ok(!validation.valid, 'Three-node cycle should be detected');
  });

  // ── 3. Auto-launch on completion ───────────────────────

  it('should recognize when B can launch after A completes', () => {
    const a = makePrompt({
      name: 'A',
      status: 'launched',
      sessionId: 'session-a',
    });
    const b = makePrompt({
      name: 'B',
      dependsOn: [a.id],
    });

    const sessions: SessionsFile = {
      sessions: [
        { id: 'session-a', name: 'A', status: 'complete' },
      ],
    };

    // B's dependencies should be met now
    assert.ok(
      allDependenciesMet(b, [a, b], sessions),
      'B dependencies should be met after A completes',
    );
  });

  it('should NOT recognize B as ready when A is still running', () => {
    const a = makePrompt({
      name: 'A',
      status: 'launched',
      sessionId: 'session-a',
    });
    const b = makePrompt({
      name: 'B',
      dependsOn: [a.id],
    });

    const sessions: SessionsFile = {
      sessions: [
        { id: 'session-a', name: 'A', status: 'running' },
      ],
    };

    assert.ok(
      !allDependenciesMet(b, [a, b], sessions),
      'B dependencies should NOT be met while A is running',
    );
  });

  // ── 4. Full chain: A completes → B launches → B completes → C launches

  it('should support full 3-step chain progression', () => {
    const a = makePrompt({ name: 'A', position: 0 });
    const b = makePrompt({ name: 'B', position: 1, dependsOn: [a.id] });
    const c = makePrompt({ name: 'C', position: 2, dependsOn: [b.id] });

    const prompts = [a, b, c];
    const sessions: SessionsFile = { sessions: [] };

    // Step 1: A is launched and running
    a.status = 'launched';
    a.sessionId = 'session-a';
    sessions.sessions.push({ id: 'session-a', name: 'A', status: 'running' });

    assert.ok(!allDependenciesMet(b, prompts, sessions), 'B not ready while A runs');
    assert.ok(!allDependenciesMet(c, prompts, sessions), 'C not ready while A runs');

    // Step 2: A completes
    sessions.sessions[0].status = 'complete';
    assert.ok(allDependenciesMet(b, prompts, sessions), 'B ready after A completes');
    assert.ok(!allDependenciesMet(c, prompts, sessions), 'C still not ready (B not launched)');

    // Step 3: B is launched and running
    b.status = 'launched';
    b.sessionId = 'session-b';
    sessions.sessions.push({ id: 'session-b', name: 'B', status: 'running' });

    assert.ok(!allDependenciesMet(c, prompts, sessions), 'C not ready while B runs');

    // Step 4: B completes
    sessions.sessions[1].status = 'complete';
    assert.ok(allDependenciesMet(c, prompts, sessions), 'C ready after B completes');
  });

  // ── 5. Error blocking ──────────────────────────────────

  it('should NOT allow B to launch when A errors', () => {
    const a = makePrompt({
      name: 'A',
      status: 'launched',
      sessionId: 'session-a',
    });
    const b = makePrompt({
      name: 'B',
      dependsOn: [a.id],
    });

    const sessions: SessionsFile = {
      sessions: [
        { id: 'session-a', name: 'A', status: 'error' },
      ],
    };

    assert.ok(
      !allDependenciesMet(b, [a, b], sessions),
      'B should NOT launch when A has errored',
    );
  });

  // ── 6. Diamond dependency: A → B, A → C, B → D, C → D ─

  it('should handle diamond dependency correctly', () => {
    const a = makePrompt({ name: 'A', position: 0 });
    const b = makePrompt({ name: 'B', position: 1, dependsOn: [a.id] });
    const c = makePrompt({ name: 'C', position: 2, dependsOn: [a.id] });
    const d = makePrompt({ name: 'D', position: 3, dependsOn: [b.id, c.id] });

    const prompts = [a, b, c, d];

    // Validate DAG (should be valid)
    const validation = validateDAG(prompts);
    assert.ok(validation.valid, 'Diamond dependency should be a valid DAG');

    const sessions: SessionsFile = { sessions: [] };

    // A completes
    a.status = 'launched';
    a.sessionId = 'session-a';
    sessions.sessions.push({ id: 'session-a', name: 'A', status: 'complete' });

    assert.ok(allDependenciesMet(b, prompts, sessions), 'B ready after A completes');
    assert.ok(allDependenciesMet(c, prompts, sessions), 'C ready after A completes');
    assert.ok(!allDependenciesMet(d, prompts, sessions), 'D NOT ready (B and C not done)');

    // B completes, C still running
    b.status = 'launched';
    b.sessionId = 'session-b';
    sessions.sessions.push({ id: 'session-b', name: 'B', status: 'complete' });

    c.status = 'launched';
    c.sessionId = 'session-c';
    sessions.sessions.push({ id: 'session-c', name: 'C', status: 'running' });

    assert.ok(!allDependenciesMet(d, prompts, sessions), 'D NOT ready (C still running)');

    // C completes → D should now be ready
    sessions.sessions[2].status = 'complete';
    assert.ok(allDependenciesMet(d, prompts, sessions), 'D ready after BOTH B and C complete');
  });

  // ── 7. getDependents ───────────────────────────────────

  it('should find all dependents of a prompt', () => {
    const a = makePrompt({ name: 'A' });
    const b = makePrompt({ name: 'B', dependsOn: [a.id] });
    const c = makePrompt({ name: 'C', dependsOn: [a.id] });
    const d = makePrompt({ name: 'D', dependsOn: [b.id] });

    const prompts = [a, b, c, d];
    const dependents = getDependents(a.id, prompts);

    assert.strictEqual(dependents.length, 2, 'A should have 2 dependents (B and C)');
    assert.ok(dependents.some(p => p.id === b.id), 'B should depend on A');
    assert.ok(dependents.some(p => p.id === c.id), 'C should depend on A');
  });

  // ── 8. Persistence ─────────────────────────────────────

  it('should persist queue and dependencies across reads', () => {
    const a = makePrompt({ name: 'A', position: 0 });
    const b = makePrompt({ name: 'B', position: 1, dependsOn: [a.id] });
    const c = makePrompt({ name: 'C', position: 2, dependsOn: [b.id] });

    writeQueue({ prompts: [a, b, c] });

    // Read back
    const loaded = readQueue();
    assert.strictEqual(loaded.prompts.length, 3);
    assert.deepStrictEqual(loaded.prompts[1].dependsOn, [a.id]);
    assert.deepStrictEqual(loaded.prompts[2].dependsOn, [b.id]);

    // Validate the loaded DAG
    const validation = validateDAG(loaded.prompts);
    assert.ok(validation.valid);
  });

  // ── 9. Chain status summary ─────────────────────────────

  it('should produce correct chain status summary', () => {
    const a = makePrompt({ name: 'A', status: 'launched', sessionId: 'sa' });
    const b = makePrompt({ name: 'B', status: 'launched', sessionId: 'sb', dependsOn: [a.id] });
    const c = makePrompt({ name: 'C', status: 'queued', dependsOn: [b.id] });

    const prompts = [a, b, c];
    const sessions: SessionsFile = {
      sessions: [
        { id: 'sa', name: 'A', status: 'complete' },
        { id: 'sb', name: 'B', status: 'running' },
      ],
    };

    // Count statuses manually
    let complete = 0;
    let running = 0;
    let queued = 0;

    for (const p of prompts) {
      if (p.status === 'launched' && p.sessionId) {
        const s = sessions.sessions.find(s => s.id === p.sessionId);
        if (s?.status === 'complete') { complete++; }
        else if (s?.status === 'running') { running++; }
      } else if (p.status === 'queued') {
        queued++;
      }
    }

    assert.strictEqual(complete, 1, '1 complete (A)');
    assert.strictEqual(running, 1, '1 running (B)');
    assert.strictEqual(queued, 1, '1 queued (C)');
  });

  // ── 10. Manual override ─────────────────────────────────

  it('should allow manual override of dependency check', () => {
    const a = makePrompt({ name: 'A', status: 'launched', sessionId: 'sa' });
    const b = makePrompt({ name: 'B', dependsOn: [a.id] });

    const sessions: SessionsFile = {
      sessions: [
        { id: 'sa', name: 'A', status: 'running' }, // NOT complete
      ],
    };

    // Normal check: not met
    assert.ok(!allDependenciesMet(b, [a, b], sessions));

    // Force launch: temporarily clear dependencies
    const savedDeps = b.dependsOn;
    b.dependsOn = [];
    assert.ok(allDependenciesMet(b, [a, b], sessions), 'Force launch bypasses dependency check');
    b.dependsOn = savedDeps; // restore
  });
});
