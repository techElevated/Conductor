/**
 * Conductor — TaskFeedback.
 *
 * Feedback loop for pattern learning.  Maintains a global ignore list
 * so that false-positive task detections don't recur across sessions
 * or workspaces.
 *
 * PRD v1.1 §4d, Implementation Plan §7 Task 4.3
 */

import { v4 as uuid } from 'uuid';
import { readJsonFile, writeJsonFile, ensureDir } from '../storage/FileStore';
import { isSimilarDescription, normaliseDescription } from '../utils/patternMatcher';
import { getConductorHome } from '../storage/paths';
import * as path from 'path';

// ── Ignore entry ─────────────────────────────────────────────────

export interface IgnoreEntry {
  id: string;
  /** The pattern name that produced the false positive */
  patternName: string;
  /** Normalised description that should be suppressed */
  normalisedDescription: string;
  /** Human-readable example of what triggered the entry */
  exampleText: string;
  /** ISO timestamp when this entry was added */
  createdAt: string;
}

// ── Persisted format ─────────────────────────────────────────────

interface IgnoreFile {
  entries: IgnoreEntry[];
}

// ── TaskFeedback ─────────────────────────────────────────────────

export class TaskFeedback {
  private entries: IgnoreEntry[] = [];
  private readonly filePath: string;
  private loaded = false;

  constructor() {
    this.filePath = path.join(getConductorHome(), 'task-ignore.json');
  }

  // ── Initialisation ───────────────────────────────────────────

  async initialise(): Promise<void> {
    await ensureDir(getConductorHome());
    const data = await readJsonFile<IgnoreFile | null>(this.filePath, null);
    if (data?.entries) {
      this.entries = data.entries;
    }
    this.loaded = true;
  }

  // ── Ignore list queries ──────────────────────────────────────

  /**
   * Return true if the given description / patternName combination
   * matches an entry in the ignore list and should be suppressed.
   */
  isIgnored(description: string, patternName?: string): boolean {
    if (!this.loaded) {return false;}

    for (const entry of this.entries) {
      // Optional: if patternName is provided and differs, skip
      if (patternName && entry.patternName && entry.patternName !== patternName) {continue;}

      if (isSimilarDescription(description, entry.normalisedDescription)) {return true;}
    }
    return false;
  }

  getIgnoreList(): IgnoreEntry[] {
    return [...this.entries];
  }

  // ── Ignore list mutations ────────────────────────────────────

  /**
   * Add a description/pattern pair to the ignore list (called on 👎).
   * Skips adding if an equivalent entry already exists.
   */
  async addToIgnoreList(
    patternName: string,
    exampleText: string,
  ): Promise<IgnoreEntry> {
    const normalised = normaliseDescription(exampleText);

    // Deduplicate
    for (const entry of this.entries) {
      if (
        entry.patternName === patternName &&
        isSimilarDescription(normalised, entry.normalisedDescription)
      ) {
        return entry;
      }
    }

    const entry: IgnoreEntry = {
      id: uuid(),
      patternName,
      normalisedDescription: normalised,
      exampleText,
      createdAt: new Date().toISOString(),
    };

    this.entries.push(entry);
    await this.saveToDisk();
    return entry;
  }

  /**
   * Remove an ignore entry by ID (called from the UI "Manage ignore list").
   */
  async removeFromIgnoreList(id: string): Promise<void> {
    this.entries = this.entries.filter(e => e.id !== id);
    await this.saveToDisk();
  }

  // ── Persistence ──────────────────────────────────────────────

  private async saveToDisk(): Promise<void> {
    await writeJsonFile<IgnoreFile>(this.filePath, { entries: this.entries });
  }
}
