# pi-agenticoding

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![npm version](https://img.shields.io/badge/npm-0.1.0-blue)
![Status](https://img.shields.io/badge/status-active-green)

**The LLM manages its own context.** Not the platform. Not the user. Not lossy compaction that fires when the window is already polluted. Three tools — `spawn`, `ledger`, `handoff` — that let the agent actively curate, persist, and reset its context as a deliberate part of its workflow.

This extension is directly tied to the [agenticoding.ai](https://agenticoding.ai) course. It provides automation primitives for the course's Research → Plan → Execute → Validate workflow — and other long-running agent workflows — by giving the model clean ways to isolate work, preserve reusable knowledge, and restart with a fresh context when needed.

---

## The Problem No One's Solving

Every coding agent degrades as its context grows. The industry's answer has been to manage context *around* the LLM — but all three common approaches fall short:

| Approach | How It Works | Where It Fails |
|----------|-------------|----------------|
| **Platform auto-compaction** | The runtime summarizes and trims the conversation in the background | The platform doesn't know what's important — blunt summarization buries critical details the agent needs later |
| **User-triggered compaction** | The user runs `/compact` when the session feels slow or bloated | The user doesn't know the agent's internal working state — it's guesswork from the outside |
| **Manual session reset** | User runs `/clear` or `/new`, then manually copies over relevant context | Lossy, tedious, error-prone. The user has to remember what mattered across dozens of turns |

All three share the same assumption: context is something to be **managed for the LLM.** The LLM is a passive recipient — it gets whatever the platform or user decides to give it, and it silently degrades when that context grows beyond what it can effectively use.

Meanwhile, users cope with the fallout: lossy compaction that buries critical details, manual copy-paste of text between conversations, moving markdown files around to "save" context.

**pi-agenticoding inverts this.** It gives the LLM `spawn`, `ledger`, and `handoff` — tools to manage its own context actively and deliberately. The agent decides what's worth keeping, when to isolate noise, and when to restart clean with a structured brief of what it learned.

---

## How It Works

The LLM gets three primitives. It uses them as part of its normal workflow — not triggered by the user, not forced by the platform.

```
You ask: "Add OAuth to the backend"
                 │
         ┌───────┴───────┐
         ▼               ▼
    spawn("research    spawn("audit
    OAuth best        current auth
    practices")       code")
         │               │
         └───────┬───────┘
                 ▼
         ledger_add("oauth-decisions",
           "Flow: PKCE. Scope: read+write.
            Constraint: no refresh tokens v1.")
                 │
         ┌───────┴───────┐
         ▼               ▼
    spawn("impl        spawn("write
    token endpoint")  tests")
         │               │
         └───────┬───────┘
                 ▼
         handoff("Wire OAuth routes
           into the existing middleware
           stack. Ledger entry
           'oauth-decisions' has the durable constraints.
           Carry forward the remaining integration context.")
```

The agent decided to spawn research children, save reusable findings and constraints to the ledger as it worked, spawn implementation subtasks, and then use handoff to preserve the important context still missing from the ledger before restarting clean. **The user said one sentence.** The agent did the rest — including deciding when its context was getting noisy and when to restart clean.

---

## The Three Primitives

### Spawn — Isolate Noise

Delegate messy work to an isolated child agent with a clean context. The child inherits the parent's model and tools, works independently, and returns only the condensed result. The parent stays focused on orchestration.

In the agenticoding.ai workflow, spawn is what makes isolated research, parallel execution, and fresh-context validation practical without polluting the parent context.

- **Agent decides** when a subtask needs clean context — not pre-routed by platform
- **Parallel execution** — siblings run concurrently, not sequentially
- **Inherited understanding** — children get the parent's prompt + context primer, then specialize
- **Depth 1** — children can't spawn grand-children (explosive branch prevention)

### Ledger — Continuity Across Cuts

A sparse continuity cache that the agent actively curates while it works. After discovering something reusable — a fact, finding, constraint, decision, progress update, or expensive discovery — it saves it by name. Later contexts fetch entries on demand instead of re-deriving the work. The ledger persists across handoffs, context resets, and session restarts.

- **Agent decides** what's worth remembering — not a platform background process
- **Sparse by design** — named entries, not one monolithic blob
- **Evolves during work** — refine existing entries rather than accumulating tiny ones
- **Carries phase knowledge forward** — research can feed planning, planning can feed execution, execution can feed validation
- **Survives everything** — persisted in the session file, rehydrated on restart

### Handoff — Deliberate Compaction

When the context has degraded or the job changes, the agent captures what matters and restarts clean. First it saves reusable state to the ledger. Then it writes a focused brief that preserves the important picture still missing from the ledger and compacts. The new context starts with the brief front-and-center, all ledger entries accessible, and zero noise.

- **Agent initiates** when context is noisy or the job changes — not a platform timer
- **Structured transition** — extracts reusable state + writes explicit brief for what comes next
- **Fresh-context workflow** — ideal for phase changes and validation or review in a clean context
- **Knowledge preserved** — the ledger holds durable learned knowledge; the handoff brief carries the remaining situational context
- **Full history saved** — nothing is lost, it's just not cluttering the active context


**Rule of thumb:** the ledger holds reusable learned knowledge. Handoff carries the remaining situational context needed to continue in a fresh context.

---

## The Primacy-Zone Heuristic

Here's what the research says: LLMs don't use context evenly. Performance degrades as context grows — **even far from the token limit.** The first ~30% of the context window is a practical heuristic for where the model pays attention. Past that, information drifts into the "lost in the middle" zone.

No other tool manages around this. The three common approaches — platform auto-compaction, user-triggered `/compact`, manual `/clear` or `/new` — all treat context as one undifferentiated block. The agent has no idea its important state has scrolled out of the high-attention zone.

pi-agenticoding injects watchdog reminders when context passes 30%, 50%, and 70%. These are **advisory only** — they don't force anything. But they give the agent the awareness to decide: "Am I mid-task and clear, or has my context become noise that's hurting my performance?"

---

## Quick Start

**1. Install**

```bash
pi install npm:pi-agenticoding
```

**2. Disable pi's built-in compaction.**

Add this to `~/.pi/agent/settings.json` so handoff can manage context instead:

```json
{
  "compaction": {
    "enabled": false
  }
}
```

This prevents pi from silently compacting the conversation behind the agent's back. With compaction off, handoff is the only compaction mechanism — the agent stays in control of when and how context is trimmed.

**3. You're done.**

Your agent now has `spawn`, `ledger_add`, `ledger_get`, `ledger_list`, and `handoff`. The status bar shows context usage and ledger count.

**Try it in 30 seconds:**

```bash
# Tell your agent:
# "Use spawn to research what the current primacy-zone heuristic says
#  about context degradation, then ledger_add a summary."
```

The agent spawns a child with clean context, researches, and caches the result. You can reference that knowledge across turns without re-deriving it.

---

## What You Get

| Feature | What it looks like |
|---------|-------------------|
| **Context usage %** | `ctx 65%` in status bar — green < 30%, yellow < 50%, orange < 70%, red ≥ 70% |
| **Ledger count** | 📒 `3` when entries exist, hidden when empty |
| **`/handoff` command** | Instant pivot — agent drafts brief, compacts context, resumes |
| **`/ledger` command** | Overlay showing all entries with previews |
| **Auto-rehydration** | Ledger entries survive session restarts — determined by epoch |
| **Spawn transparency** | Watch child agents work in real time in the TUI |
| **Token cost visibility** | Each spawn reports input/output tokens, cache hits, and cost |
| **No polling** | Writes serialized via a process-local lock — no race conditions |

---

## Architecture

<details>
<summary><strong>How the three primitives wire together</strong></summary>

The extension hooks into pi's lifecycle:

| Hook | What it does |
|------|-------------|
| `before_agent_start` | Injects context management primer + live ledger listing into system prompt |
| `context` | Injects advisory watchdog reminders when context > 30% |
| `session_start` | Rehydrates ledger from persisted entries; resets on `/new` |
| `turn_end` | Updates TUI indicators (context %, ledger count) |
| `agent_end` | Records last context usage percent |
| `session_before_compact` | Consumes pending handoff task and sets it as compaction summary |

All state lives in a single `AgenticodingState` instance — one truth shared across all modules.

```typescript
interface AgenticodingState {
  ledger: Map<string, string>          // keyed by kebab-case name
  epoch: number                        // set on first ledger_add, for rehydration
  lastContextPercent: number | null    // last reading from getContextUsage()
  pendingHandoff: { task, source } | null
  pendingRequestedHandoff: { direction, ... } | null
  childSessions: Map<string, AgentSession>
  liveChildSessions: Map<string, AgentSession>
  childSessionEpoch: number
}
```

</details>

<details>
<summary><strong>Deep dive → ARCHITECTURE.md</strong></summary>

See [ARCHITECTURE.md](ARCHITECTURE.md) for full module breakdown, tool schemas, lifecycle wiring, spawn depth tracking, and ledger rehydration algorithm.

</details>

---

## The Comparison

| | Platform auto-compaction | User-triggered compaction | Manual `/clear` or `/new` | **pi-agenticoding** |
|---|---|---|---|---|
| **Compaction** | Runtime decides | User decides | Manual wipe + copy-paste | **Agent decides** |
| **Subagents** | Pre-defined or manual trigger | None | None | **Agent spawns dynamically** |
| **Persistent memory** | Background-generated (if at all) | None | None — gone on reset | **Ledger — agent-curated reusable continuity** |
| **Context awareness** | Token count only | Token count only | None | **Primacy-zone heuristic (~30%)** |
| **Cross-session continuity** | Rare (opt-in, background) | Manual copy-paste | Manual copy-paste | **Ledger persists across restarts** |
| **Structured handoff** | No | No | No | **Yes — resets context while carrying forward non-ledger state explicitly** |

---

## Why This Exists

The "lost in the middle" problem is well-documented academically (Liu et al., 2023). LLM performance degrades when relevant information sits in the middle of long contexts — information near the start and end gets the most attention. But the industry's response has been to manage context *around* the LLM: platform-side auto-compaction, user-triggered `/compact` commands, static files injected at startup.

None of this works well. Platform compaction doesn't know what's important — it summarizes everything into one blob and hopes. User-triggered compaction is guesswork — the user doesn't know the exact state of the agent's working memory. Static files are stale on arrival — they can't evolve as the agent learns during a session.

The agenticoding.ai course teaches a disciplined Research → Plan → Execute → Validate workflow for operating coding agents in production. pi-agenticoding is directly tied to that methodology: it does not hardcode the workflow, but it gives the model the context-management primitives that make it automatable across long-running tasks and clean phase transitions.

pi-agenticoding takes the obvious next step: **give the LLM the tools to manage its own context.** The agent knows what it's holding in its working memory. It knows when it's getting confused. It knows which findings are reusable and which are dead ends. Let it act on that knowledge.

A single summary blob mixes durable knowledge with transient situational context. pi-agenticoding separates them: reusable knowledge goes into the ledger; transient but still-important context goes into the handoff brief.

The three primitives map to the three fundamental operations in any context management system:

| Operation | Primitive | What It Prevents |
|-----------|-----------|-----------------|
| **Isolate** | Spawn | Context pollution from noisy subtasks |
| **Persist** | Ledger | Knowledge loss across resets and pivots |
| **Compact** | Handoff | Degradation from overstuffed context |

Combined with the primacy-zone heuristic — the only production deployment of "lost in the middle" awareness — the agent has everything it needs to manage its own context for the duration of any task, session, or project.

---

## Contributing

Contributions welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

MIT — see [LICENSE](LICENSE).
