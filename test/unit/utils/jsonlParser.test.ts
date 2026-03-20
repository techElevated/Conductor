/**
 * Conductor — Unit tests: utils/jsonlParser.ts
 *
 * Tests JSONL parsing, entry type conversion, status inference,
 * and malformed-line resilience.  watchNewEntries (which uses
 * vscode.Disposable) is covered via the mock in test/setup.ts.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
  parseJsonlString,
  parseJsonlFile,
  entryToOutputEvent,
  entriesToOutputEvents,
  inferStatusFromEntries,
} from '../../../src/utils/jsonlParser';

// ── parseJsonlString ─────────────────────────────────────────────

describe('jsonlParser.parseJsonlString', () => {
  it('parses a single valid JSON line', () => {
    const entries = parseJsonlString('{"type":"assistant","timestamp":"2026-01-01T00:00:00.000Z"}');
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].type, 'assistant');
  });

  it('parses multiple JSONL lines', () => {
    const raw = [
      '{"type":"system","message":{"role":"system","content":"Hello"}}',
      '{"type":"assistant","message":{"role":"assistant","content":"Hi"}}',
      '{"type":"tool_use","name":"Bash","input":{"command":"ls"}}',
    ].join('\n');
    const entries = parseJsonlString(raw);
    assert.strictEqual(entries.length, 3);
  });

  it('skips malformed (non-JSON) lines without throwing', () => {
    const raw = [
      '{"type":"assistant"}',
      'NOT VALID JSON !!@#',
      '{"type":"tool_result"}',
    ].join('\n');
    const entries = parseJsonlString(raw);
    assert.strictEqual(entries.length, 2, 'Should skip the bad line');
  });

  it('skips blank lines', () => {
    const raw = '{"type":"system"}\n\n\n{"type":"assistant"}';
    assert.strictEqual(parseJsonlString(raw).length, 2);
  });

  it('returns empty array for empty string', () => {
    assert.deepStrictEqual(parseJsonlString(''), []);
  });

  it('preserves all fields from each JSON object', () => {
    const raw = '{"type":"tool_use","name":"Write","input":{"path":"file.ts","content":"x"},"timestamp":"2026-01-01T00:00:00.000Z"}';
    const [entry] = parseJsonlString(raw);
    assert.strictEqual(entry.type, 'tool_use');
    assert.strictEqual(entry.name, 'Write');
    assert.strictEqual(entry.timestamp, '2026-01-01T00:00:00.000Z');
  });
});

// ── parseJsonlFile ───────────────────────────────────────────────

describe('jsonlParser.parseJsonlFile', () => {
  let dir: string;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-jl-')); });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('parses a real JSONL file on disk', async () => {
    const filePath = path.join(dir, 'session.jsonl');
    fs.writeFileSync(filePath, [
      '{"type":"system","content":"init"}',
      '{"type":"assistant","message":{"role":"assistant","content":"Hello"}}',
    ].join('\n'));
    const entries = await parseJsonlFile(filePath);
    assert.strictEqual(entries.length, 2);
  });

  it('returns empty array for missing file', async () => {
    const entries = await parseJsonlFile(path.join(dir, 'missing.jsonl'));
    assert.deepStrictEqual(entries, []);
  });

  it('parses the sample-session.jsonl fixture', async () => {
    const fixturePath = path.join(__dirname, '../../fixtures/sample-session.jsonl');
    const entries = await parseJsonlFile(fixturePath);
    assert.ok(entries.length >= 5, `Expected >= 5 entries, got ${entries.length}`);
    const types = entries.map(e => e.type);
    assert.ok(types.includes('assistant'), 'Expected assistant entry');
    assert.ok(types.includes('tool_use'), 'Expected tool_use entry');
  });
});

// ── entryToOutputEvent ───────────────────────────────────────────

describe('jsonlParser.entryToOutputEvent', () => {
  it('converts assistant entry with string content', () => {
    const entry = {
      type: 'assistant',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'assistant', content: 'Hello world' },
    };
    const event = entryToOutputEvent(entry);
    assert.ok(event !== null);
    assert.strictEqual(event!.type, 'assistant');
    assert.strictEqual(event!.content, 'Hello world');
  });

  it('converts assistant entry with array content blocks', () => {
    const entry = {
      type: 'assistant',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Part 1' },
          { type: 'text', text: 'Part 2' },
        ],
      },
    };
    const event = entryToOutputEvent(entry);
    assert.ok(event !== null);
    assert.ok(event!.content.includes('Part 1'));
    assert.ok(event!.content.includes('Part 2'));
  });

  it('converts tool_use entry with command', () => {
    const entry = {
      type: 'tool_use',
      timestamp: '2026-01-01T00:00:00.000Z',
      name: 'Bash',
      input: { command: 'npm test' },
    };
    const event = entryToOutputEvent(entry);
    assert.ok(event !== null);
    assert.strictEqual(event!.type, 'tool_use');
    assert.ok(event!.content.includes('npm test'));
    assert.strictEqual(event!.metadata?.toolName, 'Bash');
  });

  it('converts tool_result entry with exit code', () => {
    const entry = {
      type: 'tool_result',
      timestamp: '2026-01-01T00:00:00.000Z',
      content: 'output text',
      exit_code: 0,
    };
    const event = entryToOutputEvent(entry);
    assert.ok(event !== null);
    assert.strictEqual(event!.type, 'tool_result');
    assert.strictEqual(event!.metadata?.exitCode, 0);
  });

  it('converts error entry', () => {
    const entry = {
      type: 'error',
      timestamp: '2026-01-01T00:00:00.000Z',
      content: 'Something went wrong',
    };
    const event = entryToOutputEvent(entry);
    assert.ok(event !== null);
    assert.strictEqual(event!.type, 'error');
    assert.ok(event!.content.includes('Something went wrong'));
  });

  it('converts system entry', () => {
    const entry = {
      type: 'system',
      timestamp: '2026-01-01T00:00:00.000Z',
      content: 'Session started',
    };
    const event = entryToOutputEvent(entry);
    assert.ok(event !== null);
    assert.strictEqual(event!.type, 'system');
  });

  it('returns null for unknown entry types (e.g., result)', () => {
    const entry = { type: 'result', timestamp: '2026-01-01T00:00:00.000Z' };
    const event = entryToOutputEvent(entry);
    assert.strictEqual(event, null);
  });

  it('returns null for user messages', () => {
    const entry = {
      type: 'user',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'Please do this' },
    };
    const event = entryToOutputEvent(entry);
    assert.strictEqual(event, null);
  });

  it('uses current ISO timestamp when entry has no timestamp', () => {
    const entry = { type: 'assistant', message: { role: 'assistant', content: 'Hi' } };
    const event = entryToOutputEvent(entry);
    assert.ok(event !== null);
    assert.ok(typeof event!.timestamp === 'string');
    assert.ok(event!.timestamp.length > 0);
  });
});

// ── entriesToOutputEvents ────────────────────────────────────────

describe('jsonlParser.entriesToOutputEvents', () => {
  it('converts an array of entries, skipping non-emittable types', () => {
    const entries = [
      { type: 'assistant', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'assistant', content: 'Hi' } },
      { type: 'user', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'Hello' } },
      { type: 'tool_use', timestamp: '2026-01-01T00:00:00.000Z', name: 'Bash', input: { command: 'ls' } },
      { type: 'result', timestamp: '2026-01-01T00:00:00.000Z' },
    ];
    const events = entriesToOutputEvents(entries);
    // assistant and tool_use should produce events; user and result should not
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].type, 'assistant');
    assert.strictEqual(events[1].type, 'tool_use');
  });

  it('returns empty array for empty input', () => {
    assert.deepStrictEqual(entriesToOutputEvents([]), []);
  });
});

// ── inferStatusFromEntries ───────────────────────────────────────

describe('jsonlParser.inferStatusFromEntries', () => {
  it('returns "queued" for empty entries array', () => {
    assert.strictEqual(inferStatusFromEntries([]), 'queued');
  });

  it('returns "complete" when last meaningful entry is result/completion', () => {
    const entries = [
      { type: 'assistant', message: { role: 'assistant', content: 'Done' } },
      { type: 'result' },
    ];
    assert.strictEqual(inferStatusFromEntries(entries), 'complete');
  });

  it('returns "complete" for "completion" type', () => {
    assert.strictEqual(inferStatusFromEntries([{ type: 'completion' }]), 'complete');
  });

  it('returns "error" when last meaningful entry is error', () => {
    const entries = [
      { type: 'assistant', message: { role: 'assistant', content: 'Starting' } },
      { type: 'error', content: 'Something failed' },
    ];
    assert.strictEqual(inferStatusFromEntries(entries), 'error');
  });

  it('returns "waiting" when last meaningful entry is tool_use', () => {
    const entries = [
      { type: 'assistant', message: { role: 'assistant', content: 'Running tool' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
    ];
    assert.strictEqual(inferStatusFromEntries(entries), 'waiting');
  });

  it('returns "running" when last meaningful entry is assistant message', () => {
    const entries = [
      { type: 'system', content: 'init' },
      { type: 'assistant', message: { role: 'assistant', content: 'Processing...' } },
    ];
    assert.strictEqual(inferStatusFromEntries(entries), 'running');
  });

  it('returns "running" as fallback when no meaningful entries', () => {
    const entries = [
      { type: 'user', message: { role: 'user', content: 'hello' } },
    ];
    assert.strictEqual(inferStatusFromEntries(entries), 'running');
  });

  it('infers status from sample fixture correctly', async () => {
    const fixturePath = path.join(__dirname, '../../fixtures/sample-session.jsonl');
    const { parseJsonlFile: plf } = await import('../../../src/utils/jsonlParser');
    const entries = await plf(fixturePath);
    // Fixture ends with a 'result' entry → should be 'complete'
    const status = inferStatusFromEntries(entries);
    assert.strictEqual(status, 'complete');
  });
});
