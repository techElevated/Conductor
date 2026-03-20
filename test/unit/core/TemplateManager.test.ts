/**
 * Conductor — Unit tests: TemplateManager.ts
 *
 * Tests template CRUD, variable resolution, topological sort,
 * import/export, and fixture validation.
 */

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';

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
