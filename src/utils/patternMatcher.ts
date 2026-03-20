/**
 * Conductor — Pattern Matcher.
 *
 * Regex-based task detection patterns with confidence levels.  All
 * patterns are active by default per PRD decision §9 decision #8
 * (aggressive task detection with feedback loop).
 *
 * PRD v1.1 §4d, Implementation Plan §7 Task 4.1
 */

import type { TaskPriority } from '../types';

// ── Pattern definitions ──────────────────────────────────────────

export type ConfidenceLevel = 'high' | 'medium' | 'low';

interface PatternDef {
  name: string;
  regex: RegExp;
  confidence: ConfidenceLevel;
}

const TASK_PATTERNS: PatternDef[] = [
  {
    name: 'conductor-tag',
    regex: /\[CONDUCTOR_TASK\]([\s\S]*?)\[\/CONDUCTOR_TASK\]/g,
    confidence: 'high',
  },
  {
    name: 'human-task-tag',
    regex: /\[HUMAN_TASK\]([\s\S]*?)\[\/HUMAN_TASK\]/g,
    confidence: 'high',
  },
  {
    name: 'action-item',
    regex: /ACTION ITEM:\s*(.+)/gi,
    confidence: 'high',
  },
  {
    name: 'human-action',
    regex: /Human action required:\s*(.+)/gi,
    confidence: 'high',
  },
  {
    name: 'need-you-to',
    regex: /I need you to\s+(.+?)(?:\.|$)/gi,
    confidence: 'medium',
  },
  {
    name: 'please-do',
    regex: /Please\s+(?:manually\s+)?(.+?)(?:\s+(?:before|so|and)\s|\.)/gi,
    confidence: 'medium',
  },
  {
    name: 'youll-need',
    regex: /You'll need to\s+(?:manually\s+)?(.+?)(?:\.|$)/gi,
    confidence: 'medium',
  },
  {
    name: 'run-command',
    regex: /(?:Run|Execute)\s+`([^`]+)`/gi,
    confidence: 'medium',
  },
  {
    name: 'configure',
    regex: /(?:Configure|Set up|Enable)\s+(?:the\s+)?(.+?)(?:\s+(?:in|on|for)\s|\.)/gi,
    confidence: 'low',
  },
  {
    name: 'restart',
    regex: /(?:Restart|Reboot|Reload)\s+(?:the\s+)?(.+?)(?:\.|$)/gi,
    confidence: 'medium',
  },
];

// ── Detected task (raw match result) ────────────────────────────

export interface DetectedTask {
  /** Which pattern fired. */
  patternName: string;
  /** Extracted task description text. */
  description: string;
  /** Confidence of this match. */
  confidence: ConfidenceLevel;
  /** Character offset in the source text where the match started. */
  offset: number;
  /** Raw matched string. */
  raw: string;
}

// ── Structured task parsed from [CONDUCTOR_TASK] block ──────────

export interface StructuredTaskFields {
  description: string;
  priority: TaskPriority;
  blocking: boolean;
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Run all patterns against the supplied text and return all matches
 * with their confidence level.  Results are not deduplicated at this
 * layer — deduplication happens in TaskDetector.
 */
export function matchTasks(text: string): DetectedTask[] {
  const results: DetectedTask[] = [];

  for (const def of TASK_PATTERNS) {
    // Reset lastIndex before each run (all regexes use /g).
    def.regex.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = def.regex.exec(text)) !== null) {
      const captured = (match[1] ?? match[0]).trim();
      if (!captured) {continue;}

      results.push({
        patternName: def.name,
        description: captured,
        confidence: def.confidence,
        offset: match.index,
        raw: match[0],
      });
    }
  }

  return results;
}

/**
 * Parse a `[CONDUCTOR_TASK]…[/CONDUCTOR_TASK]` block into structured
 * fields.  Returns null if the text contains no such block.
 *
 * Expected inner format (each field on its own line):
 *   description: <text>
 *   priority: normal|urgent|low
 *   blocking: true|false
 */
export function parseStructuredTask(text: string): StructuredTaskFields | null {
  const blockRegex = /\[CONDUCTOR_TASK\]([\s\S]*?)\[\/CONDUCTOR_TASK\]/i;
  const match = blockRegex.exec(text);
  if (!match) {return null;}

  const body = match[1];

  const descMatch = /description:\s*(.+)/i.exec(body);
  const priorityMatch = /priority:\s*(normal|urgent|low)/i.exec(body);
  const blockingMatch = /blocking:\s*(true|false)/i.exec(body);

  const description = descMatch ? descMatch[1].trim() : body.trim();
  const priority: TaskPriority =
    (priorityMatch?.[1]?.toLowerCase() as TaskPriority | undefined) ?? 'normal';
  const blocking = blockingMatch ? blockingMatch[1].toLowerCase() === 'true' : false;

  if (!description) {return null;}

  return { description, priority, blocking };
}

/**
 * Normalise a description string for deduplication comparison:
 * lowercase, collapse whitespace, strip punctuation.
 */
export function normaliseDescription(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Return true when two descriptions are ≥ 90 % similar by character
 * overlap (Dice coefficient on 2-grams).
 */
export function isSimilarDescription(a: string, b: string): boolean {
  const na = normaliseDescription(a);
  const nb = normaliseDescription(b);

  if (na === nb) {return true;}

  const bigrams = (s: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) {set.add(s.slice(i, i + 2));}
    return set;
  };

  const setA = bigrams(na);
  const setB = bigrams(nb);

  let intersection = 0;
  for (const bg of setA) {
    if (setB.has(bg)) {intersection++;}
  }

  const dice = (2 * intersection) / (setA.size + setB.size);
  return dice >= 0.9;
}
