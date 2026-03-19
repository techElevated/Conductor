/**
 * Conductor — Provider Adapter interface.
 *
 * This is the contract every provider (Claude Code, Codex, Gemini CLI,
 * custom) must implement.  The Conductor core is provider-agnostic;
 * all provider-specific logic lives behind this interface.
 *
 * See PRD v1.1 §5.3 for the full specification.
 *
 * The types referenced here (DiscoveredSession, ManagedSession, etc.)
 * are defined in src/types.ts.  This file re-exports the
 * ProviderAdapter interface for import convenience.
 */

export type { ProviderAdapter } from '../types';

// Re-export supporting types that adapter implementors need
export type {
  DiscoveredSession,
  ManagedSession,
  LaunchConfig,
  SessionState,
  SessionOutputEvent,
} from '../types';
