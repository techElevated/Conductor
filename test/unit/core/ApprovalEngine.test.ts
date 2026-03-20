/**
 * Conductor — Unit tests: core/ApprovalEngine.ts
 *
 * Tests approval detection, approve/deny actions, batch operations,
 * stale cleanup, and history persistence.  Uses a temp directory
 * to simulate the ~/.conductor/approvals/ layout.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { ApprovalEngine } from '../../../src/core/ApprovalEngine';
import type { PendingApproval } from '../../../src/types';

// ── Helpers ──────────────────────────────────────────────────────

function makeTmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-ae-'));
  fs.mkdirSync(path.join(dir, '.conductor', 'approvals'), { recursive: true });
  return dir;
}

function writeApproval(
  approvalsDir: string,
  sessionId: string,
  approvalId: string,
  overrides: Partial<PendingApproval> = {},
): string {
  const sessionDir = path.join(approvalsDir, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });

  const approval: PendingApproval = {
    id: approvalId,
    sessionId,
    sessionName: 'Test Session',
    tool: 'Bash',
    command: 'npm install',
    context: 'Installing dependencies',
    timestamp: new Date().toISOString(),
    status: 'pending',
    resolvedAt: null,
    ...overrides,
  };

  const filePath = path.join(sessionDir, `${approvalId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(approval, null, 2));
  return filePath;
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

describe('ApprovalEngine — initialise and scan', () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let engine: ApprovalEngine;

  beforeEach(() => {
    origHome = process.env.HOME;
    tmpHome = makeTmpHome();
    process.env.HOME = tmpHome;
    engine = new ApprovalEngine();
  });

  afterEach(() => {
    engine.dispose();
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('starts with zero pending approvals', async () => {
    await engine.initialise();
    assert.strictEqual(engine.getPendingCount(), 0);
  });

  it('scans and loads pre-existing approval files on initialise', async () => {
    const approvalsDir = path.join(tmpHome, '.conductor', 'approvals');
    writeApproval(approvalsDir, 'session-1', 'approval-a');
    writeApproval(approvalsDir, 'session-1', 'approval-b');

    await engine.initialise();
    assert.strictEqual(engine.getPendingCount(), 2);
  });

  it('ignores .decision.json files during scan', async () => {
    const approvalsDir = path.join(tmpHome, '.conductor', 'approvals');
    const sessionDir = path.join(approvalsDir, 'sess-x');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, 'appr-1.decision.json'),
      JSON.stringify({ decision: 'allow', resolvedAt: new Date().toISOString() }),
    );

    await engine.initialise();
    assert.strictEqual(engine.getPendingCount(), 0);
  });

  it('getPendingApprovals returns sorted by timestamp (oldest first)', async () => {
    const approvalsDir = path.join(tmpHome, '.conductor', 'approvals');
    writeApproval(approvalsDir, 'sess', 'a1', {
      timestamp: '2026-01-01T10:00:00.000Z',
    });
    writeApproval(approvalsDir, 'sess', 'a2', {
      timestamp: '2026-01-01T09:00:00.000Z', // older
    });

    await engine.initialise();
    const pending = engine.getPendingApprovals();
    assert.strictEqual(pending[0].id, 'a2'); // older first
    assert.strictEqual(pending[1].id, 'a1');
  });
});

describe('ApprovalEngine — approveAction / denyAction', () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let engine: ApprovalEngine;

  beforeEach(async () => {
    origHome = process.env.HOME;
    tmpHome = makeTmpHome();
    process.env.HOME = tmpHome;
    engine = new ApprovalEngine();

    const approvalsDir = path.join(tmpHome, '.conductor', 'approvals');
    writeApproval(approvalsDir, 'sess-1', 'appr-1');
    writeApproval(approvalsDir, 'sess-1', 'appr-2');
    await engine.initialise();
  });

  afterEach(() => {
    engine.dispose();
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('approveAction removes from pending', async () => {
    await engine.approveAction('appr-1');
    assert.strictEqual(engine.getPendingCount(), 1);
    assert.ok(!engine.getPendingApprovals().some(a => a.id === 'appr-1'));
  });

  it('approveAction writes decision file with "allow"', async () => {
    await engine.approveAction('appr-1');
    const decisionPath = path.join(
      tmpHome, '.conductor', 'approvals', 'sess-1', 'appr-1.decision.json',
    );
    assert.ok(fs.existsSync(decisionPath), 'Decision file should exist');
    const data = JSON.parse(fs.readFileSync(decisionPath, 'utf-8'));
    assert.strictEqual(data.decision, 'allow');
  });

  it('approveAction emits "resolved" event', async () => {
    const { events, dispose } = collectEvents(cb => engine.onApprovalEvent(cb));
    await engine.approveAction('appr-1');
    dispose();
    assert.ok(events.some(e => e.type === 'resolved' && e.approval.id === 'appr-1'));
  });

  it('approveAction adds approval to history', async () => {
    await engine.approveAction('appr-1');
    const history = engine.getHistory();
    assert.ok(history.some(a => a.id === 'appr-1'));
  });

  it('denyAction writes decision file with "deny"', async () => {
    await engine.denyAction('appr-2');
    const decisionPath = path.join(
      tmpHome, '.conductor', 'approvals', 'sess-1', 'appr-2.decision.json',
    );
    const data = JSON.parse(fs.readFileSync(decisionPath, 'utf-8'));
    assert.strictEqual(data.decision, 'deny');
  });

  it('denyAction removes from pending and adds to history', async () => {
    await engine.denyAction('appr-2');
    assert.ok(!engine.getPendingApprovals().some(a => a.id === 'appr-2'));
    assert.ok(engine.getHistory().some(a => a.id === 'appr-2'));
  });

  it('approveAction on unknown ID is a no-op', async () => {
    const countBefore = engine.getPendingCount();
    await engine.approveAction('no-such-id');
    assert.strictEqual(engine.getPendingCount(), countBefore);
  });
});

describe('ApprovalEngine — approveAll / denyAll', () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let engine: ApprovalEngine;

  beforeEach(async () => {
    origHome = process.env.HOME;
    tmpHome = makeTmpHome();
    process.env.HOME = tmpHome;
    engine = new ApprovalEngine();

    const approvalsDir = path.join(tmpHome, '.conductor', 'approvals');
    writeApproval(approvalsDir, 'sess', 'batch-1');
    writeApproval(approvalsDir, 'sess', 'batch-2');
    writeApproval(approvalsDir, 'sess', 'batch-3');
    await engine.initialise();
  });

  afterEach(() => {
    engine.dispose();
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('approveAll resolves all pending approvals', async () => {
    await engine.approveAll();
    assert.strictEqual(engine.getPendingCount(), 0);
  });

  it('approveAll puts all approvals into history', async () => {
    await engine.approveAll();
    assert.ok(engine.getHistory().length >= 3);
  });

  it('denyAll resolves all pending approvals', async () => {
    await engine.denyAll();
    assert.strictEqual(engine.getPendingCount(), 0);
  });
});

describe('ApprovalEngine — dismissSessionApprovals', () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let engine: ApprovalEngine;

  beforeEach(async () => {
    origHome = process.env.HOME;
    tmpHome = makeTmpHome();
    process.env.HOME = tmpHome;
    engine = new ApprovalEngine();

    const approvalsDir = path.join(tmpHome, '.conductor', 'approvals');
    writeApproval(approvalsDir, 'session-A', 'appr-a1');
    writeApproval(approvalsDir, 'session-A', 'appr-a2');
    writeApproval(approvalsDir, 'session-B', 'appr-b1');
    await engine.initialise();
  });

  afterEach(() => {
    engine.dispose();
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('removes all approvals for the given session', async () => {
    await engine.dismissSessionApprovals('session-A');
    const remaining = engine.getPendingApprovals();
    assert.ok(!remaining.some(a => a.sessionId === 'session-A'));
    assert.ok(remaining.some(a => a.sessionId === 'session-B'), 'Other session should be untouched');
  });

  it('emits "stale" events for dismissed approvals', async () => {
    const { events, dispose } = collectEvents(cb => engine.onApprovalEvent(cb));
    await engine.dismissSessionApprovals('session-A');
    dispose();
    const staleEvents = events.filter(e => e.type === 'stale');
    assert.strictEqual(staleEvents.length, 2);
  });
});

describe('ApprovalEngine — fixture validation', () => {
  it('sample-approval.json fixture has correct structure', () => {
    const fixturePath = path.join(__dirname, '../../fixtures/sample-approval.json');
    const raw = fs.readFileSync(fixturePath, 'utf-8');
    const data = JSON.parse(raw) as PendingApproval;

    assert.ok(typeof data.id === 'string' && data.id.length > 0);
    assert.ok(typeof data.sessionId === 'string');
    assert.ok(typeof data.tool === 'string');
    assert.ok(typeof data.command === 'string');
    assert.strictEqual(data.status, 'pending');
    assert.strictEqual(data.resolvedAt, null);
  });
});
