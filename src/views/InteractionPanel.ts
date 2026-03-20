/**
 * Conductor — InteractionPanel (WebviewPanel).
 *
 * The inline session interaction surface.  A tabbed WebviewPanel that
 * shows session output, accepts follow-up prompts, and presents
 * inline approve/deny buttons when a session is waiting.
 *
 * PRD v1.1 §4g, Implementation Plan §8 Task 5.3
 */

import * as vscode from 'vscode';
import * as path from 'path';
import type { InteractionManager } from '../core/InteractionManager';
import type { SessionManager } from '../core/SessionManager';
import type { ApprovalEngine } from '../core/ApprovalEngine';
import type { SessionOutputEvent, ConductorSession } from '../types';
import { CommandId, ConfigKey } from '../constants';

// ── Types ────────────────────────────────────────────────────────

interface TabState {
  sessionId: string;
  name: string;
  pinned: boolean;
  outputSub: vscode.Disposable | null;
}

type WebviewMessage =
  | { command: 'sendMessage'; sessionId: string; message: string }
  | { command: 'approve'; approvalId: string }
  | { command: 'deny'; approvalId: string }
  | { command: 'switchTab'; sessionId: string }
  | { command: 'closeTab'; sessionId: string }
  | { command: 'pinTab'; sessionId: string }
  | { command: 'unpinTab'; sessionId: string }
  | { command: 'loadMore'; sessionId: string; before: string }
  | { command: 'killSession'; sessionId: string }
  | { command: 'restartSession'; sessionId: string }
  | { command: 'copyPrompt'; sessionId: string }
  | { command: 'ready' };

// ── InteractionPanel ────────────────────────────────────────────

export class InteractionPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | null = null;
  private tabs = new Map<string, TabState>();
  private activeTabId: string | null = null;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly interactionManager: InteractionManager,
    private readonly sessionManager: SessionManager,
    private readonly approvalEngine: ApprovalEngine,
  ) {
    // Listen for session events to update tab state
    this.disposables.push(
      sessionManager.onSessionEvent((event) => {
        if (!this.panel) { return; }
        const tab = this.tabs.get(event.sessionId);
        if (!tab) { return; }

        // Update tab name if session name changed
        tab.name = event.session.name;

        // Post status update to webview
        this.postMessage({
          type: 'sessionStateChanged',
          sessionId: event.sessionId,
          status: event.session.status,
          name: event.session.name,
        });
      }),
    );
  }

  // ── Public API ───────────────────────────────────────────────

  /**
   * Open a session in the interaction panel.
   * Creates the WebviewPanel if it doesn't exist, then switches
   * to the session's tab.
   */
  async openSession(sessionId: string): Promise<void> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) { return; }

    this.ensurePanel();

    if (!this.tabs.has(sessionId)) {
      this.addTab(session);
    }

    this.switchToTab(sessionId);

    // Load initial history
    await this.loadHistory(sessionId);
  }

  /**
   * Send a quick reply to a session without opening the full panel.
   */
  async quickReply(sessionId: string, message: string): Promise<void> {
    await this.interactionManager.sendMessage(sessionId, message);
  }

  /**
   * Check if the panel is currently visible.
   */
  isVisible(): boolean {
    return this.panel?.visible ?? false;
  }

  // ── Panel lifecycle ──────────────────────────────────────────

  private ensurePanel(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    const column = this.resolveViewColumn();

    this.panel = vscode.window.createWebviewPanel(
      'conductor.interaction',
      'Conductor: Sessions',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.file(path.join(this.context.extensionPath, 'webviews', 'interaction')),
          vscode.Uri.file(path.join(this.context.extensionPath, 'media')),
        ],
      },
    );

    this.panel.iconPath = vscode.Uri.file(
      path.join(this.context.extensionPath, 'media', 'conductor-icon.svg'),
    );

    this.panel.webview.html = this.getWebviewHtml(this.panel.webview);

    // Handle messages from the webview
    this.panel.webview.onDidReceiveMessage(
      (msg: WebviewMessage) => this.handleWebviewMessage(msg),
      undefined,
      this.disposables,
    );

    this.panel.onDidDispose(() => {
      // Clean up all tab subscriptions
      for (const [, tab] of this.tabs) {
        tab.outputSub?.dispose();
        this.interactionManager.closeSession(tab.sessionId);
      }
      this.tabs.clear();
      this.activeTabId = null;
      this.panel = null;
    });

    this.panel.onDidChangeViewState(() => {
      if (this.panel?.visible && this.activeTabId) {
        this.interactionManager.setActiveSession(this.activeTabId);
      }
    });
  }

  private resolveViewColumn(): vscode.ViewColumn {
    const target = vscode.workspace
      .getConfiguration()
      .get<string>(ConfigKey.InteractionDefaultTarget, 'editor');

    if (target === 'bottom') {
      // VS Code doesn't directly support opening a WebviewPanel in the bottom panel,
      // but ViewColumn.Active is the closest approximation.
      return vscode.ViewColumn.Active;
    }
    return vscode.ViewColumn.Two;
  }

  // ── Tab management ───────────────────────────────────────────

  private addTab(session: ConductorSession): void {
    const tab: TabState = {
      sessionId: session.id,
      name: session.name,
      pinned: false,
      outputSub: null,
    };

    this.tabs.set(session.id, tab);
    this.interactionManager.openSession(session.id);

    // Subscribe to output events
    tab.outputSub = this.interactionManager.subscribeToOutput(
      session.id,
      (event: SessionOutputEvent) => {
        this.postMessage({
          type: 'outputEvent',
          sessionId: session.id,
          event,
        });
      },
    );

    // Notify webview of new tab
    this.postMessage({
      type: 'tabAdded',
      sessionId: session.id,
      name: session.name,
      status: session.status,
    });
  }

  private removeTab(sessionId: string): void {
    const tab = this.tabs.get(sessionId);
    if (!tab) { return; }

    tab.outputSub?.dispose();
    this.interactionManager.closeSession(sessionId);
    this.tabs.delete(sessionId);

    // If we closed the active tab, switch to another
    if (this.activeTabId === sessionId) {
      const remaining = [...this.tabs.keys()];
      if (remaining.length > 0) {
        this.switchToTab(remaining[remaining.length - 1]);
      } else {
        this.activeTabId = null;
      }
    }

    this.postMessage({ type: 'tabRemoved', sessionId });
  }

  private switchToTab(sessionId: string): void {
    this.activeTabId = sessionId;
    this.interactionManager.setActiveSession(sessionId);

    const session = this.sessionManager.getSession(sessionId);
    const approvals = session
      ? this.approvalEngine.getPendingApprovals().filter(a => a.sessionId === session.id)
      : [];

    this.postMessage({
      type: 'switchTab',
      sessionId,
      approvals: approvals.map(a => ({
        id: a.id,
        tool: a.tool,
        command: a.command,
        context: a.context,
      })),
    });
  }

  // ── History loading ──────────────────────────────────────────

  private async loadHistory(sessionId: string): Promise<void> {
    try {
      const events = await this.interactionManager.getHistory(sessionId, 50);
      this.postMessage({
        type: 'historyLoaded',
        sessionId,
        events,
      });
    } catch {
      // History load failure is non-fatal
    }
  }

  // ── Webview message handling ─────────────────────────────────

  private async handleWebviewMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.command) {
      case 'ready':
        // Webview is ready — send current state
        this.sendFullState();
        break;

      case 'sendMessage':
        try {
          await this.interactionManager.sendMessage(msg.sessionId, msg.message);
          this.postMessage({
            type: 'messageSent',
            sessionId: msg.sessionId,
          });
        } catch (err) {
          this.postMessage({
            type: 'error',
            message: `Failed to send message: ${err}`,
          });
        }
        break;

      case 'approve':
        try {
          await this.approvalEngine.approveAction(msg.approvalId);
          this.postMessage({ type: 'approvalResolved', approvalId: msg.approvalId });
        } catch (err) {
          this.postMessage({ type: 'error', message: `Approval failed: ${err}` });
        }
        break;

      case 'deny':
        try {
          await this.approvalEngine.denyAction(msg.approvalId);
          this.postMessage({ type: 'approvalResolved', approvalId: msg.approvalId });
        } catch (err) {
          this.postMessage({ type: 'error', message: `Deny failed: ${err}` });
        }
        break;

      case 'switchTab':
        this.switchToTab(msg.sessionId);
        break;

      case 'closeTab':
        this.removeTab(msg.sessionId);
        break;

      case 'pinTab':
        this.setTabPinned(msg.sessionId, true);
        break;

      case 'unpinTab':
        this.setTabPinned(msg.sessionId, false);
        break;

      case 'loadMore':
        await this.loadMoreHistory(msg.sessionId, msg.before);
        break;

      case 'killSession':
        vscode.commands.executeCommand(CommandId.KillSession, msg.sessionId);
        break;

      case 'restartSession':
        vscode.commands.executeCommand(CommandId.RestartSession, msg.sessionId);
        break;

      case 'copyPrompt': {
        const session = this.sessionManager.getSession(msg.sessionId);
        if (session) {
          await vscode.env.clipboard.writeText(session.prompt);
          vscode.window.showInformationMessage('Prompt copied to clipboard');
        }
        break;
      }
    }
  }

  private setTabPinned(sessionId: string, pinned: boolean): void {
    const tab = this.tabs.get(sessionId);
    if (tab) {
      tab.pinned = pinned;
      this.postMessage({ type: 'tabPinned', sessionId, pinned });
    }
  }

  private async loadMoreHistory(sessionId: string, _before: string): Promise<void> {
    try {
      const events = await this.interactionManager.getHistory(sessionId, 100);
      this.postMessage({
        type: 'moreHistoryLoaded',
        sessionId,
        events,
      });
    } catch {
      // Non-fatal
    }
  }

  private sendFullState(): void {
    const tabList = [...this.tabs.entries()].map(([id, tab]) => {
      const session = this.sessionManager.getSession(id);
      return {
        sessionId: id,
        name: tab.name,
        pinned: tab.pinned,
        status: session?.status ?? 'complete',
      };
    });

    this.postMessage({
      type: 'fullState',
      tabs: tabList,
      activeTabId: this.activeTabId,
    });
  }

  // ── Messaging helper ─────────────────────────────────────────

  private postMessage(msg: Record<string, unknown>): void {
    this.panel?.webview.postMessage(msg);
  }

  // ── Webview HTML ─────────────────────────────────────────────

  private getWebviewHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const cspSource = webview.cspSource;

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}'; font-src ${cspSource};">
  <title>Conductor Sessions</title>
  <style nonce="${nonce}">
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --border: var(--vscode-panel-border, #444);
      --input-bg: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
      --input-border: var(--vscode-input-border, #555);
      --button-bg: var(--vscode-button-background);
      --button-fg: var(--vscode-button-foreground);
      --button-hover: var(--vscode-button-hoverBackground);
      --badge-bg: var(--vscode-badge-background);
      --badge-fg: var(--vscode-badge-foreground);
      --error-fg: var(--vscode-errorForeground, #f44);
      --success-fg: var(--vscode-terminal-ansiGreen, #4c4);
      --warning-fg: var(--vscode-editorWarning-foreground, #fa0);
      --tab-active-bg: var(--vscode-tab-activeBackground, var(--bg));
      --tab-inactive-bg: var(--vscode-tab-inactiveBackground, transparent);
      --tab-hover-bg: var(--vscode-tab-hoverBackground, rgba(255,255,255,0.05));
      --code-bg: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.2));
      --scrollbar-bg: var(--vscode-scrollbarSlider-background);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-font-family, system-ui);
      font-size: var(--vscode-font-size, 13px);
      color: var(--fg);
      background: var(--bg);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    /* ── Tab bar ──────────────────────────── */
    .tab-bar {
      display: flex;
      align-items: center;
      border-bottom: 1px solid var(--border);
      background: var(--tab-inactive-bg);
      overflow-x: auto;
      flex-shrink: 0;
      height: 35px;
    }
    .tab-bar::-webkit-scrollbar { height: 3px; }
    .tab-bar::-webkit-scrollbar-thumb { background: var(--scrollbar-bg); }

    .tab {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 0 12px;
      height: 100%;
      cursor: pointer;
      white-space: nowrap;
      font-size: 12px;
      border-right: 1px solid var(--border);
      user-select: none;
      opacity: 0.7;
      transition: opacity 0.15s, background 0.15s;
    }
    .tab:hover { background: var(--tab-hover-bg); opacity: 0.9; }
    .tab.active { background: var(--tab-active-bg); opacity: 1; }
    .tab .pin { font-size: 10px; opacity: 0.5; }
    .tab .close-btn {
      font-size: 14px;
      opacity: 0.4;
      cursor: pointer;
      margin-left: 4px;
    }
    .tab .close-btn:hover { opacity: 1; }
    .tab .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .status-dot.running { background: var(--success-fg); }
    .status-dot.waiting { background: var(--warning-fg); }
    .status-dot.error { background: var(--error-fg); }
    .status-dot.complete { background: #888; }
    .status-dot.queued { background: #6af; }
    .status-dot.blocked { background: #fa0; }

    /* ── Header bar ──────────────────────── */
    .header-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 12px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    .header-bar .session-info {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 600;
    }
    .header-bar .controls {
      display: flex;
      gap: 6px;
    }
    .header-bar .controls button {
      background: none;
      border: 1px solid var(--border);
      color: var(--fg);
      padding: 2px 8px;
      border-radius: 3px;
      cursor: pointer;
      font-size: 11px;
    }
    .header-bar .controls button:hover {
      background: var(--tab-hover-bg);
    }

    /* ── Output stream ───────────────────── */
    .output-container {
      flex: 1;
      overflow-y: auto;
      padding: 8px 12px;
      scroll-behavior: smooth;
    }
    .output-container::-webkit-scrollbar { width: 8px; }
    .output-container::-webkit-scrollbar-thumb {
      background: var(--scrollbar-bg);
      border-radius: 4px;
    }

    .load-more {
      text-align: center;
      padding: 8px;
      opacity: 0.6;
      cursor: pointer;
      font-size: 12px;
    }
    .load-more:hover { opacity: 1; }

    .output-entry {
      margin-bottom: 8px;
      padding: 6px 8px;
      border-radius: 4px;
      font-size: 13px;
      line-height: 1.5;
      word-wrap: break-word;
      overflow-wrap: break-word;
    }
    .output-entry.assistant {
      background: rgba(100, 180, 255, 0.06);
      border-left: 3px solid rgba(100, 180, 255, 0.3);
    }
    .output-entry.tool_use {
      background: rgba(200, 180, 100, 0.06);
      border-left: 3px solid rgba(200, 180, 100, 0.3);
    }
    .output-entry.tool_result {
      background: rgba(100, 200, 100, 0.06);
      border-left: 3px solid rgba(100, 200, 100, 0.3);
    }
    .output-entry.error {
      background: rgba(255, 80, 80, 0.08);
      border-left: 3px solid rgba(255, 80, 80, 0.4);
      color: var(--error-fg);
    }
    .output-entry.system {
      background: rgba(128, 128, 128, 0.06);
      border-left: 3px solid rgba(128, 128, 128, 0.3);
      opacity: 0.7;
      font-style: italic;
    }

    .output-entry .entry-header {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 4px;
      font-size: 11px;
      opacity: 0.6;
    }
    .output-entry .entry-type {
      font-weight: 600;
      text-transform: uppercase;
      font-size: 10px;
    }

    .output-entry pre {
      background: var(--code-bg);
      padding: 8px;
      border-radius: 4px;
      overflow-x: auto;
      font-family: var(--vscode-editor-font-family, 'Menlo', monospace);
      font-size: 12px;
      line-height: 1.4;
      margin: 4px 0;
    }
    .output-entry code {
      font-family: var(--vscode-editor-font-family, 'Menlo', monospace);
      font-size: 12px;
      background: var(--code-bg);
      padding: 1px 4px;
      border-radius: 3px;
    }

    .collapsible-header {
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .collapsible-header .arrow { font-size: 10px; transition: transform 0.15s; }
    .collapsible-header .arrow.open { transform: rotate(90deg); }
    .collapsible-body { display: none; margin-top: 4px; }
    .collapsible-body.open { display: block; }

    /* ── Jump to latest ──────────────────── */
    .jump-to-latest {
      position: absolute;
      bottom: 80px;
      left: 50%;
      transform: translateX(-50%);
      background: var(--button-bg);
      color: var(--button-fg);
      border: none;
      border-radius: 12px;
      padding: 4px 14px;
      font-size: 11px;
      cursor: pointer;
      display: none;
      z-index: 10;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    }
    .jump-to-latest.visible { display: block; }
    .jump-to-latest:hover { background: var(--button-hover); }

    /* ── Approval bar ────────────────────── */
    .approval-bar {
      display: none;
      padding: 8px 12px;
      border-top: 2px solid var(--warning-fg);
      background: rgba(255, 170, 0, 0.06);
      flex-shrink: 0;
    }
    .approval-bar.visible { display: block; }
    .approval-bar .approval-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 0;
      gap: 8px;
    }
    .approval-bar .approval-info {
      flex: 1;
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .approval-bar .approval-tool { font-weight: 600; }
    .approval-bar .approval-actions {
      display: flex;
      gap: 6px;
      flex-shrink: 0;
    }
    .approval-bar .btn-approve {
      background: var(--success-fg);
      color: #000;
      border: none;
      padding: 3px 12px;
      border-radius: 3px;
      cursor: pointer;
      font-size: 11px;
      font-weight: 600;
    }
    .approval-bar .btn-deny {
      background: transparent;
      color: var(--error-fg);
      border: 1px solid var(--error-fg);
      padding: 3px 12px;
      border-radius: 3px;
      cursor: pointer;
      font-size: 11px;
    }

    /* ── Input area ──────────────────────── */
    .input-area {
      display: flex;
      align-items: flex-end;
      gap: 8px;
      padding: 8px 12px;
      border-top: 1px solid var(--border);
      flex-shrink: 0;
    }
    .input-area textarea {
      flex: 1;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border);
      border-radius: 4px;
      padding: 6px 8px;
      font-family: var(--vscode-font-family, system-ui);
      font-size: 13px;
      resize: none;
      min-height: 32px;
      max-height: 120px;
      line-height: 1.4;
    }
    .input-area textarea:focus { outline: 1px solid var(--button-bg); }
    .input-area button {
      background: var(--button-bg);
      color: var(--button-fg);
      border: none;
      border-radius: 4px;
      padding: 6px 14px;
      cursor: pointer;
      font-size: 12px;
      white-space: nowrap;
    }
    .input-area button:hover { background: var(--button-hover); }
    .input-area button:disabled { opacity: 0.5; cursor: not-allowed; }

    .queued-indicator {
      font-size: 11px;
      color: var(--warning-fg);
      padding: 0 12px 4px;
      display: none;
    }
    .queued-indicator.visible { display: block; }

    /* ── Empty state ─────────────────────── */
    .empty-state {
      display: flex;
      align-items: center;
      justify-content: center;
      flex: 1;
      opacity: 0.4;
      font-size: 14px;
      text-align: center;
      padding: 40px;
    }

    /* ── Session ended overlay ────────────── */
    .session-ended {
      padding: 6px 12px;
      text-align: center;
      font-size: 12px;
      opacity: 0.6;
      border-top: 1px solid var(--border);
      flex-shrink: 0;
      display: none;
    }
    .session-ended.visible { display: block; }
  </style>
</head>
<body>
  <div class="tab-bar" id="tabBar"></div>

  <div class="header-bar" id="headerBar" style="display:none">
    <div class="session-info">
      <span class="status-dot" id="headerStatus"></span>
      <span id="headerName">—</span>
    </div>
    <div class="controls">
      <button onclick="copyPrompt()" title="Copy prompt">Copy Prompt</button>
      <button onclick="killSession()" title="Kill session">Kill</button>
      <button onclick="restartSession()" title="Restart session">Restart</button>
    </div>
  </div>

  <div class="empty-state" id="emptyState">
    Click a session in the status board to open it here.
  </div>

  <div class="output-container" id="outputContainer" style="display:none">
    <div class="load-more" id="loadMore" onclick="loadMoreHistory()">Load earlier messages...</div>
  </div>

  <button class="jump-to-latest" id="jumpToLatest" onclick="jumpToLatest()">Jump to latest</button>

  <div class="approval-bar" id="approvalBar"></div>

  <div class="queued-indicator" id="queuedIndicator">Message queued — session is mid-execution</div>

  <div class="session-ended" id="sessionEnded">Session ended</div>

  <div class="input-area" id="inputArea" style="display:none">
    <textarea id="messageInput" placeholder="Send a message..." rows="1"></textarea>
    <button id="sendBtn" onclick="sendMessage()">Send</button>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let activeSessionId = null;
    let tabs = {};
    let sessionOutputs = {}; // sessionId → output entries
    let autoScroll = true;
    let sessionStatuses = {};

    // ── Init ───────────────────────────────────────
    vscode.postMessage({ command: 'ready' });

    // ── Message handler ────────────────────────────
    window.addEventListener('message', (e) => {
      const msg = e.data;
      switch (msg.type) {
        case 'fullState':
          handleFullState(msg);
          break;
        case 'tabAdded':
          addTab(msg.sessionId, msg.name, msg.status);
          break;
        case 'tabRemoved':
          removeTab(msg.sessionId);
          break;
        case 'switchTab':
          switchTab(msg.sessionId, msg.approvals);
          break;
        case 'tabPinned':
          updateTabPin(msg.sessionId, msg.pinned);
          break;
        case 'historyLoaded':
          loadHistory(msg.sessionId, msg.events);
          break;
        case 'moreHistoryLoaded':
          prependHistory(msg.sessionId, msg.events);
          break;
        case 'outputEvent':
          appendOutput(msg.sessionId, msg.event);
          break;
        case 'sessionStateChanged':
          updateSessionState(msg.sessionId, msg.status, msg.name);
          break;
        case 'messageSent':
          onMessageSent(msg.sessionId);
          break;
        case 'approvalResolved':
          removeApproval(msg.approvalId);
          break;
        case 'error':
          showError(msg.message);
          break;
      }
    });

    // ── Full state ─────────────────────────────────
    function handleFullState(msg) {
      for (const tab of msg.tabs) {
        addTab(tab.sessionId, tab.name, tab.status);
      }
      if (msg.activeTabId) {
        switchTab(msg.activeTabId, []);
      }
    }

    // ── Tab management ─────────────────────────────
    function addTab(sessionId, name, status) {
      tabs[sessionId] = { name, status, pinned: false };
      sessionStatuses[sessionId] = status;
      if (!sessionOutputs[sessionId]) {
        sessionOutputs[sessionId] = [];
      }
      renderTabs();
    }

    function removeTab(sessionId) {
      delete tabs[sessionId];
      delete sessionOutputs[sessionId];
      delete sessionStatuses[sessionId];
      renderTabs();
      if (activeSessionId === sessionId) {
        activeSessionId = null;
        showEmptyState();
      }
    }

    function switchTab(sessionId, approvals) {
      activeSessionId = sessionId;
      renderTabs();
      renderOutput(sessionId);
      renderApprovals(approvals || []);
      updateHeader(sessionId);
      showActiveState();
      scrollToBottom();
    }

    function updateTabPin(sessionId, pinned) {
      if (tabs[sessionId]) {
        tabs[sessionId].pinned = pinned;
        renderTabs();
      }
    }

    function renderTabs() {
      const bar = document.getElementById('tabBar');
      bar.innerHTML = '';
      // Sort: pinned first, then by insertion order
      const entries = Object.entries(tabs);
      entries.sort((a, b) => (b[1].pinned ? 1 : 0) - (a[1].pinned ? 1 : 0));

      for (const [id, tab] of entries) {
        const el = document.createElement('div');
        el.className = 'tab' + (id === activeSessionId ? ' active' : '');
        el.innerHTML =
          '<span class="status-dot ' + (sessionStatuses[id] || 'running') + '"></span>' +
          (tab.pinned ? '<span class="pin">&#128204;</span>' : '') +
          '<span class="tab-name">' + escapeHtml(tab.name.slice(0, 30)) + '</span>' +
          '<span class="close-btn" data-close="' + id + '">&times;</span>';
        el.addEventListener('click', (e) => {
          if (e.target.dataset.close) {
            vscode.postMessage({ command: 'closeTab', sessionId: e.target.dataset.close });
            return;
          }
          vscode.postMessage({ command: 'switchTab', sessionId: id });
        });
        el.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          const pinned = tabs[id]?.pinned;
          vscode.postMessage({
            command: pinned ? 'unpinTab' : 'pinTab',
            sessionId: id,
          });
        });
        bar.appendChild(el);
      }
    }

    // ── Header ─────────────────────────────────────
    function updateHeader(sessionId) {
      const tab = tabs[sessionId];
      if (!tab) return;
      document.getElementById('headerName').textContent = tab.name;
      const dot = document.getElementById('headerStatus');
      dot.className = 'status-dot ' + (sessionStatuses[sessionId] || 'running');

      // Show/hide input based on session status
      const status = sessionStatuses[sessionId];
      const ended = status === 'complete' || status === 'error';
      document.getElementById('inputArea').style.display = ended ? 'none' : 'flex';
      document.getElementById('sessionEnded').classList.toggle('visible', ended);
    }

    // ── Output rendering ───────────────────────────
    function loadHistory(sessionId, events) {
      sessionOutputs[sessionId] = events || [];
      if (sessionId === activeSessionId) {
        renderOutput(sessionId);
        scrollToBottom();
      }
    }

    function prependHistory(sessionId, events) {
      if (!events || events.length === 0) return;
      const existing = sessionOutputs[sessionId] || [];
      // Deduplicate by timestamp
      const existingTs = new Set(existing.map(e => e.timestamp));
      const newEvents = events.filter(e => !existingTs.has(e.timestamp));
      sessionOutputs[sessionId] = [...newEvents, ...existing];
      if (sessionId === activeSessionId) {
        renderOutput(sessionId);
      }
    }

    function appendOutput(sessionId, event) {
      if (!sessionOutputs[sessionId]) {
        sessionOutputs[sessionId] = [];
      }
      sessionOutputs[sessionId].push(event);
      // Cap at 500 entries
      if (sessionOutputs[sessionId].length > 500) {
        sessionOutputs[sessionId] = sessionOutputs[sessionId].slice(-500);
      }
      if (sessionId === activeSessionId) {
        appendOutputEntry(event);
        if (autoScroll) scrollToBottom();
      }
    }

    function renderOutput(sessionId) {
      const container = document.getElementById('outputContainer');
      // Remove all entries but keep the load-more button
      const entries = container.querySelectorAll('.output-entry');
      entries.forEach(e => e.remove());

      const events = sessionOutputs[sessionId] || [];
      for (const event of events) {
        container.appendChild(createOutputEntry(event));
      }
    }

    function appendOutputEntry(event) {
      const container = document.getElementById('outputContainer');
      container.appendChild(createOutputEntry(event));
    }

    function createOutputEntry(event) {
      const div = document.createElement('div');
      div.className = 'output-entry ' + event.type;

      const header = document.createElement('div');
      header.className = 'entry-header';

      const typeSpan = document.createElement('span');
      typeSpan.className = 'entry-type';
      typeSpan.textContent = formatEntryType(event);
      header.appendChild(typeSpan);

      const timeSpan = document.createElement('span');
      timeSpan.textContent = formatTime(event.timestamp);
      header.appendChild(timeSpan);

      div.appendChild(header);

      // Content
      if (event.type === 'tool_use' || event.type === 'tool_result') {
        // Collapsible
        const colHeader = document.createElement('div');
        colHeader.className = 'collapsible-header';
        const arrow = document.createElement('span');
        arrow.className = 'arrow';
        arrow.textContent = '\\u25B6';
        colHeader.appendChild(arrow);
        const summary = document.createElement('span');
        summary.textContent = event.metadata?.toolName
          ? event.metadata.toolName + (event.metadata.command ? ': ' + event.metadata.command.slice(0, 80) : '')
          : event.content.slice(0, 100);
        colHeader.appendChild(summary);

        const colBody = document.createElement('div');
        colBody.className = 'collapsible-body';
        colBody.appendChild(renderContent(event.content));

        colHeader.addEventListener('click', () => {
          arrow.classList.toggle('open');
          colBody.classList.toggle('open');
        });

        div.appendChild(colHeader);
        div.appendChild(colBody);
      } else {
        div.appendChild(renderContent(event.content));
      }

      return div;
    }

    function renderContent(text) {
      const container = document.createElement('div');
      // Simple code block detection and rendering
      const parts = text.split(/(\\x60\\x60\\x60[\\s\\S]*?\\x60\\x60\\x60)/g);

      // Use a simpler approach: split on triple backtick patterns
      const codeBlockRe = /\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g;
      let lastIndex = 0;
      let match;
      let hasCodeBlocks = false;

      const safeText = text;
      while ((match = codeBlockRe.exec(safeText)) !== null) {
        hasCodeBlocks = true;
        // Text before code block
        if (match.index > lastIndex) {
          const textNode = document.createElement('span');
          textNode.textContent = safeText.slice(lastIndex, match.index);
          container.appendChild(textNode);
        }
        // Code block
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = match[2];
        pre.appendChild(code);
        container.appendChild(pre);
        lastIndex = match.index + match[0].length;
      }

      if (hasCodeBlocks && lastIndex < safeText.length) {
        const textNode = document.createElement('span');
        textNode.textContent = safeText.slice(lastIndex);
        container.appendChild(textNode);
      }

      if (!hasCodeBlocks) {
        // Check for inline code
        const inlineRe = /\`([^\`]+)\`/g;
        let inlineLastIdx = 0;
        let inlineMatch;
        let hasInline = false;
        while ((inlineMatch = inlineRe.exec(text)) !== null) {
          hasInline = true;
          if (inlineMatch.index > inlineLastIdx) {
            container.appendChild(
              document.createTextNode(text.slice(inlineLastIdx, inlineMatch.index))
            );
          }
          const code = document.createElement('code');
          code.textContent = inlineMatch[1];
          container.appendChild(code);
          inlineLastIdx = inlineMatch.index + inlineMatch[0].length;
        }
        if (hasInline && inlineLastIdx < text.length) {
          container.appendChild(document.createTextNode(text.slice(inlineLastIdx)));
        }
        if (!hasInline) {
          container.textContent = text;
        }
      }

      return container;
    }

    function formatEntryType(event) {
      if (event.type === 'tool_use') return 'TOOL';
      if (event.type === 'tool_result') return 'RESULT';
      return event.type.toUpperCase();
    }

    function formatTime(ts) {
      try {
        const d = new Date(ts);
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      } catch { return ''; }
    }

    // ── Approvals ──────────────────────────────────
    function renderApprovals(approvals) {
      const bar = document.getElementById('approvalBar');
      bar.innerHTML = '';
      if (!approvals || approvals.length === 0) {
        bar.classList.remove('visible');
        return;
      }
      bar.classList.add('visible');
      for (const a of approvals) {
        const item = document.createElement('div');
        item.className = 'approval-item';
        item.dataset.approvalId = a.id;
        item.innerHTML =
          '<div class="approval-info">' +
            '<span class="approval-tool">' + escapeHtml(a.tool) + '</span> ' +
            escapeHtml(a.command.slice(0, 80)) +
          '</div>' +
          '<div class="approval-actions">' +
            '<button class="btn-approve" onclick="approve(\\'' + a.id + '\\')">Approve</button>' +
            '<button class="btn-deny" onclick="deny(\\'' + a.id + '\\')">Deny</button>' +
          '</div>';
        bar.appendChild(item);
      }
    }

    function removeApproval(approvalId) {
      const item = document.querySelector('[data-approval-id="' + approvalId + '"]');
      if (item) item.remove();
      const bar = document.getElementById('approvalBar');
      if (bar.children.length === 0) {
        bar.classList.remove('visible');
      }
    }

    function approve(approvalId) {
      vscode.postMessage({ command: 'approve', approvalId });
    }

    function deny(approvalId) {
      vscode.postMessage({ command: 'deny', approvalId });
    }

    // ── Session state ──────────────────────────────
    function updateSessionState(sessionId, status, name) {
      sessionStatuses[sessionId] = status;
      if (tabs[sessionId]) {
        tabs[sessionId].status = status;
        if (name) tabs[sessionId].name = name;
      }
      renderTabs();
      if (sessionId === activeSessionId) {
        updateHeader(sessionId);
      }
    }

    // ── Auto-scroll ────────────────────────────────
    const outputContainer = document.getElementById('outputContainer');
    outputContainer.addEventListener('scroll', () => {
      const atBottom = outputContainer.scrollHeight - outputContainer.scrollTop - outputContainer.clientHeight < 50;
      autoScroll = atBottom;
      document.getElementById('jumpToLatest').classList.toggle('visible', !atBottom);
    });

    function scrollToBottom() {
      requestAnimationFrame(() => {
        outputContainer.scrollTop = outputContainer.scrollHeight;
      });
    }

    function jumpToLatest() {
      autoScroll = true;
      scrollToBottom();
      document.getElementById('jumpToLatest').classList.remove('visible');
    }

    // ── Load more ──────────────────────────────────
    function loadMoreHistory() {
      if (!activeSessionId) return;
      const events = sessionOutputs[activeSessionId];
      const before = events && events.length > 0 ? events[0].timestamp : '';
      vscode.postMessage({ command: 'loadMore', sessionId: activeSessionId, before });
    }

    // ── Input ──────────────────────────────────────
    const messageInput = document.getElementById('messageInput');
    messageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    // Auto-resize textarea
    messageInput.addEventListener('input', () => {
      messageInput.style.height = 'auto';
      messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
    });

    function sendMessage() {
      const msg = messageInput.value.trim();
      if (!msg || !activeSessionId) return;
      const status = sessionStatuses[activeSessionId];
      vscode.postMessage({ command: 'sendMessage', sessionId: activeSessionId, message: msg });
      messageInput.value = '';
      messageInput.style.height = 'auto';

      // Show queued indicator if session is running (mid-execution)
      if (status === 'running') {
        document.getElementById('queuedIndicator').classList.add('visible');
        setTimeout(() => {
          document.getElementById('queuedIndicator').classList.remove('visible');
        }, 3000);
      }
    }

    function onMessageSent(sessionId) {
      // Visual feedback
      document.getElementById('queuedIndicator').classList.remove('visible');
    }

    // ── Session controls ───────────────────────────
    function killSession() {
      if (activeSessionId) {
        vscode.postMessage({ command: 'killSession', sessionId: activeSessionId });
      }
    }
    function restartSession() {
      if (activeSessionId) {
        vscode.postMessage({ command: 'restartSession', sessionId: activeSessionId });
      }
    }
    function copyPrompt() {
      if (activeSessionId) {
        vscode.postMessage({ command: 'copyPrompt', sessionId: activeSessionId });
      }
    }

    // ── UI state ───────────────────────────────────
    function showEmptyState() {
      document.getElementById('emptyState').style.display = 'flex';
      document.getElementById('outputContainer').style.display = 'none';
      document.getElementById('headerBar').style.display = 'none';
      document.getElementById('inputArea').style.display = 'none';
      document.getElementById('approvalBar').classList.remove('visible');
      document.getElementById('sessionEnded').classList.remove('visible');
    }

    function showActiveState() {
      document.getElementById('emptyState').style.display = 'none';
      document.getElementById('outputContainer').style.display = 'block';
      document.getElementById('headerBar').style.display = 'flex';
    }

    function showError(message) {
      // Show a brief error toast
      const div = document.createElement('div');
      div.className = 'output-entry error';
      div.textContent = message;
      document.getElementById('outputContainer').appendChild(div);
      scrollToBottom();
    }

    // ── Helpers ─────────────────────────────────────
    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
  </script>
</body>
</html>`;
  }

  // ── Register commands ────────────────────────────────────────

  registerCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.commands.registerCommand(
        CommandId.OpenInteraction,
        (sessionId?: string) => {
          if (sessionId) {
            this.openSession(sessionId);
          }
        },
      ),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand(
        CommandId.SendMessage,
        async (sessionId?: string) => {
          if (!sessionId) { return; }
          const message = await vscode.window.showInputBox({
            prompt: 'Send message to session',
            placeHolder: 'Type your message...',
          });
          if (message) {
            await this.quickReply(sessionId, message);
          }
        },
      ),
    );
  }

  // ── Disposal ──────────────────────────────────────────────────

  dispose(): void {
    for (const [, tab] of this.tabs) {
      tab.outputSub?.dispose();
    }
    this.tabs.clear();
    this.panel?.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

// ── Utilities ────────────────────────────────────────────────────

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
