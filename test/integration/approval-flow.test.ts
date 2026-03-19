/**
 * Conductor — Integration test: Full Approval Flow.
 *
 * Tests the complete flow from hook writing a pending approval
 * through detection, resolution, and cleanup.
 *
 * This test exercises the file-based IPC without VS Code APIs
 * by directly manipulating the filesystem.
 *
 * Run: npx mocha --require ts-node/register test/integration/approval-flow.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as assert from 'assert';
import { v4 as uuid } from 'uuid';

// ── Test helpers ────────────────────────────────────────────

const TEST_DIR = path.join(os.tmpdir(), `conductor-test-${process.pid}`);
const APPROVALS_DIR = path.join(TEST_DIR, 'approvals');

interface TestApproval {
  id: string;
  sessionId: string;
  sessionName: string;
  tool: string;
  command: string;
  context: string;
  timestamp: string;
  status: 'pending';
}

interface DecisionFile {
  decision: 'allow' | 'deny';
  resolvedAt: string;
}

function createApprovalJson(sessionId: string, approvalId: string): TestApproval {
  return {
    id: approvalId,
    sessionId,
    sessionName: `test-session-${sessionId.slice(0, 8)}`,
    tool: 'bash',
    command: 'npm run migrate',
    context: 'I need to run the database migration to create the users table.',
    timestamp: new Date().toISOString(),
    status: 'pending',
  };
}

async function writeApprovalFile(
  sessionId: string,
  approvalId: string,
  approval: TestApproval,
): Promise<string> {
  const sessionDir = path.join(APPROVALS_DIR, sessionId);
  await fs.promises.mkdir(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, `${approvalId}.json`);
  await fs.promises.writeFile(filePath, JSON.stringify(approval, null, 2));
  return filePath;
}

async function writeDecisionFile(
  sessionId: string,
  approvalId: string,
  decision: 'allow' | 'deny',
): Promise<string> {
  const sessionDir = path.join(APPROVALS_DIR, sessionId);
  const filePath = path.join(sessionDir, `${approvalId}.decision.json`);
  const data: DecisionFile = { decision, resolvedAt: new Date().toISOString() };
  await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2));
  return filePath;
}

async function readDecisionFile(
  sessionId: string,
  approvalId: string,
): Promise<DecisionFile | null> {
  const filePath = path.join(APPROVALS_DIR, sessionId, `${approvalId}.decision.json`);
  try {
    const raw = await fs.promises.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as DecisionFile;
  } catch {
    return null;
  }
}

async function listApprovalFiles(sessionId: string): Promise<string[]> {
  const sessionDir = path.join(APPROVALS_DIR, sessionId);
  try {
    const files = await fs.promises.readdir(sessionDir);
    return files.filter(f => f.endsWith('.json') && !f.includes('.decision.') && !f.startsWith('.tmp-'));
  } catch {
    return [];
  }
}

async function cleanup(): Promise<void> {
  await fs.promises.rm(TEST_DIR, { recursive: true, force: true });
}

// ── Tests ───────────────────────────────────────────────────

describe('Approval Flow Integration', () => {
  beforeEach(async () => {
    await fs.promises.mkdir(APPROVALS_DIR, { recursive: true });
  });

  afterEach(async () => {
    await cleanup();
  });

  it('should write a pending approval file with correct structure', async () => {
    const sessionId = uuid();
    const approvalId = uuid();
    const approval = createApprovalJson(sessionId, approvalId);

    const filePath = await writeApprovalFile(sessionId, approvalId, approval);

    // Verify file exists
    const stat = await fs.promises.stat(filePath);
    assert.ok(stat.isFile(), 'Approval file should exist');

    // Verify content
    const raw = await fs.promises.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as TestApproval;

    assert.strictEqual(parsed.id, approvalId);
    assert.strictEqual(parsed.sessionId, sessionId);
    assert.strictEqual(parsed.tool, 'bash');
    assert.strictEqual(parsed.command, 'npm run migrate');
    assert.strictEqual(parsed.status, 'pending');
  });

  it('should detect new approval files in the approvals directory', async () => {
    const sessionId = uuid();
    const approvalId = uuid();
    const approval = createApprovalJson(sessionId, approvalId);

    await writeApprovalFile(sessionId, approvalId, approval);

    const files = await listApprovalFiles(sessionId);
    assert.strictEqual(files.length, 1, 'Should find exactly one approval file');
    assert.ok(files[0].includes(approvalId), 'File name should contain approval ID');
  });

  it('should resolve an approval by writing a decision file', async () => {
    const sessionId = uuid();
    const approvalId = uuid();
    const approval = createApprovalJson(sessionId, approvalId);

    // Write pending approval
    await writeApprovalFile(sessionId, approvalId, approval);

    // Write decision
    await writeDecisionFile(sessionId, approvalId, 'allow');

    // Verify decision file
    const decision = await readDecisionFile(sessionId, approvalId);
    assert.ok(decision, 'Decision file should exist');
    assert.strictEqual(decision!.decision, 'allow');
    assert.ok(decision!.resolvedAt, 'Should have resolvedAt timestamp');
  });

  it('should handle deny decision correctly', async () => {
    const sessionId = uuid();
    const approvalId = uuid();
    const approval = createApprovalJson(sessionId, approvalId);

    await writeApprovalFile(sessionId, approvalId, approval);
    await writeDecisionFile(sessionId, approvalId, 'deny');

    const decision = await readDecisionFile(sessionId, approvalId);
    assert.ok(decision, 'Decision file should exist');
    assert.strictEqual(decision!.decision, 'deny');
  });

  it('should handle multiple concurrent approvals across sessions', async () => {
    const session1 = uuid();
    const session2 = uuid();
    const approval1 = uuid();
    const approval2 = uuid();
    const approval3 = uuid();

    // Write 3 approvals across 2 sessions
    await writeApprovalFile(session1, approval1, createApprovalJson(session1, approval1));
    await writeApprovalFile(session1, approval2, createApprovalJson(session1, approval2));
    await writeApprovalFile(session2, approval3, createApprovalJson(session2, approval3));

    // Verify counts
    const files1 = await listApprovalFiles(session1);
    const files2 = await listApprovalFiles(session2);

    assert.strictEqual(files1.length, 2, 'Session 1 should have 2 approvals');
    assert.strictEqual(files2.length, 1, 'Session 2 should have 1 approval');

    // Resolve all
    await writeDecisionFile(session1, approval1, 'allow');
    await writeDecisionFile(session1, approval2, 'allow');
    await writeDecisionFile(session2, approval3, 'deny');

    // Verify all decisions
    const d1 = await readDecisionFile(session1, approval1);
    const d2 = await readDecisionFile(session1, approval2);
    const d3 = await readDecisionFile(session2, approval3);

    assert.strictEqual(d1!.decision, 'allow');
    assert.strictEqual(d2!.decision, 'allow');
    assert.strictEqual(d3!.decision, 'deny');
  });

  it('should handle cleanup of approval files after resolution', async () => {
    const sessionId = uuid();
    const approvalId = uuid();
    const approval = createApprovalJson(sessionId, approvalId);

    const approvalPath = await writeApprovalFile(sessionId, approvalId, approval);
    const decisionPath = await writeDecisionFile(sessionId, approvalId, 'allow');

    // Cleanup: remove both files (simulating what the hook does)
    await fs.promises.unlink(approvalPath);
    await fs.promises.unlink(decisionPath);

    const files = await listApprovalFiles(sessionId);
    assert.strictEqual(files.length, 0, 'No approval files should remain after cleanup');
  });

  it('should handle rapid successive approvals without collision', async () => {
    const sessionId = uuid();
    const approvalIds = Array.from({ length: 5 }, () => uuid());

    // Write 5 approvals rapidly
    await Promise.all(
      approvalIds.map((id) =>
        writeApprovalFile(sessionId, id, createApprovalJson(sessionId, id)),
      ),
    );

    const files = await listApprovalFiles(sessionId);
    assert.strictEqual(files.length, 5, 'All 5 approvals should be written without collision');

    // Resolve all in parallel
    await Promise.all(
      approvalIds.map((id) => writeDecisionFile(sessionId, id, 'allow')),
    );

    // Verify all decisions
    const decisions = await Promise.all(
      approvalIds.map((id) => readDecisionFile(sessionId, id)),
    );
    assert.ok(decisions.every((d) => d?.decision === 'allow'), 'All decisions should be allow');
  });

  it('should not confuse decision files with approval files', async () => {
    const sessionId = uuid();
    const approvalId = uuid();

    await writeApprovalFile(sessionId, approvalId, createApprovalJson(sessionId, approvalId));
    await writeDecisionFile(sessionId, approvalId, 'allow');

    // listApprovalFiles should only return the approval, not the decision
    const files = await listApprovalFiles(sessionId);
    assert.strictEqual(files.length, 1, 'Should only count approval files, not decision files');
    assert.ok(!files[0].includes('.decision.'), 'Should not include decision files');
  });

  it('should handle malformed JSON gracefully', async () => {
    const sessionId = uuid();
    const sessionDir = path.join(APPROVALS_DIR, sessionId);
    await fs.promises.mkdir(sessionDir, { recursive: true });

    // Write invalid JSON
    const badPath = path.join(sessionDir, 'bad-approval.json');
    await fs.promises.writeFile(badPath, 'this is not json{{{');

    // Reading should not throw
    try {
      const raw = await fs.promises.readFile(badPath, 'utf-8');
      assert.throws(() => JSON.parse(raw), 'Malformed JSON should throw on parse');
    } catch {
      assert.fail('Reading the file itself should not throw');
    }
  });

  it('should handle non-existent session directories', async () => {
    const files = await listApprovalFiles('non-existent-session');
    assert.strictEqual(files.length, 0, 'Should return empty array for non-existent session');
  });
});
