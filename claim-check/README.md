# Claim Check

A Claude Code mod that flags confident claims about prod, data, deployments and tickets that no query backed up in the same turn. **Experimental, deterministic, and a heuristic.**

## Why

Story 1120: the assistant said a correction utility "never ran in prod" and that the problem was "getting worse", without querying anything. It read as a finding. It was a guess. This mod makes that kind of sentence visible when it happens.

## What you see

- **Toast** at the end of a turn: `claim-check: unverified — "The correction utility never ran in prod." (+2 more)`. One toast per turn, however many sentences were flagged.
- **Status line**: `claims: 3 unverified`, a running count for the session.
- **`/claim-check`** lists the flagged sentences (last 20), which certainty marker and state noun matched, and what the last turn came to. `/claim-check clear` resets the count. A `/clear` resets it too.

```
claim-check: 2 unverified this session (heuristic)
1. [turn 1, never-ran/prod] "The correction utility never ran in prod."
2. [turn 1, worse/data] "The problem is getting worse."
Last turn: 2 candidates, 0 evidence calls → flagged.
`/claim-check clear` resets the count.
```

## How it decides

For each finished main-loop answer (subagent, aborted and errored turns are skipped), it reads the final answer plus the text written between tool calls, strips code, quotes and tables, and splits it into sentences. A sentence is a candidate when it:

1. contains a **certainty marker** (`never ran`, `has not run`, `always`, `definitely`, `getting worse`, `no record of`, `confirmed that`, `the root cause is`, ...), and
2. is about a **state noun** in the same or the previous sentence (prod, database, deployment, ticket, telemetry, Azure resources), and
3. has no **hedge** (`UNVERIFIED`, `I haven't checked`, `might`, `if ...`, a question, `you said`, `the code`, `let me check`, ...).

Candidates are flagged unless the turn made at least one **successful evidence call**: a SQL/Azure/DevOps CLI command, an MCP call to a database, Azure, ADO or telemetry server (or a query-like tool), or a read of a `.log`/`.csv`/`.json`/export file. One evidence call clears the whole turn. The tables live in `hooks/claims.ts`.

## The rule it adds

The mod appends a four-line rule to the system prompt: verify claims about external state in the same turn, or prefix them `UNVERIFIED:`. The `injectRule` option (default on) turns it off; do that if you would rather put the rule in your own `CLAUDE.md`.

## It is a heuristic

Expect roughly **50% precision and 20-40% recall**. The prompt rule probably does more good than the detector.

False positives:
- Evidence gathered in an earlier turn does not count; the claim is re-flagged.
- Evidence through a tool the tables do not know about.
- Facts the user stated that the assistant restates, and imperatives like "never deploy on Fridays".
- Broad nouns (`utility`, `script`, `job`, `build`, `bug`, `task`, `log`).

False negatives:
- A flat declarative with no certainty marker ("The job failed in prod.") is never flagged. This is the fundamental limit.
- Hedge filler ("probably", "I think") drops a sentence even when the rest is a bare claim.
- Any single evidence call clears every claim in the turn, even if it returned nothing useful or looked at something else. Background Bash starts count as success.
- Tables and code blocks are stripped before scanning. Subagent answers are not scanned. English only.

**A quiet turn is not a verified turn.**

## Ideas for v0.2

An optional model judge (`judge: boolean`, default off) that re-reads only the Layer-1 candidates and the turn's tool log and decides whether the evidence actually covers the claim. Not in v0.1.

## Check

```sh
claude plugin validate ./claim-check
claude plugin test ./claim-check
```
