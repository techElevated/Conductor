/**
 * Conductor — Integration test: End-to-End Multi-Session Workflow.
 *
 * Full 4-session diamond workflow exercising real engines:
 *   a. Add 4 prompts: A, B (depends A), C (depends A), D (depends B+C)
 *   b. Launch A
 *   c. Simulate approval needed → approve it
 *   d. Simulate CONDUCTOR_TASK in output → verify task detected
 *   e. Simulate A completing → verify B and C auto-launch
 *   f. Simulate B and C completing → verify D auto-launches
 *   g. Verify chain status summary accurate at each step
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as assert from 'assert';
import { v4 as uuid } from 'uuid';

import { SessionManager } from '../../src/core/SessionManager';
import { QueueManager } from '../../src/core/QueueManager';
import { DependencyEngine } from '../../src/core/DependencyEngine';
import { ApprovalEngine } from '../../src/core/ApprovalEngine';
import type { DependencyEvent, ChainStatus } from '../../src/core/DependencyEngine';
import { matchTasks, parseStructuredTask } from '../../src/utils/patternMatcher';
import { registerProvider, clearProviders } from '../../src/providers';
import { createMockProvider } from '../helpers/mockProvider';

// ── Event helpers ────────────────────────────────────────────────

function waitForDependencyEvent(
  engine: DependencyEngine,
  type: DependencyEvent['type'],
  timeoutMs = 5000,
): Promise<DependencyEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      disposable.dispose();
      reject(new Error(`Timed out waiting for '${type}' event after ${timeoutMs}ms`));
    }, timeoutMs);

    const disposable = engine.onDependencyEvent((event: DependencyEvent) => {
      if (event.type === type) {
        clearTimeout(timer);
        disposable.dispose();
        resolve(event);
      }
    });
  });
}

function waitForMultipleDependencyEvents(
  engine: DependencyEngine,
  type: DependencyEvent['type'],
  count: number,
  timeoutMs = 5000,
): Promise<DependencyEvent[]> {
  return new Promise((resolve, reject) => {
    const collected: DependencyEvent[] = [];
    const timer = setTimeout(() => {
      disposable.dispose();
      reject(new Error(
        `Timed out: expected ${count} '${type}' events, got ${collected.length} after ${timeoutMs}ms`,
      ));
    }, timeoutMs);

    const disposable = engine.onDependencyEvent((event: DependencyEvent) => {
      if (event.type === type) {
        collected.push(event);
        if (collected.length >= count) {
          clearTimeout(timer);
          disposable.dispose();
          resolve(collected);
        }
      }
    });
  });
}

function assertChainStatus(
  actual: ChainStatus,
  expected: Partial<ChainStatus>,
  label: string,
): void {
  for (const [key, value] of Object.entries(expected)) {
    assert.strictEqual(
      (actual as any)[key],
      value,
      `${label}: expected ${key}=${value}, got ${(actual as any)[key]}`,
    );
  }
}

// ── Suite ────────────────────────────────────────────────────────

describe('E2E Multi-Session Workflow', () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let sm: SessionManager;
  let qm: QueueManager;
  let de: DependencyEngine;
  let ae: ApprovalEngine;
  const workspacePath = '/tmp/test-workspace';

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-e2e-integ-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;

    fs.mkdirSync(path.join(tmpHome, '.conductor', 'queue'), { recursive: true });

    clearProviders();
    const mock = createMockProvider();
    registerProvider(mock.provider);

    sm = new SessionManager();
    qm = new QueueManager(workspacePath, sm as any);
    de = new DependencyEngine(sm as any, qm as any);
    ae = new ApprovalEngine();

    await sm.initialise();
    await qm.initialise();
    await de.initialise();
    await ae.initialise();
  });

  afterEach(() => {
    ae.dispose();
    de.dispose();
    qm.dispose();
    sm.dispose();
    clearProviders();
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  // ── Full E2E workflow ─────────────────────────────────────────

  it('full 4-session diamond workflow with approvals and task detection', async () => {
    // ─── Step (a): Add 4 prompts with diamond dependencies ────
    const pA = await qm.addPrompt({ name: 'Task A', prompt: 'Set up project scaffolding' });
    const pB = await qm.addPrompt({ name: 'Task B', prompt: 'Build API layer', dependsOn: [pA.id] });
    const pC = await qm.addPrompt({ name: 'Task C', prompt: 'Build UI components', dependsOn: [pA.id] });
    const pD = await qm.addPrompt({ name: 'Task D', prompt: 'Integration testing', dependsOn: [pB.id, pC.id] });

    assert.strictEqual(qm.getQueue().length, 4);
    assert.ok(de.validateDAG().valid, 'Diamond DAG should be valid');

    // Initial chain status: all queued
    assertChainStatus(de.getChainStatus(), { total: 4, queued: 4, running: 0, complete: 0 }, 'Step a');

    // ─── Step (b): Launch A ───────────────────────────────────
    const sessionA = await qm.launchPrompt(pA.id);
    assert.strictEqual(sm.getSession(sessionA.id)!.status, 'running');
    assert.strictEqual(qm.getPrompt(pA.id)!.status, 'launched');

    // Chain status: 1 running, 3 queued
    assertChainStatus(de.getChainStatus(), { running: 1, queued: 3, complete: 0 }, 'Step b');

    // ─── Step (c): Simulate approval needed → approve it ──────
    const approvalId = uuid();
    const approvalsDir = path.join(tmpHome, '.conductor', 'approvals');
    const sessionDir = path.join(approvalsDir, sessionA.id);
    fs.mkdirSync(sessionDir, { recursive: true });

    // Write pending approval file
    fs.writeFileSync(
      path.join(sessionDir, `${approvalId}.json`),
      JSON.stringify({
        id: approvalId,
        sessionId: sessionA.id,
        sessionName: 'Task A',
        tool: 'Bash',
        command: 'npm install express',
        context: 'Installing server dependency',
        timestamp: new Date().toISOString(),
        status: 'pending',
        resolvedAt: null,
      }, null, 2),
    );

    // Re-scan approvals (engine was initialised before the file was written)
    // We create a new ApprovalEngine to pick up the file via scanAllApprovals
    ae.dispose();
    ae = new ApprovalEngine();
    await ae.initialise();

    assert.strictEqual(ae.getPendingCount(), 1, 'Should detect pending approval');
    const pending = ae.getPendingApprovals();
    assert.strictEqual(pending[0].sessionId, sessionA.id);

    // Approve it
    await ae.approveAction(approvalId);
    assert.strictEqual(ae.getPendingCount(), 0, 'Approval should be resolved');

    // Decision file written
    const decisionPath = path.join(sessionDir, `${approvalId}.decision.json`);
    assert.ok(fs.existsSync(decisionPath), 'Decision file should exist');
    const decision = JSON.parse(fs.readFileSync(decisionPath, 'utf-8'));
    assert.strictEqual(decision.decision, 'allow');

    // ─── Step (d): Simulate CONDUCTOR_TASK → verify detection ─
    const taskOutput = `I've completed the scaffolding. However, you need to configure the CI pipeline.

[CONDUCTOR_TASK]
description: Configure GitHub Actions CI pipeline for the new project
priority: urgent
blocking: true
[/CONDUCTOR_TASK]

Continuing with the remaining setup...`;

    // Use pattern matcher directly (as TaskDetector does internally)
    const detectedTasks = matchTasks(taskOutput);
    const conductorTasks = detectedTasks.filter(t => t.patternName === 'conductor-tag');
    assert.strictEqual(conductorTasks.length, 1, 'Should detect 1 CONDUCTOR_TASK');

    // Parse structured fields
    const parsed = parseStructuredTask(taskOutput);
    assert.ok(parsed, 'Should parse structured task');
    assert.strictEqual(parsed!.description, 'Configure GitHub Actions CI pipeline for the new project');
    assert.strictEqual(parsed!.priority, 'urgent');
    assert.strictEqual(parsed!.blocking, true);

    // ─── Step (e): A completes → B and C auto-launch ──────────
    const bcAutoLaunch = waitForMultipleDependencyEvents(de, 'auto-launched', 2);
    await sm.updateStatus(sessionA.id, 'complete');

    const bcEvents = await bcAutoLaunch;
    const autoLaunchedIds = bcEvents.map(e => e.promptId).sort();
    const expectedIds = [pB.id, pC.id].sort();
    assert.deepStrictEqual(autoLaunchedIds, expectedIds, 'B and C should both auto-launch');

    // Verify B and C states
    assert.strictEqual(qm.getPrompt(pB.id)!.status, 'launched');
    assert.strictEqual(qm.getPrompt(pC.id)!.status, 'launched');
    assert.ok(qm.getPrompt(pB.id)!.sessionId);
    assert.ok(qm.getPrompt(pC.id)!.sessionId);

    const bSessionId = qm.getPrompt(pB.id)!.sessionId!;
    const cSessionId = qm.getPrompt(pC.id)!.sessionId!;
    assert.strictEqual(sm.getSession(bSessionId)!.status, 'running');
    assert.strictEqual(sm.getSession(cSessionId)!.status, 'running');

    // D should still be queued
    assert.strictEqual(qm.getPrompt(pD.id)!.status, 'queued');

    // Chain status: 1 complete (A), 2 running (B, C), 1 queued (D)
    assertChainStatus(de.getChainStatus(), { complete: 1, running: 2, queued: 1 }, 'Step e');

    // ─── Step (f): B and C complete → D auto-launches ─────────

    // Complete B first
    await sm.updateStatus(bSessionId, 'complete');
    // D should NOT auto-launch yet (C still running)
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.strictEqual(qm.getPrompt(pD.id)!.status, 'queued', 'D should stay queued after only B completes');

    // Chain status: 2 complete, 1 running, 1 queued
    assertChainStatus(de.getChainStatus(), { complete: 2, running: 1, queued: 1 }, 'Step f.1');

    // Complete C → D should auto-launch
    const dAutoLaunch = waitForDependencyEvent(de, 'auto-launched');
    await sm.updateStatus(cSessionId, 'complete');

    const dEvent = await dAutoLaunch;
    assert.strictEqual(dEvent.promptId, pD.id, 'D should auto-launch after B+C complete');

    assert.strictEqual(qm.getPrompt(pD.id)!.status, 'launched');
    const dSessionId = qm.getPrompt(pD.id)!.sessionId!;
    assert.strictEqual(sm.getSession(dSessionId)!.status, 'running');

    // Chain status: 3 complete (A, B, C), 1 running (D)
    assertChainStatus(de.getChainStatus(), { complete: 3, running: 1, queued: 0 }, 'Step f.2');

    // ─── Step (g): D completes → all done ─────────────────────
    await sm.updateStatus(dSessionId, 'complete');

    // Final chain status: all 4 complete
    assertChainStatus(de.getChainStatus(), { total: 4, complete: 4, running: 0, queued: 0, failed: 0 }, 'Step g');
  });

  // ── Error propagation in diamond ──────────────────────────────

  it('error in one branch blocks D but not the other branch', async () => {
    const pA = await qm.addPrompt({ name: 'A', prompt: 'Do A' });
    const pB = await qm.addPrompt({ name: 'B', prompt: 'Do B', dependsOn: [pA.id] });
    const pC = await qm.addPrompt({ name: 'C', prompt: 'Do C', dependsOn: [pA.id] });
    const pD = await qm.addPrompt({ name: 'D', prompt: 'Do D', dependsOn: [pB.id, pC.id] });

    // Launch and complete A → B and C auto-launch
    const sA = await qm.launchPrompt(pA.id);
    const bcLaunch = waitForMultipleDependencyEvents(de, 'auto-launched', 2);
    await sm.updateStatus(sA.id, 'complete');
    await bcLaunch;

    // B errors → D should be blocked
    const bSessionId = qm.getPrompt(pB.id)!.sessionId!;
    const blockedEvent = waitForDependencyEvent(de, 'blocked');
    await sm.updateStatus(bSessionId, 'error');

    const blocked = await blockedEvent;
    assert.strictEqual(blocked.promptId, pD.id, 'D should be blocked when B errors');
    assert.strictEqual(qm.getPrompt(pD.id)!.status, 'cancelled');

    // C can still complete without issue
    const cSessionId = qm.getPrompt(pC.id)!.sessionId!;
    await sm.updateStatus(cSessionId, 'complete');

    // Chain status should reflect the error
    const status = de.getChainStatus();
    assert.ok(status.complete >= 2, 'A and C should be complete');
    assert.ok(status.failed >= 1, 'B and/or D should be failed');
  });

  // ── Multiple CONDUCTOR_TASK blocks ────────────────────────────

  it('detects multiple CONDUCTOR_TASK blocks from agent output', () => {
    const output = `Working on the feature. Found two things that need attention:

[CONDUCTOR_TASK]
description: Update the DNS records for staging.example.com
priority: normal
blocking: false
[/CONDUCTOR_TASK]

Also discovered this:

[CONDUCTOR_TASK]
description: Restart the CI runner — stale credentials
priority: urgent
blocking: true
[/CONDUCTOR_TASK]`;

    const tasks = matchTasks(output);
    const conductorTasks = tasks.filter(t => t.patternName === 'conductor-tag');
    assert.strictEqual(conductorTasks.length, 2);

    // Parse first block
    const parsed1 = parseStructuredTask(output);
    assert.ok(parsed1);
    assert.strictEqual(parsed1!.description, 'Update the DNS records for staging.example.com');
    assert.strictEqual(parsed1!.blocking, false);
  });

  // ── Chain status at every step ────────────────────────────────

  it('chain status is accurate at every step of the workflow', async () => {
    const pA = await qm.addPrompt({ name: 'A', prompt: 'Do A' });
    const pB = await qm.addPrompt({ name: 'B', prompt: 'Do B', dependsOn: [pA.id] });
    const pC = await qm.addPrompt({ name: 'C', prompt: 'Do C', dependsOn: [pA.id] });
    const pD = await qm.addPrompt({ name: 'D', prompt: 'Do D', dependsOn: [pB.id, pC.id] });

    // Step 0: all queued
    assertChainStatus(de.getChainStatus(),
      { total: 4, queued: 4, running: 0, complete: 0, failed: 0 },
      'All queued');

    // Step 1: A running
    const sA = await qm.launchPrompt(pA.id);
    assertChainStatus(de.getChainStatus(),
      { running: 1, queued: 3 },
      'A running');

    // Step 2: A complete, B+C auto-launch
    const bc = waitForMultipleDependencyEvents(de, 'auto-launched', 2);
    await sm.updateStatus(sA.id, 'complete');
    await bc;
    assertChainStatus(de.getChainStatus(),
      { complete: 1, running: 2, queued: 1 },
      'A done, B+C running');

    // Step 3: B complete
    await sm.updateStatus(qm.getPrompt(pB.id)!.sessionId!, 'complete');
    await new Promise(resolve => setTimeout(resolve, 100));
    assertChainStatus(de.getChainStatus(),
      { complete: 2, running: 1, queued: 1 },
      'A+B done, C running');

    // Step 4: C complete → D auto-launches
    const dLaunch = waitForDependencyEvent(de, 'auto-launched');
    await sm.updateStatus(qm.getPrompt(pC.id)!.sessionId!, 'complete');
    await dLaunch;
    assertChainStatus(de.getChainStatus(),
      { complete: 3, running: 1, queued: 0 },
      'A+B+C done, D running');

    // Step 5: D complete → all done
    await sm.updateStatus(qm.getPrompt(pD.id)!.sessionId!, 'complete');
    assertChainStatus(de.getChainStatus(),
      { total: 4, complete: 4, running: 0, queued: 0, failed: 0 },
      'All complete');
  });
});
