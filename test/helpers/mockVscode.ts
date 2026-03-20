/**
 * Conductor — VS Code API mock for unit tests.
 *
 * Provides just enough of the VS Code surface area to satisfy the
 * imports in Conductor's source modules without requiring an actual
 * VS Code host.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export class MockDisposable {
  private _fn: () => void;
  constructor(fn: () => void = () => { /* no-op */ }) {
    this._fn = fn;
  }
  dispose(): void { this._fn(); }
}

export class MockEventEmitter<T = unknown> {
  private _listeners: Array<(e: T) => void> = [];

  /** Subscribes a listener; returns a Disposable that unsubscribes it. */
  event = (listener: (e: T) => void): MockDisposable => {
    this._listeners.push(listener);
    return new MockDisposable(() => {
      const idx = this._listeners.indexOf(listener);
      if (idx >= 0) { this._listeners.splice(idx, 1); }
    });
  };

  fire(e: T): void {
    for (const l of [...this._listeners]) { l(e); }
  }

  dispose(): void { this._listeners = []; }

  /** Test helper: current listener count. */
  get listenerCount(): number { return this._listeners.length; }
}

/** A minimal mock of vscode.workspace.getConfiguration(). */
class MockConfiguration {
  private _store: Record<string, unknown> = {};

  set(key: string, value: unknown): void { this._store[key] = value; }

  get<T>(key: string, defaultValue?: T): T {
    const stored = this._store[key];
    return (stored !== undefined ? stored : defaultValue) as T;
  }

  has(key: string): boolean { return key in this._store; }

  update(_key: string, _value: unknown): Promise<void> { return Promise.resolve(); }
}

const globalConfig = new MockConfiguration();

export const vscodeMock = {
  // ── Core primitives ──────────────────────────────────────────
  EventEmitter: MockEventEmitter,
  Disposable: MockDisposable,

  // ── workspace ────────────────────────────────────────────────
  workspace: {
    workspaceFolders: undefined as undefined,
    getConfiguration: (_section?: string): MockConfiguration => globalConfig,
    onDidChangeWorkspaceFolders: () => new MockDisposable(),
    onDidChangeConfiguration: () => new MockDisposable(),
    findFiles: () => Promise.resolve([]),
  },

  // ── window ───────────────────────────────────────────────────
  window: {
    showInformationMessage: (..._args: unknown[]): Promise<undefined> => Promise.resolve(undefined),
    showWarningMessage: (..._args: unknown[]): Promise<undefined> => Promise.resolve(undefined),
    showErrorMessage: (..._args: unknown[]): Promise<undefined> => Promise.resolve(undefined),
    showInputBox: (): Promise<undefined> => Promise.resolve(undefined),
    createOutputChannel: () => ({
      appendLine: () => { /* no-op */ },
      show: () => { /* no-op */ },
      dispose: () => { /* no-op */ },
    }),
    createTerminal: (_name: string) => ({
      sendText: () => { /* no-op */ },
      show: () => { /* no-op */ },
      dispose: () => { /* no-op */ },
    }),
    createWebviewPanel: () => ({
      webview: {
        html: '',
        onDidReceiveMessage: () => new MockDisposable(),
        postMessage: () => Promise.resolve(false),
      },
      onDidChangeViewState: () => new MockDisposable(),
      onDidDispose: () => new MockDisposable(),
      reveal: () => { /* no-op */ },
      dispose: () => { /* no-op */ },
    }),
    registerTreeDataProvider: () => new MockDisposable(),
    createTreeView: () => ({
      onDidChangeSelection: () => new MockDisposable(),
      onDidExpandElement: () => new MockDisposable(),
      onDidCollapseElement: () => new MockDisposable(),
      badge: undefined,
      dispose: () => { /* no-op */ },
    }),
    registerWebviewViewProvider: () => new MockDisposable(),
    tabGroups: { all: [] },
  },

  // ── commands ─────────────────────────────────────────────────
  commands: {
    registerCommand: (_id: string, _handler: (...args: unknown[]) => unknown) => new MockDisposable(),
    executeCommand: (_id: string, ..._args: unknown[]) => Promise.resolve(undefined),
  },

  // ── Uri ──────────────────────────────────────────────────────
  Uri: {
    file: (p: string) => ({ fsPath: p, path: p, scheme: 'file', toString: () => p }),
    parse: (s: string) => ({ fsPath: s, path: s, scheme: 'file', toString: () => s }),
  },

  // ── TreeItem ─────────────────────────────────────────────────
  TreeItem: class TreeItem {
    label: string;
    collapsibleState: number;
    constructor(label: string, collapsibleState = 0) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },

  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },

  ThemeIcon: class ThemeIcon {
    id: string;
    constructor(id: string) { this.id = id; }
  },

  // ── extensions ───────────────────────────────────────────────
  extensions: {
    getExtension: (_id: string) => undefined,
  },

  // ── env ──────────────────────────────────────────────────────
  env: {
    clipboard: { readText: () => Promise.resolve(''), writeText: () => Promise.resolve() },
  },

  // ── globalConfig access for tests ────────────────────────────
  _config: globalConfig,
};

export type VscodeMock = typeof vscodeMock;
