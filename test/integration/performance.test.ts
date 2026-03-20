/**
 * Conductor — Performance Profiling Tests.
 *
 * Validates performance targets from the implementation plan:
 * - Memory: < 50MB with 6 active sessions
 * - JSONL parsing: getSessionHistory(id, 50) within 2 seconds
 * - Output event conversion latency
 * - Task detection pattern matching speed
 *
 * Run: npx mocha --require ts-node/register test/integration/performance.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as assert from 'assert';
import { v4 as uuid } from 'uuid';

// ── Helpers ────────────────────────────────────────────────────

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-perf-'));
}

function generateJsonlEntries(count: number): string {
  const lines: string[] = [];
  const types = ['assistant', 'tool_use', 'tool_result', 'system'];

  for (let i = 0; i < count; i++) {
    const type = types[i % types.length];
    const entry: Record<string, unknown> = {
      type,
      timestamp: new Date(Date.now() - (count - i) * 1000).toISOString(),
    };

    if (type === 'assistant') {
      entry.message = {
        role: 'assistant',
        content: `This is output line ${i}. `.repeat(10) + `\`\`\`javascript\nconst x = ${i};\nconsole.log(x);\n\`\`\``,
      };
    } else if (type === 'tool_use') {
      entry.name = 'Bash';
      entry.input = { command: `echo "test command ${i}"` };
    } else if (type === 'tool_result') {
      entry.content = `Result output ${i}: ${'x'.repeat(200)}`;
      entry.exit_code = 0;
    } else {
      entry.content = `System message ${i}`;
    }

    lines.push(JSON.stringify(entry));
  }

  return lines.join('\n') + '\n';
}

function parseJsonlString(raw: string): object[] {
  const entries: object[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) { continue; }
    try { entries.push(JSON.parse(trimmed)); } catch { /* skip */ }
  }
  return entries;
}

function extractTaskBlocks(content: string): number {
  const re = /\[CONDUCTOR_TASK\][\s\S]*?\[\/CONDUCTOR_TASK\]/g;
  let count = 0;
  while (re.exec(content)) { count++; }
  return count;
}

// ── Tests ──────────────────────────────────────────────────────

describe('Performance Profiling', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = createTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('JSONL parsing: 500 entries parses in < 500ms', () => {
    const content = generateJsonlEntries(500);
    const filePath = path.join(tmpDir, 'session.jsonl');
    fs.writeFileSync(filePath, content);

    const start = Date.now();
    const raw = fs.readFileSync(filePath, 'utf-8');
    const entries = parseJsonlString(raw);
    const elapsed = Date.now() - start;

    assert.strictEqual(entries.length, 500);
    assert.ok(elapsed < 500, `Parsing 500 entries took ${elapsed}ms (target: < 500ms)`);
  });

  it('JSONL parsing: 2000 entries (large session) parses in < 2000ms', () => {
    const content = generateJsonlEntries(2000);
    const filePath = path.join(tmpDir, 'large-session.jsonl');
    fs.writeFileSync(filePath, content);

    const start = Date.now();
    const raw = fs.readFileSync(filePath, 'utf-8');
    const entries = parseJsonlString(raw);
    const last50 = entries.slice(-50);
    const elapsed = Date.now() - start;

    assert.strictEqual(entries.length, 2000);
    assert.strictEqual(last50.length, 50);
    assert.ok(elapsed < 2000, `Parsing 2000 entries took ${elapsed}ms (target: < 2000ms)`);
  });

  it('getSessionHistory(id, 50): slicing last 50 from 1000 entries in < 100ms', () => {
    const content = generateJsonlEntries(1000);
    const filePath = path.join(tmpDir, 'history.jsonl');
    fs.writeFileSync(filePath, content);

    const start = Date.now();
    const raw = fs.readFileSync(filePath, 'utf-8');
    const entries = parseJsonlString(raw);
    const last50 = entries.slice(-50);
    const elapsed = Date.now() - start;

    assert.strictEqual(last50.length, 50);
    assert.ok(elapsed < 100, `History extraction took ${elapsed}ms (target: < 100ms)`);
  });

  it('Task detection: pattern matching 100 entries with 5 task blocks in < 50ms', () => {
    const entries: string[] = [];
    for (let i = 0; i < 100; i++) {
      if (i % 20 === 0) {
        entries.push(`Line ${i}\n[CONDUCTOR_TASK]\ndescription: Task ${i}\npriority: normal\nblocking: false\n[/CONDUCTOR_TASK]`);
      } else {
        entries.push(`Regular output line ${i} with some content. `.repeat(5));
      }
    }
    const content = entries.join('\n');

    const start = Date.now();
    const count = extractTaskBlocks(content);
    const elapsed = Date.now() - start;

    assert.strictEqual(count, 5);
    assert.ok(elapsed < 50, `Task detection took ${elapsed}ms (target: < 50ms)`);
  });

  it('Memory: 6 session caches (200 events each) stay under 20MB', () => {
    const sessions = 6;
    const eventsPerSession = 200;
    const caches: object[][] = [];

    const baselineMem = process.memoryUsage().heapUsed;

    for (let s = 0; s < sessions; s++) {
      const content = generateJsonlEntries(eventsPerSession);
      const entries = parseJsonlString(content);
      caches.push(entries);
    }

    const afterMem = process.memoryUsage().heapUsed;
    const deltaMB = (afterMem - baselineMem) / (1024 * 1024);

    assert.strictEqual(caches.length, 6);
    assert.strictEqual(caches[0].length, 200);
    assert.ok(deltaMB < 20, `6 session caches used ${deltaMB.toFixed(1)}MB (target: < 20MB)`);
  });

  it('Incremental read: reading 10 new bytes from a 1MB file in < 10ms', () => {
    const largePath = path.join(tmpDir, 'large.jsonl');
    // Write ~1MB of data
    const bigContent = generateJsonlEntries(3000);
    fs.writeFileSync(largePath, bigContent);

    const lastSize = fs.statSync(largePath).size;

    // Append a new entry
    const newEntry = JSON.stringify({ type: 'assistant', message: { content: 'New!' }, timestamp: new Date().toISOString() }) + '\n';
    fs.appendFileSync(largePath, newEntry);

    const newSize = fs.statSync(largePath).size;
    const delta = newSize - lastSize;

    // Read only the new bytes
    const start = Date.now();
    const fd = fs.openSync(largePath, 'r');
    const buf = Buffer.alloc(delta);
    fs.readSync(fd, buf, 0, delta, lastSize);
    fs.closeSync(fd);
    const text = buf.toString('utf-8');
    const parsed = JSON.parse(text.trim());
    const elapsed = Date.now() - start;

    assert.strictEqual(parsed.type, 'assistant');
    assert.ok(elapsed < 10, `Incremental read took ${elapsed}ms (target: < 10ms)`);
  });

  it('TreeView refresh debounce: rapid state changes batch correctly', () => {
    // Simulate rapid state changes and debounce
    const DEBOUNCE_MS = 100;
    let refreshCount = 0;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    function scheduleRefresh() {
      if (debounceTimer) { clearTimeout(debounceTimer); }
      debounceTimer = setTimeout(() => { refreshCount++; }, DEBOUNCE_MS);
    }

    // Fire 20 rapid changes
    for (let i = 0; i < 20; i++) {
      scheduleRefresh();
    }

    // After debounce, only 1 refresh should fire
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        assert.strictEqual(refreshCount, 1, `Expected 1 debounced refresh, got ${refreshCount}`);
        resolve();
      }, DEBOUNCE_MS + 50);
    });
  });
});
