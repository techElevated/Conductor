/**
 * Conductor — Unit tests: core/SessionManager.ts
 *
 * Tests session creation, status updates, discovery reconciliation,
 * event emission, and persistence round-trips.  All file I/O goes
 * to a temp directory; vscode is stubbed via test/setup.ts.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { SessionManager } from '../../../src/core/SessionManager';
import { clearProviders } from '../../../src/providers';
import type { DiscoveredSession } from '../../../src/types';

// ── Test helpers ─────────────────────────────────────────────────

function makeTmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-sm-'));
  fs.mkdirSync(path.join(dir, '.conductor'), { recursive: true });
  return dir;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collectEvents(
  subscribe: (cb: (e: any) => void) => { dispose: () => void },
): { events: any[]; dispose: () => void } {
  const events: any[] = [];
  const disposable = subscribe((e: unknown) => { events.push(e); });
  return { events, dispose: () => disposable.dispose() };
}

// ── Suite ────────────────────────────────────────────────────────

describe('SessionManager — createSession', () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let manager: SessionManager;

  beforeEach(() => {
    origHome = process.env.HOME;
    tmpHome = makeTmpHome();
    process.env.HOME = tmpHome;
    manager = new SessionManager();
  });

  afterEach(() => {
    manager.dispose();
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('creates a session with status "queued"', async () => {
    const session = await manager.createSession('Test', 'claude-code', '/ws', 'Do something');
    assert.strictEqual(session.status, 'queued');
  });

  it('assigns a unique UUID', async () => {
    const s1 = await manager.createSession('A', 'claude-code', '/ws', 'Prompt A');
    const s2 = await manager.createSession('B', 'claude-code', '/ws', 'Prompt B');
    assert.notStrictEqual(s1.id, s2.id);
    assert.ok(s1.id.length > 0);
  });

  it('stores name, providerId, workspacePath, prompt', async () => {
    const session = await manager.createSession('My Session', 'claude-code', '/my/workspace', 'Build the thing');
    assert.strictEqual(session.name, 'My Session');
    assert.strictEqual(session.providerId, 'claude-code');
    assert.strictEqual(session.workspacePath, '/my/workspace');
    assert.strictEqual(session.prompt, 'Build the thing');
  });

  it('emits a "created" event', async () => {
    const { events, dispose } = collectEvents(cb => manager.onSessionEvent(cb));
    await manager.createSession('Evt', 'claude-code', '/ws', 'Prompt');
    dispose();
    assert.ok(events.some(e => e.type === 'created'));
  });

  it('persists to disk (readable after re-instantiation)', async () => {
    const session = await manager.createSession('Persist', 'claude-code', '/ws', 'Stored prompt');
    manager.dispose();

    const manager2 = new SessionManager();
    await manager2.initialise();
    const loaded = manager2.getSession(session.id);
    assert.ok(loaded !== undefined);
    assert.strictEqual(loaded!.name, 'Persist');
    manager2.dispose();
  });

  it('stores dependsOn and templateId from opts', async () => {
    const session = await manager.createSession('Dep', 'claude-code', '/ws', 'Prompt', {
      dependsOn: ['parent-id'],
      templateId: 'tpl-001',
    });
    assert.deepStrictEqual(session.dependsOn, ['parent-id']);
    assert.strictEqual(session.templateId, 'tpl-001');
  });
});

describe('SessionManager — getSession / getAllSessions / getSessionsByStatus', () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let manager: SessionManager;

  beforeEach(async () => {
    origHome = process.env.HOME;
    tmpHome = makeTmpHome();
    process.env.HOME = tmpHome;
    manager = new SessionManager();
    await manager.createSession('A', 'claude-code', '/ws', 'PA');
    await manager.createSession('B', 'claude-code', '/ws', 'PB');
  });

  afterEach(() => {
    manager.dispose();
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('getSession returns the correct session by ID', async () => {
    const all = manager.getAllSessions();
    const first = all[0];
    const found = manager.getSession(first.id);
    assert.ok(found !== undefined);
    assert.strictEqual(found!.id, first.id);
  });

  it('getSession returns undefined for unknown ID', () => {
    assert.strictEqual(manager.getSession('no-such-id'), undefined);
  });

  it('getAllSessions returns all created sessions', () => {
    assert.strictEqual(manager.getAllSessions().length, 2);
  });

  it('getSessionsByStatus filters correctly', () => {
    const queued = manager.getSessionsByStatus('queued');
    assert.strictEqual(queued.length, 2);
    const running = manager.getSessionsByStatus('running');
    assert.strictEqual(running.length, 0);
  });
});

describe('SessionManager — updateStatus', () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let manager: SessionManager;

  beforeEach(async () => {
    origHome = process.env.HOME;
    tmpHome = makeTmpHome();
    process.env.HOME = tmpHome;
    manager = new SessionManager();
  });

  afterEach(() => {
    manager.dispose();
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('updates status and emits "stateChanged" event', async () => {
    const session = await manager.createSession('S', 'claude-code', '/ws', 'P');
    const { events, dispose } = collectEvents(cb => manager.onSessionEvent(cb));
    await manager.updateStatus(session.id, 'running');
    dispose();
    assert.strictEqual(manager.getSession(session.id)!.status, 'running');
    assert.ok(events.some(e => e.type === 'stateChanged'));
  });

  it('emits "completed" event when status becomes "complete"', async () => {
    const session = await manager.createSession('S', 'claude-code', '/ws', 'P');
    await manager.updateStatus(session.id, 'running');
    const { events, dispose } = collectEvents(cb => manager.onSessionEvent(cb));
    await manager.updateStatus(session.id, 'complete');
    dispose();
    assert.ok(events.some(e => e.type === 'completed'));
  });

  it('emits "error" event when status becomes "error"', async () => {
    const session = await manager.createSession('S', 'claude-code', '/ws', 'P');
    const { events, dispose } = collectEvents(cb => manager.onSessionEvent(cb));
    await manager.updateStatus(session.id, 'error');
    dispose();
    assert.ok(events.some(e => e.type === 'error'));
  });

  it('is a no-op if new status equals current status', async () => {
    const session = await manager.createSession('S', 'claude-code', '/ws', 'P');
    const { events, dispose } = collectEvents(cb => manager.onSessionEvent(cb));
    await manager.updateStatus(session.id, 'queued'); // same status
    dispose();
    assert.strictEqual(events.length, 0, 'No event should fire for same status');
  });

  it('sets completedAt for terminal statuses', async () => {
    const session = await manager.createSession('S', 'claude-code', '/ws', 'P');
    await manager.updateStatus(session.id, 'complete');
    const updated = manager.getSession(session.id)!;
    assert.ok(typeof updated.completedAt === 'string');
    assert.ok(updated.completedAt!.length > 0);
  });

  it('throws for unknown session ID', async () => {
    await assert.rejects(
      () => manager.updateStatus('no-such-id', 'running'),
      /not found/i,
    );
  });
});

describe('SessionManager — mergeDiscovered', () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let manager: SessionManager;

  beforeEach(() => {
    origHome = process.env.HOME;
    tmpHome = makeTmpHome();
    process.env.HOME = tmpHome;
    manager = new SessionManager();
  });

  afterEach(() => {
    manager.dispose();
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function makeDiscovered(id: string, status: 'running' | 'complete' = 'running'): DiscoveredSession {
    return {
      id,
      name: `Session ${id}`,
      workspacePath: '/ws',
      pid: null,
      status,
      startedAt: new Date().toISOString(),
      managed: false,
    };
  }

  it('adds new discovered sessions and emits "created"', async () => {
    const { events, dispose } = collectEvents(cb => manager.onSessionEvent(cb));
    await manager.mergeDiscovered([makeDiscovered('ext-1'), makeDiscovered('ext-2')], 'claude-code');
    dispose();
    assert.strictEqual(manager.getAllSessions().length, 2);
    assert.strictEqual(events.filter(e => e.type === 'created').length, 2);
  });

  it('updates status of existing session and emits "stateChanged"', async () => {
    await manager.mergeDiscovered([makeDiscovered('ext-1', 'running')], 'claude-code');
    const { events, dispose } = collectEvents(cb => manager.onSessionEvent(cb));
    await manager.mergeDiscovered([makeDiscovered('ext-1', 'complete')], 'claude-code');
    dispose();
    assert.ok(events.some(e => e.type === 'stateChanged'));
    assert.strictEqual(manager.getSession('ext-1')!.status, 'complete');
  });

  it('does not emit events if status is unchanged', async () => {
    await manager.mergeDiscovered([makeDiscovered('ext-1', 'running')], 'claude-code');
    const { events, dispose } = collectEvents(cb => manager.onSessionEvent(cb));
    await manager.mergeDiscovered([makeDiscovered('ext-1', 'running')], 'claude-code');
    dispose();
    assert.strictEqual(events.length, 0);
  });

  it('marks discovered sessions with discoveredExternally metadata', async () => {
    await manager.mergeDiscovered([makeDiscovered('ext-1')], 'claude-code');
    const session = manager.getSession('ext-1')!;
    assert.strictEqual(session.metadata['discoveredExternally'], true);
  });
});

describe('SessionManager — removeSession', () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let manager: SessionManager;

  beforeEach(() => {
    origHome = process.env.HOME;
    tmpHome = makeTmpHome();
    process.env.HOME = tmpHome;
    manager = new SessionManager();
  });

  afterEach(() => {
    manager.dispose();
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('removes session from registry', async () => {
    const session = await manager.createSession('R', 'claude-code', '/ws', 'P');
    await manager.removeSession(session.id);
    assert.strictEqual(manager.getSession(session.id), undefined);
  });

  it('is a no-op for unknown session ID', async () => {
    await assert.doesNotReject(() => manager.removeSession('no-such-id'));
  });
});
