/**
 * Conductor — Unit tests: TaskDetector.ts
 *
 * Tests task detection, deduplication, persistence, and lifecycle methods
 * without requiring VS Code APIs (uses in-memory mocks).
 */

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';

// ── Lightweight mock setup ───────────────────────────────────────

// Minimal mock for vscode types consumed at runtime
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const vscodeMock: any = {
  EventEmitter: class {
    listeners: Array<(e: unknown) => void> = [];
    event = (cb: (e: unknown) => void) => { this.listeners.push(cb); return { dispose: () => {} }; };
    fire = (e: unknown) => { this.listeners.forEach(l => l(e)); };
    dispose = () => {};
  },
  Disposable: class {
    constructor(private fn: () => void) {}
    dispose() { this.fn(); }
  },
  window: { showInformationMessage: () => Promise.resolve() },
};

// Patch require before importing source modules
// This approach works with ts-node for pure logic tests
// Note: For full integration tests use vscode-test runner instead.

// ── Helper functions ─────────────────────────────────────────────

function tmpDir(): string {
  const dir = path.join(os.tmpdir(), `conductor-td-test-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Tests using patternMatcher directly (no VS Code deps) ────────

import { matchTasks, parseStructuredTask } from '../../../src/utils/patternMatcher';

describe('TaskDetector — pattern detection logic (unit)', () => {
  it('detects a structured CONDUCTOR_TASK from agent output', () => {
    const agentOutput = `
I've completed the migration script. Before proceeding, the operator needs to take action:

[CONDUCTOR_TASK]
description: Run the migration script on the production database
priority: urgent
blocking: true
[/CONDUCTOR_TASK]

I'll wait for confirmation before continuing.
`;
    const matches = matchTasks(agentOutput);
    assert.ok(matches.length > 0, 'Should detect at least one task');

    const taggedMatch = matches.find(m => m.patternName === 'conductor-tag');
    assert.ok(taggedMatch, 'Should find conductor-tag match');
    assert.strictEqual(taggedMatch?.confidence, 'high');

    const structured = parseStructuredTask(taggedMatch?.raw ?? '');
    assert.ok(structured, 'Should parse structured fields');
    assert.strictEqual(structured?.priority, 'urgent');
    assert.strictEqual(structured?.blocking, true);
    assert.ok(structured?.description.includes('migration script'));
  });

  it('detects run-command pattern for backtick commands', () => {
    const output = 'Please run `npm run db:migrate` to apply the pending database changes.';
    const matches = matchTasks(output);
    const cmd = matches.find(m => m.patternName === 'run-command');
    assert.ok(cmd, 'Should detect run-command');
    assert.ok(cmd?.description.includes('npm run db:migrate'));
  });

  it('does not double-detect the same task (deduplication)', () => {
    // Same description surfaced twice — in real TaskDetector this is
    // handled by isSimilarDescription before storing
    const desc1 = 'Restart the gateway service';
    const desc2 = 'Restart the gateway services'; // near-duplicate

    // Import after mock setup so we can use it directly
    const { isSimilarDescription } = require('../../../src/utils/patternMatcher');
    assert.ok(
      isSimilarDescription(desc1, desc2),
      'Near-duplicate descriptions should be considered similar',
    );
  });
});

// ── Fixture-based test ───────────────────────────────────────────

describe('TaskDetector — fixture data', () => {
  it('loads sample-tasks fixture without error', () => {
    const fixturePath = path.join(__dirname, '../../fixtures/sample-tasks.json');
    const raw = fs.readFileSync(fixturePath, 'utf-8');
    const data = JSON.parse(raw) as { tasks: unknown[] };
    assert.ok(Array.isArray(data.tasks), 'Expected tasks array in fixture');
    assert.strictEqual(data.tasks.length, 5, 'Expected 5 tasks in fixture');
  });

  it('fixture tasks have required fields', () => {
    const fixturePath = path.join(__dirname, '../../fixtures/sample-tasks.json');
    const data = JSON.parse(fs.readFileSync(fixturePath, 'utf-8')) as {
      tasks: Array<{
        id: string;
        sessionId: string;
        description: string;
        priority: string;
        status: string;
      }>
    };

    for (const task of data.tasks) {
      assert.ok(task.id, `Task missing id`);
      assert.ok(task.sessionId, `Task "${task.id}" missing sessionId`);
      assert.ok(task.description, `Task "${task.id}" missing description`);
      assert.ok(['urgent', 'normal', 'low'].includes(task.priority), `Task "${task.id}" invalid priority`);
      assert.ok(['pending', 'in-progress', 'complete'].includes(task.status), `Task "${task.id}" invalid status`);
    }
  });
});

// ── TaskDetector class-level tests ───────────────────────────────

import { TaskDetector } from '../../../src/core/TaskDetector';
import type { HumanTask, ConductorSession, SessionEvent } from '../../../src/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
class StubSessionManager {
  onSessionEvent = (_cb: (e: SessionEvent) => void) => ({ dispose: () => { /* no-op */ } });
  getAllSessions(): ConductorSession[] { return []; }
}

class StubTaskFeedback {
  isIgnored(_desc: string, _pattern?: string): boolean { return false; }
}

function makeTmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-td-'));
  fs.mkdirSync(path.join(dir, '.conductor', 'tasks'), { recursive: true });
  return dir;
}

/** Compute the workspace-hash used by getTasksFilePath. */
function workspaceHash(workspacePath: string): string {
  return crypto.createHash('sha256').update(workspacePath).digest('hex').slice(0, 16);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collectEvents(
  subscribe: (cb: (e: any) => void) => { dispose: () => void },
): { events: any[]; dispose: () => void } {
  const events: any[] = [];
  const disposable = subscribe((e: unknown) => { events.push(e); });
  return { events, dispose: () => disposable.dispose() };
}

describe('TaskDetector — completeTask / dismissTask', () => {
  const WORKSPACE = '/test-workspace';

  let tmpHome: string;
  let origHome: string | undefined;
  let detector: TaskDetector;

  const TASK_1: HumanTask = {
    id: 'task-1',
    sessionId: 'sess-1',
    sessionName: 'Session 1',
    description: 'Do the thing',
    priority: 'normal',
    blocking: false,
    status: 'pending',
    captureMethod: 'agent-tagged',
    context: 'some context',
    surfacedAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
  };

  const TASK_2: HumanTask = {
    id: 'task-2',
    sessionId: 'sess-1',
    sessionName: 'Session 1',
    description: 'Another task',
    priority: 'urgent',
    blocking: true,
    status: 'pending',
    captureMethod: 'convention-parsed',
    context: 'context 2',
    surfacedAt: '2026-01-02T00:00:00.000Z',
    completedAt: null,
  };

  beforeEach(async () => {
    origHome = process.env.HOME;
    tmpHome = makeTmpHome();
    process.env.HOME = tmpHome;

    // Pre-seed tasks file at the expected path
    const hash = workspaceHash(WORKSPACE);
    const tasksPath = path.join(tmpHome, '.conductor', 'tasks', `${hash}.json`);
    fs.writeFileSync(tasksPath, JSON.stringify({ tasks: [TASK_1, TASK_2] }, null, 2));

    detector = new TaskDetector(
      WORKSPACE,
      new StubSessionManager() as unknown as import('../../../src/core/SessionManager').SessionManager,
      new StubTaskFeedback() as unknown as import('../../../src/core/TaskFeedback').TaskFeedback,
    );
    await detector.initialise();
  });

  afterEach(() => {
    detector.dispose();
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('getAllTasks returns all loaded tasks', () => {
    assert.strictEqual(detector.getAllTasks().length, 2);
  });

  it('getPendingTasks returns only pending/in-progress tasks', () => {
    assert.strictEqual(detector.getPendingTasks().length, 2);
  });

  it('getTasksBySession returns tasks for a specific session', () => {
    const tasks = detector.getTasksBySession('sess-1');
    assert.strictEqual(tasks.length, 2);
    assert.ok(tasks.every(t => t.sessionId === 'sess-1'));
  });

  it('completeTask marks task as complete and sets completedAt', async () => {
    await detector.completeTask('task-1');
    const task = detector.getAllTasks().find(t => t.id === 'task-1');
    assert.strictEqual(task?.status, 'complete');
    assert.ok(typeof task?.completedAt === 'string' && task.completedAt.length > 0);
  });

  it('completeTask emits "completed" event', async () => {
    const { events, dispose } = collectEvents(cb => detector.onTaskEvent(cb));
    await detector.completeTask('task-1');
    dispose();
    assert.ok(events.some(e => e.type === 'completed' && e.task.id === 'task-1'));
  });

  it('completeTask is a no-op for unknown task', async () => {
    const countBefore = detector.getAllTasks().length;
    await detector.completeTask('no-such-task');
    assert.strictEqual(detector.getAllTasks().length, countBefore);
  });

  it('dismissTask removes task from getAllTasks', async () => {
    await detector.dismissTask('task-2');
    assert.strictEqual(detector.getAllTasks().length, 1);
    assert.ok(!detector.getAllTasks().some(t => t.id === 'task-2'));
  });

  it('dismissTask emits "dismissed" event', async () => {
    const { events, dispose } = collectEvents(cb => detector.onTaskEvent(cb));
    await detector.dismissTask('task-2');
    dispose();
    assert.ok(events.some(e => e.type === 'dismissed'));
  });

  it('completed tasks are excluded from getPendingTasks', async () => {
    await detector.completeTask('task-1');
    const pending = detector.getPendingTasks();
    assert.ok(!pending.some(t => t.id === 'task-1'));
    assert.ok(pending.some(t => t.id === 'task-2'));
  });
});
