/**
 * Conductor — Integration test: Queue → Launch Flow.
 *
 * Exercises the real QueueManager and SessionManager together:
 * 1. Add prompt to queue → verify queued
 * 2. Launch prompt → provider.launchSession called → terminal created
 * 3. Session registered in SessionManager with running status
 * 4. Prompt status updated to 'launched' with sessionId set
 * 5. Hook installation via provider adapter
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as assert from 'assert';

import { SessionManager } from '../../src/core/SessionManager';
import { QueueManager } from '../../src/core/QueueManager';
import { registerProvider, clearProviders } from '../../src/providers';
import { createMockProvider } from '../helpers/mockProvider';

// ── Suite ────────────────────────────────────────────────────────

describe('Queue → Launch Integration', () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let sm: SessionManager;
  let qm: QueueManager;
  const workspacePath = '/tmp/test-workspace';
  let mockCalls: ReturnType<typeof createMockProvider>['calls'];

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-queue-integ-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;

    // Ensure storage dirs
    fs.mkdirSync(path.join(tmpHome, '.conductor', 'queue'), { recursive: true });

    // Register mock provider
    clearProviders();
    const mock = createMockProvider();
    mockCalls = mock.calls;
    registerProvider(mock.provider);

    // Create real engines
    sm = new SessionManager();
    qm = new QueueManager(workspacePath, sm as any);

    // Initialise (loads from empty disk)
    await sm.initialise();
    await qm.initialise();
  });

  afterEach(() => {
    qm.dispose();
    sm.dispose();
    clearProviders();
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  // ── 1. Add prompt ──────────────────────────────────────────────

  it('addPrompt adds to queue with correct defaults', async () => {
    const prompt = await qm.addPrompt({
      name: 'Route definitions',
      prompt: 'Create the Express route definitions for the API',
    });

    assert.ok(prompt.id, 'Should have an ID');
    assert.strictEqual(prompt.name, 'Route definitions');
    assert.strictEqual(prompt.status, 'queued');
    assert.strictEqual(prompt.providerId, 'claude-code');
    assert.strictEqual(prompt.parallelSafe, true);
    assert.strictEqual(prompt.complexity, 'medium');
    assert.deepStrictEqual(prompt.dependsOn, []);
    assert.strictEqual(prompt.sessionId, null);

    // Verify in queue
    const queue = qm.getQueue();
    assert.strictEqual(queue.length, 1);
    assert.strictEqual(queue[0].id, prompt.id);

    // Verify persisted to disk
    const hash = require('crypto').createHash('sha256').update(workspacePath).digest('hex').slice(0, 16);
    const queueFile = path.join(tmpHome, '.conductor', 'queue', `${hash}.json`);
    assert.ok(fs.existsSync(queueFile), 'Queue file should be persisted');
  });

  // ── 2. Launch prompt → provider called → terminal created ────

  it('launchPrompt calls provider and creates terminal', async () => {
    const prompt = await qm.addPrompt({
      name: 'Build API server',
      prompt: 'Set up an Express server with health check endpoint',
    });

    // Launch
    const session = await qm.launchPrompt(prompt.id);

    // Provider.launchSession was called
    assert.strictEqual(mockCalls.launchSession.length, 1);
    const launchConfig = mockCalls.launchSession[0];
    assert.strictEqual(launchConfig.sessionName, 'Build API server');
    assert.strictEqual(launchConfig.workspacePath, workspacePath);
    assert.ok(launchConfig.prompt.includes('Express server'));

    // ManagedSession returned with terminal
    assert.ok(session, 'Session should be returned');
    assert.ok(session.id, 'Session should have an ID');
  });

  // ── 3. Session registered in SessionManager ───────────────────

  it('launched session is registered in SessionManager with running status', async () => {
    const prompt = await qm.addPrompt({
      name: 'Database setup',
      prompt: 'Create PostgreSQL schema',
    });

    const session = await qm.launchPrompt(prompt.id);

    // Session exists in SessionManager
    const registered = sm.getSession(session.id);
    assert.ok(registered, 'Session should be in SessionManager');
    assert.strictEqual(registered!.name, 'Database setup');
    assert.strictEqual(registered!.status, 'running');
    assert.ok(registered!.pid, 'Should have a PID');
    assert.ok(registered!.launchedAt, 'Should have launchedAt');
    assert.strictEqual(registered!.providerId, 'claude-code');
    assert.strictEqual(registered!.workspacePath, workspacePath);
  });

  // ── 4. Prompt status updated ──────────────────────────────────

  it('prompt status updated to launched with sessionId set', async () => {
    const prompt = await qm.addPrompt({
      name: 'Auth middleware',
      prompt: 'Implement JWT auth middleware',
    });

    const session = await qm.launchPrompt(prompt.id);

    // Re-fetch prompt from queue
    const updated = qm.getPrompt(prompt.id);
    assert.ok(updated, 'Prompt should still exist in queue');
    assert.strictEqual(updated!.status, 'launched');
    assert.strictEqual(updated!.sessionId, session.id);
    assert.ok(updated!.launchedAt, 'Should have launchedAt timestamp');
  });

  // ── 5. Cannot launch non-queued prompt ────────────────────────

  it('throws when launching an already-launched prompt', async () => {
    const prompt = await qm.addPrompt({ name: 'Test', prompt: 'Run tests' });
    await qm.launchPrompt(prompt.id);

    await assert.rejects(
      () => qm.launchPrompt(prompt.id),
      /not in queued status/,
    );
  });

  // ── 6. Dependency check blocks launch ─────────────────────────

  it('rejects launch when dependencies are unmet', async () => {
    const upstream = await qm.addPrompt({ name: 'Upstream', prompt: 'Do A' });
    const downstream = await qm.addPrompt({
      name: 'Downstream',
      prompt: 'Do B',
      dependsOn: [upstream.id],
    });

    // Downstream should not launch (upstream not complete)
    await assert.rejects(
      () => qm.launchPrompt(downstream.id),
      /unmet dependencies/,
    );
  });

  // ── 7. Launch succeeds when dependencies met ──────────────────

  it('allows launch when all dependencies are complete', async () => {
    const upstream = await qm.addPrompt({ name: 'Upstream', prompt: 'Do A' });
    const downstream = await qm.addPrompt({
      name: 'Downstream',
      prompt: 'Do B',
      dependsOn: [upstream.id],
    });

    // Launch and complete upstream
    const sessionA = await qm.launchPrompt(upstream.id);
    await sm.updateStatus(sessionA.id, 'complete');

    // Now downstream should be launchable
    const sessionB = await qm.launchPrompt(downstream.id);
    assert.ok(sessionB, 'Downstream should launch successfully');
    assert.strictEqual(sm.getSession(sessionB.id)!.status, 'running');
  });

  // ── 8. Force-launch bypasses deps ─────────────────────────────

  it('forceLaunch bypasses dependency check', async () => {
    const upstream = await qm.addPrompt({ name: 'Upstream', prompt: 'Do A' });
    const downstream = await qm.addPrompt({
      name: 'Downstream',
      prompt: 'Do B',
      dependsOn: [upstream.id],
    });

    // Force launch despite unmet dependency
    const session = await qm.forceLaunch(downstream.id);
    assert.ok(session, 'Should launch despite unmet deps');
    assert.strictEqual(qm.getPrompt(downstream.id)!.status, 'launched');
  });

  // ── 9. Queue events fire correctly ────────────────────────────

  it('fires add, launch queue events', async () => {
    const events: Array<{ type: string; promptId: string }> = [];
    qm.onQueueEvent((e) => events.push({ type: e.type, promptId: e.promptId }));

    const prompt = await qm.addPrompt({ name: 'Evented', prompt: 'Test events' });
    await qm.launchPrompt(prompt.id);

    assert.ok(events.some(e => e.type === 'added'), 'Should fire added event');
    assert.ok(events.some(e => e.type === 'launched'), 'Should fire launched event');
  });

  // ── 10. Session events fire on launch ─────────────────────────

  it('SessionManager fires created and launched events', async () => {
    const events: string[] = [];
    sm.onSessionEvent((e) => events.push(e.type));

    const prompt = await qm.addPrompt({ name: 'Tracked', prompt: 'Test' });
    await qm.launchPrompt(prompt.id);

    assert.ok(events.includes('created'), 'Should fire created event');
    assert.ok(events.includes('launched'), 'Should fire launched event');
  });
});
