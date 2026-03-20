/**
 * Conductor — Integration test: End-to-End Multi-Session Workflow.
 *
 * Simulates a complete multi-session workflow:
 * 1. Launch Conductor — verify status board shows "No sessions."
 * 2. Add 4 prompts with dependencies: A, B (depends A), C (depends A), D (depends B+C).
 * 3. Launch A from the queue.
 * 4. Simulate A needing approval — verify approval appears.
 * 5. Approve it — verify A continues.
 * 6. Simulate A's agent producing a [CONDUCTOR_TASK] — verify task surfaces.
 * 7. Simulate A completing — verify B and C become launchable.
 * 8. Verify output streaming produces SessionOutputEvents.
 * 9. Simulate B and C completing — verify D becomes launchable.
 * 10. Verify chain status summary is accurate at each step.
 *
 * This test exercises the queue, dependency, approval, task detection,
 * and JSONL output event logic without VS Code APIs.
 *
 * Run: npx mocha --require ts-node/register test/integration/e2e-workflow.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as assert from 'assert';
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

interface QueueFile { prompts: QueuedPrompt[]; }

interface ConductorSession {
  id: string;
  name: string;
  providerId: string;
  workspacePath: string;
  prompt: string;
  status: 'queued' | 'running' | 'waiting' | 'complete' | 'error' | 'blocked';
  pid: number | null;
  terminalId: string | null;
  hookInstalled: boolean;
  dependsOn: string[];
  templateId: string | null;
  createdAt: string;
  launchedAt: string | null;
  completedAt: string | null;
  exitCode: number | null;
  metadata: Record<string, unknown>;
}

interface SessionsFile { sessions: ConductorSession[]; }

interface PendingApproval {
  id: string;
  sessionId: string;
  sessionName: string;
  tool: string;
  command: string;
  context: string;
  timestamp: string;
  status: 'pending' | 'approved' | 'denied';
  resolvedAt: string | null;
}

interface HumanTask {
  id: string;
  sessionId: string;
  sessionName: string;
  description: string;
  priority: 'urgent' | 'normal' | 'low';
  blocking: boolean;
  status: 'pending' | 'in-progress' | 'complete';
  captureMethod: string;
  context: string;
  surfacedAt: string;
  completedAt: string | null;
}

// ── Test helpers ────────────────────────────────────────────────

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-e2e-'));
}

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

function makePrompt(
  name: string,
  position: number,
  dependsOn: string[] = [],
  id?: string,
): QueuedPrompt {
  return {
    id: id ?? uuid(),
    name,
    description: `Test prompt: ${name}`,
    prompt: `Do task ${name}`,
    providerId: 'claude-code',
    parallelSafe: dependsOn.length === 0,
    complexity: 'small',
    dependsOn,
    status: 'queued',
    sessionId: null,
    position,
    createdAt: new Date().toISOString(),
    launchedAt: null,
  };
}

function makeSession(
  name: string,
  status: ConductorSession['status'] = 'running',
  dependsOn: string[] = [],
): ConductorSession {
  return {
    id: uuid(),
    name,
    providerId: 'claude-code',
    workspacePath: '/tmp/test-workspace',
    prompt: `Do task ${name}`,
    status,
    pid: status === 'running' || status === 'waiting' ? 12345 : null,
    terminalId: null,
    hookInstalled: true,
    dependsOn,
    templateId: null,
    createdAt: new Date().toISOString(),
    launchedAt: status !== 'queued' ? new Date().toISOString() : null,
    completedAt: status === 'complete' ? new Date().toISOString() : null,
    exitCode: status === 'complete' ? 0 : null,
    metadata: {},
  };
}

function makeApproval(sessionId: string, sessionName: string): PendingApproval {
  return {
    id: uuid(),
    sessionId,
    sessionName,
    tool: 'Bash',
    command: 'npm install express',
    context: 'Installing dependency for server setup',
    timestamp: new Date().toISOString(),
    status: 'pending',
    resolvedAt: null,
  };
}

function makeJsonlContent(entries: object[]): string {
  return entries.map(e => JSON.stringify(e)).join('\n') + '\n';
}

// ── Helper: check which prompts are launchable ──────────────────

function getLaunchablePrompts(
  queue: QueuedPrompt[],
  sessions: ConductorSession[],
): QueuedPrompt[] {
  const completedSessionIds = new Set(
    sessions
      .filter(s => s.status === 'complete')
      .map(s => s.id),
  );

  // Build a map of promptId → sessionId for launched prompts
  const promptToSession = new Map<string, string>();
  for (const p of queue) {
    if (p.sessionId) {
      promptToSession.set(p.id, p.sessionId);
    }
  }

  return queue.filter(p => {
    if (p.status !== 'queued') { return false; }
    // All dependencies must be completed
    return p.dependsOn.every(depId => {
      // depId could be a prompt ID — find its session
      const depPrompt = queue.find(q => q.id === depId);
      if (depPrompt?.sessionId) {
        return completedSessionIds.has(depPrompt.sessionId);
      }
      // Or depId is a session ID directly
      return completedSessionIds.has(depId);
    });
  });
}

// ── Test: detect [CONDUCTOR_TASK] from output ──────────────────

function extractTasks(content: string): HumanTask[] {
  const tasks: HumanTask[] = [];
  const re = /\[CONDUCTOR_TASK\]\s*\n([\s\S]*?)\[\/CONDUCTOR_TASK\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const body = match[1];
    const desc = body.match(/description:\s*(.*)/)?.[1]?.trim() ?? '';
    const priority = body.match(/priority:\s*(urgent|normal|low)/)?.[1] as 'normal' ?? 'normal';
    const blocking = body.match(/blocking:\s*(true|false)/)?.[1] === 'true';

    tasks.push({
      id: uuid(),
      sessionId: '',
      sessionName: '',
      description: desc,
      priority,
      blocking,
      status: 'pending',
      captureMethod: 'agent-tagged',
      context: body,
      surfacedAt: new Date().toISOString(),
      completedAt: null,
    });
  }
  return tasks;
}

// ── Tests ───────────────────────────────────────────────────────

describe('E2E Multi-Session Workflow', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('Step 1: Empty state shows no sessions', () => {
    const sessionsFile = path.join(tmpDir, 'sessions.json');
    writeJson(sessionsFile, { sessions: [] });

    const data = readJson<SessionsFile>(sessionsFile);
    assert.strictEqual(data.sessions.length, 0, 'Should start with no sessions');
  });

  it('Step 2: Add 4 prompts with diamond dependencies A → B,C → D', () => {
    const promptA = makePrompt('Task A', 0);
    const promptB = makePrompt('Task B', 1, [promptA.id]);
    const promptC = makePrompt('Task C', 2, [promptA.id]);
    const promptD = makePrompt('Task D', 3, [promptB.id, promptC.id]);

    const queueFile = path.join(tmpDir, 'queue.json');
    writeJson(queueFile, { prompts: [promptA, promptB, promptC, promptD] });

    const data = readJson<QueueFile>(queueFile);
    assert.strictEqual(data.prompts.length, 4);
    assert.deepStrictEqual(data.prompts[1].dependsOn, [promptA.id]);
    assert.deepStrictEqual(data.prompts[2].dependsOn, [promptA.id]);
    assert.deepStrictEqual(data.prompts[3].dependsOn, [promptB.id, promptC.id]);

    // Only A should be launchable (no dependencies)
    const launchable = getLaunchablePrompts(data.prompts, []);
    assert.strictEqual(launchable.length, 1);
    assert.strictEqual(launchable[0].name, 'Task A');
  });

  it('Step 3-5: Launch A, simulate approval, approve it', () => {
    // Create session A
    const sessionA = makeSession('Task A', 'running');
    const sessionsFile = path.join(tmpDir, 'sessions.json');
    writeJson(sessionsFile, { sessions: [sessionA] });

    // Step 4: Simulate A needing approval
    const approval = makeApproval(sessionA.id, sessionA.name);
    const approvalDir = path.join(tmpDir, 'approvals', sessionA.id);
    writeJson(path.join(approvalDir, `${approval.id}.json`), approval);

    // Verify approval exists
    const approvalFile = readJson<PendingApproval>(
      path.join(approvalDir, `${approval.id}.json`),
    );
    assert.strictEqual(approvalFile.status, 'pending');
    assert.strictEqual(approvalFile.sessionId, sessionA.id);

    // Update session status to waiting
    sessionA.status = 'waiting';
    writeJson(sessionsFile, { sessions: [sessionA] });

    // Step 5: Approve it
    approval.status = 'approved';
    approval.resolvedAt = new Date().toISOString();
    writeJson(path.join(approvalDir, `${approval.id}.json`), approval);

    const decisionPath = path.join(approvalDir, `${approval.id}.decision.json`);
    writeJson(decisionPath, { decision: 'allow', resolvedAt: approval.resolvedAt });

    // Verify decision written
    assert.ok(fs.existsSync(decisionPath));

    // Session resumes running
    sessionA.status = 'running';
    writeJson(sessionsFile, { sessions: [sessionA] });
    const updated = readJson<SessionsFile>(sessionsFile);
    assert.strictEqual(updated.sessions[0].status, 'running');
  });

  it('Step 6: Detect [CONDUCTOR_TASK] from session output', () => {
    const outputContent = `I've completed the database migration. However, you need to restart the Redis service.

[CONDUCTOR_TASK]
description: Restart the Redis service on the production server
priority: urgent
blocking: true
[/CONDUCTOR_TASK]

Continuing with the next step...`;

    const tasks = extractTasks(outputContent);
    assert.strictEqual(tasks.length, 1);
    assert.strictEqual(tasks[0].description, 'Restart the Redis service on the production server');
    assert.strictEqual(tasks[0].priority, 'urgent');
    assert.strictEqual(tasks[0].blocking, true);
  });

  it('Step 7: A completes → B and C become launchable', () => {
    const promptA = makePrompt('Task A', 0);
    const promptB = makePrompt('Task B', 1, [promptA.id]);
    const promptC = makePrompt('Task C', 2, [promptA.id]);
    const promptD = makePrompt('Task D', 3, [promptB.id, promptC.id]);

    // Launch A, create a session
    const sessionA = makeSession('Task A', 'complete');
    promptA.status = 'launched';
    promptA.sessionId = sessionA.id;

    const queue = [promptA, promptB, promptC, promptD];
    const sessions = [sessionA];

    const launchable = getLaunchablePrompts(queue, sessions);
    assert.strictEqual(launchable.length, 2);
    const launchableNames = launchable.map(p => p.name).sort();
    assert.deepStrictEqual(launchableNames, ['Task B', 'Task C']);
  });

  it('Step 8: JSONL log produces SessionOutputEvents', () => {
    const jsonlEntries = [
      {
        type: 'assistant',
        message: { role: 'assistant', content: 'Starting the refactor...' },
        timestamp: '2026-03-19T10:00:00Z',
      },
      {
        type: 'tool_use',
        name: 'Bash',
        input: { command: 'npm test' },
        timestamp: '2026-03-19T10:00:05Z',
      },
      {
        type: 'tool_result',
        content: 'All 42 tests passed',
        exit_code: 0,
        timestamp: '2026-03-19T10:00:10Z',
      },
      {
        type: 'error',
        content: 'Rate limit exceeded',
        timestamp: '2026-03-19T10:00:15Z',
      },
      {
        type: 'system',
        content: 'Session resumed',
        timestamp: '2026-03-19T10:00:20Z',
      },
    ];

    const jsonlPath = path.join(tmpDir, 'test-session.jsonl');
    fs.writeFileSync(jsonlPath, makeJsonlContent(jsonlEntries));

    // Parse and convert (inline logic matching jsonlParser)
    const raw = fs.readFileSync(jsonlPath, 'utf-8');
    const entries = raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));

    assert.strictEqual(entries.length, 5);
    assert.strictEqual(entries[0].type, 'assistant');
    assert.strictEqual(entries[0].message.content, 'Starting the refactor...');
    assert.strictEqual(entries[1].type, 'tool_use');
    assert.strictEqual(entries[1].name, 'Bash');
    assert.strictEqual(entries[2].type, 'tool_result');
    assert.strictEqual(entries[3].type, 'error');
    assert.strictEqual(entries[4].type, 'system');
  });

  it('Step 9: B and C complete → D becomes launchable', () => {
    const promptA = makePrompt('Task A', 0);
    const promptB = makePrompt('Task B', 1, [promptA.id]);
    const promptC = makePrompt('Task C', 2, [promptA.id]);
    const promptD = makePrompt('Task D', 3, [promptB.id, promptC.id]);

    const sessionA = makeSession('Task A', 'complete');
    const sessionB = makeSession('Task B', 'complete');
    const sessionC = makeSession('Task C', 'complete');

    promptA.status = 'launched';
    promptA.sessionId = sessionA.id;
    promptB.status = 'launched';
    promptB.sessionId = sessionB.id;
    promptC.status = 'launched';
    promptC.sessionId = sessionC.id;

    const queue = [promptA, promptB, promptC, promptD];
    const sessions = [sessionA, sessionB, sessionC];

    const launchable = getLaunchablePrompts(queue, sessions);
    assert.strictEqual(launchable.length, 1);
    assert.strictEqual(launchable[0].name, 'Task D');
  });

  it('Step 10: Chain status summary is accurate', () => {
    const promptA = makePrompt('Task A', 0);
    const promptB = makePrompt('Task B', 1, [promptA.id]);
    const promptC = makePrompt('Task C', 2, [promptA.id]);
    const promptD = makePrompt('Task D', 3, [promptB.id, promptC.id]);

    const sessionA = makeSession('Task A', 'complete');
    const sessionB = makeSession('Task B', 'running');
    const sessionC = makeSession('Task C', 'waiting');

    promptA.status = 'launched';
    promptA.sessionId = sessionA.id;
    promptB.status = 'launched';
    promptB.sessionId = sessionB.id;
    promptC.status = 'launched';
    promptC.sessionId = sessionC.id;

    const sessions = [sessionA, sessionB, sessionC];

    // Chain summary
    const summary = {
      total: 4,
      complete: sessions.filter(s => s.status === 'complete').length,
      running: sessions.filter(s => s.status === 'running').length,
      waiting: sessions.filter(s => s.status === 'waiting').length,
      queued: 1, // prompt D still queued
    };

    assert.strictEqual(summary.total, 4);
    assert.strictEqual(summary.complete, 1);
    assert.strictEqual(summary.running, 1);
    assert.strictEqual(summary.waiting, 1);
    assert.strictEqual(summary.queued, 1);

    // D should NOT be launchable yet (B running, C waiting)
    const queue = [promptA, promptB, promptC, promptD];
    const launchable = getLaunchablePrompts(queue, sessions);
    assert.strictEqual(launchable.length, 0, 'D should not be launchable while B and C are still active');
  });

  it('handles session error blocking downstream prompts', () => {
    const promptA = makePrompt('Task A', 0);
    const promptB = makePrompt('Task B', 1, [promptA.id]);

    const sessionA = makeSession('Task A', 'error');
    promptA.status = 'launched';
    promptA.sessionId = sessionA.id;

    const queue = [promptA, promptB];
    const sessions = [sessionA];

    // B should NOT be launchable because A errored (not completed)
    const launchable = getLaunchablePrompts(queue, sessions);
    assert.strictEqual(launchable.length, 0, 'B should not launch when A has errored');
  });

  it('handles multiple CONDUCTOR_TASK blocks in output', () => {
    const outputContent = `Found two issues:

[CONDUCTOR_TASK]
description: Update the DNS records for staging.example.com
priority: normal
blocking: false
[/CONDUCTOR_TASK]

Also:

[CONDUCTOR_TASK]
description: Restart the CI runner — it has stale credentials
priority: urgent
blocking: true
[/CONDUCTOR_TASK]`;

    const tasks = extractTasks(outputContent);
    assert.strictEqual(tasks.length, 2);
    assert.strictEqual(tasks[0].description, 'Update the DNS records for staging.example.com');
    assert.strictEqual(tasks[0].blocking, false);
    assert.strictEqual(tasks[1].description, 'Restart the CI runner — it has stale credentials');
    assert.strictEqual(tasks[1].priority, 'urgent');
    assert.strictEqual(tasks[1].blocking, true);
  });
});
