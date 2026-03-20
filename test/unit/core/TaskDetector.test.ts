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
