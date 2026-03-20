/**
 * Conductor — Integration test: Dependency Chain Flow.
 *
 * Exercises the real SessionManager, QueueManager, and DependencyEngine
 * together to verify auto-launch on completion:
 *
 * 1. Create A → B → C chain
 * 2. Launch A manually
 * 3. Simulate A completing → verify B auto-launches
 * 4. Simulate B completing → verify C auto-launches
 * 5. Verify chain status summary at each step
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as assert from 'assert';

import { SessionManager } from '../../src/core/SessionManager';
import { QueueManager } from '../../src/core/QueueManager';
import { DependencyEngine } from '../../src/core/DependencyEngine';
import type { DependencyEvent } from '../../src/core/DependencyEngine';
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

// ── Suite ────────────────────────────────────────────────────────

describe('Dependency Chain Integration', () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let sm: SessionManager;
  let qm: QueueManager;
  let de: DependencyEngine;
  const workspacePath = '/tmp/test-workspace';

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-dep-integ-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;

    fs.mkdirSync(path.join(tmpHome, '.conductor', 'queue'), { recursive: true });

    clearProviders();
    const mock = createMockProvider();
    registerProvider(mock.provider);

    sm = new SessionManager();
    qm = new QueueManager(workspacePath, sm as any);
    de = new DependencyEngine(sm as any, qm as any);

    await sm.initialise();
    await qm.initialise();
    await de.initialise();
  });

  afterEach(() => {
    de.dispose();
    qm.dispose();
    sm.dispose();
    clearProviders();
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  // ── 1. Linear chain A → B → C auto-launch ───────────────────

  it('A completes → B auto-launches → B completes → C auto-launches', async () => {
    // Create the chain
    const promptA = await qm.addPrompt({ name: 'A — Route definitions', prompt: 'Create routes' });
    const promptB = await qm.addPrompt({ name: 'B — Auth middleware', prompt: 'Add auth', dependsOn: [promptA.id] });
    const promptC = await qm.addPrompt({ name: 'C — Integration tests', prompt: 'Write tests', dependsOn: [promptB.id] });

    // Validate DAG
    const validation = de.validateDAG();
    assert.ok(validation.valid, 'Linear chain should be a valid DAG');

    // Launch A manually
    const sessionA = await qm.launchPrompt(promptA.id);
    assert.strictEqual(sm.getSession(sessionA.id)!.status, 'running');

    // B and C should still be queued
    assert.strictEqual(qm.getPrompt(promptB.id)!.status, 'queued');
    assert.strictEqual(qm.getPrompt(promptC.id)!.status, 'queued');

    // Check chain status: 1 running (A), 2 queued (B, C)
    const status1 = de.getChainStatus();
    assert.strictEqual(status1.total, 3);
    assert.strictEqual(status1.running, 1);
    assert.strictEqual(status1.queued, 2);

    // Set up listener for B auto-launch, then complete A
    const bAutoLaunch = waitForDependencyEvent(de, 'auto-launched');
    await sm.updateStatus(sessionA.id, 'complete');

    // Wait for B to auto-launch
    const eventB = await bAutoLaunch;
    assert.strictEqual(eventB.promptId, promptB.id);
    assert.strictEqual(eventB.upstreamId, sessionA.id);

    // B should now be launched
    const bPrompt = qm.getPrompt(promptB.id)!;
    assert.strictEqual(bPrompt.status, 'launched');
    assert.ok(bPrompt.sessionId, 'B should have a session ID');
    assert.strictEqual(sm.getSession(bPrompt.sessionId!)!.status, 'running');

    // C should still be queued
    assert.strictEqual(qm.getPrompt(promptC.id)!.status, 'queued');

    // Chain status: 1 complete (A), 1 running (B), 1 queued (C)
    const status2 = de.getChainStatus();
    assert.strictEqual(status2.complete, 1);
    assert.strictEqual(status2.running, 1);
    assert.strictEqual(status2.queued, 1);

    // Set up listener for C auto-launch, then complete B
    const cAutoLaunch = waitForDependencyEvent(de, 'auto-launched');
    await sm.updateStatus(bPrompt.sessionId!, 'complete');

    // Wait for C to auto-launch
    const eventC = await cAutoLaunch;
    assert.strictEqual(eventC.promptId, promptC.id);

    // C should now be launched
    const cPrompt = qm.getPrompt(promptC.id)!;
    assert.strictEqual(cPrompt.status, 'launched');
    assert.ok(cPrompt.sessionId);
    assert.strictEqual(sm.getSession(cPrompt.sessionId!)!.status, 'running');

    // Chain status: 2 complete, 1 running
    const status3 = de.getChainStatus();
    assert.strictEqual(status3.complete, 2);
    assert.strictEqual(status3.running, 1);
    assert.strictEqual(status3.queued, 0);
  });

  // ── 2. Error blocking ────────────────────────────────────────

  it('upstream error blocks downstream prompts', async () => {
    const promptA = await qm.addPrompt({ name: 'A', prompt: 'Do A' });
    const promptB = await qm.addPrompt({ name: 'B', prompt: 'Do B', dependsOn: [promptA.id] });

    const sessionA = await qm.launchPrompt(promptA.id);

    // Set up listener for blocked event
    const blockedEvent = waitForDependencyEvent(de, 'blocked');
    await sm.updateStatus(sessionA.id, 'error');

    const event = await blockedEvent;
    assert.strictEqual(event.promptId, promptB.id);
    assert.strictEqual(event.upstreamId, sessionA.id);

    // B should be cancelled
    assert.strictEqual(qm.getPrompt(promptB.id)!.status, 'cancelled');
  });

  // ── 3. Cycle detection ───────────────────────────────────────

  it('rejects cycles via addDependency', async () => {
    const promptA = await qm.addPrompt({ name: 'A', prompt: 'Do A' });
    const promptB = await qm.addPrompt({ name: 'B', prompt: 'Do B', dependsOn: [promptA.id] });

    // Trying to make A depend on B should fail (creates cycle)
    await assert.rejects(
      () => de.addDependency(promptA.id, [promptB.id]),
      /cycle/i,
    );
  });

  // ── 4. Diamond dependency ────────────────────────────────────

  it('diamond: D launches only after both B and C complete', async () => {
    const pA = await qm.addPrompt({ name: 'A', prompt: 'Do A' });
    const pB = await qm.addPrompt({ name: 'B', prompt: 'Do B', dependsOn: [pA.id] });
    const pC = await qm.addPrompt({ name: 'C', prompt: 'Do C', dependsOn: [pA.id] });
    const pD = await qm.addPrompt({ name: 'D', prompt: 'Do D', dependsOn: [pB.id, pC.id] });

    // Valid DAG
    assert.ok(de.validateDAG().valid);

    // Launch and complete A
    const sA = await qm.launchPrompt(pA.id);

    // Collect all auto-launched IDs
    const autoLaunched: string[] = [];
    de.onDependencyEvent((e: DependencyEvent) => {
      if (e.type === 'auto-launched') { autoLaunched.push(e.promptId); }
    });

    await sm.updateStatus(sA.id, 'complete');

    // Wait for B and C to auto-launch
    await new Promise(resolve => setTimeout(resolve, 100));

    assert.ok(autoLaunched.includes(pB.id), 'B should auto-launch after A completes');
    assert.ok(autoLaunched.includes(pC.id), 'C should auto-launch after A completes');
    assert.ok(!autoLaunched.includes(pD.id), 'D should NOT auto-launch yet');

    // D should still be queued
    assert.strictEqual(qm.getPrompt(pD.id)!.status, 'queued');

    // Complete B
    const bSessionId = qm.getPrompt(pB.id)!.sessionId!;
    await sm.updateStatus(bSessionId, 'complete');
    await new Promise(resolve => setTimeout(resolve, 100));

    // D still not launched (C still running)
    assert.ok(!autoLaunched.includes(pD.id), 'D should NOT auto-launch with only B complete');

    // Complete C
    const cSessionId = qm.getPrompt(pC.id)!.sessionId!;

    const dAutoLaunch = waitForDependencyEvent(de, 'auto-launched');
    await sm.updateStatus(cSessionId, 'complete');
    const eventD = await dAutoLaunch;

    assert.strictEqual(eventD.promptId, pD.id, 'D should auto-launch after B+C complete');
    assert.strictEqual(qm.getPrompt(pD.id)!.status, 'launched');
  });

  // ── 5. Topological order ─────────────────────────────────────

  it('getTopologicalOrder returns correct order', async () => {
    const pA = await qm.addPrompt({ name: 'A', prompt: 'Do A' });
    const pB = await qm.addPrompt({ name: 'B', prompt: 'Do B', dependsOn: [pA.id] });
    const pC = await qm.addPrompt({ name: 'C', prompt: 'Do C', dependsOn: [pB.id] });

    const order = de.getTopologicalOrder();
    const names = order.map(p => p.name);

    assert.strictEqual(names.indexOf('A'), 0, 'A should be first');
    assert.ok(names.indexOf('B') < names.indexOf('C'), 'B should come before C');
  });

  // ── 6. getDependents ─────────────────────────────────────────

  it('getDependents finds direct dependents', async () => {
    const pA = await qm.addPrompt({ name: 'A', prompt: 'Do A' });
    const pB = await qm.addPrompt({ name: 'B', prompt: 'Do B', dependsOn: [pA.id] });
    const pC = await qm.addPrompt({ name: 'C', prompt: 'Do C', dependsOn: [pA.id] });
    await qm.addPrompt({ name: 'D', prompt: 'Do D', dependsOn: [pB.id] });

    const dependents = de.getDependents(pA.id);
    assert.strictEqual(dependents.length, 2, 'A should have 2 direct dependents');
    const depNames = dependents.map(p => p.name).sort();
    assert.deepStrictEqual(depNames, ['B', 'C']);
  });

  // ── 7. getDependents via sessionId ────────────────────────────

  it('getDependents finds dependents via sessionId', async () => {
    const pA = await qm.addPrompt({ name: 'A', prompt: 'Do A' });
    const pB = await qm.addPrompt({ name: 'B', prompt: 'Do B', dependsOn: [pA.id] });

    // Launch A → sets sessionId on prompt A
    const sA = await qm.launchPrompt(pA.id);

    // getDependents with sessionId should find B
    const dependents = de.getDependents(sA.id);
    assert.strictEqual(dependents.length, 1);
    assert.strictEqual(dependents[0].id, pB.id);
  });

  // ── 8. allDependenciesMet ────────────────────────────────────

  it('allDependenciesMet returns correct status', async () => {
    const pA = await qm.addPrompt({ name: 'A', prompt: 'Do A' });
    const pB = await qm.addPrompt({ name: 'B', prompt: 'Do B', dependsOn: [pA.id] });

    // B's deps not met (A not launched)
    assert.ok(!de.allDependenciesMet(pB.id));

    // Launch and complete A
    const sA = await qm.launchPrompt(pA.id);
    assert.ok(!de.allDependenciesMet(pB.id)); // still not met (running)

    await sm.updateStatus(sA.id, 'complete');

    // Wait for microtasks to settle
    await new Promise(resolve => setTimeout(resolve, 50));

    // B's deps should now be met
    assert.ok(de.allDependenciesMet(pB.id));
  });
});
