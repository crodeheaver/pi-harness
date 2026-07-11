# Pi Audited Harness

A small, auditable safety and workflow layer for [Pi](https://pi.dev). It adds policy gates, execution profiles, structured questions, status visibility, and a few progressively disclosed workflows without replacing Pi's core agent loop.

## Included

### Extensions

- **Safety policy** — blocks direct `write`/`edit` calls outside the workspace and to `.git`, `node_modules`, secret files, and private keys; gates sensitive reads and consequential shell commands.
- **Execution profiles** — `/harness-profile inspect|plan|develop|isolated`.
- **`ask_user` tool** — one structured question with an optional free-form answer.
- **Status** — footer indicators for the active profile and policy approvals/blocks.
- **Secure web fetch** — public HTTP(S) text retrieval with redirect, SSRF, timeout, content-type, and size guards; never sends cookies or credentials.
- **Task ledger** — a compact, branch-aware task tool and widget for genuinely multi-step work.
- **Plan approval** — a plan profile that restricts writes to one selected plan file until explicit review and approval.

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
  -e ./extensions/structured-question.ts \
  -e ./extensions/presets.ts \
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

## Profiles

| Profile | Tools | Intended use |
| --- | --- | --- |
| `inspect` | Read/search, `ask_user`, `web_fetch`, `task` | Read-only analysis |
| `plan` | Inspect tools plus `write`/`edit` restricted to one plan file | Prepare a human-approved implementation plan |
| `develop` | The tools that were active before entering a restricted profile | Normal work in a trusted repository |
| `isolated` | Same configured tools as develop | Work inside a verified or externally established sandbox |

Switch interactively:

```text
/harness-profile inspect
/harness-profile develop
```

Or at startup:

```bash
pi --harness-profile inspect
```

Plan and approve a change:

```text
/harness-plan .pi/auth-plan.md
# Ask Pi to investigate and write the plan.
/harness-plan-review
```

The review command displays the plan and requires an explicit **Approve and execute** decision before restoring the develop profile and asking Pi to implement it.

The isolated profile accepts a positive `audited-harness:sandbox-status` event from a sandbox integration. For externally established Docker, VM, WSL, Gondolin, or OpenShell boundaries, `PI_HARNESS_ISOLATED=1` remains an explicit assertion. It **does not create isolation**.

## Policy behavior

### Always blocked

- Direct `write`/`edit` calls outside the current workspace
- Direct writes to `.git`, `node_modules`, `.env*`, private keys, and common credential paths
- Obvious filesystem-root deletion, fork bombs, and raw-disk writes
- All mutation and shell execution in the inspect profile

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

Restricted profiles fail closed for unknown custom tools. Develop and isolated profiles preserve the configured active-tool set, so explicitly installed third-party tools no longer disappear merely because the harness is active.

## Optional ecosystem integrations

Third-party Pi packages execute with full process access and are not bundled. Review and pin them separately.

- **`pi-landstrip`** — recommended companion for OS-level filesystem and network containment. A compatible integration can answer `audited-harness:sandbox-status-request` or emit `{ active: true, provider: "pi-landstrip" }` on `audited-harness:sandbox-status`.
- **`pi-mcp-adapter`** — opt-in only. Every generic MCP operation is approval-gated by the harness; configure explicit server/tool allowlists rather than `npx ...@latest`.
- **`pi-subagents`** — opt-in only. Subagent starts and control operations are approval-gated; also configure model, cost, depth, concurrency, and tool limits in that package.
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
