/**
 * Conductor — Unit tests: storage/FileStore.ts
 *
 * Tests read/write round-trip, atomic write semantics, directory
 * operations, and file listing.  All operations use a temp directory
 * so ~/.conductor is never touched.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
  readJsonFile,
  writeJsonFile,
  ensureDir,
  fileExists,
  removeFile,
  listJsonFiles,
} from '../../../src/storage/FileStore';

// ── Helpers ──────────────────────────────────────────────────────

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-fs-test-'));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── readJsonFile / writeJsonFile ─────────────────────────────────

describe('FileStore.readJsonFile', () => {
  let dir: string;
  before(() => { dir = tmpDir(); });
  after(() => { cleanup(dir); });

  it('returns default when file does not exist', async () => {
    const result = await readJsonFile(path.join(dir, 'missing.json'), { x: 1 });
    assert.deepStrictEqual(result, { x: 1 });
  });

  it('returns default when file contains invalid JSON', async () => {
    const filePath = path.join(dir, 'bad.json');
    fs.writeFileSync(filePath, 'not json!!');
    const result = await readJsonFile(filePath, { fallback: true });
    assert.deepStrictEqual(result, { fallback: true });
  });

  it('parses valid JSON and returns typed result', async () => {
    const filePath = path.join(dir, 'good.json');
    fs.writeFileSync(filePath, JSON.stringify({ name: 'test', count: 42 }));
    const result = await readJsonFile<{ name: string; count: number }>(filePath, { name: '', count: 0 });
    assert.strictEqual(result.name, 'test');
    assert.strictEqual(result.count, 42);
  });
});

describe('FileStore.writeJsonFile', () => {
  let dir: string;
  before(() => { dir = tmpDir(); });
  after(() => { cleanup(dir); });

  it('writes pretty-printed JSON to disk', async () => {
    const filePath = path.join(dir, 'written.json');
    await writeJsonFile(filePath, { hello: 'world', num: 7 });
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.hello, 'world');
    assert.strictEqual(parsed.num, 7);
  });

  it('round-trips: write then read returns original value', async () => {
    const filePath = path.join(dir, 'roundtrip.json');
    const original = { sessions: [{ id: 'abc', status: 'running' }] };
    await writeJsonFile(filePath, original);
    const restored = await readJsonFile<typeof original>(filePath, { sessions: [] });
    assert.deepStrictEqual(restored, original);
  });

  it('creates intermediate parent directories', async () => {
    const nested = path.join(dir, 'a', 'b', 'c', 'nested.json');
    await writeJsonFile(nested, { created: true });
    assert.ok(fs.existsSync(nested));
  });

  it('uses atomic write (no .tmp files left on success)', async () => {
    const filePath = path.join(dir, 'atomic.json');
    await writeJsonFile(filePath, { ok: true });
    const entries = fs.readdirSync(dir);
    const tmpFiles = entries.filter(e => e.startsWith('.tmp-'));
    assert.strictEqual(tmpFiles.length, 0, 'No temp files should remain after write');
  });

  it('overwrites existing file with new content', async () => {
    const filePath = path.join(dir, 'overwrite.json');
    await writeJsonFile(filePath, { version: 1 });
    await writeJsonFile(filePath, { version: 2 });
    const result = await readJsonFile<{ version: number }>(filePath, { version: 0 });
    assert.strictEqual(result.version, 2);
  });
});

// ── ensureDir ────────────────────────────────────────────────────

describe('FileStore.ensureDir', () => {
  let dir: string;
  before(() => { dir = tmpDir(); });
  after(() => { cleanup(dir); });

  it('creates a directory that does not exist', async () => {
    const newDir = path.join(dir, 'new-subdir');
    assert.ok(!fs.existsSync(newDir));
    await ensureDir(newDir);
    assert.ok(fs.existsSync(newDir));
    assert.ok(fs.statSync(newDir).isDirectory());
  });

  it('does not throw if directory already exists', async () => {
    const existingDir = path.join(dir, 'already-exists');
    fs.mkdirSync(existingDir);
    await assert.doesNotReject(() => ensureDir(existingDir));
  });

  it('creates nested directories recursively', async () => {
    const deep = path.join(dir, 'x', 'y', 'z');
    await ensureDir(deep);
    assert.ok(fs.statSync(deep).isDirectory());
  });
});

// ── fileExists ───────────────────────────────────────────────────

describe('FileStore.fileExists', () => {
  let dir: string;
  before(() => { dir = tmpDir(); });
  after(() => { cleanup(dir); });

  it('returns true for an existing file', async () => {
    const filePath = path.join(dir, 'exists.json');
    fs.writeFileSync(filePath, '{}');
    assert.strictEqual(await fileExists(filePath), true);
  });

  it('returns false for a missing file', async () => {
    assert.strictEqual(await fileExists(path.join(dir, 'nope.json')), false);
  });

  it('returns true for a directory', async () => {
    assert.strictEqual(await fileExists(dir), true);
  });
});

// ── removeFile ───────────────────────────────────────────────────

describe('FileStore.removeFile', () => {
  let dir: string;
  before(() => { dir = tmpDir(); });
  after(() => { cleanup(dir); });

  it('deletes an existing file', async () => {
    const filePath = path.join(dir, 'to-delete.json');
    fs.writeFileSync(filePath, '{}');
    await removeFile(filePath);
    assert.ok(!fs.existsSync(filePath));
  });

  it('does not throw when file is already missing', async () => {
    await assert.doesNotReject(() => removeFile(path.join(dir, 'ghost.json')));
  });
});

// ── listJsonFiles ────────────────────────────────────────────────

describe('FileStore.listJsonFiles', () => {
  let dir: string;
  before(() => {
    dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'a.json'), '{}');
    fs.writeFileSync(path.join(dir, 'b.json'), '{}');
    fs.writeFileSync(path.join(dir, 'c.txt'), 'not json');
    fs.writeFileSync(path.join(dir, '.tmp-d.json-1234-5678'), '{}');
    fs.mkdirSync(path.join(dir, 'subdir'));
  });
  after(() => { cleanup(dir); });

  it('returns only .json files', async () => {
    const files = await listJsonFiles(dir);
    assert.ok(files.every(f => f.endsWith('.json')));
  });

  it('excludes .tmp- files', async () => {
    const files = await listJsonFiles(dir);
    assert.ok(!files.some(f => path.basename(f).startsWith('.tmp-')));
  });

  it('excludes subdirectories', async () => {
    const files = await listJsonFiles(dir);
    assert.ok(!files.some(f => fs.statSync(f).isDirectory()));
  });

  it('returns absolute paths', async () => {
    const files = await listJsonFiles(dir);
    assert.ok(files.every(f => path.isAbsolute(f)));
  });

  it('returns exactly 2 json files (a.json and b.json)', async () => {
    const files = await listJsonFiles(dir);
    assert.strictEqual(files.length, 2);
  });

  it('returns empty array for non-existent directory', async () => {
    const files = await listJsonFiles(path.join(dir, 'no-such-dir'));
    assert.deepStrictEqual(files, []);
  });
});
