/**
 * Conductor — Integration test: Full Approval Flow.
 *
 * Exercises the real ApprovalEngine class against the filesystem:
 * 1. Write pending approval file → engine detects via scanAllApprovals
 * 2. Approve → decision file written → removed from pending → history updated
 * 3. Deny flow
 * 4. Multiple approvals across sessions
 * 5. dismissSessionApprovals cleanup
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as assert from 'assert';
import { v4 as uuid } from 'uuid';

import { ApprovalEngine } from '../../src/core/ApprovalEngine';
import type { ApprovalEvent } from '../../src/types';

// ── Helpers ──────────────────────────────────────────────────────

function writeApprovalJson(
  approvalsDir: string,
  sessionId: string,
  approvalId: string,
  overrides: Record<string, unknown> = {},
): string {
  const sessionDir = path.join(approvalsDir, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });

  const data = {
    id: approvalId,
    sessionId,
    sessionName: `session-${sessionId.slice(0, 8)}`,
    tool: 'Bash',
    command: 'npm run migrate',
    context: 'Running database migration',
    timestamp: new Date().toISOString(),
    status: 'pending',
    resolvedAt: null,
    ...overrides,
  };

  const filePath = path.join(sessionDir, `${approvalId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return filePath;
}

function collectEvents(engine: ApprovalEngine): ApprovalEvent[] {
  const events: ApprovalEvent[] = [];
  engine.onApprovalEvent((e) => events.push(e));
  return events;
}

// ── Suite ────────────────────────────────────────────────────────

describe('Approval Flow Integration', () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let engine: ApprovalEngine;
  let approvalsDir: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-approval-integ-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    approvalsDir = path.join(tmpHome, '.conductor', 'approvals');
    engine = new ApprovalEngine();
  });

  afterEach(() => {
    engine.dispose();
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  // ── 1. Full approve flow ─────────────────────────────────────

  it('write pending → engine detects → approve → decision file → cleanup', async () => {
    const sessionId = uuid();
    const approvalId = uuid();

    // Write pending approval file BEFORE init
    writeApprovalJson(approvalsDir, sessionId, approvalId, {
      tool: 'Bash',
      command: 'npm install express',
    });

    // Initialise — scanAllApprovals picks up the file
    await engine.initialise();

    // Engine should detect 1 pending approval
    assert.strictEqual(engine.getPendingCount(), 1);
    const pending = engine.getPendingApprovals();
    assert.strictEqual(pending[0].id, approvalId);
    assert.strictEqual(pending[0].sessionId, sessionId);
    assert.strictEqual(pending[0].tool, 'Bash');
    assert.strictEqual(pending[0].command, 'npm install express');
    assert.strictEqual(pending[0].status, 'pending');

    // Listen for resolved event
    const events = collectEvents(engine);

    // Approve it
    await engine.approveAction(approvalId);

    // Pending count drops to 0
    assert.strictEqual(engine.getPendingCount(), 0);

    // Decision file written
    const decisionPath = path.join(
      approvalsDir, sessionId, `${approvalId}.decision.json`,
    );
    assert.ok(fs.existsSync(decisionPath), 'Decision file should exist');

    const decision = JSON.parse(fs.readFileSync(decisionPath, 'utf-8'));
    assert.strictEqual(decision.decision, 'allow');
    assert.ok(decision.resolvedAt);

    // Event fired
    const resolved = events.find(e => e.type === 'resolved');
    assert.ok(resolved, 'Should fire resolved event');
    assert.strictEqual(resolved!.approval.id, approvalId);
    assert.strictEqual(resolved!.approval.status, 'approved');

    // History updated
    const history = engine.getHistory();
    assert.strictEqual(history.length, 1);
    assert.strictEqual(history[0].id, approvalId);
    assert.strictEqual(history[0].status, 'approved');

    // Cleanup: dismissSessionApprovals should be no-op now (already resolved)
    await engine.dismissSessionApprovals(sessionId);
    assert.strictEqual(engine.getPendingCount(), 0);
  });

  // ── 2. Deny flow ─────────────────────────────────────────────

  it('deny flow writes deny decision and updates history', async () => {
    const sessionId = uuid();
    const approvalId = uuid();

    writeApprovalJson(approvalsDir, sessionId, approvalId, {
      tool: 'Write',
      command: 'write /etc/hosts',
    });

    await engine.initialise();
    assert.strictEqual(engine.getPendingCount(), 1);

    await engine.denyAction(approvalId);

    assert.strictEqual(engine.getPendingCount(), 0);

    const decisionPath = path.join(
      approvalsDir, sessionId, `${approvalId}.decision.json`,
    );
    const decision = JSON.parse(fs.readFileSync(decisionPath, 'utf-8'));
    assert.strictEqual(decision.decision, 'deny');

    const history = engine.getHistory();
    assert.strictEqual(history.length, 1);
    assert.strictEqual(history[0].status, 'denied');
  });

  // ── 3. Multiple approvals across sessions ────────────────────

  it('handles multiple approvals across sessions with batch operations', async () => {
    const session1 = uuid();
    const session2 = uuid();
    const app1 = uuid();
    const app2 = uuid();
    const app3 = uuid();

    writeApprovalJson(approvalsDir, session1, app1, { command: 'cmd-1' });
    writeApprovalJson(approvalsDir, session1, app2, { command: 'cmd-2' });
    writeApprovalJson(approvalsDir, session2, app3, { command: 'cmd-3' });

    await engine.initialise();
    assert.strictEqual(engine.getPendingCount(), 3);

    // Approve all at once
    await engine.approveAll();
    assert.strictEqual(engine.getPendingCount(), 0);

    // All 3 decision files exist
    for (const [sid, aid] of [[session1, app1], [session1, app2], [session2, app3]]) {
      const dp = path.join(approvalsDir, sid, `${aid}.decision.json`);
      assert.ok(fs.existsSync(dp), `Decision file should exist for ${aid}`);
      const d = JSON.parse(fs.readFileSync(dp, 'utf-8'));
      assert.strictEqual(d.decision, 'allow');
    }

    // History has 3 entries
    assert.strictEqual(engine.getHistory().length, 3);
  });

  // ── 4. Deny all ──────────────────────────────────────────────

  it('denyAll writes deny decisions for all pending', async () => {
    const sessionId = uuid();
    const app1 = uuid();
    const app2 = uuid();

    writeApprovalJson(approvalsDir, sessionId, app1);
    writeApprovalJson(approvalsDir, sessionId, app2);

    await engine.initialise();
    assert.strictEqual(engine.getPendingCount(), 2);

    await engine.denyAll();
    assert.strictEqual(engine.getPendingCount(), 0);

    const d1 = JSON.parse(fs.readFileSync(
      path.join(approvalsDir, sessionId, `${app1}.decision.json`), 'utf-8',
    ));
    const d2 = JSON.parse(fs.readFileSync(
      path.join(approvalsDir, sessionId, `${app2}.decision.json`), 'utf-8',
    ));
    assert.strictEqual(d1.decision, 'deny');
    assert.strictEqual(d2.decision, 'deny');
  });

  // ── 5. dismissSessionApprovals ───────────────────────────────

  it('dismissSessionApprovals removes pending approvals for a session', async () => {
    const session1 = uuid();
    const session2 = uuid();
    const app1 = uuid();
    const app2 = uuid();

    writeApprovalJson(approvalsDir, session1, app1);
    writeApprovalJson(approvalsDir, session2, app2);

    await engine.initialise();
    assert.strictEqual(engine.getPendingCount(), 2);

    const events = collectEvents(engine);

    await engine.dismissSessionApprovals(session1);

    // Only session2's approval remains
    assert.strictEqual(engine.getPendingCount(), 1);
    const remaining = engine.getPendingApprovals();
    assert.strictEqual(remaining[0].sessionId, session2);

    // Stale event fired for dismissed approval
    const staleEvents = events.filter(e => e.type === 'stale');
    assert.strictEqual(staleEvents.length, 1);
    assert.strictEqual(staleEvents[0].approval.sessionId, session1);
  });

  // ── 6. Ignores malformed and decision files ──────────────────

  it('ignores non-pending, malformed, and decision files during scan', async () => {
    const sessionId = uuid();
    const sessionDir = path.join(approvalsDir, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    // Malformed JSON
    fs.writeFileSync(path.join(sessionDir, 'bad.json'), 'not json{{{');

    // Already resolved approval
    fs.writeFileSync(
      path.join(sessionDir, 'resolved.json'),
      JSON.stringify({ id: 'r1', sessionId, status: 'approved', resolvedAt: new Date().toISOString() }),
    );

    // Decision file (should be skipped)
    fs.writeFileSync(
      path.join(sessionDir, 'x.decision.json'),
      JSON.stringify({ decision: 'allow' }),
    );

    // Temp file (should be skipped)
    fs.writeFileSync(path.join(sessionDir, '.tmp-write'), 'temp');

    // One valid pending approval
    writeApprovalJson(approvalsDir, sessionId, uuid());

    await engine.initialise();
    assert.strictEqual(engine.getPendingCount(), 1, 'Only valid pending approval counted');
  });

  // ── 7. History persistence ───────────────────────────────────

  it('history persists to disk and loads on re-init', async () => {
    const sessionId = uuid();
    const approvalId = uuid();

    writeApprovalJson(approvalsDir, sessionId, approvalId);
    await engine.initialise();
    await engine.approveAction(approvalId);

    assert.strictEqual(engine.getHistory().length, 1);
    engine.dispose();

    // Create a new engine and re-init
    const engine2 = new ApprovalEngine();
    await engine2.initialise();

    const history = engine2.getHistory();
    assert.strictEqual(history.length, 1);
    assert.strictEqual(history[0].id, approvalId);
    assert.strictEqual(history[0].status, 'approved');
    engine2.dispose();
  });

  // ── 8. Approve non-existent is no-op ─────────────────────────

  it('approving a non-existent approval is a no-op', async () => {
    await engine.initialise();
    await engine.approveAction('does-not-exist');
    assert.strictEqual(engine.getPendingCount(), 0);
  });
});
