# Architecture

pi-agenticoding is a Pi extension. It registers tools and hooks into the agent lifecycle, and keeps session state in one `AgenticodingState` instance.

## Lifecycle hooks

| Hook | Role |
|---|---|
| `before_agent_start` | Refreshes Model Groups, injects the context-management primer, names-only group guidance, and live notebook index; resolves deferred `readonly:` frontmatter |
| `context` | Advisory watchdog reminders when context is elevated; readonly toggle nudges |
| `input` | Queues skill/prompt names for deferred readonly frontmatter resolution |
| `tool_call` | Readonly blocks write/edit/unguarded bash; blocks handoff unless a requested bypass is active |
| `session_start` | Rehydrates notebook pages and readonly state; loads and validates Model Groups, registers group autocomplete, reports config issues, and resets session state on `/new` |
| `turn_end` | Updates TUI indicators (context %, notebook count, topic, readonly) |
| `agent_end` | Records last context usage percent; handoff enforcement cleanup |
| `session_before_compact` | Consumes the pending handoff task and sets it as the compaction summary |

## State

```typescript
interface AgenticodingState {
  notebookPages: Map<string, string>
  activeNotebookTopic: string | null
  activeNotebookTopicSource: "human" | "agent" | null
  pendingTopicBoundaryHint: { from, to } | null
  readonlyEnabled: boolean
  modelGroups: {
    groups: ResolvedModelGroup[]
    validation: ModelGroupsBootValidation | null
  }
  epoch: number
  lastContextPercent: number | null
  pendingHandoff: { task, source } | null
  pendingRequestedHandoff: { direction, resumeReadonlyAfterHandoff, ... } | null
  childSessions: Map<string, AgentSession>
  liveChildSessions: Map<string, AgentSession>
  childSessionEpoch: number
}
```

## Behavioral notes

**Spawn** — Without a Model Group, the child inherits the parent's public model and explicit/default thinking level. An exact known group randomly selects a registry-resolved, authenticated entry; an entry-specific thinking level overrides explicit/inherited thinking and is clamped for the selected model. An unknown group reports fallback and uses the parent model/thinking. A known empty group or one with no usable authenticated entries fails before child-session creation. The selected public model enters a child-owned runtime. Children also inherit cwd and active registered tools executable in that session, retain child-local notebook tools, cannot spawn or handoff, and inherit readonly posture.

**Model Groups** — `/model-groups` manages versioned global and trusted-project JSON configuration. Project groups shadow same-named global groups. Configuration is loaded and validated against Pi's model registry into the `modelGroups` snapshot; only names are injected into the agent prompt. Routing uses the parent registry only to select configured/authenticated entries—the registry/auth objects are not passed into the child runtime.

**Notebook** — Agent-curated named pages **scoped to the current conversation/task**, not a long-lived memory product. Stored as session custom entries so pages survive handoff and resume of the same work stream; `/new` (fresh session) clears them with the conversation. That coupling avoids the stale-entry / invalidation problem of forever-memory systems. Active topic (`notebook_topic_set` or `/notebook <topic>`) frames spawn-vs-handoff preference; human-set topics are authoritative. Topic clears after a successful handoff.

**Handoff** — Requires a real prompt and a meaningful context load (rejects empty prompts, very small sessions, or missing usage). Notebook bodies are not inlined into the prompt; the next context in this work stream fetches pages by name. Under readonly, handoff is blocked unless the user runs `/handoff` or crosses an eligible human topic boundary; readonly can resume after compaction. Compaction replaces the prior transcript with the prompt: the next turns see a small context again (quality), and providers start a new input prefix for billing/cache (the dropped history is no longer in that prefix). Spawn runs children in separate context so their token use does not permanently inflate the parent. This extension does not configure provider cache TTLs or breakpoints.

**Readonly** — Session-persisted research posture. Toggle via `/readonly`, Ctrl+Shift+R, or `--readonly`. Skills/prompts may set `readonly: true` in frontmatter to defer-enable when invoked. Write/edit always blocked at the tool boundary. Bash uses a two-layer guard:

| Platform | Enforcement |
|---|---|
| **macOS** | OS sandbox via `sandbox-exec` (Seatbelt) — kernel denies file writes outside the OS temp dir; classifier is secondary |
| **Linux** | OS sandbox via `bwrap` when available — read-only root + writable temp; classifier is secondary. Without `bwrap`, classifier only |
| **Windows** | **No OS / syscall-level sandbox.** `canUseOsSandbox()` is always false. Only the shell-command **classifier** runs — best-effort pattern matching. Known gaps: interpreter one-liners (`node -e`, `python -c`, …), piped indirection (`xargs`, etc.). **Not true write protection.** |

Coding-agent guardrail on every OS — not a hardened security boundary. Strongest on macOS/Linux with sandbox binaries present; weakest on Windows. UI-oriented toggle; state rehydrates on resume.

**Watchdog** — Band-throttled advisory reminders as context crosses practical pressure bands; high-usage TUI widget reinforces spawn-vs-handoff guidance (topic- and readonly-aware).

## Package layout (high level)

| Area | Role |
|---|---|
| `index.ts` | Extension entry: tools, hooks, wiring |
| `spawn/` | Child sessions and live TUI rendering |
| `model-groups/` | Persistence, boot validation, CRUD TUI/autocomplete, and spawn routing |
| `notebook/` | Page store, tools, topic, rehydration |
| `handoff/` | Eligibility, prompt, compaction bridge |
| `readonly-*.ts` / `os-sandbox.ts` | Readonly posture, bash policy, sandbox |
| `watchdog.ts` / `tui.ts` / `state.ts` | Pressure advisories, status UI, shared state |

## See also

- [README](../README.md) — install and primitives
- [why.md](why.md) — product rationale
