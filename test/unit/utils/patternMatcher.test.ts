/**
 * Conductor — Unit tests: patternMatcher.ts
 *
 * Tests all detection patterns, confidence levels, structured tag parsing,
 * and deduplication helpers.
 *
 * Run without VS Code via ts-node:
 *   npx ts-node --project tsconfig.json -e "require('./test/unit/utils/patternMatcher.test')"
 */

import * as assert from 'assert';
import {
  matchTasks,
  parseStructuredTask,
  isSimilarDescription,
  normaliseDescription,
} from '../../../src/utils/patternMatcher';

// ── matchTasks ───────────────────────────────────────────────────

describe('patternMatcher.matchTasks', () => {
  it('detects [CONDUCTOR_TASK] blocks with high confidence', () => {
    const text = `
Some output from the agent.
[CONDUCTOR_TASK]
description: Restart the gateway service
priority: urgent
blocking: true
[/CONDUCTOR_TASK]
More output.
`;
    const results = matchTasks(text);
    assert.ok(results.length > 0, 'Expected at least one match');
    const tagged = results.find(r => r.patternName === 'conductor-tag');
    assert.ok(tagged, 'Expected conductor-tag match');
    assert.strictEqual(tagged?.confidence, 'high');
  });

  it('detects ACTION ITEM pattern with high confidence', () => {
    const results = matchTasks('ACTION ITEM: Update the environment variables in .env.prod');
    assert.ok(results.some(r => r.patternName === 'action-item'), 'Expected action-item match');
    const match = results.find(r => r.patternName === 'action-item');
    assert.strictEqual(match?.confidence, 'high');
  });

  it('detects Human action required pattern', () => {
    const results = matchTasks('Human action required: Deploy the migration script to production');
    assert.ok(results.some(r => r.patternName === 'human-action'));
  });

  it('detects run-command pattern for backtick commands', () => {
    const results = matchTasks('Run `npm run migrate` to apply database changes.');
    assert.ok(results.some(r => r.patternName === 'run-command'));
    const match = results.find(r => r.patternName === 'run-command');
    assert.strictEqual(match?.confidence, 'medium');
    assert.ok(match?.description.includes('npm run migrate'));
  });

  it('detects restart pattern with medium confidence', () => {
    const results = matchTasks('Restart the gateway service after the deployment.');
    assert.ok(results.some(r => r.patternName === 'restart'));
    const match = results.find(r => r.patternName === 'restart');
    assert.strictEqual(match?.confidence, 'medium');
  });

  it('returns empty array for text with no task patterns', () => {
    const results = matchTasks('The function was implemented successfully. All tests pass.');
    assert.strictEqual(results.length, 0);
  });

  it('handles multiple matches in the same text', () => {
    const text = `
ACTION ITEM: Update environment variables.
Please restart the server before continuing.
Run \`npm test\` to verify changes.
`;
    const results = matchTasks(text);
    assert.ok(results.length >= 2, `Expected 2+ matches, got ${results.length}`);
  });

  it('does not crash on empty string', () => {
    assert.doesNotThrow(() => matchTasks(''));
    assert.strictEqual(matchTasks('').length, 0);
  });
});

// ── parseStructuredTask ──────────────────────────────────────────

describe('patternMatcher.parseStructuredTask', () => {
  it('parses a well-formed CONDUCTOR_TASK block', () => {
    const text = `
[CONDUCTOR_TASK]
description: Restart the gateway service
priority: urgent
blocking: true
[/CONDUCTOR_TASK]
`;
    const result = parseStructuredTask(text);
    assert.ok(result !== null, 'Expected non-null result');
    assert.strictEqual(result?.description, 'Restart the gateway service');
    assert.strictEqual(result?.priority, 'urgent');
    assert.strictEqual(result?.blocking, true);
  });

  it('returns default priority (normal) when priority is missing', () => {
    const text = '[CONDUCTOR_TASK]\ndescription: Do something\n[/CONDUCTOR_TASK]';
    const result = parseStructuredTask(text);
    assert.strictEqual(result?.priority, 'normal');
  });

  it('returns blocking: false by default', () => {
    const text = '[CONDUCTOR_TASK]\ndescription: Non-blocking task\n[/CONDUCTOR_TASK]';
    const result = parseStructuredTask(text);
    assert.strictEqual(result?.blocking, false);
  });

  it('returns null when no CONDUCTOR_TASK block is present', () => {
    assert.strictEqual(parseStructuredTask('No tags here.'), null);
  });

  it('is case-insensitive for the tags', () => {
    const text = '[conductor_task]\ndescription: Test task\n[/conductor_task]';
    const result = parseStructuredTask(text);
    assert.ok(result !== null);
    assert.strictEqual(result?.description, 'Test task');
  });
});

// ── isSimilarDescription ─────────────────────────────────────────

describe('patternMatcher.isSimilarDescription', () => {
  it('returns true for identical strings', () => {
    assert.ok(isSimilarDescription('Restart the gateway', 'Restart the gateway'));
  });

  it('returns true for near-identical strings (>= 90% Dice)', () => {
    assert.ok(isSimilarDescription(
      'Restart the gateway service',
      'Restart the gateway services',
    ));
  });

  it('returns false for completely different strings', () => {
    assert.ok(!isSimilarDescription(
      'Restart the gateway service',
      'Update the environment variables in production',
    ));
  });

  it('is case-insensitive (normalised before comparison)', () => {
    assert.ok(isSimilarDescription(
      'RESTART THE GATEWAY SERVICE',
      'restart the gateway service',
    ));
  });
});

// ── normaliseDescription ─────────────────────────────────────────

describe('patternMatcher.normaliseDescription', () => {
  it('lowercases and strips punctuation', () => {
    const result = normaliseDescription('Restart the Gateway-Service!');
    assert.ok(!result.includes('!'));
    assert.ok(!result.includes('-'));
    assert.ok(result === result.toLowerCase());
  });

  it('collapses multiple spaces', () => {
    const result = normaliseDescription('A   long   gap');
    assert.ok(!result.includes('  '));
  });
});
