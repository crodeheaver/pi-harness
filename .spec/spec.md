# Sub-Agent Framework for the Pi Audited Harness

## Summary

This feature adds a Claude Code–style **sub-agent framework** to the `pi-audited-harness`
package: the parent agent can dispatch a **sub-agent** — a specialized agent running in its own
isolated conversation, with its own system prompt, tools, and model — to handle a self-contained
task, and receive back only that sub-agent's final result. Users define custom agents as Markdown
files under `.pi/agents/` (project) and `~/.pi/agent/agents/` (global). The framework exposes three
tools to the parent LLM — `subagent` (dispatch), `get_subagent_result` (retrieve/background poll),
and `steer_subagent` (mid-run course correction) — and ships built-in agent types (`general-purpose`,
`Explore`, `Plan`) that users can override by name.

The design follows Claude Code's established sub-agent conventions (Markdown + YAML-frontmatter
definitions, isolated context by default, parent sees only the final summary, nesting with a depth
cap, per-agent model, background/resume/steer lifecycle), adapted to Pi's extension model and
**hard-bound to this harness's safety policy**: delegating work to a sub-agent must never bypass the
harness's mode restrictions, path protections, or command-approval gates.

## Problem & motivation

Pi intentionally ships without sub-agents (Pi README: *"Pi ships with powerful defaults but skips
features like sub agents and plan mode"*). The audited harness already ports other Claude Code
concepts (auto-memory). Without sub-agents, the parent agent must do every exploration, research,
and implementation step in its own single, ever-growing context window — paying for and cluttering
that context with verbose tool output (file dumps, search results, build logs) that the user largely
does not need to see again. Sub-agents solve this: a focused agent does the noisy work in a separate
context and returns only a compact result.

The harness ports this concept *because* its identity is safety: a naive "just spawn an unrestricted
child agent" port would let a task sidestep every guardrail by delegating. This spec therefore makes
policy inheritance a first-class requirement rather than an afterthought.

## Goals & success metrics

**Goals**
- Let the parent agent delegate a well-scoped task to a sub-agent that runs in an isolated context
  and returns a compact result, keeping verbose intermediate output out of the parent's context.
- Let users (and the package) define specialized agents as portable Markdown files.
- Support the lifecycle the existing harness workflow skills already assume: foreground dispatch,
  background dispatch, result polling, mid-run steering, and resume.
- Enforce the harness safety policy inside every sub-agent, so delegation is never a policy bypass.

**Success metrics**
- Dispatching a read-heavy task to an `Explore` sub-agent returns a correct summary while the parent
  LLM context grows by only that summary — the sub-agent's verbose tool output stays out of the parent
  context (live progress may still be shown in the UI per REQ-017).
- A sub-agent that attempts a policy-prohibited action (e.g. writing to `.git`, running `rm -rf ~/`,
  acting in `inspect` mode) is blocked or approval-gated exactly as the parent would be.
- Multiple background sub-agents run concurrently and their results are retrieved independently.
- An agent file added/edited under `.pi/agents/` is picked up without restarting Pi.

## Non-goals

- **Process or OS-level isolation.** Sub-agents run in the same Pi process and are bounded by the
  harness policy, not by a sandbox. This matches the rest of the harness (a guardrail, not a sandbox).
- **Cross-harness agent portability standard.** No external standard for agent definitions exists
  (only the Agent Skills standard, which covers *skills*, not *agents*). We follow Claude Code's
  conventions; we do not pursue a new standard.
- **Persistent / cross-session sub-agent transcripts.** v1 keeps sub-agent runs in-memory and scoped
  to the parent session. Resume works within the session; resuming a sub-agent in a later Pi session
  is not supported. (Time-based transcript cleanup à la Claude Code is out of scope.)
- **Worktree / git-isolation**, **per-agent MCP server connection**, **per-agent hooks**, **per-agent
  persistent memory scopes**, **`effort` field**, and **`disallowedTools` denylist**. These Claude
  Code features are deferred; v1 supports a focused frontmatter set (see Data model).
- **Auto-routing / auto-delegation.** The parent LLM chooses the agent type explicitly via
  `subagent_type`; the harness does not intercept and re-route prompts.
- **A `/agents` management UI.** Agent files are plain Markdown edited directly or reloaded on change.

## Users / consumers

- **The parent agent (LLM)** — calls `subagent`, `get_subagent_result`, and `steer_subagent`.
- **End users** — author custom agent files and observe sub-agent activity in the TUI.
- **Harness workflow skills** (e.g. `implementation-orchestrator`, `codebase-explorer`) — dispatch
  specialized sub-agents and consume their results; these skills already assume this surface exists.

## Functional requirements

### Agent definitions: format, discovery, precedence

**REQ-001 (MUST)** — An agent is defined as a single Markdown file with YAML frontmatter. The
frontmatter holds metadata and configuration; the Markdown body (after the frontmatter) becomes that
agent's **system prompt** (appended to Pi's baseline agent instructions, not a wholesale replacement).
- *Acceptance:*
  - Given a file `.pi/agents/researcher.md` whose body is `You are a meticulous researcher.`, when the
    parent dispatches `subagent_type: "researcher"`, then the spawned sub-agent's system prompt
    contains `You are a meticulous researcher.` and Pi's baseline tool-use/environment instructions.
  - A file with no frontmatter, or with empty frontmatter, is still valid as long as it has a `name`
    (see REQ-003); its body becomes the system prompt.

**REQ-002 (MUST)** — The framework discovers agent files from these locations:
  - Project: `<cwd>/.pi/agents/**/*.md` and, walking up from `cwd` to the **repository root** (the git
    top-level directory, or the filesystem root when not inside a git repo — matching Pi's own
    `.agents/skills` walk), every `.pi/agents/**/*.md` found. When the same `name` is defined in
    multiple of these directories, the one **closest to `cwd`** wins.
  - Global: `~/.pi/agent/agents/**/*.md`.
  - Precedence, highest to lowest: **project (closest-to-cwd) → global → built-in**. A user file
    whose `name` matches a built-in type overrides that built-in.
  - **Name matching is case-insensitive** for dispatch and override resolution: `subagent_type:
    "explore"` resolves the same as `"Explore"`. A user-defined `name: explore` therefore overrides
    the built-in `Explore`. (Canonical built-in names are exceptions to REQ-003's lowercase rule.)
- *Acceptance:*
  - Given a global `explorer.md` and a project `.pi/agents/explorer.md` with the same `name`, the
    project definition is used.
  - Given a project file with frontmatter `name: explore`, dispatching `subagent_type: "explore"` or
    `"Explore"` uses the project file, overriding the built-in `Explore`.
  - Given `.pi/agents/x.md` at the repo root and `subdir/.pi/agents/x.md` deeper, dispatching from
    `subdir/` resolves to the deeper (closest-to-cwd) definition.
  - Files are discovered recursively within an `agents/` directory (subfolders allowed); for
    project/global scope the subfolder path does not affect identity — only the frontmatter `name`.

**REQ-003 (MUST)** — Frontmatter fields for v1:
  - `name` (string, **required**): lowercase letters, digits, and hyphens; must be unique (case-insensitively)
    across the merged registry. This is the `subagent_type` value and the sole identity of the agent
    (filename and subfolder are irrelevant for project/global scope). User-defined names are
    lowercase+digits+hyphens; the framework's built-in names (`general-purpose`, `Explore`, `Plan`)
    are exceptions, matched case-insensitively (see REQ-002).
  - `description` (string, **required**): one to two sentences describing what the agent is for and
    when to use it; shown to the parent LLM in the system prompt so it can choose the right type.
  - `tools` (array of tool-name strings, optional): allowlist of tools the agent may use. Omitting
    it means "inherit the default sub-agent tool set" (see REQ-009).
  - `model` (string, optional): `provider/modelId`, a fuzzy alias (`haiku`, `sonnet`, `opus`), or the
    literal `inherit`. Omitting it means inherit.
  - `thinking` (one of `off|minimal|low|medium|high|xhigh`, optional, or `inherit`): thinking level.
  - `max_turns` (non-negative integer, optional): turn cap for this agent.
- *Acceptance:*
  - A file missing `name` or `description` is rejected with a single diagnostic naming the file and
    the missing field; it is not registered.
  - An invalid `name` (e.g. uppercase, spaces) is rejected with a diagnostic.
  - Unknown frontmatter fields produce a warning diagnostic but do not prevent registration.
  - `tools`, `model`, `thinking`, and `max_turns` each take effect when the agent is dispatched
    (verified via REQ-009/010/011/012).

**REQ-004 (MUST)** — Project-local agent files (`.pi/agents/**`) load **only when the project is
trusted** (`ctx.isProjectTrusted()`), identical to how the harness treats other `.pi/` resources
(e.g. memory). Global files always load. An explicit opt-in path via environment
(`PI_HARNESS_AGENTS_DIR`, absolute/`~/`/project-relative) bypasses the trust gate exactly as
`PI_HARNESS_MEMORY_DIR` does for memory.
- *Acceptance:* in an untrusted project with no env override, project agent files are not discovered
  and dispatching their types fails with a "not found" message; global agents still work.

**REQ-005 (MUST)** — Agent definitions are re-discovered without a Pi restart: a `/reload` always
re-discovers synchronously, and the registry is refreshed on the next agent run (so an agent file
added mid-session becomes available for the next dispatch). A native filesystem watcher that updates
the registry within seconds of an on-disk change is a **SHOULD** (best-effort, where the host supports
it); it is not required for correctness.
- *Acceptance:* with Pi running, adding `.pi/agents/linter.md` then issuing `/reload` makes
  `subagent_type: "linter"` dispatchable without restarting Pi; without `/reload`, the file is picked
  up on the next agent run.

**REQ-006 (MUST)** — Duplicate `name` within the *same* directory is a load error: only one is
registered and a diagnostic identifies the conflict. Across the precedence stack the higher-precedence
definition silently wins (per REQ-002).
- *Acceptance:* two files in the same `.pi/agents/` with `name: review` produce a diagnostic; the
  registry contains at most one `review`.

### Registry & system-prompt injection

**REQ-007 (MUST)** — On agent run start, the framework injects a concise **agent registry** block into
the parent's system prompt listing every available agent type (built-in and discovered), each with its
`name` and `description`, plus a short note on `subagent_type` selection, background dispatch, and
result/steering tools. This block is injected only when the `subagent` tool is active for the parent
(i.e. the parent is not itself at the depth cap).
- *Acceptance:* the parent system prompt, after `before_agent_start`, contains each registered agent's
  name and description; when the `subagent` tool is inactive (parent at max depth) the block is absent.

### The `subagent` tool — dispatch

**REQ-008 (MUST)** — The framework registers a tool named `subagent` that dispatches a sub-agent. Its
parameters are:
  - `prompt` (string, required): the task for the sub-agent.
  - `description` (string, required): a short (3–5 word) **task label** shown in the UI (distinct from
    an agent definition's `description` field). The 3–5 word length is a soft hint; longer values are
    displayed as given (truncated only for inline display) and are not validated.
  - `subagent_type` (string, optional, default `general-purpose`): the agent `name` to use (built-in
    or discovered, matched case-insensitively). An unknown value returns an error listing the
    available types.
  - `model` (string, optional): per-call model override.
  - `thinking` (enum, optional): per-call thinking-level override.
  - `max_turns` (integer, optional): per-call turn cap.
  - `run_in_background` (boolean, optional, default `false`): return an agent ID immediately.
  - `resume` (string, optional): an agent ID to resume (see REQ-014).
  - `inherit_context` (boolean, optional, default `false`): fork the parent's conversation into the
    sub-agent's initial context (see REQ-013).
- *Acceptance:* the tool is present in the parent's tool list (when not depth-capped) with these
  parameters; dispatching with `subagent_type` referring to a non-existent agent returns an error
  result naming the unknown type and listing the available types.

**REQ-009 (MUST)** — A sub-agent's **effective tool set** is computed as follows:
  1. Start from the **built-in coding tools** (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`).
     In v1, sub-agents run in an isolated session that does **not** load the harness extensions, so
     harness-provided tools (`memory`, `web_fetch`, `ask_user`, `task`) are not inherited; an agent's
     `tools` allowlist may therefore name only built-in coding tools (D16).
  2. If the agent definition declares a `tools` allowlist, that allowlist **replaces** the default set
     (it does not intersect). An empty allowlist `tools: []` means "no tools." Names not in the
     built-in set are dropped.
  3. When the agent's **own** depth is below the cap, add the dispatch tools (`subagent`,
     `get_subagent_result`, `steer_subagent`); when its own depth equals the cap, they are absent
     (see REQ-015).
  4. Remove any tool not permitted by the active harness mode (see REQ-023 / REQ-022): in
     `inspect`/`plan`, only `read`, `grep`, `find`, `ls` remain.
If the effective set is empty after step 4, dispatch fails with a clear error (an agent with no usable
tools cannot do agentic work).
- *Acceptance:*
  - A `general-purpose` sub-agent (no `tools` field) can use `read`/`bash`/`edit`/etc.
  - A sub-agent whose definition declares `tools: [read, grep, find, ls]` can call exactly those tools
    (mode permitting) and cannot `edit`/`write`.
  - A sub-agent whose own depth equals the depth cap has no `subagent` tool.
  - A sub-agent whose effective tool set is empty after mode restriction (e.g. an allowlist of
    mutation tools in `inspect` mode) fails to dispatch with an explanatory error.

**REQ-010 (MUST)** — Model resolution order, first match wins: per-call `model` parameter → the agent
definition's `model` field → the `PI_HARNESS_SUBAGENT_MODEL` environment variable → **inherit the
parent's current model**. The literal value `inherit` at any source means "use the parent's model."
Model values may be `provider/modelId` or a fuzzy alias resolved through Pi's model registry. A model
that has no available API key falls back to the parent's model and emits a diagnostic.
- *Acceptance:* dispatching with `model: "haiku"` runs the sub-agent on a Haiku-class model;
  dispatching with no model and no `PI_HARNESS_SUBAGENT_MODEL` runs on the parent's model.

**REQ-011 (MUST)** — Thinking-level resolution order: per-call `thinking` → agent definition
`thinking` → **inherit the parent's current thinking level**. The level is clamped to the resolved
model's capabilities (a non-reasoning model always uses `off`).
- *Acceptance:* a sub-agent dispatched with `thinking: "high"` on a reasoning model runs at high; on a
  non-reasoning model it runs at `off` with no error.

**REQ-012 (MUST)** — A per-agent or per-call **turn cap** bounds execution. Resolution: per-call
`max_turns` → agent `max_turns` → `PI_HARNESS_SUBAGENT_MAX_TURNS` (default `50`). A value of `0` means
uncapped. When the cap is reached the sub-agent is stopped gracefully and the result returned to the
parent includes a note that the turn cap was hit.
- *Acceptance:* dispatching with `max_turns: 1` on a task that needs multiple tool calls returns after
  one agentic turn with a "turn cap reached" note in the result.

### Context isolation, fork, resume, steering

**REQ-013 (MUST)** — By default a sub-agent starts with a **fresh, isolated context**: it does not see
the parent's message history, previously read files, or invoked skills — only its own system prompt,
the task `prompt`, and the environment (cwd, etc.). When `inherit_context: true` is passed, the
sub-agent's initial context is seeded with a copy of the parent's current conversation branch at
dispatch time (a "fork"); the forked sub-agent's subsequent tool calls still do not appear in the
parent — only its final result returns.
- *Acceptance:*
  - A default sub-agent asked "what files were just read?" cannot answer from the parent's history.
  - An `inherit_context: true` sub-agent asked to summarize the parent's conversation so far can do so
    from the forked history, while the parent's own context is unaffected by the sub-agent's reads.

**REQ-014 (MUST)** — Every dispatch creates an **agent ID** (opaque string). `resume` (an agent ID)
continues an existing sub-agent with a new `prompt`, preserving that sub-agent's own conversation
history. Resume is scoped to the current parent session (in-memory); resuming an ID unknown to the
session, or resuming a one-shot built-in (`Explore`/`Plan`) ID, returns an error.
- *Acceptance:* dispatch returns an agent ID; a second dispatch with `resume: <that id>` and a new
  prompt continues the same sub-agent (it retains its earlier conclusions), and the parent receives
  the new final result. Resuming an `Explore`/`Plan` ID returns an error.

**REQ-015 (MUST)** — Sub-agents may spawn further sub-agents, up to a fixed **depth cap** of
`PI_HARNESS_SUBAGENT_MAX_DEPTH` (default `5`), counted across foreground and background levels. A
sub-agent at the cap does not receive the `subagent` tool (per REQ-009b). Depth is measured relative to
the top-level parent session.
- *Acceptance:* with the default cap, a chain parent → sub → sub → sub → sub → sub is allowed, and the
  fifth-level sub-agent's tool list has no `subagent` tool, preventing a sixth level.

### Return value & progress

**REQ-016 (MUST)** — A **foreground** dispatch blocks until the sub-agent finishes and returns, as the
tool result, only the sub-agent's **final assistant text** (its summary/answer) — never its
intermediate tool calls or tool outputs. If the sub-agent produced no final assistant text, an empty
result is returned with a note.
- *Acceptance:* dispatching an `Explore` sub-agent to "find all callers of `foo()`" returns a textual
  summary; the parent's received tool result does not contain the sub-agent's `grep`/`read` outputs.

**REQ-017 (SHOULD)** — While a sub-agent runs (foreground or background), the framework streams
**concise progress** to the parent UI via the tool's update channel — at minimum the agent type, a
turn counter, and a one-line last-action hint — **without** putting that detail into the parent LLM's
final tool-result context (only the final summary per REQ-016 goes to the LLM). The dispatch tool also
provides custom TUI rendering (`renderCall`/`renderResult`, per house style) showing the agent type
and the task label for the call, and the result summary (or current status) for the result.
- *Acceptance:* during a foreground dispatch the UI shows live progress (e.g. "Explore · turn 3 ·
  reading src/"); the value ultimately returned to the LLM is just the final summary; the transcript
  entry for the call shows the agent type and task label.

**REQ-018 (MUST)** — If a sub-agent ends due to an error (e.g. provider/API failure, abort), the
returned result clearly distinguishes **error** from success and includes any partial final text, so
the parent is never fed an error message as if it were findings.
- *Acceptance:* a sub-agent whose model call fails returns an `isError` tool result whose text says
  the run failed (with any partial output), not a bare error string presented as a normal answer.

### Background, result retrieval, steering

**REQ-019 (MUST)** — `run_in_background: true` starts the sub-agent and returns its **agent ID**
immediately without blocking; the parent may continue other work. Multiple background sub-agents may
run concurrently up to a cap of `PI_HARNESS_SUBAGENT_MAX_CONCURRENCY` (default `5`); a background
dispatch that would exceed the cap is queued (returns its ID; runs when a slot frees) rather than
erroring. Foreground dispatches are not counted against the background cap.
- *Acceptance:* dispatching two background sub-agents returns two distinct IDs promptly and the
  parent is not blocked; both run concurrently. With the cap at the default and five background
  agents already running, a sixth returns an ID but does not start until a slot frees.

**REQ-020 (MUST)** — The `get_subagent_result` tool takes `agent_id` (required), `wait` (boolean,
default `false`), and `verbose` (boolean, default `false`). With `wait: false` it returns the current
status (running/completed/errored) and, if completed, the final result. With `wait: true` it blocks
until that sub-agent finishes (or errors) then returns the result. `verbose: true` additionally
returns the sub-agent's full conversation transcript for debugging; the default returns only the final
summary.
- *Acceptance:* calling `get_subagent_result` with a running ID and `wait: false` returns a "running"
  status without blocking; with `wait: true` it returns the final summary after completion.

**REQ-021 (MUST)** — The `steer_subagent` tool takes `agent_id` (required) and `message` (required)
and delivers a steering message to a **running** sub-agent, applied after its current turn. Steering a
sub-agent that is not running returns an error.
- *Acceptance:* while a background sub-agent runs, calling `steer_subagent` with a new instruction
  changes the sub-agent's subsequent behavior; steering an already-finished ID returns an error.

### Safety & policy integration (binding)

**REQ-022 (MUST)** — Policy enforcement is **structural**, not dependent on hook propagation: the
`subagent` tool's own execute path MUST classify every tool call made inside the spawned sub-agent
through the harness's existing exported rule functions (`classifyCommand`, `classifyFileTool`,
`classifyCustomTool` from `extensions/policy-rules.ts`) against the **parent's active harness mode**.
The resolved mode, current `cwd`, and approval store are inherited from the parent session. Delegating
work to a sub-agent MUST NOT enable any action the parent could not perform directly under the current
mode. Confirm-category decisions surface in the **parent session's** UI and use the parent session's
approval store; if no interactive UI is available (non-interactive `print`/`json` mode),
confirm-category calls auto-block (fail-closed), identical to the parent.
- *Acceptance:*
  - In `default` mode, a sub-agent attempt to `write` to `.git/config` is blocked, and a sub-agent
    `bash` `rm -rf ~/x` is blocked — identically to the parent — because the execute path classified
    them via the rule functions before the sub-agent's tool ran.
  - In `default` mode, a sub-agent `bash` invocation matching a confirm-category (e.g. `npm install`)
    surfaces the same approval prompt in the parent session's UI; if denied, the sub-agent receives
    the denial as its tool result (and may adapt), exactly as the parent would.
  - With no interactive UI, a confirm-category sub-agent call auto-blocks rather than hanging or
    silently proceeding.

**REQ-023 (MUST)** — Sub-agents honor restricted modes by construction: in `inspect` and `plan` modes
the sub-agent's effective tool set excludes every mutation/shell tool the policy forbids in those
modes (the sub-agent simply does not receive those tools), so a sub-agent cannot mutate in a read-only
session. Restricted modes **degrade** the sub-agent's tools to the read-only set; they do not block
dispatch.
- *Acceptance:* in `inspect` mode, even a `general-purpose` sub-agent can only use read-only tools and
  cannot `bash`/`edit`/`write`; dispatch still succeeds for read-only tasks.

**REQ-024 (MUST)** — The three dispatch tools are added to the policy's read-only and first-party
categories so they are neither blocked nor spuriously approval-gated: `subagent`,
`get_subagent_result`, and `steer_subagent` are added to the `READ_ONLY_CUSTOM_TOOLS` set (so
`inspect`/`plan` permit them, since REQ-023 guarantees any spawned sub-agent is read-only in those
modes) and to the `HARNESS_FIRST_PARTY_TOOLS` set (so `default` mode does not prompt on every dispatch
— they are trusted harness tools, like `memory`). There is no "blocked because it would require tools
the mode forbids" case, because REQ-023 degrades the tool set rather than blocking dispatch. This is a
companion edit to `extensions/policy-rules.ts` (see Harness integration contract).
- *Acceptance:* in `inspect` mode the parent dispatches an `Explore` sub-agent with no approval prompt;
  in `default` mode dispatching a `general-purpose` sub-agent requires no approval prompt.

**REQ-025 (MUST)** — Cancellation/abort propagates: if the parent's run is aborted (e.g. user presses
Esc, or the parent turn is cancelled), any running foreground sub-agent is aborted; background
sub-agents are aborted on session shutdown. Sub-agents must not outlive the parent session.
- *Acceptance:* aborting the parent mid-dispatch stops the foreground sub-agent and the tool returns
  promptly with an aborted result; on session shutdown no sub-agent process/handle leaks.

### Observability

**REQ-026 (SHOULD)** — Observability: (a) the framework records harness audit entries for sub-agent
lifecycle (dispatch/completion/error/block) via `pi.appendEntry("audited-harness:audit", …)` using the
existing audit event shape (`{outcome, category, tool, scope, timestamp}`) and emits on the `pi.events`
bus; (b) it sets a footer status showing the active sub-agent count while one or more are running,
clearing on completion; (c) a `/agents` command lists registered agent types (built-in + discovered)
with source paths and any load diagnostics.
- *Acceptance:* dispatching a sub-agent produces an audit entry visible to the status extension; while
  a sub-agent runs the footer shows a non-zero active count that clears on completion; `/agents` lists
  all registered types.

## Interfaces & contracts

This is the externally observable surface — the contract the implementation must honor. Internal data
structures (how sub-agent sessions are held, how messages are converted) are implementation details.

**Tools exposed to the parent LLM** (only when the parent is not at the depth cap):
- `subagent(prompt, description, subagent_type, model?, thinking?, max_turns?, run_in_background?,
  resume?, inherit_context?)` → foreground: final summary text (REQ-016); background: agent ID
  (REQ-019).
- `get_subagent_result(agent_id, wait?, verbose?)` → status and/or final result (REQ-020).
- `steer_subagent(agent_id, message)` → acknowledgement or error (REQ-021).

**Agent file contract** (REQ-001/003): Markdown + YAML frontmatter; required `name`, `description`;
optional `tools`, `model`, `thinking`, `max_turns`; body = system prompt. Locations and precedence per
REQ-002. Trust gating per REQ-004.

**Harness integration contract**: a new extension file under `extensions/` (conventionally
`extensions/subagents.ts`) following the existing extension style (default-export factory
`(pi: ExtensionAPI) => void`, pure exported helpers for unit testing, `CONFIG_DIR_NAME`-relative
paths, mode tracking via `pi.events.on("audited-harness:mode")`, `ctx.isProjectTrusted()` gating,
`before_agent_start` prompt injection, `registerTool`/`registerCommand`). It is added to
`package.json`'s `pi.extensions` list. It imports the shared policy rule functions rather than
duplicating them. It also requires a small companion edit to `extensions/policy-rules.ts` to register
the three dispatch tools in the `READ_ONLY_CUSTOM_TOOLS` and `HARNESS_FIRST_PARTY_TOOLS` sets
(REQ-024). Project discovery uses `.pi/agents/` (the `.pi` config dir); global discovery uses
`~/.pi/agent/agents/` (Pi's singular global `~/.pi/agent/` directory, the same parent as
`auth.json`/`settings.json`) — the singular-vs-`agents` difference is intentional and matches Pi's
directory layout.

**Configuration / environment variables**:
- `PI_HARNESS_AGENTS_DIR` — overrides the **project-scope** discovery directory (replaces
  `.pi/agents`; global `~/.pi/agent/agents/` still loads). Absolute / `~/` / project-relative path;
  bypasses project trust, mirroring `PI_HARNESS_MEMORY_DIR`.
- `PI_HARNESS_SUBAGENT_MODEL` — default model for sub-agents.
- `PI_HARNESS_SUBAGENT_MAX_TURNS` — default turn cap (default `50`; `0` = uncapped).
- `PI_HARNESS_SUBAGENT_MAX_DEPTH` — nesting depth cap (default `5`).
- `PI_HARNESS_SUBAGENT_MAX_CONCURRENCY` — maximum concurrent background sub-agents (default `5`).
- `PI_HARNESS_DISABLE_SUBAGENTS` — `1` disables the feature entirely (registers no tools), mirroring
  the `PI_HARNESS_DISABLE_*` convention.

**Slash command**: `/agents` — lists registered agent types (built-in + discovered) with source paths
and any load diagnostics; see REQ-026.

## Data model / key entities

- **AgentDefinition**: `{ name: string; description: string; systemPrompt: string; tools?: string[];
  model?: string; thinking?: ThinkingLevel|'inherit'; maxTurns?: number; source: {path, scope} }`.
- **Built-in agents** (registered unless overridden by a user/project file of the same `name`, matched
  case-insensitively):
  - `general-purpose` — default sub-agent tool set; inherits model; for complex multi-step tasks.
    Resumable.
  - `Explore` — read-only tools (`read`, `grep`, `find`, `ls`); inherits model; for
    codebase search and mapping. One-shot (not resumable).
  - `Plan` — read-only tools (`read`, `grep`, `find`, `ls`); inherits model; for
    planning/research. One-shot (not resumable).
- **Agent run / handle** (in-memory, per parent session): `{ id: string; type: string; depth: number;
  background: boolean; status: 'running'|'completed'|'errored'|'aborted'; finalText?: string }`.
- **Depth**: integer ≥ 1 for the top-level parent's direct children; incremented per nesting level.

## Constraints

- **[Constraint: host platform]** Must integrate as a Pi extension within the `pi-audited-harness`
  package (Node/TypeScript, ESM, no runtime deps beyond Pi's peer packages), loaded via
  `package.json` `pi.extensions`. Rationale: this is a harness feature, not a standalone product.
- **[Constraint: policy parity]** Sub-agent tool calls must be classified by the *existing* exported
  rule functions in `extensions/policy-rules.ts`; the policy must not be reimplemented or weakened.
- **[Constraint: process model]** Sub-agents run in-process (same Node process as Pi). No subprocess or
  OS sandbox is introduced. Rationale: matches the harness's stated "guardrail, not sandbox" model.
- **[Constraint: terminology]** Use the spelling **sub-agent** in prose and **subagent** in tool/identifier
  names, matching Claude Code's current naming and the existing harness tool descriptions.

## Edge cases & error handling

- Unknown `subagent_type` → error result listing available types.
- Unknown `resume` / `agent_id` / `steer` target → error result ("no such agent / not running").
- Agent file missing required fields or invalid `name` → diagnostic; not registered; dispatch of that
  type reports it unavailable.
- Resolved model has no API key → fall back to parent model + diagnostic (REQ-010).
- Sub-agent hits the turn cap → stop, return partial result + "turn cap reached" note (REQ-012).
- Sub-agent at depth cap → no `subagent` tool (REQ-015); an attempt to nest deeper is impossible.
- Sub-agent tool call blocked/declined by policy → the call is denied inside the sub-agent (the
  sub-agent sees the denial reason as its tool result and can adapt), exactly as the parent would.
- Parent aborted mid-foreground-dispatch → sub-agent aborted, prompt tool return (REQ-025).
- Fork (`inherit_context: true`) combined with `resume` → not allowed; `resume` ignores fork and
  continues the existing sub-agent's history (fork only seeds a *new* sub-agent).
- Background sub-agent still running at `get_subagent_result` with `wait:false` → "running" status.
- Concurrent edits to the same agent file during a run → the running sub-agent is unaffected (it was
  constructed from the definition at dispatch time); later dispatches see the new content.
- Resuming a one-shot built-in (`Explore`/`Plan`) ID → error.
- Effective tool set empty after mode restriction → dispatch fails with a clear error.
- Confirm-category call raised inside a background sub-agent → surfaces in the parent session UI; if
  no UI is available it auto-blocks (REQ-022).
- No available model at all (parent has no model) → dispatch fails with a clear error.

## Decisions

- **D1 — Follow Claude Code's Markdown+frontmatter format and isolated-by-default model.** Lowest
  friction, proven design; body = system prompt; parent sees only the final summary. (Rationale:
  research-verified conventions; matches user intent.)
- **D2 — Add policy inheritance as a first-class MUST, using the existing rule functions.** A
  delegation must never be a policy bypass; this is the core reason the harness — not Pi core — owns
  this feature. (REQ-022/023/024.)
- **D3 — v1 frontmatter is a focused subset** (`name`, `description`, `tools`, `model`, `thinking`,
  `max_turns`). Claude Code's many other fields (`disallowedTools`, `hooks`, `mcpServers`, `memory`,
  `effort`, `isolation`, `permissionMode`, `skills`, `background`) are explicit non-goals to avoid
  scope creep; they can be added later without breaking the v1 contract.
- **D4 — The sub-agent tool set is the built-in coding tools, restricted by allowlist and mode.**
  v1 runs sub-agents in an isolated session that does not load harness extensions, so harness tools
  (`memory`, `web_fetch`, `ask_user`, `task`) are unavailable by design (D16); an agent's `tools`
  allowlist names built-in coding tools only. (REQ-009.)
- **D5 — Resume is in-session only; transcripts are not persisted.** Right-sizes v1 and avoids a
  disk-growth/cleanup problem; cross-session resume is deferred. (REQ-014, non-goals.)
- **D6 — Model default is "inherit the parent", not a fixed cheap model.** Predictable and avoids
  surprising cost/quality shifts; users opt into cheaper models per agent or via `PI_HARNESS_SUBAGENT_MODEL`.
- **D7 — Turn cap default of 50 and depth cap default of 5.** Bounds cost and recursion; both
  configurable; mirrors Claude Code's fixed depth cap of 5.
- **D8 — Project agents load only for trusted projects; global always.** Consistent with every other
  `.pi/` resource in the harness and Pi's own trust model. (REQ-004.)
- **D9 — The LLM chooses `subagent_type` explicitly; no auto-routing.** Simpler, observable, and
  matches the existing tool-description contract; auto-delegation is a non-goal.
- **D10 — Built-ins `Explore` and `Plan` are one-shot (not resumable); `general-purpose` is resumable.**
  Mirrors Claude Code; one-shot read-only research agents don't need resume state.
- **D11 — Default-mode dispatch tools are first-party (no per-dispatch approval).** The three dispatch
  tools are added to `HARNESS_FIRST_PARTY_TOOLS` (like `memory`) so `default` mode does not prompt on
  every dispatch — the orchestrator/explorer skills dispatch freely, and per-dispatch approvals would
  make the feature unusable. They are also read-only-allowlisted for `inspect`/`plan`. The safety
  boundary is enforced structurally inside each sub-agent (REQ-022/023), not at the dispatch tool.
- **D12 — Case-insensitive name matching; built-in names keep Claude Code's casing.** Dispatch and
  override resolution match `name` case-insensitively so a lowercase user file overrides a capitalized
  built-in; built-ins retain `general-purpose`/`Explore`/`Plan` to match the target contract and
  Claude Code.
- **D13 — An explicit `tools` allowlist replaces (not intersects) the default set**, giving authors
  full control of the (built-in) tool surface.
- **D14 — Background approvals surface in the parent UI; non-interactive modes auto-block.**
  Sub-agents share the parent session's UI and approval store; with no UI, confirms fail closed,
  identical to the parent.
- **D15 — Include `/agents` (SHOULD) and the footer active-count status (SHOULD) in v1** (settles OQ-2).
- **D16 — v1 isolation runs sub-agent sessions with `noExtensions`/`noSkills`.** The harness extensions
  (including this one) are therefore not re-entered (no recursion, no double policy application), and
  the inheritable tools are the built-in coding tools only. This is the safe, faithful v1; selectively
  loading trusted harness tools (e.g. `web_fetch`, `memory`) into sub-agents is future work. The
  agent's body is **appended** to Pi's baseline system prompt (not a wholesale replacement) so the
  sub-agent keeps tool/guideline docs while gaining its specialized instructions.

## Assumptions

- An in-process agent-session mechanism that supports an isolated/in-memory conversation, selectable
  tools, a custom system prompt, model/thinking overrides, and an event stream for progress/turns/idle
  is available to run a sub-agent in-process (Pi's SDK `createAgentSession` with
  `SessionManager.inMemory()` is one such mechanism; verified against Pi's `docs/sdk.md`). The spec
  does not mandate a specific API.
- The parent's current conversation branch is obtainable from the extension/tool context
  (`ctx.sessionManager`) for the `inherit_context` fork case.
- The policy rule functions in `extensions/policy-rules.ts` remain exported and pure, so the new
  extension can reuse them without duplicating classification logic.

## Open questions

None remaining after review. Previously open items are settled in Decisions: OQ-1 (`ask_user`
and other harness tools are unavailable to sub-agents in v1) → D4/D16; OQ-2 (include `/agents` and
footer status) → D15.

## Glossary

- **Sub-agent** — a specialized agent running in its own isolated conversation, spawned by the parent
  (or by another sub-agent) to handle a self-contained task.
- **Agent definition** — a Markdown file (YAML frontmatter + body) that defines a reusable sub-agent
  type; the body is the agent's system prompt.
- **Agent type** — the value passed as `subagent_type`; the frontmatter `name` of a definition, or a
  built-in name (`general-purpose`, `Explore`, `Plan`).
- **Parent** — the agent (session) that dispatches a sub-agent. The top-level parent is the user's Pi
  session; a sub-agent that spawns another is itself the parent of that nested sub-agent.
- **Dispatch** — invoking the `subagent` tool to start (or resume) a sub-agent.
- **Foreground** — a dispatch that blocks the parent until the sub-agent finishes and returns its
  result directly.
- **Background** — a dispatch that returns an agent ID immediately and runs concurrently; the result is
  fetched later via `get_subagent_result`.
- **Fork / `inherit_context`** — a dispatch that seeds the sub-agent's initial context with a copy of
  the parent's current conversation, instead of a fresh window.
- **Resume** — continuing an existing (in-session) sub-agent with a new prompt, keeping its history.
- **Steer** — sending a mid-run course-correction message to a running sub-agent.
- **Depth** — nesting level; the top-level parent's direct children are depth 1.
- **Turn** — one LLM response plus its tool calls within a (sub-)agent run.
- **Agent ID** — an opaque string identifying one in-session sub-agent run/handle.
- **Built-in agent** — an agent type provided by the framework (`general-purpose`, `Explore`, `Plan`),
  overridable by a user/project file of the same `name`.
- **Harness mode** — one of `inspect|plan|default|permissive|yolo|isolated` (see `extensions/policy-rules.ts`).
- **Read-only allowlist** — the set of custom tools the policy permits in `inspect`/`plan` modes
  (`READ_ONLY_CUSTOM_TOOLS` in `policy-rules.ts`); not a single exported list, but the mode-specific
  allow behavior of the `classify*` functions.
- **First-party (harness) tool** — a harness-provided tool trusted without per-call approval in
  unrestricted modes (`HARNESS_FIRST_PARTY_TOOLS`, e.g. `memory`).
- **ThinkingLevel** — Pi's reasoning-effort enum: `off|minimal|low|medium|high|xhigh`.
- **One-shot agent** — a built-in that runs a single dispatch and is not resumable (`Explore`, `Plan`).
- **Fuzzy alias** — a short model name (`haiku`, `sonnet`, `opus`) resolved through Pi's model
  registry, as an alternative to `provider/modelId`.
- **Task label** — the `subagent` tool's `description` parameter; a short UI label for the dispatch,
  distinct from an agent definition's `description` field (which tells the LLM when to use the type).
