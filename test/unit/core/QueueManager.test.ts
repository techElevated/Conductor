/**
 * Conductor — Unit tests: core/QueueManager.ts
 *
 * Tests prompt CRUD, reordering, dependency checking, and the
 * permission-mode hierarchy.  SessionManager is mocked with a
 * lightweight stub.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { QueueManager } from '../../../src/core/QueueManager';
import type { ConductorSession } from '../../../src/types';

// ── Minimal SessionManager stub ───────────────────────────────────

class StubSessionManager {
  private sessions = new Map<string, ConductorSession>();

  onSessionEvent = (cb: (e: unknown) => void) => {
    void cb;
    return { dispose: () => { /* no-op */ } };
  };

  async createSession(
    name: string,
    providerId: string,
    workspacePath: string,
    prompt: string,
  ): Promise<ConductorSession> {
    const id = `session-${Date.now()}-${Math.random()}`;
    const session: ConductorSession = {
      id,
      name,
      providerId,
      workspacePath,
      prompt,
      status: 'queued',
      pid: null,
      terminalId: null,
      hookInstalled: false,
      dependsOn: [],
      templateId: null,
      createdAt: new Date().toISOString(),
      launchedAt: null,
      completedAt: null,
      exitCode: null,
      metadata: {},
    };
    this.sessions.set(id, session);
    return session;
  }

  async launchSession(
    sessionId: string,
    _config: unknown,
  ): Promise<{ id: string; pid: number; terminal: null; workspacePath: string }> {
    const s = this.sessions.get(sessionId);
    if (!s) { throw new Error(`Session not found: ${sessionId}`); }
    s.status = 'running';
    return { id: sessionId, pid: 0, terminal: null, workspacePath: s.workspacePath };
  }

  getSession(id: string): ConductorSession | undefined {
    return this.sessions.get(id);
  }

  setSessionStatus(id: string, status: ConductorSession['status']): void {
    const s = this.sessions.get(id);
    if (s) { s.status = status; }
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function makeTmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-qm-'));
  fs.mkdirSync(path.join(dir, '.conductor', 'queue'), { recursive: true });
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

describe('QueueManager — addPrompt', () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let qm: QueueManager;
  let sm: StubSessionManager;

  beforeEach(async () => {
    origHome = process.env.HOME;
    tmpHome = makeTmpHome();
    process.env.HOME = tmpHome;
    sm = new StubSessionManager();
    qm = new QueueManager('/workspace', sm as unknown as import('../../../src/core/SessionManager').SessionManager);
    await qm.initialise();
  });

  afterEach(() => {
    qm.dispose();
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('adds a prompt with default fields', async () => {
    const prompt = await qm.addPrompt({ prompt: 'Do the thing' });
    assert.ok(typeof prompt.id === 'string' && prompt.id.length > 0);
    assert.strictEqual(prompt.status, 'queued');
    assert.strictEqual(prompt.sessionId, null);
    assert.strictEqual(prompt.launchedAt, null);
  });

  it('emits "added" event', async () => {
    const { events, dispose } = collectEvents(cb => qm.onQueueEvent(cb));
    await qm.addPrompt({ name: 'Test' });
    dispose();
    assert.ok(events.some(e => e.type === 'added'));
  });

  it('assigns sequential positions', async () => {
    await qm.addPrompt({ name: 'First' });
    await qm.addPrompt({ name: 'Second' });
    await qm.addPrompt({ name: 'Third' });
    const queue = qm.getQueue();
    assert.strictEqual(queue[0].position, 0);
    assert.strictEqual(queue[1].position, 1);
    assert.strictEqual(queue[2].position, 2);
  });

  it('persists to disk (readable after re-initialise)', async () => {
    await qm.addPrompt({ name: 'Persistent', prompt: 'Stay' });
    qm.dispose();

    const qm2 = new QueueManager('/workspace', sm as unknown as import('../../../src/core/SessionManager').SessionManager);
    await qm2.initialise();
    const queue = qm2.getQueue();
    assert.ok(queue.some(p => p.name === 'Persistent'));
    qm2.dispose();
  });
});

describe('QueueManager — removePrompt', () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let qm: QueueManager;

  beforeEach(async () => {
    origHome = process.env.HOME;
    tmpHome = makeTmpHome();
    process.env.HOME = tmpHome;
    const sm = new StubSessionManager();
    qm = new QueueManager('/workspace', sm as unknown as import('../../../src/core/SessionManager').SessionManager);
    await qm.initialise();
  });

  afterEach(() => {
    qm.dispose();
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('removes a prompt from the queue', async () => {
    const p = await qm.addPrompt({ name: 'ToRemove' });
    await qm.removePrompt(p.id);
    assert.strictEqual(qm.getQueue().length, 0);
  });

  it('emits "removed" event', async () => {
    const p = await qm.addPrompt({ name: 'ToRemove' });
    const { events, dispose } = collectEvents(cb => qm.onQueueEvent(cb));
    await qm.removePrompt(p.id);
    dispose();
    assert.ok(events.some(e => e.type === 'removed'));
  });

  it('is a no-op for unknown ID', async () => {
    await qm.addPrompt({ name: 'Keep' });
    await qm.removePrompt('no-such-id');
    assert.strictEqual(qm.getQueue().length, 1);
  });
});

describe('QueueManager — updatePrompt', () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let qm: QueueManager;

  beforeEach(async () => {
    origHome = process.env.HOME;
    tmpHome = makeTmpHome();
    process.env.HOME = tmpHome;
    const sm = new StubSessionManager();
    qm = new QueueManager('/workspace', sm as unknown as import('../../../src/core/SessionManager').SessionManager);
    await qm.initialise();
  });

  afterEach(() => {
    qm.dispose();
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('updates name and prompt fields', async () => {
    const p = await qm.addPrompt({ name: 'OldName', prompt: 'old' });
    await qm.updatePrompt(p.id, { name: 'NewName', prompt: 'new' });
    const updated = qm.getPrompt(p.id)!;
    assert.strictEqual(updated.name, 'NewName');
    assert.strictEqual(updated.prompt, 'new');
  });

  it('emits "updated" event', async () => {
    const p = await qm.addPrompt({ name: 'Upd' });
    const { events, dispose } = collectEvents(cb => qm.onQueueEvent(cb));
    await qm.updatePrompt(p.id, { name: 'Updated' });
    dispose();
    assert.ok(events.some(e => e.type === 'updated'));
  });

  it('cannot overwrite the prompt ID', async () => {
    const p = await qm.addPrompt({ name: 'KeepId' });
    const originalId = p.id;
    await qm.updatePrompt(p.id, { id: 'new-id-attempt' } as Partial<import('../../../src/types').QueuedPrompt>);
    assert.strictEqual(qm.getPrompt(originalId)!.id, originalId);
  });
});

describe('QueueManager — reorderPrompt', () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let qm: QueueManager;

  beforeEach(async () => {
    origHome = process.env.HOME;
    tmpHome = makeTmpHome();
    process.env.HOME = tmpHome;
    const sm = new StubSessionManager();
    qm = new QueueManager('/workspace', sm as unknown as import('../../../src/core/SessionManager').SessionManager);
    await qm.initialise();
    await qm.addPrompt({ name: 'A' });
    await qm.addPrompt({ name: 'B' });
    await qm.addPrompt({ name: 'C' });
  });

  afterEach(() => {
    qm.dispose();
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('moves a prompt to a new position and reindexes', async () => {
    const queue = qm.getQueue();
    const cId = queue.find(p => p.name === 'C')!.id;
    await qm.reorderPrompt(cId, 0); // move C to front

    const reordered = qm.getQueue();
    assert.strictEqual(reordered[0].name, 'C');
    assert.strictEqual(reordered[1].name, 'A');
    assert.strictEqual(reordered[2].name, 'B');
  });

  it('positions are contiguous after reorder', async () => {
    const queue = qm.getQueue();
    const bId = queue.find(p => p.name === 'B')!.id;
    await qm.reorderPrompt(bId, 0);

    const reordered = qm.getQueue();
    for (let i = 0; i < reordered.length; i++) {
      assert.strictEqual(reordered[i].position, i);
    }
  });

  it('is a no-op for unknown ID', async () => {
    const before = qm.getQueue().map(p => p.name);
    await qm.reorderPrompt('no-such', 0);
    const after = qm.getQueue().map(p => p.name);
    assert.deepStrictEqual(after, before);
  });
});

describe('QueueManager — getUnmetDependencies', () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let qm: QueueManager;
  let sm: StubSessionManager;

  beforeEach(async () => {
    origHome = process.env.HOME;
    tmpHome = makeTmpHome();
    process.env.HOME = tmpHome;
    sm = new StubSessionManager();
    qm = new QueueManager('/workspace', sm as unknown as import('../../../src/core/SessionManager').SessionManager);
    await qm.initialise();
  });

  afterEach(() => {
    qm.dispose();
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('returns empty array when prompt has no dependencies', async () => {
    const p = await qm.addPrompt({ name: 'NoDeps' });
    const unmet = qm.getUnmetDependencies(qm.getPrompt(p.id)!);
    assert.deepStrictEqual(unmet, []);
  });

  it('returns unmet dependency IDs when deps are not complete', async () => {
    const dep = await qm.addPrompt({ name: 'Dep' });
    const dependent = await qm.addPrompt({ name: 'Dependent', dependsOn: [dep.id] });
    const unmet = qm.getUnmetDependencies(qm.getPrompt(dependent.id)!);
    assert.ok(unmet.includes(dep.id));
  });

  it('returns empty when dependency prompt has a complete session', async () => {
    // Create a dep prompt and a session that is complete
    const dep = await qm.addPrompt({ name: 'Dep' });
    const session = await sm.createSession('Dep session', 'claude-code', '/ws', 'P');
    sm.setSessionStatus(session.id, 'complete');
    await qm.updatePrompt(dep.id, { status: 'launched', sessionId: session.id });

    const dependent = await qm.addPrompt({ name: 'Dependent', dependsOn: [dep.id] });
    const unmet = qm.getUnmetDependencies(qm.getPrompt(dependent.id)!);
    assert.deepStrictEqual(unmet, []);
  });
});

describe('QueueManager — launchPrompt', () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let qm: QueueManager;
  let sm: StubSessionManager;

  beforeEach(async () => {
    origHome = process.env.HOME;
    tmpHome = makeTmpHome();
    process.env.HOME = tmpHome;
    sm = new StubSessionManager();
    qm = new QueueManager('/workspace', sm as unknown as import('../../../src/core/SessionManager').SessionManager);
    await qm.initialise();
  });

  afterEach(() => {
    qm.dispose();
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('throws if prompt is not in queued status', async () => {
    const p = await qm.addPrompt({ name: 'AlreadyLaunched' });
    await qm.updatePrompt(p.id, { status: 'launched' });
    await assert.rejects(
      () => qm.launchPrompt(p.id),
      /not in queued status/i,
    );
  });

  it('throws if dependencies are unmet', async () => {
    const dep = await qm.addPrompt({ name: 'Blocker' });
    const dependent = await qm.addPrompt({ name: 'Waiting', dependsOn: [dep.id] });
    await assert.rejects(
      () => qm.launchPrompt(dependent.id),
      /unmet dependencies/i,
    );
  });

  it('throws for unknown prompt ID', async () => {
    await assert.rejects(
      () => qm.launchPrompt('no-such-prompt'),
      /not found/i,
    );
  });

  it('fixture sample-queue.json has correct structure', () => {
    const fixturePath = path.join(__dirname, '../../fixtures/sample-queue.json');
    const data = JSON.parse(fs.readFileSync(fixturePath, 'utf-8')) as {
      prompts: Array<{ id: string; name: string; status: string; dependsOn: string[] }>;
    };
    assert.ok(Array.isArray(data.prompts));
    assert.ok(data.prompts.length >= 2);
    for (const p of data.prompts) {
      assert.ok(typeof p.id === 'string');
      assert.ok(typeof p.name === 'string');
      assert.ok(Array.isArray(p.dependsOn));
    }
  });
});
