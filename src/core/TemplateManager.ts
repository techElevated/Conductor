/**
 * Conductor — TemplateManager.
 *
 * Template CRUD with variable resolution and launch orchestration.
 * Templates are stored at two scopes:
 *   - User-level:    ~/.conductor/templates/{id}.json
 *   - Project-level: {workspace}/.conductor/templates/{id}.json
 *
 * Variables in prompt text and session names use `{{varName}}` syntax.
 *
 * PRD v1.1 §4f, Implementation Plan §7 Task 4.6
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuid } from 'uuid';
import type {
  SessionTemplate,
  TemplateSession,
  TemplateScope,
  ConductorSession,
} from '../types';
import type { QueueManager } from './QueueManager';
import type { DependencyEngine } from './DependencyEngine';
import { readJsonFile, writeJsonFile, ensureDir } from '../storage/FileStore';
import { getUserTemplatesDir, getProjectTemplatesDir } from '../storage/paths';

// ── Events ───────────────────────────────────────────────────────

export interface TemplateEvent {
  type: 'created' | 'updated' | 'deleted' | 'launched';
  templateId: string;
  template?: SessionTemplate;
}

// ── TemplateManager ──────────────────────────────────────────────

export class TemplateManager implements vscode.Disposable {
  private userTemplates = new Map<string, SessionTemplate>();
  private projectTemplates = new Map<string, SessionTemplate>();
  private workspacePath: string;

  private readonly _onTemplateEvent = new vscode.EventEmitter<TemplateEvent>();
  readonly onTemplateEvent = this._onTemplateEvent.event;

  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    workspacePath: string,
    private readonly queueManager: QueueManager,
    private readonly dependencyEngine: DependencyEngine,
  ) {
    this.workspacePath = workspacePath;
    this.disposables.push(this._onTemplateEvent);
  }

  // ── Initialisation ───────────────────────────────────────────

  async initialise(): Promise<void> {
    await ensureDir(getUserTemplatesDir());
    await ensureDir(getProjectTemplatesDir(this.workspacePath));
    await this.loadUserTemplates();
    await this.loadProjectTemplates();
  }

  // ── Queries ──────────────────────────────────────────────────

  getTemplate(id: string): SessionTemplate | undefined {
    return this.userTemplates.get(id) ?? this.projectTemplates.get(id);
  }

  getUserTemplates(): SessionTemplate[] {
    return [...this.userTemplates.values()].sort(sortByName);
  }

  getProjectTemplates(): SessionTemplate[] {
    return [...this.projectTemplates.values()].sort(sortByName);
  }

  getAllTemplates(): SessionTemplate[] {
    return [...this.getUserTemplates(), ...this.getProjectTemplates()];
  }

  // ── CRUD ─────────────────────────────────────────────────────

  /**
   * Create a new template.  Validates required fields, generates UUID,
   * persists, and emits an event.
   */
  async createTemplate(partial: Partial<SessionTemplate>): Promise<SessionTemplate> {
    const template: SessionTemplate = {
      id: partial.id ?? uuid(),
      name: partial.name ?? 'Untitled Template',
      description: partial.description ?? '',
      version: partial.version ?? 1,
      variables: partial.variables ?? [],
      sessions: partial.sessions ?? [],
      createdAt: partial.createdAt ?? new Date().toISOString(),
      lastUsedAt: partial.lastUsedAt ?? null,
      scope: partial.scope ?? 'user',
    };

    await this.persistTemplate(template);

    if (template.scope === 'user') {
      this.userTemplates.set(template.id, template);
    } else {
      this.projectTemplates.set(template.id, template);
    }

    this._onTemplateEvent.fire({ type: 'created', templateId: template.id, template });
    return template;
  }

  /**
   * Capture currently active sessions as a template.
   */
  async createFromActiveSessions(
    sessions: ConductorSession[],
    name: string,
    scope: TemplateScope = 'user',
  ): Promise<SessionTemplate> {
    const templateSessions: TemplateSession[] = sessions.map(s => ({
      templateSessionId: s.id,
      name: s.name,
      prompt: s.prompt,
      providerId: s.providerId,
      parallelSafe: s.dependsOn.length === 0,
      dependsOn: s.dependsOn,
      permissionMode: 'default',
    }));

    return this.createTemplate({
      name,
      description: `Captured from ${sessions.length} active session(s)`,
      sessions: templateSessions,
      scope,
    });
  }

  /** Update an existing template. */
  async updateTemplate(
    id: string,
    updates: Partial<Omit<SessionTemplate, 'id' | 'createdAt'>>,
  ): Promise<void> {
    const existing = this.getTemplate(id);
    if (!existing) {throw new Error(`Template "${id}" not found`);}

    const updated: SessionTemplate = { ...existing, ...updates, id };
    await this.persistTemplate(updated);

    if (updated.scope === 'user') {
      this.userTemplates.set(id, updated);
    } else {
      this.projectTemplates.set(id, updated);
    }

    this._onTemplateEvent.fire({ type: 'updated', templateId: id, template: updated });
  }

  /** Delete a template. */
  async deleteTemplate(id: string): Promise<void> {
    const template = this.getTemplate(id);
    if (!template) {return;}

    const filePath = this.templateFilePath(id, template.scope);
    try {
      await fs.promises.unlink(filePath);
    } catch {
      // File may already be gone
    }

    if (template.scope === 'user') {
      this.userTemplates.delete(id);
    } else {
      this.projectTemplates.delete(id);
    }

    this._onTemplateEvent.fire({ type: 'deleted', templateId: id });
  }

  // ── Launch ───────────────────────────────────────────────────

  /**
   * Launch a template:
   *   1. Load the template.
   *   2. Validate and resolve variables.
   *   3. Topological sort sessions by dependency.
   *   4. Add all to the prompt queue with correct dependency relationships.
   *   5. Auto-launch sessions with no unmet dependencies.
   *   6. Return created sessions.
   */
  async launchTemplate(
    templateId: string,
    variables: Record<string, string> = {},
  ): Promise<ConductorSession[]> {
    const template = this.getTemplate(templateId);
    if (!template) {throw new Error(`Template "${templateId}" not found`);}

    // Validate required variables
    for (const v of template.variables) {
      if (v.required && !variables[v.name] && !v.default) {
        throw new Error(
          `Template "${template.name}" requires variable "{{${v.name}}}" but no value was provided`,
        );
      }
    }

    // Build variable map (provided values take precedence over defaults)
    const resolvedVars: Record<string, string> = {};
    for (const v of template.variables) {
      resolvedVars[v.name] = variables[v.name] ?? v.default ?? '';
    }

    // Map templateSessionId → queuedPromptId for dependency remapping
    const idMap = new Map<string, string>();

    // Topological sort
    const sorted = topologicalSort(template.sessions);

    // Add sessions to queue
    const queuedPromptIds: string[] = [];
    for (const ts of sorted) {
      const resolvedPrompt = resolveVariables(ts.prompt, resolvedVars);
      const resolvedName = resolveVariables(ts.name, resolvedVars);

      // Remap dependsOn from templateSessionId to the new queued prompt ID
      const remappedDeps = ts.dependsOn
        .map(dep => idMap.get(dep))
        .filter((dep): dep is string => dep !== undefined);

      const queuedPrompt = await this.queueManager.addPrompt({
        name: resolvedName,
        prompt: resolvedPrompt,
        providerId: ts.providerId,
        parallelSafe: ts.parallelSafe,
        dependsOn: remappedDeps,
      });

      idMap.set(ts.templateSessionId, queuedPrompt.id);
      queuedPromptIds.push(queuedPrompt.id);

      // Wire dependencies in DependencyEngine
      if (remappedDeps.length > 0) {
        this.dependencyEngine.addDependency(queuedPrompt.id, remappedDeps);
      }
    }

    // Update lastUsedAt
    await this.updateTemplate(templateId, { lastUsedAt: new Date().toISOString() });

    // Auto-launch prompts with no dependencies
    const launchedSessions: ConductorSession[] = [];
    for (const promptId of queuedPromptIds) {
      if (this.dependencyEngine.allDependenciesMet(promptId)) {
        try {
          const session = await this.queueManager.launchPrompt(promptId);
          launchedSessions.push(session);
        } catch {
          // Non-fatal — prompt stays in queue
        }
      }
    }

    this._onTemplateEvent.fire({ type: 'launched', templateId });
    return launchedSessions;
  }

  // ── Import / Export ──────────────────────────────────────────

  /** Serialize a template to a JSON string for sharing. */
  exportTemplate(templateId: string): string {
    const template = this.getTemplate(templateId);
    if (!template) {throw new Error(`Template "${templateId}" not found`);}
    return JSON.stringify(template, null, 2);
  }

  /** Parse and validate an imported template JSON string. */
  async importTemplate(
    json: string,
    scope: TemplateScope = 'user',
  ): Promise<SessionTemplate> {
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch {
      throw new Error('Invalid template JSON: could not parse');
    }

    if (!isValidTemplate(raw)) {
      throw new Error('Invalid template: missing required fields (name, sessions)');
    }

    // Assign a new ID and scope on import
    return this.createTemplate({
      ...raw,
      id: uuid(),
      scope,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    });
  }

  // ── Variable resolution ──────────────────────────────────────

  /** Replace `{{varName}}` tokens in text with resolved values. */
  resolveVariables(text: string, vars: Record<string, string>): string {
    return resolveVariables(text, vars);
  }

  // ── Persistence ──────────────────────────────────────────────

  private async loadUserTemplates(): Promise<void> {
    const dir = getUserTemplatesDir();
    await this.loadTemplatesFromDir(dir, 'user', this.userTemplates);
  }

  private async loadProjectTemplates(): Promise<void> {
    const dir = getProjectTemplatesDir(this.workspacePath);
    await this.loadTemplatesFromDir(dir, 'project', this.projectTemplates);
  }

  private async loadTemplatesFromDir(
    dir: string,
    scope: TemplateScope,
    target: Map<string, SessionTemplate>,
  ): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {continue;}
      const filePath = path.join(dir, entry.name);
      const data = await readJsonFile<SessionTemplate | null>(filePath, null);
      if (data && data.id) {
        target.set(data.id, { ...data, scope });
      }
    }
  }

  private async persistTemplate(template: SessionTemplate): Promise<void> {
    const filePath = this.templateFilePath(template.id, template.scope);
    await writeJsonFile<SessionTemplate>(filePath, template);
  }

  private templateFilePath(id: string, scope: TemplateScope): string {
    const dir =
      scope === 'user'
        ? getUserTemplatesDir()
        : getProjectTemplatesDir(this.workspacePath);
    return path.join(dir, `${id}.json`);
  }

  // ── Disposable ────────────────────────────────────────────────

  dispose(): void {
    for (const d of this.disposables) {d.dispose();}
  }
}

// ── Module helpers ───────────────────────────────────────────────

/** Replace `{{varName}}` tokens in text. */
function resolveVariables(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, name) => vars[name] ?? `{{${name}}}`);
}

/** Sort templates alphabetically by name. */
function sortByName(a: SessionTemplate, b: SessionTemplate): number {
  return a.name.localeCompare(b.name);
}

/**
 * Topologically sort template sessions so that sessions with no
 * dependencies come first.  Uses Kahn's algorithm.
 */
function topologicalSort(sessions: TemplateSession[]): TemplateSession[] {
  const idToSession = new Map<string, TemplateSession>(
    sessions.map(s => [s.templateSessionId, s]),
  );
  const inDegree = new Map<string, number>(
    sessions.map(s => [s.templateSessionId, 0]),
  );

  for (const s of sessions) {
    for (const dep of s.dependsOn) {
      inDegree.set(s.templateSessionId, (inDegree.get(s.templateSessionId) ?? 0) + 1);
      void dep; // dep just increments the count of the dependent
    }
  }

  // Rebuild: count how many upstream dependencies each session has
  const depCount = new Map<string, number>(sessions.map(s => [s.templateSessionId, 0]));
  for (const s of sessions) {
    depCount.set(s.templateSessionId, s.dependsOn.length);
  }

  const queue: string[] = [];
  for (const [id, count] of depCount) {
    if (count === 0) {queue.push(id);}
  }

  const sorted: TemplateSession[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const session = idToSession.get(id);
    if (session) {sorted.push(session);}

    // Decrement dependent counts for sessions that depended on this one
    for (const s of sessions) {
      if (s.dependsOn.includes(id)) {
        const newCount = (depCount.get(s.templateSessionId) ?? 1) - 1;
        depCount.set(s.templateSessionId, newCount);
        if (newCount === 0) {queue.push(s.templateSessionId);}
      }
    }
  }

  // If sorted.length < sessions.length there's a cycle — return original order
  return sorted.length === sessions.length ? sorted : [...sessions];
}

/** Minimal runtime validation for an imported template object. */
function isValidTemplate(raw: unknown): raw is Omit<SessionTemplate, 'id' | 'scope'> {
  if (typeof raw !== 'object' || raw === null) {return false;}
  const obj = raw as Record<string, unknown>;
  return (
    typeof obj['name'] === 'string' &&
    Array.isArray(obj['sessions'])
  );
}
