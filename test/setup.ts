/**
 * Conductor — Mocha test bootstrap.
 *
 * This file is required by .mocharc.json before any test spec is
 * loaded (via --require).  It patches Node's module loader to
 * intercept `require('vscode')` calls and return our mock so that
 * source modules can be imported in a pure Node environment.
 *
 * Load order guaranteed by Mocha:
 *   1. ts-node/register  (TypeScript compilation hook)
 *   2. test/setup.ts     (this file — registers vscode mock)
 *   3. test/unit/**\/*.test.ts  (specs, after setup)
 */

/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any */

import { vscodeMock } from './helpers/mockVscode';

// Patch Module._load to intercept require('vscode')
const Module = require('module');
const _originalLoad = Module._load.bind(Module);

Module._load = function (request: string, parent: unknown, isMain: boolean): unknown {
  if (request === 'vscode') {
    return vscodeMock;
  }
  return _originalLoad(request, parent, isMain);
};
