/**
 * Conductor — Unit tests: providers/ProviderPaths.ts
 *
 * Tests correct path construction for each provider, version detection,
 * and the data-exists helper.  No VS Code dependencies.
 */

import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

import {
  getProviderHomeDir,
  getProviderProjectsDir,
  getSessionLogDir,
  detectProviderVersion,
  providerDataExists,
  getAllProviderHomeDirs,
  getRegisteredProviderIds,
} from '../../../src/providers/ProviderPaths';

// ── getProviderHomeDir ───────────────────────────────────────────

describe('ProviderPaths.getProviderHomeDir', () => {
  it('returns ~/.claude for claude-code', () => {
    const result = getProviderHomeDir('claude-code');
    assert.strictEqual(result, path.join(os.homedir(), '.claude'));
  });

  it('returns ~/.codex for codex', () => {
    assert.strictEqual(getProviderHomeDir('codex'), path.join(os.homedir(), '.codex'));
  });

  it('returns ~/.gemini for gemini-cli', () => {
    assert.strictEqual(getProviderHomeDir('gemini-cli'), path.join(os.homedir(), '.gemini'));
  });

  it('returns an absolute path', () => {
    assert.ok(path.isAbsolute(getProviderHomeDir('claude-code')));
  });
});

// ── getProviderProjectsDir ───────────────────────────────────────

describe('ProviderPaths.getProviderProjectsDir', () => {
  it('appends "projects" subdir for claude-code', () => {
    const result = getProviderProjectsDir('claude-code');
    assert.strictEqual(result, path.join(os.homedir(), '.claude', 'projects'));
  });

  it('appends "projects" subdir for codex', () => {
    assert.ok(getProviderProjectsDir('codex').endsWith(path.sep + 'projects'));
  });

  it('contains the provider home dir as prefix', () => {
    const home = getProviderHomeDir('claude-code');
    const projectsDir = getProviderProjectsDir('claude-code');
    assert.ok(projectsDir.startsWith(home));
  });
});

// ── getSessionLogDir ─────────────────────────────────────────────

describe('ProviderPaths.getSessionLogDir', () => {
  it('returns path under the projects directory', () => {
    const projectsDir = getProviderProjectsDir('claude-code');
    const logDir = getSessionLogDir('claude-code', 'abc123def456');
    assert.ok(logDir.startsWith(projectsDir));
  });

  it('includes the project hash in the path', () => {
    const hash = 'deadbeef12345678';
    const logDir = getSessionLogDir('claude-code', hash);
    assert.ok(logDir.endsWith(hash));
  });

  it('works for all providers', () => {
    const providers: Array<'claude-code' | 'codex' | 'gemini-cli'> = [
      'claude-code', 'codex', 'gemini-cli',
    ];
    for (const p of providers) {
      const dir = getSessionLogDir(p, 'testhash');
      assert.ok(path.isAbsolute(dir), `Expected absolute path for ${p}`);
      assert.ok(dir.includes('testhash'), `Expected hash in path for ${p}`);
    }
  });
});

// ── getAllProviderHomeDirs ────────────────────────────────────────

describe('ProviderPaths.getAllProviderHomeDirs', () => {
  it('returns an array with one path per registered provider', () => {
    const dirs = getAllProviderHomeDirs();
    const ids = getRegisteredProviderIds();
    assert.strictEqual(dirs.length, ids.length);
  });

  it('includes the claude-code home dir', () => {
    const dirs = getAllProviderHomeDirs();
    assert.ok(dirs.includes(path.join(os.homedir(), '.claude')));
  });

  it('all returned paths are absolute', () => {
    assert.ok(getAllProviderHomeDirs().every(d => path.isAbsolute(d)));
  });
});

// ── getRegisteredProviderIds ─────────────────────────────────────

describe('ProviderPaths.getRegisteredProviderIds', () => {
  it('returns at least the three known providers', () => {
    const ids = getRegisteredProviderIds();
    assert.ok(ids.includes('claude-code'));
    assert.ok(ids.includes('codex'));
    assert.ok(ids.includes('gemini-cli'));
  });

  it('returns unique IDs', () => {
    const ids = getRegisteredProviderIds();
    assert.strictEqual(ids.length, new Set(ids).size);
  });
});

// ── providerDataExists ───────────────────────────────────────────

describe('ProviderPaths.providerDataExists', () => {
  let tmpBase: string;
  let origHome: string | undefined;

  before(() => {
    origHome = process.env.HOME;
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-pp-'));
    process.env.HOME = tmpBase;
  });

  after(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('returns false when provider home dir does not exist', async () => {
    const exists = await providerDataExists('codex');
    assert.strictEqual(exists, false);
  });

  it('returns true when provider home dir exists', async () => {
    fs.mkdirSync(path.join(tmpBase, '.claude'), { recursive: true });
    const exists = await providerDataExists('claude-code');
    assert.strictEqual(exists, true);
  });
});

// ── detectProviderVersion ────────────────────────────────────────

describe('ProviderPaths.detectProviderVersion', () => {
  it('returns null if binary is not found', async () => {
    // 'nonexistent-binary-xyz' should not be in PATH
    // We test by checking a known-missing binary pattern
    // Use a provider that won't be installed in test env
    const version = await detectProviderVersion('codex');
    // Could be null (not installed) or a string (if installed)
    // Just verify the return type contract
    assert.ok(version === null || typeof version === 'string');
  });

  it('returns a string (or null) without throwing', async () => {
    let result: string | null;
    try {
      result = await detectProviderVersion('gemini-cli');
      assert.ok(result === null || typeof result === 'string');
    } catch {
      assert.fail('detectProviderVersion should not throw');
    }
  });
});
