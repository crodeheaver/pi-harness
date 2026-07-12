# Pi Audited Harness

A small, auditable safety and workflow layer for [Pi](https://pi.dev). It adds policy gates, execution modes, structured questions, status visibility, and a few progressively disclosed workflows without replacing Pi's core agent loop.

## Included

### Extensions

- **Session environment** — applies an `environment` object from Pi settings (`~/.pi/agent/settings.json`, then trusted `.pi/settings.json`) to the session's environment variables on startup.
- **Safety policy** — blocks direct `write`/`edit` calls outside the workspace and to `.git`, `node_modules`, secret files, and private keys; gates sensitive reads and consequential shell commands.
- **Anthropic subscription status** — shows whether the selected Anthropic model uses Pi's stored Pro/Max OAuth and can fail closed instead of using metered API credentials.
- **Harness modes** — `/mode inspect|plan|default|permissive|yolo|isolated`.
- **Task profiles** — `/profile [name]` hot-swaps one trusted project profile from `./pi`.
- **`ask_user` tool** — one structured question with an optional free-form answer.
- **Status** — footer indicators for the active mode and policy approvals/blocks.
- **Secure web fetch** — public HTTP(S) text retrieval with redirect, SSRF, timeout, content-type, and size guards; never sends cookies or credentials.
- **Task ledger** — a compact, branch-aware task tool and widget for genuinely multi-step work.
- **Auto-memory** — Claude Code–style persistent project memory: durable context is saved to `.pi/memory/` as Markdown, the head of `MEMORY.md` is injected into the system prompt each turn, and the agent proactively saves facts worth keeping. Manage it with `/memory`.
- **Sub-agents** — Claude Code–style sub-agent framework: dispatch isolated, specialized agents (`general-purpose`, `Explore`, `Plan`, or custom `.pi/agents/*.md` definitions) that run in their own context and return only a summary; foreground, background (`run_in_background`), fork (`inherit_context`), resume, and steer. Every sub-agent tool call honors the harness safety policy. Manage with `/agents`.
- **Plan approval** — plan mode restricts writes to one selected plan file until explicit review and approval.

### Skills

- `validate-change`
- `code-review`
- `technical-research`

### Prompt templates

- `/investigate <problem>`
- `/review [focus]`
- `/handoff [next goal]`

## Install from this directory

For a temporary test:

```bash
pi -e ./extensions/environment.ts \
  -e ./extensions/policy.ts \
  -e ./extensions/anthropic-subscription.ts \
  -e ./extensions/structured-question.ts \
  -e ./extensions/presets.ts \
  -e ./extensions/profiles.ts \
  -e ./extensions/status.ts \
  -e ./extensions/web-fetch.ts \
  -e ./extensions/tasks.ts \
  -e ./extensions/memory.ts \
  --skill ./skills/validate/SKILL.md \
  --skill ./skills/review/SKILL.md \
  --skill ./skills/research/SKILL.md \
  --prompt-template ./prompts/investigate.md \
  --prompt-template ./prompts/review.md \
  --prompt-template ./prompts/handoff.md
```

To install the package in user settings:

```bash
pi install .
```

For project-local settings instead:

```bash
pi install . -l
```

Because this directory contains executable extensions, review it before installation. Project-local packages load only after Pi project trust is granted.

## Modes

| Mode | Policy | Intended use |
| --- | --- | --- |
| `inspect` | Read/search, `ask_user`, `web_fetch`, and `task` only | Read-only analysis |
| `plan` | Inspect tools plus `write`/`edit` restricted to one plan file | Prepare a human-approved implementation plan |
| `default` | The harness's standard blocks and approval gates | Normal work in a trusted repository |
| `permissive` | Allows all tool actions except `rm` targets outside the project or OS temporary directory | Low-friction work with a deletion boundary |
| `yolo` | Disables all harness policy gates | Fully unrestricted work |
| `isolated` | Default policy inside a verified or externally established sandbox | Contained autonomous work |

Switch interactively:

```text
/mode inspect
/mode default
/mode permissive
```

Or at startup:

```bash
pi --harness-mode inspect
```

Plan and approve a change:

```text
/harness-plan .pi/auth-plan.md
# Ask Pi to investigate and write the plan.
/harness-plan-review
```

The review command displays the plan and requires an explicit **Approve and execute** decision before restoring default mode and asking Pi to implement it.

## Task profiles

Create named profile folders directly under `./pi`:

```text
pi/
└── review/
    ├── settings.json
    ├── APPEND_SYSTEM.md
    ├── skills/
    ├── prompts/
    └── themes/
```

Load or switch profiles with `/profile review`. Calling `/profile` without a name opens a selector; `/profile --clear` unloads the active profile. Switching triggers Pi's normal resource reload, so skills, prompt templates, and themes from the previous profile are removed. The selection is stored in the current session and restored on resume. Profiles only load for trusted projects.

Profile `settings.json` accepts Pi's `defaultProvider`, `defaultModel`, `defaultThinkingLevel`, and `theme` fields, plus `tools` and `instructions`. Its `skills`, `prompts`, and `themes` arrays add paths relative to the profile folder; the conventional directories above are loaded automatically. `APPEND_SYSTEM.md` is appended to the system prompt. Example:

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-5",
  "defaultThinkingLevel": "high",
  "tools": ["read", "grep", "find", "ls"],
  "instructions": "Review changes without modifying the workspace."
}
```

Profile settings are overlays. When a profile is switched or cleared, model, thinking level, tools, and theme are first restored to the state captured before the first profile was loaded. Profile-local extensions and packages are not loaded dynamically; keep executable extensions in normal reviewed Pi package or project settings.

Isolated mode accepts a positive `audited-harness:sandbox-status` event from a sandbox integration. For externally established Docker, VM, WSL, Gondolin, or OpenShell boundaries, `PI_HARNESS_ISOLATED=1` remains an explicit assertion. It **does not create isolation**.

## Policy behavior

The rules below describe `default` and `isolated` modes. `permissive` bypasses them except for its scoped `rm` boundary, while `yolo` bypasses all harness policy decisions. The permissive boundary applies to `rm` invocations visible in shell tool input (including nested `command`, `cmd`, or `script` fields); commands hidden inside scripts or arbitrary third-party tools require OS-level containment for enforcement.

### Always blocked

- Direct `write`/`edit` calls outside the current workspace
- Direct writes to `.git`, `node_modules`, `.env*`, private keys, and common credential paths
- Obvious filesystem-root deletion, fork bombs, and raw-disk writes
- All mutation and shell execution in inspect mode

`.env.example`, `.env.sample`, and `.env.template` remain writable.

### Requires approval

- Sensitive file reads, including symlink aliases
- Reads outside the workspace
- Opaque shell wrappers that cannot be classified reliably
- MCP operations, mutating custom tools, and any third-party tool not on the harness allowlist
- Recursive deletion
- Destructive Git and force-push operations
- Dependency and system-package changes
- Privilege elevation and permission changes
- Deployments, infrastructure changes, and database migrations
- Likely network uploads and process termination

Interactive approvals can apply once or to the decision category for the rest of the session. Non-interactive runs deny actions requiring approval because no UI is available. Decisions are stored as metadata entries without recording command text or file contents.

Restricted modes fail closed for unknown custom tools. Default, permissive, yolo, and isolated modes preserve the configured active-tool set, so explicitly installed third-party tools no longer disappear merely because the harness is active.

## Anthropic Pro/Max subscription authentication

Pi 0.80.6 already includes a direct **Anthropic (Claude Pro/Max)** OAuth flow on Windows and Linux; this harness does not copy Claude Code's credential file or reproduce private billing headers.

1. Start Pi and run `/login`.
2. Select **Anthropic (Claude Pro/Max)** and complete the browser login.
3. Select an `anthropic/...` model with `/model`.
4. Run `/anthropic-subscription-status`. The footer should also show `anthropic:subscription`.

This OAuth path is intended to consume the usage included with the authenticated Pro/Max plan rather than an Anthropic API key. Subscription limits are shared with Claude and Claude Code. Anthropic may offer usage credits after the included limit; enabling those credits is metered separately.

To make the harness reject Anthropic prompts unless the selected model has stored OAuth credentials, set:

```bash
# Linux
export PI_HARNESS_ANTHROPIC_SUBSCRIPTION_ONLY=1

# Windows PowerShell
$env:PI_HARNESS_ANTHROPIC_SUBSCRIPTION_ONLY = "1"
```

Do not start Pi with `--api-key` in subscription-only mode. A stored OAuth credential takes precedence over `ANTHROPIC_API_KEY`, but removing that environment variable avoids ambiguity in other Anthropic clients.

## Optional ecosystem integrations

Third-party Pi packages execute with full process access and are not bundled. Review and pin them separately.

- **`pi-landstrip`** — recommended companion for OS-level filesystem and network containment. A compatible integration can answer `audited-harness:sandbox-status-request` or emit `{ active: true, provider: "pi-landstrip" }` on `audited-harness:sandbox-status`.
- **`pi-mcp-adapter`** — opt-in only. Every generic MCP operation is approval-gated by the harness; configure explicit server/tool allowlists rather than `npx ...@latest`.
- **`pi-lens`** — optional real-time diagnostics for teams willing to audit its native tooling, grammar downloads, language servers, and autofix behavior. The dependency-free `validate-change` skill remains the default.
- **`@ayulab/pi-rewind`** — optional checkpoint restoration. Review its overwrite behavior and GPL-3.0 license before installation.

Do not install a second permission extension alongside this policy without deciding which extension owns prompts and configuration.

## Optional notification

Set `PI_HARNESS_NOTIFY=1` to send an OSC 777 terminal notification when the agent settles:

```bash
PI_HARNESS_NOTIFY=1 pi
```

Terminal support varies.

## Session environment

The harness applies an `environment` object from Pi settings to the session's environment variables on startup. Put credentials, feature flags, or tool configuration in `~/.pi/agent/settings.json` (global) and/or `.pi/settings.json` (project):

```json
{
  "environment": {
    "ANTHROPIC_API_KEY": "sk-ant-...",
    "NODE_ENV": "test",
    "LOG_LEVEL": "debug"
  }
}
```

- Values are read from global settings first, then overlaid by project settings (project wins on key conflicts).
- String, number, and boolean values are accepted; numbers and booleans are coerced to strings. Nested objects, arrays, and `null` values are rejected with a startup error.
- Settings values **overwrite** the inherited environment. Use the real shell environment if you need it to take precedence.
- The project layer (`.pi/settings.json`) is applied only after project trust is granted, matching Pi's resource-loading rules. Global settings apply to every session.
- The `ENVIRONMENT` key is accepted as an alias; `environment` (camelCase) is canonical and wins if both are present.
- Applied variables persist for the process, so they are available to shell commands, `$VAR` interpolation in provider configuration, and extension code. Removing a key from settings and reloading does not unset a variable that was applied earlier.

Because values may be secrets, the startup notice reports only the count applied, never the names or values.

## Auto-memory

Claude Code–style persistent project memory, defaulting to the project's `.pi/memory` folder.

- **Storage** — durable context is plain Markdown in `.pi/memory/`: a `MEMORY.md` index plus any number of topic files. Edit them directly, or with `/memory edit [file]`.
- **Loading** — the head of `MEMORY.md` (≤ 200 lines / 25 KB) is injected into the system prompt every turn, so prior memories are available without an explicit read. Topic files are listed by name and read on demand via the `memory` tool.
- **Saving** — the agent is nudged to proactively persist durable facts, preferences, corrections, and decisions that would help a future session, using the sandboxed `memory` tool. There is no write-time approval prompt; review saved memories after the fact with `/memory`.
- **The `memory` tool** — `save` (append, or `append=false` to curate after `read`), `read`, `list`, and `delete`. Writes are confined to the memory directory and the policy treats the tool as a first-party harness tool (trusted, but blocked in `inspect`/`plan`).
- **`/memory` command** — `status` (default), `edit [file]`, `list`, `on`, `off`.
- **Defaults & overrides** — auto-memory is on by default. Disable with `PI_HARNESS_AUTO_MEMORY=0` (alias `PI_HARNESS_DISABLE_AUTO_MEMORY=1`) or `/memory off` for the session. Point memory elsewhere with `PI_HARNESS_MEMORY_DIR` (absolute, `~/`, or project-relative). Project-local memory (the default directory) loads only for trusted projects, like other `.pi/` resources; an explicit `PI_HARNESS_MEMORY_DIR` is an opt-in that bypasses the trust gate.

## Sub-agents

Claude Code–style sub-agents: the parent agent can dispatch a **sub-agent** — a specialized agent
running in its own isolated conversation, with its own system prompt, tools, and model — and receive
back only that sub-agent's final result. Verbose exploration/test/log output stays out of the parent
context.

Three tools are exposed to the agent:

- **`subagent`** — dispatch a sub-agent (`subagent_type`, `prompt`, optional `model`/`thinking`/
  `max_turns`). Foreground by default; `run_in_background: true` returns an agent ID to poll later;
  `inherit_context: true` forks your conversation into the sub-agent; `resume: <id>` continues one.
- **`get_subagent_result`** — poll/wait for a background sub-agent's result (`agent_id`, `wait`,
  `verbose`).
- **`steer_subagent`** — send a mid-run steering message to a running sub-agent.

Built-in types ship with the harness and can be overridden by name (matched case-insensitively):
`general-purpose` (all coding tools), `Explore` (read-only codebase investigation), `Plan` (read-only
planning). `Explore`/`Plan` are one-shot and not resumable.

Define your own as Markdown (YAML frontmatter + body) under `.pi/agents/` (project, trusted only) or
`~/.pi/agent/agents/` (global). The body becomes the agent's specialized system prompt:

```markdown
---
name: researcher
description: Finds and summarizes prior art for a question.
tools: [read, grep, find, ls]
model: haiku
thinking: high
max_turns: 20
---
You are a meticulous research sub-agent. Return a compact, sourced digest.
```

Frontmatter fields: `name` (required; lowercase/digits/hyphens), `description` (required), `tools`
(optional allowlist of built-in tool names — replaces the default set), `model` (optional;
`provider/modelId`, alias, or `inherit`), `thinking` (optional level or `inherit`), `max_turns`
(optional). Project files override global override built-ins; files closer to the working directory
win. Use `/agents` to list registered types and any load diagnostics.

**Safety.** Delegating work to a sub-agent never bypasses the harness policy: every tool call *inside*
a sub-agent is classified by the same `policy-rules.ts` rules against the active mode, so a sub-agent
is blocked or approval-gated exactly as the parent would be (approvals surface in your session). In
`inspect`/`plan` modes sub-agents degrade to read-only tools. Sub-agents may nest up to a depth cap.

Configuration:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_HARNESS_AGENTS_DIR` | `.pi/agents` | Override the project-scope agents directory (bypasses project trust; global still loads) |
| `PI_HARNESS_SUBAGENT_MODEL` | inherit | Default model for sub-agents |
| `PI_HARNESS_SUBAGENT_MAX_TURNS` | `50` | Default turn cap (`0` = uncapped) |
| `PI_HARNESS_SUBAGENT_MAX_DEPTH` | `5` | Nesting depth cap |
| `PI_HARNESS_SUBAGENT_MAX_CONCURRENCY` | `5` | Max concurrent background sub-agents |
| `PI_HARNESS_DISABLE_SUBAGENTS` | unset | `1` disables the feature entirely |

## Security limitations

This package is a guardrail, not a sandbox. Shell syntax is too expressive for regular-expression classification to provide a security boundary, custom tools may conceal effects in unconventional argument shapes, and project code can act maliciously when tests or builds run. The web fetcher's DNS validation reduces SSRF risk but cannot provide the network isolation of an OS sandbox. Extensions execute with Pi's process permissions.

For untrusted repositories or unattended automation, run the entire Pi process inside an OS-level containment boundary with minimal mounts, credentials, and network access. Do not rely on the policy extension to contain hostile code.

## Development

```bash
npm install --ignore-scripts
npm test
npm run check
```

The package intentionally has no runtime dependencies beyond Pi's bundled peer packages.

## License

MIT
