# pi-agenticoding

[![pi.dev package](https://img.shields.io/badge/pi.dev-package-purple)](https://pi.dev/packages/pi-agenticoding)
[![npm version](https://img.shields.io/badge/npm-0.4.0-blue)](https://www.npmjs.com/package/pi-agenticoding)
[![MIT License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
![Status](https://img.shields.io/badge/status-active-brightgreen)

> Context tools for [Pi](https://pi.dev): `spawn`, `notebook`, and `handoff` — so the agent manages its own context instead of rotting in a long transcript.

## Why

Long coding sessions [degrade well before the token ceiling](https://agenticoding.ai/context-engineering). Auto-compact and manual `/compact` are lossy summarizer passes — you must fire them early, steer them well, and hope the compression step kept the right facts. The agent does not author that cut.

**pi-agenticoding flips that.** It gives the LLM tools to isolate noisy work, keep task-scoped notes across deliberate cuts, and restart clean on purpose — with optional readonly when you want research without mutating the tree.

Keeping that context small is also cheaper: most coding spend is **input** tokens, and provider prefix caches only stay warm for a few minutes of idle time.

Deeper rationale: [docs/why.md](docs/why.md) · companion book: [agenticoding.ai](https://agenticoding.ai)

## Features

- **Spawn** — run research or implementation in a clean child context so the parent stays focused
- **Model Groups** — manage durable project/global model pools with `/model-groups`; route `spawn` by an exact group name, with `#group` autocomplete showing model/thinking details
- **Capabilities** — model pickers and editor rows show a chip beside each model for the input modalities it handles (`T` text, `I` image); a group advertises what its members can do, and a spawn that needs a capability the group can't deliver fails early instead of working around it
- **Notebook** — task-scoped named pages for facts and decisions; survives handoff, dies with the conversation (`/new`) — no forever-memory rot
- **Handoff** — deliberate clean restart with a task prompt when the topic changes or context turns to noise
- **Topic** — same problem → prefer spawn; new problem → prefer handoff (human-set topics win)
- **Readonly** — explore and plan without writing the tree (`/readonly`, Ctrl+Shift+R, or `--readonly`); macOS/Linux can OS-sandbox bash, Windows is classifier-only
- **Visibility** — status bar shows context pressure, notebook count, topic, and readonly; warning at high usage

## Install

Requires the [Pi](https://pi.dev) coding agent.

```bash
pi install npm:pi-agenticoding
```

Disable pi's built-in compaction so **handoff** owns deliberate restarts:

```json
// ~/.pi/agent/settings.json
{
  "compaction": { "enabled": false }
}
```

**You should get:** tools `spawn`, `notebook_write`, `notebook_read`, `notebook_index`, `notebook_topic_set`, and `handoff`. The status bar can show context usage, notebook count, active topic, and readonly when enabled.

### Compatibility

pi-agenticoding requires **Pi 0.82.0 or later** and **Node.js 22.19.0 or later**. Spawn passes the final selected public model into a child-owned runtime. Persisted, environment-based, and extension-rediscoverable provider/auth configuration is available to children; parent-only transient credentials, inline provider factories, or in-memory catalog changes are not guaranteed to be rediscoverable. In that unsupported case, spawn reports the child resolution/auth failure and does not silently select another model.

## How it works

```
You: "Add OAuth to the backend"

  notebook_topic_set("oauth")
  spawn("research OAuth best practices")
  spawn("audit current auth code")
         │
         ▼
  notebook_write("oauth-decisions", "Flow: PKCE. Scope: read+write.")
         │
         ├── spawn("implement token endpoint")
         └── spawn("write tests")
         │
         ▼
  handoff("Wire OAuth routes into the middleware stack.
           Notebook page 'oauth-decisions' holds the constraints.")
```

The agent set a topic, spawned research, saved decisions, delegated implementation, and handed off when context got noisy. **You said one sentence.**

## Primitives

| | |
|---|---|
| **Spawn** | Subtask in a clean child context. Parent orchestrates; siblings run in parallel. Children inherit active registered parent tools executable in the child session — MCP/extension tools such as ChunkHound — plus child-local notebook tools. Children cannot spawn grandchildren or handoff. Omit `group` to inherit the parent model/thinking. An unknown group reports fallback to the parent. A known group randomly selects among configured/authenticated usable entries and fails before child creation if none are usable. When the delegated task declares a `constraints` requirement, the group **and** the exact selected model are both checked before any child is created, and the child is told which capabilities the group allows. The selected entry supplies the model and, when configured, overrides explicit/inherited thinking before Pi clamps it; the final selected public model runs in the child-owned runtime. |
| **Notebook** | Named pages coupled to this conversation/task. Carries memory across handoff; cleared on `/new`. Not a long-lived memory store — lifetime matches the work, so it cannot go stale across unrelated sessions. |
| **Handoff** | Write a prompt, compact, resume clean. Notebook holds reusable memory for this task; the prompt holds only remaining situational context. |
| **Readonly** | Blocks write/edit and guards bash while researching. Spawn inherits the posture. **macOS/Linux:** bash can run under OS sandbox (`sandbox-exec` / `bwrap`) — syscall-level write denial outside temp. **Windows:** no OS sandbox — **best-effort command classifier only** (interpreters and clever pipes can bypass). A coding guardrail on every OS — not a hardened security boundary. |

**Commands:** `/handoff` · `/notebook` · `/notebook <topic>` · `/readonly` · `Ctrl+Shift+R` · `--readonly`

## Capabilities

Model groups advertise what their members can do. Today that means input modalities: `text` and `image`.

Model pickers and editor rows put a small chip beside each model (`T` for text, `I` for image) so you can tell at a glance which inputs it handles. A group's set is derived from its members — you can **narrow** it, but never widen it beyond what the members actually support.

When you delegate a task with `spawn`, you can declare which capabilities it needs. Spawn checks that requirement against the group and the exact model it selects — and if it can't be met, it fails before creating any child rather than improvising around the gap.

## Comparison

| Approach | Who decides | Across cuts |
|---|---|---|
| Platform auto-compaction | Runtime (late threshold) | Blunt lossy summary |
| `/compact` or `/clear` | User (timing + steer) | Lossy summarizer pass / paste |
| Forever “memory” stores | Background / RAG | Accumulates, goes stale, needs invalidation |
| **pi-agenticoding** | **Agent** | **Task-scoped notebook + handoff prompt** |

## Learn more

- [Why agent-managed context](docs/why.md)
- [Architecture](docs/architecture.md)
- [Agentic Coding](https://agenticoding.ai) — companion methodology
- [Pi package page](https://pi.dev/packages/pi-agenticoding)

## Contributing

Contributions welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the project workflow and quality expectations.

## License

MIT — see [LICENSE](LICENSE).
