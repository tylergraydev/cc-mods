# Ask on Auto Deny

A Claude Code mod that asks you when auto mode's classifier blocks a tool call, and lets you allow that exact call once.

```
⛔ auto mode blocked Bash [Self-Modification]: sed -i 's/old/new/' ~/.claude/agents/codex-runner.md  [ Allow once ]  [ Refuse ]
```

- **Band above the prompt**: one row per blocked call, newest first. Hotkeys `p` (Allow once) and `x` (Refuse) act on the newest row; after ctrl+x tab or a click they work on the band.
- **Toast** when a new call is blocked. The status line shows `auto-deny: 1 pending · 1 allowed`.
- **Allow once** records a one-shot allowance for that tool and that exact input (whitespace, `description`, `timeout` and path spelling are ignored; everything else must match). It is used up by the first matching call and expires after the TTL. Claude is then sent a prompt asking it to retry the call unchanged, and on the retry the allowance answers `allow` where the classifier would have decided.
- Only a Button press or an `/auto-allow allow` you typed can allow. A call that a settings rule, a hook or another mod denied is never overridden.

## Commands

`/auto-allow status | allow [n] | refuse [n] | clear` (registered as `/ask-on-auto-deny` if the first name is refused).

- `status` lists live allowances and the last 20 denials with their outcome.
- `allow [n]` allows entry `n`, or the newest pending one. It only works when you type it.
- `refuse [n]` refuses one. `clear` expires everything pending and drops every allowance.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `ttlMinutes` | 10 | How long an Allow once stays usable (1 to 120) |
| `maxPending` | 3 | Rows the band lists; the rest fold into `+N more` (1 to 10) |
| `autoSubmit` | on | Send Claude the retry prompt; off puts it in the prompt box for you to send |
| `askDialog` | off | Also open Claude Code's question dialog (Allow once / Refuse) on a new denial |

## What it cannot do

- It cannot turn the classifier's denial into the engine's own permission dialog, or reverse it in place. The model has to call the tool again.
- A changed command (rephrased, extra `&&`, other quoting, another tool) does not match, so the classifier decides again and a new row appears.
- A subagent's denial shows up marked `(subagent)`, but the retry prompt goes to the main conversation.
- Allowing mid-turn sends the retry prompt when the turn ends.
- It never overrides settings deny rules, hooks, an organization ceiling or other mods' `tool.call` denials.
- State is per session; `/clear` ends pending rows and allowances.

## Optional CLAUDE.md rule

If you want Claude to expect the retry prompt, paste this into your CLAUDE.md:

```
When the ask-on-auto-deny plugin sends a message saying the user allowed a blocked call once, retry that exact call unchanged. Do not rephrase it.
```

## Check

```sh
claude plugin validate ./ask-on-auto-deny
claude plugin test ./ask-on-auto-deny
```
