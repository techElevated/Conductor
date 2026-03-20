# Conductor

**One conductor. Many sessions.**

A VS Code extension for managing multiple AI coding agent sessions in parallel. Launch, monitor, approve, queue, and orchestrate 4-6+ concurrent Claude Code (or Codex, Gemini CLI) sessions from a single control surface.

![Demo](media/demo.gif)

## The Problem

Running multiple AI coding sessions simultaneously means constantly switching between terminals, missing approval prompts that block progress, and losing track of which session is doing what. Conductor solves this with a unified dashboard, centralized approvals, and dependency-aware orchestration.

## Features

| Feature | Description |
|---------|-------------|
| **Session Status Board** | Live dashboard showing all sessions with status, duration, and last activity |
| **Approval Panel** | Centralized approve/deny for all sessions — never miss a blocked prompt again |
| **Prompt Queue** | FIFO queue with complexity analysis and batch launch |
| **Dependency Engine** | Define inter-session dependencies; downstream sessions auto-launch on completion |
| **Task Inbox** | Surfaces `[CONDUCTOR_TASK]` blocks from agent output as actionable human tasks |
| **Session Templates** | Reusable multi-session blueprints with variable substitution |
| **Interaction Panel** | Read output, send follow-ups, and approve actions inline — without switching terminals |

## Quick Start

1. Install from the VS Code Marketplace:
   ```
   ext install techElevated.conductor
   ```
2. Open a workspace where you use Claude Code (or another supported agent).
3. Conductor activates automatically when it detects agent data (`~/.claude/`).
4. The first-run wizard helps you choose a layout.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `conductor.layout` | `split` | UI layout: `sidebar-left`, `sidebar-right`, `bottom`, `split` |
| `conductor.interaction.defaultTarget` | `editor` | Where the interaction panel opens |
| `conductor.interaction.clickBehavior` | `open` | Click session → open panel or jump to terminal |
| `conductor.notifications.style` | `toast-and-badge` | Approval notification style |
| `conductor.defaultPermissionMode` | `default` | Default Claude Code permission mode for new sessions |
| `conductor.terminal.type` | `vscode` | Terminal backend: `vscode` or `tmux` |
| `conductor.sessionPollIntervalMs` | `2000` | Session state polling interval |
| `conductor.outputHistoryLimit` | `50` | Number of output entries shown in interaction panel |

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+Shift+C` | Open Conductor sidebar |
| `Cmd+[` / `Cmd+]` | Cycle between interaction panel tabs |
| `Cmd+Enter` | Send message in interaction panel |
| `Cmd+F` | Search output in interaction panel |

## Provider Support

- **Claude Code** — fully supported (shipped)
- **Codex** — adapter interface ready, community contributions welcome
- **Gemini CLI** — adapter interface ready, community contributions welcome

## How It Works

```
┌─────────────────────────────────────────────────────┐
│                    Conductor Core                    │
│                                                     │
│  SessionManager  ApprovalEngine  QueueManager       │
│  DependencyEngine  TaskDetector  TemplateManager    │
│  InteractionManager                                 │
│                                                     │
├─────────────┬──────────────┬──────────────┬─────────┤
│  Claude Code │    Codex     │  Gemini CLI  │  ...    │
│   Adapter    │   Adapter    │   Adapter    │         │
├─────────────┴──────────────┴──────────────┴─────────┤
│              Provider Adapter Interface              │
│                                                     │
│  discoverSessions()  launchSession()  sendMessage()  │
│  readSessionState()  onSessionOutput()  killSession()│
│  approveAction()  denyAction()  getSessionHistory()  │
└─────────────────────────────────────────────────────┘
```

The provider adapter pattern means Conductor's core is completely provider-agnostic. All provider-specific logic (how to discover sessions, parse logs, send messages) lives behind the `ProviderAdapter` interface.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for architecture overview, development setup, and how to add a new provider adapter (~200 lines).

## Roadmap

**V1 (current):** Session management, approvals, queue, dependencies, tasks, templates, interaction panel.

**V2 (planned):** Multi-workspace support, cost tracking dashboard, session replay, AI-powered prompt suggestions, team collaboration features.

## License

MIT

## Credits

Built by Evan Franco / [Conductor AI](https://conductorai.dev). Born from managing 4-6 parallel Claude Code sessions daily and needing a better way to stay on top of them all.
