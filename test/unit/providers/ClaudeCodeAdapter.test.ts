/**
 * Conductor — Unit tests: providers/ClaudeCodeAdapter.ts
 *
 * Tests session discovery, state detection, and the pure helper
 * appendConductorSystemContext.  Uses temp directories to simulate
 * the ~/.claude/projects/ layout.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { appendConductorSystemContext } from '../../../src/providers/ClaudeCodeAdapter';

// ── appendConductorSystemContext ─────────────────────────────────

describe('ClaudeCodeAdapter.appendConductorSystemContext', () => {
  it('appends CONDUCTOR SYSTEM CONTEXT to the prompt', () => {
    const prompt = 'Do the thing.';
    const result = appendConductorSystemContext(prompt);
    assert.ok(result.startsWith(prompt), 'Should start with original prompt');
    assert.ok(result.includes('CONDUCTOR SYSTEM CONTEXT'), 'Should include system context header');
  });

  it('includes the [CONDUCTOR_TASK] tag format instructions', () => {
    const result = appendConductorSystemContext('test');
    assert.ok(result.includes('[CONDUCTOR_TASK]'), 'Should mention the tag format');
    assert.ok(result.includes('[/CONDUCTOR_TASK]'), 'Should mention the closing tag');
  });

  it('includes priority and blocking field instructions', () => {
    const result = appendConductorSystemContext('test');
    assert.ok(result.includes('priority:'), 'Should mention priority field');
    assert.ok(result.includes('blocking:'), 'Should mention blocking field');
  });

  it('preserves the original prompt content exactly', () => {
    const prompt = 'Build the authentication feature on branch feature/auth.\nFocus on OAuth2.';
    const result = appendConductorSystemContext(prompt);
    assert.ok(result.includes(prompt), 'Original prompt must appear verbatim');
  });

  it('works with an empty prompt string', () => {
    const result = appendConductorSystemContext('');
    assert.ok(result.includes('CONDUCTOR SYSTEM CONTEXT'));
  });
});

// ── Session discovery (filesystem-based) ────────────────────────

describe('ClaudeCodeAdapter — session discovery', () => {
  let tmpHome: string;
  let origHome: string | undefined;

  before(() => {
    origHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-cca-'));
    process.env.HOME = tmpHome;
  });

  after(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function createSessionDir(workspacePath: string): string {
    const crypto = require('crypto') as typeof import('crypto');
    const hash = crypto.createHash('sha256').update(workspacePath).digest('hex').slice(0, 16);
    const sessionDir = path.join(tmpHome, '.claude', 'projects', hash);
    fs.mkdirSync(sessionDir, { recursive: true });
    return sessionDir;
  }

  it('returns empty array when project directory does not exist', async () => {
    const { ClaudeCodeAdapter } = await import('../../../src/providers/ClaudeCodeAdapter');
    const adapter = new ClaudeCodeAdapter();
    const sessions = await adapter.discoverSessions('/nonexistent/workspace');
    assert.deepStrictEqual(sessions, []);
  });

  it('discovers sessions from JSONL files in project directory', async () => {
    const workspacePath = '/test/workspace';
    const sessionDir = createSessionDir(workspacePath);
    const sessionId = 'abc123def456';

    // Write a minimal JSONL file representing a session
    fs.writeFileSync(
      path.join(sessionDir, `${sessionId}.jsonl`),
      '{"type":"assistant","timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"assistant","content":"Hello"}}\n{"type":"result"}\n',
    );

    const { ClaudeCodeAdapter } = await import('../../../src/providers/ClaudeCodeAdapter');
    const adapter = new ClaudeCodeAdapter();
    const sessions = await adapter.discoverSessions(workspacePath);

    assert.strictEqual(sessions.length, 1);
    assert.strictEqual(sessions[0].id, sessionId);
    assert.strictEqual(sessions[0].workspacePath, workspacePath);
  });

  it('discovers multiple sessions in the same project directory', async () => {
    const workspacePath = '/test/workspace2';
    const sessionDir = createSessionDir(workspacePath);

    for (const id of ['sess-a', 'sess-b', 'sess-c']) {
      fs.writeFileSync(
        path.join(sessionDir, `${id}.jsonl`),
        '{"type":"assistant","message":{"role":"assistant","content":"Working"}}\n',
      );
    }

    const { ClaudeCodeAdapter } = await import('../../../src/providers/ClaudeCodeAdapter');
    const adapter = new ClaudeCodeAdapter();
    const sessions = await adapter.discoverSessions(workspacePath);
    assert.strictEqual(sessions.length, 3);
  });
});

// ── readSessionState ─────────────────────────────────────────────

describe('ClaudeCodeAdapter.readSessionState', () => {
  let tmpHome: string;
  let origHome: string | undefined;

  before(() => {
    origHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-cca2-'));
    process.env.HOME = tmpHome;
    // Create approvals dir structure
    fs.mkdirSync(path.join(tmpHome, '.conductor', 'approvals'), { recursive: true });
  });

  after(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('returns running when no pending approvals exist', async () => {
    const { ClaudeCodeAdapter } = await import('../../../src/providers/ClaudeCodeAdapter');
    const adapter = new ClaudeCodeAdapter();
    const state = await adapter.readSessionState('no-approval-session');
    assert.strictEqual(state.status, 'running');
    assert.deepStrictEqual(state.pendingApprovals, []);
  });

  it('returns waiting when a pending approval exists', async () => {
    const sessionId = 'waiting-session';
    const sessionApprovalsDir = path.join(tmpHome, '.conductor', 'approvals', sessionId);
    fs.mkdirSync(sessionApprovalsDir, { recursive: true });

    const approval = {
      id: 'approval-xyz',
      sessionId,
      sessionName: 'test',
      tool: 'Bash',
      command: 'rm -rf',
      context: 'test',
      timestamp: new Date().toISOString(),
      status: 'pending',
      resolvedAt: null,
    };
    fs.writeFileSync(
      path.join(sessionApprovalsDir, 'approval-xyz.json'),
      JSON.stringify(approval),
    );

    const { ClaudeCodeAdapter } = await import('../../../src/providers/ClaudeCodeAdapter');
    const adapter = new ClaudeCodeAdapter();
    const state = await adapter.readSessionState(sessionId);
    assert.strictEqual(state.status, 'waiting');
    assert.strictEqual(state.pendingApprovals.length, 1);
  });
});
