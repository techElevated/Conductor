#!/usr/bin/env node
/**
 * Conductor — PreToolUse Hook Script for Claude Code.
 *
 * This script is installed as a PreToolUse hook for Claude Code sessions.
 * It writes pending approvals to ~/.conductor/approvals/{sessionId}/
 * and polls for a decision file before returning to Claude Code.
 *
 * Hook contract (Claude Code PreToolUse):
 * - Receives tool use event on stdin (JSON)
 * - Must return JSON on stdout: {"decision": "allow" | "deny" | "ask"}
 * - "ask" = keep the approval pending in Claude Code's native prompt
 *
 * Environment variables:
 * - CONDUCTOR_SESSION_ID: The Conductor session ID (required)
 * - CONDUCTOR_SESSION_NAME: Human-readable session name (optional)
 *
 * Fail-safe: If anything goes wrong, returns {"decision": "ask"} so
 * Claude Code falls back to its native approval prompt.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ── Configuration ─────────────────────────────────────────────

const POLL_INTERVAL_MS = 200;
const TIMEOUT_MS = 300_000; // 5 minutes
const CONDUCTOR_DIR = path.join(os.homedir(), '.conductor');
const APPROVALS_DIR = path.join(CONDUCTOR_DIR, 'approvals');

// ── Main ──────────────────────────────────────────────────────

async function main() {
  try {
    const input = await readStdin();
    const event = parseToolEvent(input);

    if (!event) {
      // Malformed input — fall back to native
      writeDecision('ask');
      return;
    }

    const sessionId = process.env.CONDUCTOR_SESSION_ID;
    if (!sessionId) {
      // No session ID — can't write approval, fall back
      writeDecision('ask');
      return;
    }

    const sessionName = process.env.CONDUCTOR_SESSION_NAME || sessionId;
    const approvalId = crypto.randomUUID();
    const sessionDir = path.join(APPROVALS_DIR, sessionId);
    const approvalPath = path.join(sessionDir, `${approvalId}.json`);
    const decisionPath = path.join(sessionDir, `${approvalId}.decision.json`);

    // Ensure the session approval directory exists
    await mkdirp(sessionDir);

    // Write the pending approval
    const approval = {
      id: approvalId,
      sessionId,
      sessionName,
      tool: event.tool || 'unknown',
      command: event.command || '',
      context: event.context || '',
      timestamp: new Date().toISOString(),
      status: 'pending',
    };

    await writeFileAtomic(approvalPath, JSON.stringify(approval, null, 2));

    // Poll for the decision file
    const decision = await pollForDecision(decisionPath, TIMEOUT_MS);

    if (decision) {
      writeDecision(decision.decision || 'ask');
    } else {
      // Timed out — fall back to native approval
      writeDecision('ask');
    }

    // Clean up approval and decision files
    await cleanup(approvalPath, decisionPath);
  } catch {
    // Fail-safe: any error → fall back to native approval
    writeDecision('ask');
  }
}

// ── Stdin reading ─────────────────────────────────────────────

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));

    // Safety: if stdin doesn't close within 5s, resolve with what we have
    setTimeout(() => resolve(data), 5000);
  });
}

// ── Tool event parsing ────────────────────────────────────────

function parseToolEvent(input) {
  try {
    const parsed = JSON.parse(input);

    // Claude Code hook input structure:
    // { tool_name: string, tool_input: { command?: string, ... }, session_id?: string }
    const tool = parsed.tool_name || parsed.tool || 'unknown';
    const toolInput = parsed.tool_input || parsed.input || {};

    // Extract the most meaningful command/action from tool_input
    const command = toolInput.command
      || toolInput.content
      || toolInput.file_path
      || toolInput.path
      || JSON.stringify(toolInput).slice(0, 500);

    // Extract context if available
    const context = parsed.context || parsed.description || '';

    return { tool, command, context };
  } catch {
    return null;
  }
}

// ── Decision polling ──────────────────────────────────────────

function pollForDecision(decisionPath, timeoutMs) {
  return new Promise((resolve) => {
    const startTime = Date.now();

    const interval = setInterval(async () => {
      try {
        const data = await fs.promises.readFile(decisionPath, 'utf-8');
        clearInterval(interval);
        resolve(JSON.parse(data));
      } catch {
        // File doesn't exist yet — keep polling
        if (Date.now() - startTime > timeoutMs) {
          clearInterval(interval);
          resolve(null); // Timed out
        }
      }
    }, POLL_INTERVAL_MS);
  });
}

// ── Output ────────────────────────────────────────────────────

function writeDecision(decision) {
  const output = JSON.stringify({ decision });
  process.stdout.write(output);
}

// ── File helpers ──────────────────────────────────────────────

async function mkdirp(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
}

async function writeFileAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.tmp-${path.basename(filePath)}-${process.pid}`);
  try {
    await fs.promises.writeFile(tmpPath, content, 'utf-8');
    await fs.promises.rename(tmpPath, filePath);
  } catch (err) {
    try { await fs.promises.unlink(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

async function cleanup(approvalPath, decisionPath) {
  try { await fs.promises.unlink(approvalPath); } catch { /* ignore */ }
  try { await fs.promises.unlink(decisionPath); } catch { /* ignore */ }
}

// ── Run ───────────────────────────────────────────────────────

main().catch(() => {
  writeDecision('ask');
});
