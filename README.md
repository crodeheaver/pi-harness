# Pi Audited Harness

A small, auditable safety and workflow layer for [Pi](https://pi.dev). It adds policy gates, execution modes, structured questions, status visibility, and a few progressively disclosed workflows without replacing Pi's core agent loop.

## Included

### Extensions

- **Safety policy** — blocks direct `write`/`edit` calls outside the workspace and to `.git`, `node_modules`, secret files, and private keys; gates sensitive reads and consequential shell commands.
- **Anthropic subscription status** — shows whether the selected Anthropic model uses Pi's stored Pro/Max OAuth and can fail closed instead of using metered API credentials.
- **Subagent policy bridge** — applies mode, concurrency, turn, model-routing, and approval guardrails when the optional `@gotgenes/pi-subagents` engine is installed.
- **Harness modes** — `/mode inspect|plan|default|permissive|yolo|isolated`.
- **Task profiles** — `/profile [name]` hot-swaps one trusted project profile from `./pi`.
- **`ask_user` tool** — one structured question with an optional free-form answer.
- **Status** — footer indicators for the active mode and policy approvals/blocks.
- **Secure web fetch** — public HTTP(S) text retrieval with redirect, SSRF, timeout, content-type, and size guards; never sends cookies or credentials.
- **Task ledger** — a compact, branch-aware task tool and widget for genuinely multi-step work.
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
pi -e ./extensions/policy.ts \
  -e ./extensions/anthropic-subscription.ts \
  -e ./extensions/subagent-bridge.ts \
  -e ./extensions/structured-question.ts \
  -e ./extensions/presets.ts \
  -e ./extensions/profiles.ts \
  -e ./extensions/status.ts \
  -e ./extensions/web-fetch.ts \
  -e ./extensions/tasks.ts \
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
- MCP operations, subagent control, mutating custom tools, and any third-party tool not on the harness allowlist
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

## Optional subagents

The harness supports [`@gotgenes/pi-subagents`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-subagents) as an optional engine. It is not bundled or installed automatically: third-party Pi extensions execute with the user's full process authority.

Review the package, then install the audited version explicitly:

```bash
pi install npm:@gotgenes/pi-subagents@18.0.1
```

The bridge recognizes the engine's `subagent` tool and child lifecycle events. Defaults are intentionally conservative:

- no subagents in `inspect` or `plan` modes;
- at most 2 active or starting agents;
- at most 20 turns per invocation;
- foreground execution by default (background requests require a distinct policy approval);
- model overrides rejected unless they exactly match the parent model;
- only the reviewed `Explore`, `Plan`, and `general-purpose` built-ins enabled by default;
- `Explore` and `Plan` treated as read-only roles; `general-purpose` requires mutation-capable-agent approval;
- child sessions inherit loaded harness extensions, so child tool calls remain subject to policy;
- nested delegation remains disabled by the engine's recursion guard.

Limits can be adjusted before starting Pi:

```bash
PI_HARNESS_SUBAGENT_MAX_CONCURRENT=2
PI_HARNESS_SUBAGENT_MAX_TURNS=20
# Explicitly permit a different child model or reviewed custom roles when needed:
PI_HARNESS_SUBAGENT_ALLOW_MODEL_OVERRIDE=1
PI_HARNESS_SUBAGENT_ALLOW_CUSTOM_AGENTS=1
```

Accepted ranges are 1–16 concurrent agents and 1–100 turns. Invalid values fall back to the defaults. The bridge clamps `max_turns`; it does not silently increase a smaller requested limit. Custom agents are disabled because their authoritative frontmatter can override call-site model and turn settings. Enabling them transfers responsibility for those fields to the reviewed agent definition.

The engine's bundled `Explore` role currently pins an Anthropic Haiku model in its own agent definition. Agent frontmatter takes precedence over a call-site model value, so teams requiring strict parent-model inheritance should override that role in a reviewed user or project agent definition. The harness's Anthropic subscription-only check still applies before an Anthropic child prompt is sent.

Child sessions are isolated contexts, not security sandboxes. In-process children share Pi's OS permissions, credentials, mounts, and network access. For untrusted repositories or unattended delegation, contain the entire parent Pi process in an OS-level sandbox. Git worktrees prevent edit collisions but are not a security boundary.

## Optional ecosystem integrations

Third-party Pi packages execute with full process access and are not bundled. Review and pin them separately.

- **`pi-landstrip`** — recommended companion for OS-level filesystem and network containment. A compatible integration can answer `audited-harness:sandbox-status-request` or emit `{ active: true, provider: "pi-landstrip" }` on `audited-harness:sandbox-status`.
- **`pi-mcp-adapter`** — opt-in only. Every generic MCP operation is approval-gated by the harness; configure explicit server/tool allowlists rather than `npx ...@latest`.
- **`@gotgenes/pi-subagents`** — recommended opt-in engine; the harness bridge adds conservative limits and policy integration. Pin and review it separately.
- **`pi-lens`** — optional real-time diagnostics for teams willing to audit its native tooling, grammar downloads, language servers, and autofix behavior. The dependency-free `validate-change` skill remains the default.
- **`@ayulab/pi-rewind`** — optional checkpoint restoration. Review its overwrite behavior and GPL-3.0 license before installation.

Do not install a second permission extension alongside this policy without deciding which extension owns prompts and configuration.

## Optional notification

Set `PI_HARNESS_NOTIFY=1` to send an OSC 777 terminal notification when the agent settles:

```bash
PI_HARNESS_NOTIFY=1 pi
```

Terminal support varies.

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
