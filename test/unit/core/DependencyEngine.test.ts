/**
 * Conductor — Unit tests: core/DependencyEngine.ts
 *
 * Tests cycle detection, dependency queries, auto-launch on
 * completion, blocking on error, and diamond dependency patterns.
 * Both SessionManager and QueueManager are stubbed in-memory.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { DependencyEngine } from '../../../src/core/DependencyEngine';
import type { QueuedPrompt, ConductorSession, SessionEvent } from '../../../src/types';
import { MockEventEmitter } from '../../helpers/mockVscode';

// ── Stubs ─────────────────────────────────────────────────────────

type SessionEventCb = (e: SessionEvent) => void;

class StubSessionManager {
  private _emitter = new MockEventEmitter<SessionEvent>();
  onSessionEvent = this._emitter.event;
  private _sessions = new Map<string, ConductorSession>();

  addSession(s: ConductorSession): void { this._sessions.set(s.id, s); }
  getSession(id: string): ConductorSession | undefined { return this._sessions.get(id); }

  fireEvent(event: SessionEvent): void { this._emitter.fire(event); }
}

class StubQueueManager {
  private _prompts = new Map<string, QueuedPrompt>();
  private _launchCount = 0;
  private _cancelledIds: string[] = [];
  private _sm: StubSessionManager | null;

  constructor(sm?: StubSessionManager) {
    this._sm = sm ?? null;
  }

  addPrompt(p: QueuedPrompt): void { this._prompts.set(p.id, p); }
  getPrompt(id: string): QueuedPrompt | undefined { return this._prompts.get(id); }
  getQueue(): QueuedPrompt[] { return [...this._prompts.values()]; }

  async updatePrompt(id: string, updates: Partial<QueuedPrompt>): Promise<void> {
    const p = this._prompts.get(id);
    if (p) {
      Object.assign(p, updates);
      if (updates.status === 'cancelled') { this._cancelledIds.push(id); }
    }
  }

  async launchPrompt(id: string): Promise<ConductorSession> {
    this._launchCount++;
    const p = this._prompts.get(id);
    if (!p) { throw new Error(`Prompt not found: ${id}`); }
    p.status = 'launched';
    const session: ConductorSession = {
      id: `session-for-${id}`,
      name: p.name,
      providerId: 'claude-code',
      workspacePath: '/ws',
      prompt: p.prompt,
      status: 'running',
      pid: null,
      terminalId: null,
      hookInstalled: false,
      dependsOn: p.dependsOn,
      templateId: null,
      createdAt: new Date().toISOString(),
      launchedAt: new Date().toISOString(),
      completedAt: null,
      exitCode: null,
      metadata: {},
    };
    return session;
  }

  async forceLaunch(id: string): Promise<ConductorSession> { return this.launchPrompt(id); }

  getUnmetDependencies(prompt: QueuedPrompt): string[] {
    return prompt.dependsOn.filter(depId => {
      const dep = this._prompts.get(depId);
      if (!dep) { return true; }
      // If dep has a session in the session manager, require it to be complete
      if (dep.sessionId && this._sm) {
        const session = this._sm.getSession(dep.sessionId);
        if (session !== undefined) {
          return session.status !== 'complete';
        }
      }
      // Fallback: consider met if prompt was launched
      return dep.status !== 'launched';
    });
  }

  get launchCount(): number { return this._launchCount; }
  get cancelledIds(): string[] { return this._cancelledIds; }
}

// ── Helpers ───────────────────────────────────────────────────────

function makePrompt(id: string, dependsOn: string[] = []): QueuedPrompt {
  return {
    id,
    name: `Prompt ${id}`,
    description: '',
    prompt: `Do ${id}`,
    providerId: 'claude-code',
    parallelSafe: true,
    complexity: 'medium',
    dependsOn,
    status: 'queued',
    sessionId: null,
    position: 0,
    createdAt: new Date().toISOString(),
    launchedAt: null,
  };
}

function makeSession(id: string, status: ConductorSession['status'] = 'running'): ConductorSession {
  return {
    id,
    name: `Session ${id}`,
    providerId: 'claude-code',
    workspacePath: '/ws',
    prompt: '',
    status,
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
}

function makeTmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-de-'));
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

// ── validateDAG ──────────────────────────────────────────────────

describe('DependencyEngine.validateDAG', () => {
  let tmpHome: string;
  let origHome: string | undefined;

  beforeEach(() => {
    origHome = process.env.HOME;
    tmpHome = makeTmpHome();
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function buildEngine(prompts: QueuedPrompt[]): DependencyEngine {
    const sm = new StubSessionManager();
    const qm = new StubQueueManager();
    for (const p of prompts) { qm.addPrompt(p); }
    return new DependencyEngine(
      sm as unknown as import('../../../src/core/SessionManager').SessionManager,
      qm as unknown as import('../../../src/core/QueueManager').QueueManager,
    );
  }

  it('returns valid for an empty graph', () => {
    const engine = buildEngine([]);
    const result = engine.validateDAG();
    assert.strictEqual(result.valid, true);
    engine.dispose();
  });

  it('returns valid for a simple linear chain A → B → C', () => {
    const engine = buildEngine([
      makePrompt('A'),
      makePrompt('B', ['A']),
      makePrompt('C', ['B']),
    ]);
    const result = engine.validateDAG();
    assert.strictEqual(result.valid, true);
    engine.dispose();
  });

  it('returns valid for a diamond dependency (A→C, B→C)', () => {
    const engine = buildEngine([
      makePrompt('A'),
      makePrompt('B'),
      makePrompt('C', ['A', 'B']),
    ]);
    assert.strictEqual(engine.validateDAG().valid, true);
    engine.dispose();
  });

  it('returns invalid for a direct cycle (A → B → A)', () => {
    const engine = buildEngine([
      makePrompt('A', ['B']),
      makePrompt('B', ['A']),
    ]);
    const result = engine.validateDAG();
    assert.strictEqual(result.valid, false);
    assert.ok(Array.isArray(result.cycles));
    engine.dispose();
  });

  it('returns invalid for a 3-node cycle (A → B → C → A)', () => {
    const engine = buildEngine([
      makePrompt('A', ['C']),
      makePrompt('B', ['A']),
      makePrompt('C', ['B']),
    ]);
    assert.strictEqual(engine.validateDAG().valid, false);
    engine.dispose();
  });
});

// ── getDependents ────────────────────────────────────────────────

describe('DependencyEngine.getDependents', () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let sm: StubSessionManager;
  let qm: StubQueueManager;
  let engine: DependencyEngine;

  beforeEach(() => {
    origHome = process.env.HOME;
    tmpHome = makeTmpHome();
    process.env.HOME = tmpHome;
    sm = new StubSessionManager();
    qm = new StubQueueManager();
    engine = new DependencyEngine(
      sm as unknown as import('../../../src/core/SessionManager').SessionManager,
      qm as unknown as import('../../../src/core/QueueManager').QueueManager,
    );
  });

  afterEach(() => {
    engine.dispose();
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('returns direct dependents', () => {
    qm.addPrompt(makePrompt('root'));
    qm.addPrompt(makePrompt('child', ['root']));
    qm.addPrompt(makePrompt('sibling'));

    const dependents = engine.getDependents('root');
    assert.strictEqual(dependents.length, 1);
    assert.strictEqual(dependents[0].id, 'child');
  });

  it('returns empty array when nothing depends on the given ID', () => {
    qm.addPrompt(makePrompt('standalone'));
    assert.deepStrictEqual(engine.getDependents('standalone'), []);
  });

  it('returns multiple dependents', () => {
    qm.addPrompt(makePrompt('root'));
    qm.addPrompt(makePrompt('child1', ['root']));
    qm.addPrompt(makePrompt('child2', ['root']));
    qm.addPrompt(makePrompt('child3', ['root']));

    const dependents = engine.getDependents('root');
    assert.strictEqual(dependents.length, 3);
  });

  it('finds dependents via sessionId mapping', () => {
    const p = makePrompt('dep-prompt');
    p.sessionId = 'session-xyz';
    qm.addPrompt(p);
    qm.addPrompt(makePrompt('child', ['dep-prompt']));

    const dependents = engine.getDependents('session-xyz');
    assert.strictEqual(dependents.length, 1);
    assert.strictEqual(dependents[0].id, 'child');
  });
});

// ── allDependenciesMet ───────────────────────────────────────────

describe('DependencyEngine.allDependenciesMet', () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let sm: StubSessionManager;
  let qm: StubQueueManager;
  let engine: DependencyEngine;

  beforeEach(() => {
    origHome = process.env.HOME;
    tmpHome = makeTmpHome();
    process.env.HOME = tmpHome;
    sm = new StubSessionManager();
    qm = new StubQueueManager();
    engine = new DependencyEngine(
      sm as unknown as import('../../../src/core/SessionManager').SessionManager,
      qm as unknown as import('../../../src/core/QueueManager').QueueManager,
    );
  });

  afterEach(() => {
    engine.dispose();
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('returns true when prompt has no dependencies', () => {
    qm.addPrompt(makePrompt('solo'));
    assert.strictEqual(engine.allDependenciesMet('solo'), true);
  });

  it('returns false when dependency is not yet launched', () => {
    qm.addPrompt(makePrompt('root'));
    qm.addPrompt(makePrompt('child', ['root']));
    assert.strictEqual(engine.allDependenciesMet('child'), false);
  });

  it('returns true when all dependencies are launched', () => {
    const root = makePrompt('root');
    root.status = 'launched';
    qm.addPrompt(root);
    qm.addPrompt(makePrompt('child', ['root']));
    assert.strictEqual(engine.allDependenciesMet('child'), true);
  });

  it('returns false for unknown promptId', () => {
    assert.strictEqual(engine.allDependenciesMet('nonexistent'), false);
  });
});

// ── addDependency ────────────────────────────────────────────────

describe('DependencyEngine.addDependency', () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let sm: StubSessionManager;
  let qm: StubQueueManager;
  let engine: DependencyEngine;

  beforeEach(() => {
    origHome = process.env.HOME;
    tmpHome = makeTmpHome();
    process.env.HOME = tmpHome;
    sm = new StubSessionManager();
    qm = new StubQueueManager();
    engine = new DependencyEngine(
      sm as unknown as import('../../../src/core/SessionManager').SessionManager,
      qm as unknown as import('../../../src/core/QueueManager').QueueManager,
    );
  });

  afterEach(() => {
    engine.dispose();
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('throws when adding a dependency would create a cycle', async () => {
    qm.addPrompt(makePrompt('A', ['B']));
    qm.addPrompt(makePrompt('B'));
    // Adding A as a dep of B creates B → A, but A already depends on B
    await assert.rejects(
      () => engine.addDependency('B', ['A']),
      /cycle/i,
    );
  });

  it('successfully adds a valid dependency', async () => {
    qm.addPrompt(makePrompt('root'));
    qm.addPrompt(makePrompt('child'));
    await engine.addDependency('child', ['root']);
    const updated = qm.getPrompt('child')!;
    assert.ok(updated.dependsOn.includes('root'));
  });

  it('throws for unknown prompt', async () => {
    await assert.rejects(
      () => engine.addDependency('ghost', ['root']),
      /not found/i,
    );
  });
});

// ── Auto-launch on session complete ──────────────────────────────

describe('DependencyEngine — auto-launch', () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let sm: StubSessionManager;
  let qm: StubQueueManager;
  let engine: DependencyEngine;

  beforeEach(() => {
    origHome = process.env.HOME;
    tmpHome = makeTmpHome();
    process.env.HOME = tmpHome;
    sm = new StubSessionManager();
    qm = new StubQueueManager();
    engine = new DependencyEngine(
      sm as unknown as import('../../../src/core/SessionManager').SessionManager,
      qm as unknown as import('../../../src/core/QueueManager').QueueManager,
    );
  });

  afterEach(() => {
    engine.dispose();
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('auto-launches a dependent when its upstream session completes', async () => {
    const rootPrompt = makePrompt('root');
    rootPrompt.sessionId = 'session-root';
    rootPrompt.status = 'launched';
    qm.addPrompt(rootPrompt);

    const childPrompt = makePrompt('child', ['root']);
    qm.addPrompt(childPrompt);

    const session = makeSession('session-root', 'complete');
    sm.addSession(session);

    // Fire the session completed event
    sm.fireEvent({
      type: 'completed',
      sessionId: 'session-root',
      session,
    });

    // Give async auto-launch a tick to run
    await new Promise(resolve => setTimeout(resolve, 10));

    // child should have been launched
    assert.strictEqual(qm.launchCount, 1);
  });

  it('emits auto-launched event', async () => {
    const rootPrompt = makePrompt('root2');
    rootPrompt.sessionId = 'session-r2';
    rootPrompt.status = 'launched';
    qm.addPrompt(rootPrompt);
    qm.addPrompt(makePrompt('child2', ['root2']));

    const { events, dispose } = collectEvents(cb => engine.onDependencyEvent(cb));
    sm.fireEvent({ type: 'completed', sessionId: 'session-r2', session: makeSession('session-r2', 'complete') });

    await new Promise(resolve => setTimeout(resolve, 10));
    dispose();

    assert.ok(events.some(e => e.type === 'auto-launched'), 'Expected auto-launched event');
  });
});

// ── Blocking on session error ─────────────────────────────────────

describe('DependencyEngine — blocking on error', () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let sm: StubSessionManager;
  let qm: StubQueueManager;
  let engine: DependencyEngine;

  beforeEach(() => {
    origHome = process.env.HOME;
    tmpHome = makeTmpHome();
    process.env.HOME = tmpHome;
    sm = new StubSessionManager();
    qm = new StubQueueManager();
    engine = new DependencyEngine(
      sm as unknown as import('../../../src/core/SessionManager').SessionManager,
      qm as unknown as import('../../../src/core/QueueManager').QueueManager,
    );
  });

  afterEach(() => {
    engine.dispose();
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('cancels dependent prompts when upstream session errors', async () => {
    const rootPrompt = makePrompt('root-err');
    rootPrompt.sessionId = 'session-err';
    rootPrompt.status = 'launched';
    qm.addPrompt(rootPrompt);
    qm.addPrompt(makePrompt('child-err', ['root-err']));

    sm.addSession(makeSession('session-err', 'error'));
    sm.fireEvent({ type: 'error', sessionId: 'session-err', session: makeSession('session-err', 'error') });

    await new Promise(resolve => setTimeout(resolve, 10));

    assert.ok(qm.cancelledIds.includes('child-err'), 'Expected child-err to be cancelled');
  });

  it('emits blocked event', async () => {
    const rp = makePrompt('root-blocked');
    rp.sessionId = 'session-blocked';
    rp.status = 'launched';
    qm.addPrompt(rp);
    qm.addPrompt(makePrompt('child-blocked', ['root-blocked']));

    const { events, dispose } = collectEvents(cb => engine.onDependencyEvent(cb));
    sm.fireEvent({ type: 'error', sessionId: 'session-blocked', session: makeSession('session-blocked', 'error') });

    await new Promise(resolve => setTimeout(resolve, 10));
    dispose();

    assert.ok(events.some(e => e.type === 'blocked'), 'Expected blocked event');
  });
});

// ── Diamond dependency ───────────────────────────────────────────

describe('DependencyEngine — diamond dependency', () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let sm: StubSessionManager;
  let qm: StubQueueManager;
  let engine: DependencyEngine;

  beforeEach(() => {
    origHome = process.env.HOME;
    tmpHome = makeTmpHome();
    process.env.HOME = tmpHome;
    sm = new StubSessionManager();
    qm = new StubQueueManager(sm);
    engine = new DependencyEngine(
      sm as unknown as import('../../../src/core/SessionManager').SessionManager,
      qm as unknown as import('../../../src/core/QueueManager').QueueManager,
    );
  });

  afterEach(() => {
    engine.dispose();
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('validateDAG returns valid for diamond pattern (A→C, B→C)', () => {
    qm.addPrompt(makePrompt('A'));
    qm.addPrompt(makePrompt('B'));
    qm.addPrompt(makePrompt('C', ['A', 'B']));

    assert.strictEqual(engine.validateDAG().valid, true);
  });

  it('C does not launch until both A and B are complete', async () => {
    const pa = makePrompt('A-d');
    pa.sessionId = 'sess-A';
    pa.status = 'launched';
    qm.addPrompt(pa);

    const pb = makePrompt('B-d');
    pb.sessionId = 'sess-B';
    pb.status = 'launched';
    qm.addPrompt(pb);

    qm.addPrompt(makePrompt('C-d', ['A-d', 'B-d']));

    // Register both sessions as running initially
    sm.addSession(makeSession('sess-A', 'running'));
    sm.addSession(makeSession('sess-B', 'running'));

    // Only A completes first → C should NOT launch yet (B still running)
    sm.addSession(makeSession('sess-A', 'complete'));
    sm.fireEvent({ type: 'completed', sessionId: 'sess-A', session: makeSession('sess-A', 'complete') });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.strictEqual(qm.launchCount, 0, 'C should not launch with only A complete');

    // Now B also completes → C should launch
    sm.addSession(makeSession('sess-B', 'complete'));
    sm.fireEvent({ type: 'completed', sessionId: 'sess-B', session: makeSession('sess-B', 'complete') });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.strictEqual(qm.launchCount, 1, 'C should launch after both A and B complete');
  });
});
