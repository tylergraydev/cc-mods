# Agent Deck

A Claude Code mod for watching, launching and steering subagents.

- **Pane** (`/deck`): a tree of the session's subagents showing status, run time, tool count and the call each one is making now. Click a row to see its model, tokens, recent tool calls and final answer. A running agent's row also has a box to send it a note.
- **Status line**: `agents 2 running · 3 done · 1 failed`.
- **Toasts** when an agent fails or a background agent finishes.
- **Policy** (saved across sessions): `/deck cap 4` limits how many agents run at once, and `/deck model Explore haiku` sets the model for a type whenever the call names none.

| Command | |
|---|---|
| `/deck` | open the pane |
| `/deck spawn <type> [--model m] <prompt>` | start a background subagent |
| `/deck review [scope]` | start 3 background reviewers (correctness, security, quality & tests) on the current changes; when all finish, their reports are added to the conversation |
| `/deck nudge <id> <text>` | add a note to a running agent's conversation |
| `/deck cap <n\|off>` | cap the number of running subagents |
| `/deck model <type> <model\|off>` | set the model for an agent type |
| `/deck clear` | drop finished agents |

Agents can't be stopped from the deck: the API only lets a plugin abort a turn it started itself. Use the engine's own task view to kill one.

## Check

```sh
claude plugin validate ./agent-deck
claude plugin test ./agent-deck
```
