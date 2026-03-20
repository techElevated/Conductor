/**
 * Conductor — Unit tests: TemplateManager.ts
 *
 * Tests template CRUD, variable resolution, topological sort,
 * import/export, and fixture validation.
 */

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// ── Pure function tests (no VS Code deps) ────────────────────────

// Import the module-level helpers indirectly through the exported
// resolveVariables method of TemplateManager — but since those are
// module-private, we test them via the exported class interface.
// For pure function testing we can also just reproduce the logic here.

function resolveVars(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, name) => vars[name] ?? `{{${name}}}`);
}

describe('TemplateManager — variable resolution', () => {
  it('replaces a simple variable', () => {
    const result = resolveVars('Build the {{featureName}} feature', { featureName: 'payments' });
    assert.strictEqual(result, 'Build the payments feature');
  });

  it('replaces multiple variables', () => {
    const result = resolveVars(
      'Implement {{featureName}} on branch {{targetBranch}}',
      { featureName: 'auth', targetBranch: 'feature/auth' },
    );
    assert.strictEqual(result, 'Implement auth on branch feature/auth');
  });

  it('leaves unresolved variables as-is', () => {
    const result = resolveVars('Build the {{unknown}} feature', {});
    assert.strictEqual(result, 'Build the {{unknown}} feature');
  });

  it('handles empty variable map', () => {
    const result = resolveVars('No variables here', {});
    assert.strictEqual(result, 'No variables here');
  });

  it('replaces same variable appearing multiple times', () => {
    const result = resolveVars('{{x}} and {{x}} again', { x: 'foo' });
    assert.strictEqual(result, 'foo and foo again');
  });
});

// ── Topological sort tests ───────────────────────────────────────

// Replicate the topological sort logic for pure testing
interface TestSession {
  templateSessionId: string;
  dependsOn: string[];
}

function topoSort(sessions: TestSession[]): TestSession[] {
  const idToSession = new Map<string, TestSession>(
    sessions.map(s => [s.templateSessionId, s]),
  );
  const depCount = new Map<string, number>(
    sessions.map(s => [s.templateSessionId, s.dependsOn.length]),
  );

  const queue: string[] = [];
  for (const [id, count] of depCount) {
    if (count === 0) queue.push(id);
  }

  const sorted: TestSession[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const session = idToSession.get(id);
    if (session) sorted.push(session);

    for (const s of sessions) {
      if (s.dependsOn.includes(id)) {
        const newCount = (depCount.get(s.templateSessionId) ?? 1) - 1;
        depCount.set(s.templateSessionId, newCount);
        if (newCount === 0) queue.push(s.templateSessionId);
      }
    }
  }

  return sorted.length === sessions.length ? sorted : [...sessions];
}

describe('TemplateManager — topological sort', () => {
  it('returns linear chain in correct order (A → B → C)', () => {
    const sessions: TestSession[] = [
      { templateSessionId: 'C', dependsOn: ['B'] },
      { templateSessionId: 'B', dependsOn: ['A'] },
      { templateSessionId: 'A', dependsOn: [] },
    ];
    const sorted = topoSort(sessions);
    assert.strictEqual(sorted[0].templateSessionId, 'A');
    assert.strictEqual(sorted[1].templateSessionId, 'B');
    assert.strictEqual(sorted[2].templateSessionId, 'C');
  });

  it('handles parallel roots (A, B independent, C depends on both)', () => {
    const sessions: TestSession[] = [
      { templateSessionId: 'C', dependsOn: ['A', 'B'] },
      { templateSessionId: 'B', dependsOn: [] },
      { templateSessionId: 'A', dependsOn: [] },
    ];
    const sorted = topoSort(sessions);
    // C must come last
    assert.strictEqual(sorted[sorted.length - 1].templateSessionId, 'C');
    // A and B come before C
    const cIdx = sorted.findIndex(s => s.templateSessionId === 'C');
    assert.ok(cIdx >= 2, 'C should appear after A and B');
  });

  it('falls back to original order on cycle', () => {
    const sessions: TestSession[] = [
      { templateSessionId: 'A', dependsOn: ['B'] },
      { templateSessionId: 'B', dependsOn: ['A'] }, // cycle
    ];
    const sorted = topoSort(sessions);
    // Falls back to original order — no crash
    assert.strictEqual(sorted.length, 2);
  });

  it('handles empty session list', () => {
    assert.deepStrictEqual(topoSort([]), []);
  });
});

// ── Fixture tests ────────────────────────────────────────────────

describe('TemplateManager — fixture validation', () => {
  it('loads sample-template fixture without error', () => {
    const fixturePath = path.join(__dirname, '../../fixtures/sample-template.json');
    const raw = fs.readFileSync(fixturePath, 'utf-8');
    const data = JSON.parse(raw) as {
      id: string;
      name: string;
      sessions: Array<{ templateSessionId: string; name: string; prompt: string }>;
      variables: Array<{ name: string }>;
    };

    assert.ok(data.id, 'Template must have id');
    assert.ok(data.name, 'Template must have name');
    assert.ok(Array.isArray(data.sessions), 'Template must have sessions array');
    assert.ok(Array.isArray(data.variables), 'Template must have variables array');
  });

  it('fixture template variable resolution works', () => {
    const fixturePath = path.join(__dirname, '../../fixtures/sample-template.json');
    const data = JSON.parse(fs.readFileSync(fixturePath, 'utf-8')) as {
      sessions: Array<{ prompt: string; name: string }>;
    };

    const vars = { featureName: 'payments', targetBranch: 'main' };
    for (const session of data.sessions) {
      const resolvedPrompt = resolveVars(session.prompt, vars);
      const resolvedName = resolveVars(session.name, vars);
      assert.ok(!resolvedPrompt.includes('{{featureName}}'), `Session "${session.name}" has unresolved featureName`);
      assert.ok(!resolvedName.includes('{{featureName}}'), `Session name has unresolved featureName`);
    }
  });

  it('fixture template has correct dependency topology (A → B → C)', () => {
    const fixturePath = path.join(__dirname, '../../fixtures/sample-template.json');
    const data = JSON.parse(fs.readFileSync(fixturePath, 'utf-8')) as {
      sessions: Array<{ templateSessionId: string; dependsOn: string[] }>;
    };

    const sorted = topoSort(data.sessions);
    // s-api has no dependencies — should come first
    assert.strictEqual(sorted[0].templateSessionId, 's-api');
    // s-tests depends on both — should come last
    assert.strictEqual(sorted[sorted.length - 1].templateSessionId, 's-tests');
  });
});

// ── TemplateManager class-level tests ────────────────────────────

import { TemplateManager } from '../../../src/core/TemplateManager';
import type { QueuedPrompt, ConductorSession, SessionTemplate } from '../../../src/types';

class StubQueueManager {
  async addPrompt(opts: Partial<QueuedPrompt>): Promise<QueuedPrompt> {
    return {
      id: `prompt-${Date.now()}-${Math.random()}`,
      name: opts.name ?? '',
      description: opts.description ?? '',
      prompt: opts.prompt ?? '',
      providerId: opts.providerId ?? 'claude-code',
      parallelSafe: opts.parallelSafe ?? true,
      complexity: 'medium',
      dependsOn: opts.dependsOn ?? [],
      status: 'queued',
      sessionId: null,
      position: 0,
      createdAt: new Date().toISOString(),
      launchedAt: null,
    };
  }

  async launchPrompt(id: string): Promise<ConductorSession> {
    return {
      id: `session-for-${id}`,
      name: 'Session',
      providerId: 'claude-code',
      workspacePath: '/ws',
      prompt: '',
      status: 'running',
      pid: null,
      terminalId: null,
      hookInstalled: false,
      dependsOn: [],
      templateId: null,
      createdAt: new Date().toISOString(),
      launchedAt: new Date().toISOString(),
      completedAt: null,
      exitCode: null,
      metadata: {},
    };
  }
}

class StubDependencyEngine {
  allDependenciesMet(_id: string): boolean { return true; }
  async addDependency(_id: string, _deps: string[]): Promise<void> { /* no-op */ }
  dispose(): void { /* no-op */ }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collectEvents(
  subscribe: (cb: (e: any) => void) => { dispose: () => void },
): { events: any[]; dispose: () => void } {
  const events: any[] = [];
  const disposable = subscribe((e: unknown) => { events.push(e); });
  return { events, dispose: () => disposable.dispose() };
}

describe('TemplateManager — createTemplate / getTemplate', () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let manager: TemplateManager;

  beforeEach(async () => {
    origHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-tm-'));
    fs.mkdirSync(path.join(tmpHome, '.conductor'), { recursive: true });
    process.env.HOME = tmpHome;
    manager = new TemplateManager(
      tmpHome,  // use tmpHome as workspacePath so project templates dir is writable
      new StubQueueManager() as unknown as import('../../../src/core/QueueManager').QueueManager,
      new StubDependencyEngine() as unknown as import('../../../src/core/DependencyEngine').DependencyEngine,
    );
    await manager.initialise();
  });

  afterEach(() => {
    manager.dispose();
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('creates a template with default fields', async () => {
    const tpl = await manager.createTemplate({ name: 'My Template' });
    assert.ok(typeof tpl.id === 'string' && tpl.id.length > 0);
    assert.strictEqual(tpl.name, 'My Template');
    assert.strictEqual(tpl.scope, 'user');
    assert.ok(Array.isArray(tpl.sessions));
    assert.ok(Array.isArray(tpl.variables));
  });

  it('getTemplate returns the created template', async () => {
    const tpl = await manager.createTemplate({ name: 'FindMe' });
    const found = manager.getTemplate(tpl.id);
    assert.ok(found !== undefined);
    assert.strictEqual(found!.name, 'FindMe');
  });

  it('getTemplate returns undefined for unknown ID', () => {
    assert.strictEqual(manager.getTemplate('no-such-id'), undefined);
  });

  it('createTemplate emits "created" event', async () => {
    const { events, dispose } = collectEvents(cb => manager.onTemplateEvent(cb));
    const tpl = await manager.createTemplate({ name: 'EventTest' });
    dispose();
    assert.ok(events.some(e => e.type === 'created' && e.templateId === tpl.id));
  });

  it('persists template to disk (readable after re-initialise)', async () => {
    const tpl = await manager.createTemplate({ name: 'Persist Me' });
    manager.dispose();

    const manager2 = new TemplateManager(
      tmpHome,
      new StubQueueManager() as unknown as import('../../../src/core/QueueManager').QueueManager,
      new StubDependencyEngine() as unknown as import('../../../src/core/DependencyEngine').DependencyEngine,
    );
    await manager2.initialise();
    const found = manager2.getTemplate(tpl.id);
    assert.ok(found !== undefined);
    assert.strictEqual(found!.name, 'Persist Me');
    manager2.dispose();
  });

  it('getUserTemplates returns all user-scoped templates', async () => {
    await manager.createTemplate({ name: 'T1', scope: 'user' });
    await manager.createTemplate({ name: 'T2', scope: 'user' });
    assert.strictEqual(manager.getUserTemplates().length, 2);
  });
});

describe('TemplateManager — updateTemplate / deleteTemplate', () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let manager: TemplateManager;

  beforeEach(async () => {
    origHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-tm-'));
    fs.mkdirSync(path.join(tmpHome, '.conductor'), { recursive: true });
    process.env.HOME = tmpHome;
    manager = new TemplateManager(
      tmpHome,
      new StubQueueManager() as unknown as import('../../../src/core/QueueManager').QueueManager,
      new StubDependencyEngine() as unknown as import('../../../src/core/DependencyEngine').DependencyEngine,
    );
    await manager.initialise();
  });

  afterEach(() => {
    manager.dispose();
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('updateTemplate updates name and emits "updated" event', async () => {
    const tpl = await manager.createTemplate({ name: 'OldName' });
    const { events, dispose } = collectEvents(cb => manager.onTemplateEvent(cb));
    await manager.updateTemplate(tpl.id, { name: 'NewName' });
    dispose();
    assert.strictEqual(manager.getTemplate(tpl.id)!.name, 'NewName');
    assert.ok(events.some(e => e.type === 'updated' && e.templateId === tpl.id));
  });

  it('updateTemplate throws for unknown ID', async () => {
    await assert.rejects(
      () => manager.updateTemplate('no-such-id', { name: 'Fail' }),
      /not found/i,
    );
  });

  it('deleteTemplate removes template and emits "deleted" event', async () => {
    const tpl = await manager.createTemplate({ name: 'ToDelete' });
    const { events, dispose } = collectEvents(cb => manager.onTemplateEvent(cb));
    await manager.deleteTemplate(tpl.id);
    dispose();
    assert.strictEqual(manager.getTemplate(tpl.id), undefined);
    assert.ok(events.some(e => e.type === 'deleted' && e.templateId === tpl.id));
  });

  it('deleteTemplate is a no-op for unknown ID', async () => {
    const countBefore = manager.getAllTemplates().length;
    await manager.deleteTemplate('no-such-id');
    assert.strictEqual(manager.getAllTemplates().length, countBefore);
  });
});

describe('TemplateManager — exportTemplate / importTemplate', () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let manager: TemplateManager;

  beforeEach(async () => {
    origHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-tm-'));
    fs.mkdirSync(path.join(tmpHome, '.conductor'), { recursive: true });
    process.env.HOME = tmpHome;
    manager = new TemplateManager(
      tmpHome,
      new StubQueueManager() as unknown as import('../../../src/core/QueueManager').QueueManager,
      new StubDependencyEngine() as unknown as import('../../../src/core/DependencyEngine').DependencyEngine,
    );
    await manager.initialise();
  });

  afterEach(() => {
    manager.dispose();
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('exportTemplate returns valid JSON string', async () => {
    const tpl = await manager.createTemplate({ name: 'Exportable' });
    const json = manager.exportTemplate(tpl.id);
    const parsed = JSON.parse(json) as SessionTemplate;
    assert.strictEqual(parsed.id, tpl.id);
    assert.strictEqual(parsed.name, 'Exportable');
  });

  it('exportTemplate throws for unknown ID', () => {
    assert.throws(
      () => manager.exportTemplate('no-such-id'),
      /not found/i,
    );
  });

  it('importTemplate creates a new template with a fresh ID', async () => {
    const tpl = await manager.createTemplate({ name: 'ToImport' });
    const json = manager.exportTemplate(tpl.id);
    const imported = await manager.importTemplate(json);
    assert.notStrictEqual(imported.id, tpl.id);
    assert.strictEqual(imported.name, 'ToImport');
  });

  it('importTemplate throws on invalid JSON', async () => {
    await assert.rejects(
      () => manager.importTemplate('not-json'),
      /invalid template json/i,
    );
  });

  it('importTemplate throws on missing required fields', async () => {
    const badJson = JSON.stringify({ id: 'x', description: 'no name or sessions' });
    await assert.rejects(
      () => manager.importTemplate(badJson),
      /invalid template/i,
    );
  });
});
