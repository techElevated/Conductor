/**
 * Conductor — Claude Code JSONL log parser.
 *
 * Claude Code stores session conversation data as JSONL files.
 * This parser reads those files and extracts structured events
 * that Conductor needs: output events, tool calls, completion
 * signals, and error markers.
 */

import * as fs from 'fs';
import type { SessionOutputEvent, SessionStatus } from '../types';

/** Raw shape of a single JSONL entry from Claude Code logs. */
export interface JsonlEntry {
  type: string;
  message?: {
    role?: string;
    content?: string | Array<{ type: string; text?: string; name?: string; input?: unknown }>;
  };
  timestamp?: string;
  [key: string]: unknown;
}

/**
 * Parse a JSONL file into an array of raw entries.
 * Skips malformed lines silently.
 */
export async function parseJsonlFile(filePath: string): Promise<JsonlEntry[]> {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf-8');
    return parseJsonlString(raw);
  } catch {
    return [];
  }
}

/**
 * Parse a JSONL string into entries.
 */
export function parseJsonlString(raw: string): JsonlEntry[] {
  const entries: JsonlEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) { continue; }
    try {
      entries.push(JSON.parse(trimmed) as JsonlEntry);
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

/**
 * Convert raw JSONL entries into Conductor SessionOutputEvents.
 */
export function entriesToOutputEvents(entries: JsonlEntry[]): SessionOutputEvent[] {
  const events: SessionOutputEvent[] = [];

  for (const entry of entries) {
    const event = entryToOutputEvent(entry);
    if (event) {
      events.push(event);
    }
  }

  return events;
}

/**
 * Convert a single JSONL entry to a SessionOutputEvent, or null
 * if the entry type isn't relevant.
 */
function entryToOutputEvent(entry: JsonlEntry): SessionOutputEvent | null {
  const timestamp = (entry.timestamp as string) ?? new Date().toISOString();

  // Assistant message
  if (entry.type === 'assistant' || entry.message?.role === 'assistant') {
    const content = extractTextContent(entry);
    if (content) {
      return { type: 'assistant', content, timestamp };
    }
  }

  // Tool use
  if (entry.type === 'tool_use') {
    const toolName = extractToolName(entry);
    const command = extractCommand(entry);
    return {
      type: 'tool_use',
      content: command || toolName || 'tool_use',
      timestamp,
      metadata: { toolName: toolName ?? undefined, command: command ?? undefined },
    };
  }

  // Tool result
  if (entry.type === 'tool_result') {
    const content = extractTextContent(entry);
    const exitCode = typeof entry.exit_code === 'number' ? entry.exit_code : undefined;
    return {
      type: 'tool_result',
      content: content || '',
      timestamp,
      metadata: { exitCode },
    };
  }

  // Error
  if (entry.type === 'error') {
    return {
      type: 'error',
      content: extractTextContent(entry) || 'Unknown error',
      timestamp,
    };
  }

  // System message
  if (entry.type === 'system') {
    return {
      type: 'system',
      content: extractTextContent(entry) || '',
      timestamp,
    };
  }

  return null;
}

/**
 * Infer the high-level session status from the tail entries of a JSONL log.
 */
export function inferStatusFromEntries(entries: JsonlEntry[]): SessionStatus {
  if (entries.length === 0) { return 'queued'; }

  // Walk backwards to find the most recent meaningful entry
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];

    // Check for explicit completion markers
    if (entry.type === 'result' || entry.type === 'completion') {
      return 'complete';
    }

    // Check for error
    if (entry.type === 'error') {
      return 'error';
    }

    // Check for tool use (possible approval wait)
    if (entry.type === 'tool_use') {
      return 'waiting';
    }

    // Any assistant output means it's running
    if (entry.type === 'assistant' || entry.message?.role === 'assistant') {
      return 'running';
    }
  }

  return 'running';
}

// ── Content extraction helpers ──────────────────────────────────

function extractTextContent(entry: JsonlEntry): string | null {
  const msg = entry.message;
  if (!msg) {
    return typeof entry.content === 'string' ? entry.content : null;
  }

  if (typeof msg.content === 'string') {
    return msg.content;
  }

  if (Array.isArray(msg.content)) {
    const texts = msg.content
      .filter(block => block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text as string);
    return texts.length > 0 ? texts.join('\n') : null;
  }

  return null;
}

function extractToolName(entry: JsonlEntry): string | null {
  if (typeof entry.name === 'string') { return entry.name; }
  if (Array.isArray(entry.message?.content)) {
    const toolBlock = entry.message?.content.find(b => b.type === 'tool_use');
    if (toolBlock && typeof toolBlock.name === 'string') { return toolBlock.name; }
  }
  return null;
}

function extractCommand(entry: JsonlEntry): string | null {
  const input = entry.input as Record<string, unknown> | undefined;
  if (input && typeof input.command === 'string') { return input.command; }
  if (Array.isArray(entry.message?.content)) {
    const toolBlock = entry.message?.content.find(b => b.type === 'tool_use');
    if (toolBlock?.input && typeof (toolBlock.input as Record<string, unknown>).command === 'string') {
      return (toolBlock.input as Record<string, unknown>).command as string;
    }
  }
  return null;
}
