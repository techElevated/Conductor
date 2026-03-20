# Changelog

All notable changes to Conductor are documented in this file.

## [0.1.0] - 2026-03-19

### Added

- **Session Status Board** — Live dashboard showing all AI coding sessions with status, duration, and last activity.
- **Approval Panel** — Centralized approve/deny for pending tool-use approvals across all sessions.
- **Approval Notifications** — Badge counts and toast notifications when sessions need attention.
- **Prompt Queue** — FIFO queue with complexity analysis, batch launch, and clipboard import.
- **Dependency Engine** — Inter-session dependency DAG with automatic downstream launch on completion.
- **Task Inbox** — Detects `[CONDUCTOR_TASK]` blocks from agent output and surfaces them as actionable items.
- **Session Templates** — Reusable multi-session blueprints with variable substitution and scope (user/project).
- **Interaction Panel** — Full read-write session surface: output stream, follow-up prompts, inline approvals, multi-session tabs.
- **Provider Adapter Pattern** — Extensible architecture supporting Claude Code out of the box, with adapter interface for Codex and Gemini CLI.
- **Configurable Layout** — Four layout options: split, sidebar-left, sidebar-right, bottom panel.
- **First-Run Setup Wizard** — Guided onboarding with layout selection.
- **Pre-tool-use Hook** — Automatic Claude Code hook installation for approval capture.
- **Performance Optimizations** — Real-time streaming for active tabs, 5s background polling for inactive, incremental JSONL reads.
