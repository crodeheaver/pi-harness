# Module: Command-Line Tools

Fold these sections into the spec spine when specifying a command-line tool or CLI. The contract is the **invocation surface and the I/O behavior** — commands, flags, exit codes, and what goes to stdout vs stderr — because scripts, pipelines, and CI depend on every one of them. Specify those precisely; leave the implementation language open.

## Sections to add

- **Command structure.** Commands and subcommands, positional arguments, and options/flags — with names, types, defaults, and which are required vs optional.
- **Input/output contract.** stdin/stdout/stderr behavior; output formats, distinguishing human-readable output from a machine-readable mode (e.g., `--json`); and verbosity/quiet levels.
- **Exit codes.** The meaning of each exit status. This is the contract scripts and CI branch on, so enumerate it.
- **Configuration precedence.** How flags, environment variables, and config files combine, and which source wins when they conflict.
- **Error & help behavior.** The error-message contract, `--help`/usage output, and what happens on invalid input or missing arguments.
- **Interactivity.** Prompts vs non-interactive/`--yes` behavior, TTY detection, and how the tool behaves when stdin/stdout is a pipe rather than a terminal.
- **Side effects & safety.** What the tool changes on disk or elsewhere, whether it supports a dry-run, and the safeguards on destructive operations.
- **Large/streaming I/O.** Behavior with large inputs or outputs and any progress reporting.

## Cautions & conventions

- The flags, exit codes, and stream behavior are the spec — they are a stability contract for everything that scripts the tool. Specify them precisely.
- Distinguish **human-facing output** (free to change) from **machine-readable output** (a stability contract); say which is which.
- Follow established CLI conventions rather than inventing: POSIX/GNU option syntax, the `-h/--help` and `-v/--verbose` idioms, `0` for success and non-zero for failure, and errors to stderr.
- Prior-art prompt for research: how do widely-used tools in this space structure comparable commands, flags, and exit codes?
