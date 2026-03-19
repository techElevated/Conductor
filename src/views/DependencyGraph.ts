/**
 * Conductor — Dependency Graph (WebviewPanel).
 *
 * Full DAG visualization in an editor tab.  Nodes are prompts/sessions,
 * sized by complexity and colored by status.  Edges are dependency arrows.
 * Interactive: click to jump, zoom, pan.  Updates in real-time.
 *
 * PRD v1.1 §4e, Implementation Plan §6 Task 3.5
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { QueuedPrompt } from '../types';
import type { SessionManager } from '../core/SessionManager';
import type { QueueManager } from '../core/QueueManager';
import type { DependencyEngine } from '../core/DependencyEngine';
import { CommandId } from '../constants';

// ── Graph data (sent to webview) ────────────────────────────────

interface GraphNode {
  id: string;
  name: string;
  status: string;
  complexity: string;
}

interface GraphEdge {
  from: string;
  to: string;
}

interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ── DependencyGraphPanel ────────────────────────────────────────

export class DependencyGraphPanel implements vscode.Disposable {
  private static instance: DependencyGraphPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionPath: string;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    extensionPath: string,
    private readonly sessionManager: SessionManager,
    private readonly queueManager: QueueManager,
    private readonly dependencyEngine: DependencyEngine,
  ) {
    this.panel = panel;
    this.extensionPath = extensionPath;

    // Set webview HTML
    this.panel.webview.html = this.getWebviewContent();

    // Handle messages from webview
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.type === 'ready') {
          this.sendGraphUpdate();
        } else if (msg.type === 'nodeClicked') {
          await this.handleNodeClick(msg.nodeId as string);
        }
      }),
    );

    // Auto-refresh on data changes
    this.disposables.push(
      queueManager.onQueueEvent(() => this.sendGraphUpdate()),
      sessionManager.onSessionEvent(() => this.sendGraphUpdate()),
      dependencyEngine.onDependencyEvent(() => this.sendGraphUpdate()),
    );

    // Clean up on panel close
    this.panel.onDidDispose(() => {
      DependencyGraphPanel.instance = undefined;
      this.dispose();
    });
  }

  /**
   * Show or reveal the dependency graph panel.
   */
  static createOrShow(
    extensionPath: string,
    sessionManager: SessionManager,
    queueManager: QueueManager,
    dependencyEngine: DependencyEngine,
  ): DependencyGraphPanel {
    if (DependencyGraphPanel.instance) {
      DependencyGraphPanel.instance.panel.reveal();
      return DependencyGraphPanel.instance;
    }

    const panel = vscode.window.createWebviewPanel(
      'conductor.dependencyGraph',
      'Conductor: Dependency Graph',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.file(path.join(extensionPath, 'webviews', 'dag')),
        ],
      },
    );

    DependencyGraphPanel.instance = new DependencyGraphPanel(
      panel,
      extensionPath,
      sessionManager,
      queueManager,
      dependencyEngine,
    );

    return DependencyGraphPanel.instance;
  }

  // ── Graph data ──────────────────────────────────────────────

  private buildGraphData(): GraphData {
    const allPrompts = this.queueManager.getQueue();
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    // Only include prompts that are part of a dependency chain
    const inChain = new Set<string>();
    for (const prompt of allPrompts) {
      if (prompt.dependsOn.length > 0) {
        inChain.add(prompt.id);
        for (const dep of prompt.dependsOn) {
          inChain.add(dep);
        }
      }
    }

    for (const prompt of allPrompts) {
      if (!inChain.has(prompt.id)) { continue; }

      nodes.push({
        id: prompt.id,
        name: prompt.name,
        status: this.resolveDisplayStatus(prompt),
        complexity: prompt.complexity,
      });

      for (const dep of prompt.dependsOn) {
        // Edge goes from dependency to dependent (upstream → downstream)
        edges.push({ from: dep, to: prompt.id });
      }
    }

    return { nodes, edges };
  }

  private resolveDisplayStatus(prompt: QueuedPrompt): string {
    if (prompt.status === 'launched' && prompt.sessionId) {
      const session = this.sessionManager.getSession(prompt.sessionId);
      return session?.status ?? 'launched';
    }
    if (prompt.status === 'cancelled') { return 'blocked'; }
    return prompt.status;
  }

  private sendGraphUpdate(): void {
    const data = this.buildGraphData();
    this.panel.webview.postMessage({ type: 'updateGraph', data });
  }

  // ── Interaction ─────────────────────────────────────────────

  private async handleNodeClick(nodeId: string): Promise<void> {
    const prompt = this.queueManager.getPrompt(nodeId);
    if (prompt?.sessionId) {
      await vscode.commands.executeCommand(CommandId.JumpToSession, prompt.sessionId);
    } else if (prompt) {
      await vscode.commands.executeCommand(CommandId.EditPrompt, prompt.id);
    }
  }

  // ── Webview HTML ────────────────────────────────────────────

  private getWebviewContent(): string {
    const htmlPath = path.join(this.extensionPath, 'webviews', 'dag', 'index.html');

    let html: string;
    try {
      html = fs.readFileSync(htmlPath, 'utf-8');
    } catch {
      html = '<html><body><h2>Failed to load dependency graph</h2></body></html>';
    }

    // Generate nonce for CSP
    const nonce = getNonce();
    html = html.replace(/\{\{nonce\}\}/g, nonce);

    return html;
  }

  // ── Dispose ─────────────────────────────────────────────────

  dispose(): void {
    DependencyGraphPanel.instance = undefined;
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
