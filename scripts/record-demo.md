# Recording the Conductor Demo GIF

## Setup

1. Install [gifcap](https://gifcap.dev) (browser-based, no install) or [LICEcap](https://www.cockos.com/licecap/) (desktop app).
2. Open the Conductor repo in VS Code with the extension running.
3. Have 4 Claude Code sessions active (or use mock data).

## Recording Script (15 seconds)

**Seconds 0-4:** Show the status board with 4 sessions in mixed states:
- Session 1: Running (green spinner)
- Session 2: Waiting (yellow bell)
- Session 3: Complete (gray check)
- Session 4: Running (green spinner)

**Seconds 4-8:** An approval notification pops up. Click the approval panel.
Show the pending approval with tool name and command. Click "Approve."

**Seconds 8-12:** Session 2 resumes running. Session 1 completes.
A dependent session auto-launches from the queue (visible in status board update).

**Seconds 12-15:** Click a session to open the interaction panel.
Show the output stream with formatted code blocks and tool calls.

## Dimensions

- Width: 1200px
- Height: 800px
- Frame rate: 15fps (for smaller file size)
- Max file size: < 5MB for GitHub/Marketplace

## Output

Save as `media/demo.gif` in the repo root.

## Tips

- Use a dark VS Code theme for better contrast
- Keep the window focused — no desktop background visible
- Use smooth, deliberate mouse movements
- If using gifcap, set the recording region tightly around the VS Code window
