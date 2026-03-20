# Contributing to Conductor

Thanks for your interest in contributing! This guide covers architecture, development setup, and how to add new features.

## Architecture Overview

```
src/
├── core/                  # Core subsystems
│   ├── SessionManager     # Session lifecycle, persistence, polling
│   ├── ApprovalEngine     # Approval detection, routing, resolution
│   ├── QueueManager       # FIFO prompt queue with complexity analysis
│   ├── DependencyEngine   # Inter-session dependency DAG
│   ├── TaskDetector       # [CONDUCTOR_TASK] pattern matching
│   ├── TaskFeedback       # Task history persistence
│   ├── TemplateManager    # Session templates with variable substitution
│   ├── InteractionManager # Session I/O routing (real-time + background poll)
│   └── NavigationManager  # Jump-to-session command
│
├── providers/             # Provider adapters (one per AI agent)
│   ├── ProviderAdapter    # Interface contract (8 methods)
│   ├── ClaudeCodeAdapter  # Claude Code implementation
│   ├── ProviderPaths      # Provider-specific path resolution
│   └── index              # Provider registry
│
├── views/                 # VS Code UI components
│   ├── StatusBoard        # Session status TreeView
│   ├── ApprovalPanel      # Pending approvals TreeView
│   ├── ApprovalNotifier   # Toast + badge notifications
│   ├── PromptQueue        # Queue TreeView
│   ├── DependencyTreeView # Dependency graph TreeView
│   ├── TaskInbox          # Human tasks TreeView
│   ├── TemplateLibrary    # Templates TreeView
│   ├── InteractionPanel   # WebviewPanel for session I/O
│   ├── LayoutManager      # Configurable UI layout
│   └── SetupWizard        # First-run wizard
│
├── platform/              # IDE abstraction
│   ├── TerminalManager    # Terminal creation (VS Code / tmux)
│   └── IdePaths           # IDE-specific path resolution
│
├── hooks/                 # Claude Code hook integration
│   ├── hookInstaller      # Pre-tool-use hook installation
│   └── preToolUseHook     # Hook script logic
│
├── storage/               # Persistence layer
│   ├── FileStore          # JSON/JSONL read/write utilities
│   └── paths              # ~/.conductor/ directory resolution
│
├── utils/                 # Utilities
│   ├── jsonlParser        # JSONL parsing + fs.watch streaming
│   ├── patternMatcher     # Task tag regex extraction
│   └── processUtils       # Process enumeration
│
├── types.ts               # Canonical type definitions
├── constants.ts           # IDs, keys, defaults
└── extension.ts           # Activation + bootstrap
```

### Data Flow

```
Provider (Claude Code CLI)
  → JSONL log files (~/.claude/projects/{hash}/)
  → ClaudeCodeAdapter reads/watches files
  → SessionManager polls adapter for state
  → ApprovalEngine detects pending approvals
  → Views (TreeViews/WebviewPanel) render state
  → User actions → Commands → Adapter methods → Provider
```

## Development Setup

### Prerequisites

- Node.js 18+
- VS Code 1.85+
- Claude Code CLI (for testing with real sessions)

### Clone and Build

```bash
git clone https://github.com/techElevated/Conductor.git
cd Conductor
npm install
npm run compile
```

### Run the Extension

1. Open the repo in VS Code.
2. Press `F5` to launch the Extension Development Host.
3. The extension activates when it detects `~/.claude/` data.

### Run Tests

```bash
# Unit tests
npx mocha --require ts-node/register test/unit/**/*.test.ts

# Integration tests
npx mocha --require ts-node/register test/integration/*.test.ts

# All tests
npm test
```

### Lint

```bash
npx eslint src/ --ext .ts
```

## Adding a Provider Adapter

This is the most impactful contribution you can make. Here's how to add support for a new AI coding agent:

### Step 1: Create the Adapter

Create `src/providers/YourAgentAdapter.ts` implementing the `ProviderAdapter` interface:

```typescript
import type {
  ProviderAdapter,
  DiscoveredSession,
  ManagedSession,
  LaunchConfig,
  SessionState,
  SessionOutputEvent,
} from '../types';
import * as vscode from 'vscode';

export class YourAgentAdapter implements ProviderAdapter {
  readonly providerId = 'your-agent';
  readonly displayName = 'Your Agent';
  readonly iconPath = 'media/your-agent-icon.svg';

  // 1. Discover existing sessions from the agent's data directory
  async discoverSessions(workspacePath: string): Promise<DiscoveredSession[]> {
    // Read ~/.your-agent/projects/ or equivalent
    return [];
  }

  // 2. Launch a new session via terminal
  async launchSession(config: LaunchConfig): Promise<ManagedSession> {
    // Create terminal, run `your-agent --prompt '...'`
    throw new Error('Not implemented');
  }

  // 3. Install approval capture hook (if supported)
  async installApprovalHook(session: ManagedSession): Promise<void> {
    // Optional — no-op if your agent doesn't support hooks
  }

  // 4. Read current session state
  async readSessionState(sessionId: string): Promise<SessionState> {
    // Parse log files, check process status
    throw new Error('Not implemented');
  }

  // 5. Watch for state changes
  onStateChange(sessionId: string, callback: (state: SessionState) => void): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  // 6. Approve/deny actions
  async approveAction(approvalId: string): Promise<void> {}
  async denyAction(approvalId: string): Promise<void> {}

  // 7. Session control
  async killSession(sessionId: string): Promise<void> {}
  getTerminal(sessionId: string): vscode.Terminal | null { return null; }

  // 8. Session interaction
  async sendMessage(sessionId: string, message: string): Promise<void> {
    // Send text to terminal or use SDK
  }

  onSessionOutput(sessionId: string, callback: (output: SessionOutputEvent) => void): vscode.Disposable {
    // Watch log files for new output
    return new vscode.Disposable(() => {});
  }

  async getSessionHistory(sessionId: string, limit: number): Promise<SessionOutputEvent[]> {
    // Read log files, parse entries, return last N
    return [];
  }
}
```

### Step 2: Register the Adapter

In `src/extension.ts`, add registration alongside the Claude Code adapter:

```typescript
import { YourAgentAdapter } from './providers/YourAgentAdapter';

// In activateFull():
const yourAdapter = new YourAgentAdapter();
registerProvider(yourAdapter);
```

### Step 3: Add Path Configuration

In `src/providers/ProviderPaths.ts`, add your agent's directory layout:

```typescript
'your-agent': {
  homeDir: '.your-agent',
  projectsSubDir: 'projects',
  cliBinary: 'your-agent',
},
```

### Step 4: Test

Write tests in `test/unit/providers/your-agent.test.ts` covering:
- Session discovery from mock log files
- State inference from log entries
- Output event conversion

## Adding a Task Detection Pattern

Task detection patterns live in `src/utils/patternMatcher.ts`. To add a new pattern:

```typescript
// Add to the PATTERNS array
{
  name: 'your-pattern',
  regex: /YOUR_REGEX_HERE/g,
  extract: (match) => ({
    description: match[1],
    priority: 'normal',
    blocking: false,
  }),
}
```

## Code Style

- **TypeScript strict mode** — all code must pass `tsc --strict`
- **ESLint + Prettier** — run `npx eslint src/ --ext .ts` before submitting
- **No `any` types** — use `unknown` and narrow with type guards
- **Single responsibility** — each file owns one subsystem or view
- **Doc comments** — public APIs get JSDoc with PRD section references

## Testing

- **Unit tests:** `test/unit/` — test individual functions and classes in isolation
- **Integration tests:** `test/integration/` — test subsystem interactions via filesystem
- **Coverage:** aim for 80%+ on core/ and utils/

## PR Process

1. Fork the repo.
2. Create a branch from `dev`: `git checkout -b feat/your-feature`.
3. Make your changes with tests.
4. Run `npm run compile && npx eslint src/ --ext .ts`.
5. Submit a PR to `dev`. Squash merge preferred.
6. Add a changelog entry in the PR description.

## Issue Labels

| Label | Description |
|-------|-------------|
| `bug` | Something isn't working |
| `feature` | New feature request |
| `good-first-issue` | Good for newcomers |
| `help-wanted` | Extra attention needed |
| `provider-adapter` | Related to adding/improving a provider |
| `documentation` | Docs improvements |

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](https://www.contributor-covenant.org/version/2/1/code_of_conduct/). By participating, you agree to uphold this code.
