/**
 * Auto-memory extension.
 *
 * Mirrors Claude Code's auto-memory behaviour for this harness:
 * - Durable project context is stored as plain Markdown under a memory
 *   directory (default `<cwd>/.pi/memory`).
 * - The head of `MEMORY.md` is eagerly injected into the system prompt every
 *   turn so prior memories are available without an explicit read.
 * - The agent is nudged to proactively save durable facts/preferences/decisions
 *   for future sessions using the `memory` tool.
 * - Topic files in the memory directory are listed in the prompt and read on
 *   demand; only their names are eager-loaded.
 *
 * Storage stays plain Markdown on disk so users can edit it directly or via the
 * `/memory edit` command. Unlike Claude Code (which points its generic
 * Write/Edit tools at the memory directory), this harness exposes a dedicated,
 * sandboxed `memory` tool: writes are confined to the memory directory, the
 * tool is observable in the transcript, and the safety policy treats it as a
 * first-party harness tool (no per-call approval, blocked in inspect/plan).
 *
 * The memory directory defaults to the project's `.pi/memory` folder. Override
 * with `PI_HARNESS_MEMORY_DIR` (absolute, `~/`, or project-relative). Disable
 * auto-memory with `PI_HARNESS_AUTO_MEMORY=0` (or
 * `PI_HARNESS_DISABLE_AUTO_MEMORY=1`); the `/memory` command toggles it for the
 * session. Project-local memory (the default directory) loads only for trusted
 * projects, matching how Pi treats other `.pi/` resources.
 */
import { readFile, readdir, writeFile, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

/** Canonical index file name, eager-loaded into the system prompt. */
export const MEMORY_FILE = "MEMORY.md";
/** Maximum lines of `MEMORY.md` eager-loaded into the prompt. */
export const MAX_LINES = 200;
/** Maximum bytes of `MEMORY.md` eager-loaded into the prompt. */
export const MAX_BYTES = 25_000;
const TOPIC_TITLE_MAX = 60;
const SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
const SEGMENT_MAX = 80;

export interface MemoryConfig {
	/** Absolute memory directory. */
	dir: string;
	/** Whether auto-memory (eager-load + proactive save nudge) is active. */
	enabled: boolean;
	/** True when the directory came from an explicit env override (skips the project-trust gate). */
	custom: boolean;
}

export interface MemoryFile {
	name: string;
	lines: number;
	title?: string;
}

export interface MemoryDetails {
	action: "save" | "read" | "list" | "delete";
	dir: string;
	enabled: boolean;
	file?: string;
	error?: string;
	saved?: boolean;
	lines?: number;
	files?: MemoryFile[];
}

/**
 * Resolve the memory directory and feature flags from the environment.
 *
 * The default directory is `<cwd>/.pi/memory`. `PI_HARNESS_MEMORY_DIR` overrides
 * it (absolute, `~/`, or project-relative); an explicit override is treated as
 * an opt-in and bypasses the project-trust gate that otherwise guards
 * `.pi/` resources.
 */
export function resolveMemoryConfig(env: NodeJS.ProcessEnv, cwd: string): MemoryConfig {
	const raw = env.PI_HARNESS_MEMORY_DIR;
	let dir: string;
	let custom = false;
	if (raw && raw.trim()) {
		custom = true;
		const expanded = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
		dir = resolve(cwd, expanded);
	} else {
		dir = join(cwd, CONFIG_DIR_NAME, "memory");
	}
	const enabled = env.PI_HARNESS_AUTO_MEMORY !== "0" && env.PI_HARNESS_DISABLE_AUTO_MEMORY !== "1";
	return { dir, enabled, custom };
}

/**
 * Return the eager-loaded head of `MEMORY.md`, capped to {@link MAX_LINES} and
 * {@link MAX_BYTES}. Byte truncation is cluster-safe (it never splits a
 * multibyte sequence in a way that throws).
 */
export function headOf(text: string, maxLines = MAX_LINES, maxBytes = MAX_BYTES): { text: string; truncated: boolean } {
	const lines = text.split(/\r?\n/);
	let head = lines.slice(0, maxLines).join("\n");
	let truncated = lines.length > maxLines;
	if (Buffer.byteLength(head, "utf8") > maxBytes) {
		truncated = true;
		head = Buffer.from(head, "utf8").subarray(0, maxBytes).toString("utf8");
	}
	return { text: head, truncated };
}

/**
 * Resolve a caller-supplied file name to an absolute path inside `dir`.
 *
 * Defaults to {@link MEMORY_FILE}. Rejects absolute paths, parent traversal,
 * empty segments, NUL bytes, unsafe characters, and any result that escapes the
 * memory directory. Subdirectories are allowed (e.g. `notes/api.md`). A `.md`
 * extension is forced when missing.
 */
export function safeMemoryPath(dir: string, file: string | undefined): string {
	const name = (file ?? "").trim();
	if (name.includes("\0")) throw new Error("file name contains a NUL byte");
	const segments = name
		.split(/[\\/]/)
		.map((segment) => segment.trim())
		.filter((segment) => segment.length > 0 && segment !== ".");
	if (segments.length === 0) segments.push(MEMORY_FILE);
	if (isAbsolute(name)) throw new Error("file must be a relative path within the memory directory");
	for (const segment of segments) {
		if (segment === "..") throw new Error("file must stay within the memory directory");
		if (segment.length > SEGMENT_MAX) throw new Error(`file segment too long: ${segment}`);
		if (!SEGMENT_PATTERN.test(segment)) throw new Error(`invalid file name segment: ${segment}`);
	}
	let base = segments.join(sep);
	if (!/\.md$/i.test(base)) base += ".md";
	const full = resolve(dir, base);
	const rel = relative(resolve(dir), full);
	if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
		throw new Error("file escapes the memory directory");
	}
	return full;
}

function countLines(text: string): number {
	if (text === "") return 0;
	let newlines = 0;
	for (const ch of text) if (ch === "\n") newlines++;
	// Matches `wc -l` for files ending in a newline; a final unterminated line still counts.
	return text.endsWith("\n") ? newlines : newlines + 1;
}

function firstMeaningfulLine(text: string): string | undefined {
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim().replace(/^#+\s*/, "").replace(/^[-*]\s+/, "").trim();
		if (trimmed) return trimmed.length > TOPIC_TITLE_MAX ? `${trimmed.slice(0, TOPIC_TITLE_MAX - 1)}…` : trimmed;
	}
	return undefined;
}

/**
 * List the Markdown files in the memory directory with line counts and a
 * best-effort title (first non-empty line). Returns an empty array when the
 * directory does not exist or cannot be read.
 */
export async function listMemoryFiles(dir: string): Promise<MemoryFile[]> {
	let entries: import("node:fs").Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
	} catch {
		return [];
	}
	const names = entries.filter((entry) => entry.isFile() && /\.md$/i.test(entry.name)).map((entry) => entry.name).sort();
	const files: MemoryFile[] = [];
	for (const name of names) {
		try {
			const text = await readFile(join(dir, name), "utf8");
			files.push({ name, lines: countLines(text), title: firstMeaningfulLine(text) });
		} catch {
			files.push({ name, lines: 0 });
		}
	}
	return files;
}

/**
 * Build the system-prompt block describing the memory directory, the
 * eager-loaded `MEMORY.md` head, available topic files, and (when requested)
 * the proactive save instruction.
 */
export function buildMemoryPrompt(opts: {
	cwd: string;
	dir: string;
	head?: string;
	headTruncated?: boolean;
	files: MemoryFile[];
	saveNudge: boolean;
}): string {
	const relDir = relative(opts.cwd, opts.dir) || opts.dir;
	const lines: string[] = ["## Project memory", "", `Durable project context is stored as Markdown under \`${relDir}/\` (auto-memory).`];
	if (opts.head && opts.head.trim()) {
		lines.push("", `### ${MEMORY_FILE}${opts.headTruncated ? " (head, truncated)" : ""}`, "```markdown", opts.head, "```");
	} else {
		lines.push(`No memories saved yet. Use the \`memory\` tool to create \`${MEMORY_FILE}\` when you learn something worth keeping.`);
	}
	const topics = opts.files.filter((file) => file.name !== MEMORY_FILE);
	if (topics.length > 0) {
		lines.push("", "### Topic files (read on demand with the `memory` tool)");
		for (const file of topics) {
			const detail = file.title ? `: ${file.title}` : "";
			lines.push(`- ${file.name} (${file.lines} line${file.lines === 1 ? "" : "s"}${detail})`);
		}
	}
	if (opts.saveNudge) {
		lines.push(
			"",
			`When the user shares a durable fact, preference, correction, or decision that would help a future session in this project, proactively save it with the \`memory\` tool (action \`save\`). Keep \`${MEMORY_FILE}\` as a concise index — one bullet or short section per item — and move lengthy detail into a named topic file with a one-line pointer in \`${MEMORY_FILE}\`. Do not store secrets, transient task state, or anything the user asked to forget. To curate or de-duplicate, \`read\` first, then \`save\` with \`append=false\`.`,
		);
	}
	return lines.join("\n");
}

const Parameters = Type.Object({
	action: StringEnum(["save", "read", "list", "delete"] as const),
	content: Type.Optional(Type.String({ minLength: 1, maxLength: 20_000, description: "Markdown content to save (action: save)" })),
	file: Type.Optional(
		Type.String({
			maxLength: 200,
			description: `Memory file within the memory directory (default ${MEMORY_FILE}); .md extension is forced. Subdirectories allowed.`,
		}),
	),
	append: Type.Optional(Type.Boolean({ description: "Append to the file (default true); false replaces it for curation" })),
});

export default function memoryExtension(pi: ExtensionAPI): void {
	let sessionEnabled = true;
	let mode = "default";

	pi.events.on("audited-harness:mode", (value: unknown) => {
		const next = (typeof value === "string" ? value : (value as { name?: string } | undefined)?.name) ?? "default";
		if (typeof next === "string") mode = next;
	});

	function config(ctx: ExtensionContext): MemoryConfig & { available: boolean } {
		const cfg = resolveMemoryConfig(process.env, ctx.cwd);
		const trusted = cfg.custom || ctx.isProjectTrusted();
		// `/memory on|off` toggles the proactive/auto behaviour for the session.
		const enabled = cfg.enabled && sessionEnabled;
		return { ...cfg, enabled, available: enabled && trusted };
	}

	function renderStatus(ctx: ExtensionContext, cfg: ReturnType<typeof config>) {
		if (!cfg.available) {
			ctx.ui.setStatus("audited-harness:memory", undefined);
			return;
		}
		void listMemoryFiles(cfg.dir).then((files) => {
			const count = files.length;
			ctx.ui.setStatus(
				"audited-harness:memory",
				count > 0 ? ctx.ui.theme.fg("muted", `mem:${count}`) : undefined,
			);
		});
	}

	async function readHead(dir: string): Promise<{ head?: string; truncated?: boolean }> {
		try {
			const text = await readFile(join(dir, MEMORY_FILE), "utf8");
			if (!text.trim()) return {};
			const { text: head, truncated } = headOf(text);
			return { head, truncated };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw error;
		}
	}

	pi.on("session_start", (_event, ctx) => {
		const cfg = config(ctx);
		renderStatus(ctx, cfg);
	});

	pi.on("agent_settled", (_event, ctx) => {
		// Memories may have changed during the turn; refresh the footer count.
		renderStatus(ctx, config(ctx));
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const cfg = config(ctx);
		if (!cfg.available) return;
		const { head, truncated } = await readHead(cfg.dir);
		const files = await listMemoryFiles(cfg.dir);
		// The memory tool is disabled in inspect/plan, so the proactive nudge
		// would reference an unavailable tool; skip it there.
		const saveNudge = mode !== "inspect" && mode !== "plan";
		return { systemPrompt: `${event.systemPrompt}\n\n${buildMemoryPrompt({ cwd: ctx.cwd, dir: cfg.dir, head, headTruncated: truncated, files, saveNudge })}` };
	});

	pi.registerTool({
		name: "memory",
		label: "Memory",
		description:
			"Save and read durable project context (auto-memory) stored as Markdown under .pi/memory. Proactively save facts, preferences, and decisions that would help future sessions. Keep MEMORY.md as a concise index and offload detail into topic files.",
		promptSnippet: "Persist durable project context to .pi/memory for future sessions",
		promptGuidelines: [
			"Use memory to save durable facts, preferences, corrections, and decisions the user shares that would help future sessions — never transient task state or secrets.",
			"Keep MEMORY.md a concise index; move long detail into a named topic file and add a one-line pointer in MEMORY.md; read before rewriting (append=false).",
		],
		parameters: Parameters,
		async execute(_id, params, _signal, _update, ctx) {
			const cfg = config(ctx);
			const details = (over: Partial<MemoryDetails> = {}): MemoryDetails => ({
				action: params.action,
				dir: cfg.dir,
				enabled: cfg.enabled,
				...over,
			});
			if (!cfg.enabled) {
				return { content: [{ type: "text", text: "Auto-memory is disabled." }], details: details({ error: "disabled" }) };
			}
			if (!cfg.custom && !ctx.isProjectTrusted()) {
				const message = "Project memory requires project trust. Trust the project or set PI_HARNESS_MEMORY_DIR.";
				return { content: [{ type: "text", text: message }], details: details({ error: "untrusted" }) };
			}
			let target: string;
			try {
				target = safeMemoryPath(cfg.dir, params.file);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: `Error: ${message}` }], details: details({ error: message }) };
			}
			const relFile = relative(cfg.dir, target);

			if (params.action === "list") {
				const files = await listMemoryFiles(cfg.dir);
				const body = files.length
					? [`memory/ (${files.length} file${files.length === 1 ? "" : "s"})`, ...files.map((file) => `- ${file.name} · ${file.lines} line${file.lines === 1 ? "" : "s"}${file.title ? ` · ${file.title}` : ""}`)].join("\n")
					: "No memory files yet.";
				return { content: [{ type: "text", text: body }], details: details({ files }) };
			}

			if (params.action === "read") {
				try {
					const text = await readFile(target, "utf8");
					return { content: [{ type: "text", text: text || "(empty)" }], details: details({ file: relFile, lines: countLines(text) }) };
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") {
						return { content: [{ type: "text", text: `No such memory file: ${relFile}` }], details: details({ file: relFile, error: "not-found" }) };
					}
					throw error;
				}
			}

			if (params.action === "delete") {
				try {
					await rm(target, { force: false });
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") {
						return { content: [{ type: "text", text: `No such memory file: ${relFile}` }], details: details({ file: relFile, error: "not-found" }) };
					}
					throw error;
				}
				ctx.ui.notify(`Deleted ${relFile}`, "info");
				renderStatus(ctx, cfg);
				return { content: [{ type: "text", text: `Deleted ${relFile}.` }], details: details({ file: relFile, saved: false }) };
			}

			// action === "save"
			const content = params.content?.trim();
			if (!content) {
				const message = "content is required for save";
				return { content: [{ type: "text", text: `Error: ${message}` }], details: details({ error: message }) };
			}
			const append = params.append !== false;
			let previous = "";
			if (append) {
				try {
					previous = await readFile(target, "utf8");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			}
			const next = append ? `${previous ? (previous.endsWith("\n") ? previous : `${previous}\n`) : ""}${content}${content.endsWith("\n") ? "" : "\n"}` : `${content}${content.endsWith("\n") ? "" : "\n"}`;
			await mkdir(cfg.dir, { recursive: true });
			await writeFile(target, next, "utf8");
			ctx.ui.notify(`Saved memory to ${relFile}`, "info");
			renderStatus(ctx, cfg);
			return {
				content: [{ type: "text", text: `Saved to ${relFile} (${countLines(next)} line${countLines(next) === 1 ? "" : "s"}).` }],
				details: details({ file: relFile, saved: true, lines: countLines(next) }),
			};
		},
		renderCall(args, theme) {
			const file = args.file ? ` ${theme.fg("dim", args.file)}` : "";
			if (args.action === "list") return new Text(`${theme.fg("toolTitle", theme.bold("memory "))}${theme.fg("muted", "list")}`, 0, 0);
			if (args.action === "save") {
				const preview = args.content ? ` ${theme.fg("dim", `"${args.content.slice(0, 60).replaceAll("\n", " ")}${args.content.length > 60 ? "…" : ""}"`)}` : "";
				return new Text(`${theme.fg("toolTitle", theme.bold("memory "))}${theme.fg("muted", args.append === false ? "rewrite" : "save")}${file}${preview}`, 0, 0);
			}
			return new Text(`${theme.fg("toolTitle", theme.bold("memory "))}${theme.fg("muted", args.action)}${file}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as MemoryDetails | undefined;
			if (details?.error) return new Text(theme.fg("error", details.error), 0, 0);
			if (details?.action === "list") {
				const count = details.files?.length ?? 0;
				return new Text(`${theme.fg("success", "✓ ")}${theme.fg("muted", `${count} memory file${count === 1 ? "" : "s"}`)}`, 0, 0);
			}
			if (details?.action === "save") return new Text(`${theme.fg("success", "✓ ")}${theme.fg("muted", `saved ${details.file ?? MEMORY_FILE}`)}`, 0, 0);
			if (details?.action === "delete") return new Text(`${theme.fg("success", "✓ ")}${theme.fg("muted", `deleted ${details.file ?? "file"}`)}`, 0, 0);
			return new Text(`${theme.fg("success", "✓ ")}${theme.fg("muted", details?.file ?? "read")}`, 0, 0);
		},
	});

	pi.registerCommand("memory", {
		description: "Manage project auto-memory: status | edit [file] | list | on | off",
		getArgumentCompletions(prefix: string) {
			const items = ["status", "edit", "list", "on", "off"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value }));
			return items.length ? items : null;
		},
		async handler(args, ctx) {
			const cfg = config(ctx);
			const [sub] = args.trim().split(/\s+/);
			const trusted = cfg.custom || ctx.isProjectTrusted();

			if (sub === "on" || sub === "off") {
				sessionEnabled = sub === "on";
				ctx.ui.notify(`Auto-memory ${sessionEnabled ? "enabled" : "disabled"} for this session`, "info");
				renderStatus(ctx, config(ctx));
				return;
			}

			if (sub === "list") {
				if (!trusted) { ctx.ui.notify("Project memory requires trust.", "warning"); return; }
				const files = await listMemoryFiles(cfg.dir);
				const body = files.length
					? files.map((file) => `${file.name} (${file.lines} line${file.lines === 1 ? "" : "s"})${file.title ? ` — ${file.title}` : ""}`).join("\n")
					: "No memory files yet.";
				ctx.ui.notify(body, "info");
				return;
			}

			if (sub === "edit") {
				if (!ctx.hasUI) { ctx.ui.notify("/memory edit requires an interactive UI.", "error"); return; }
				if (!trusted) { ctx.ui.notify("Project memory requires trust.", "warning"); return; }
				const fileArg = args.trim().split(/\s+/).slice(1).join(" ").trim();
				let target: string;
				try { target = safeMemoryPath(cfg.dir, fileArg || undefined); }
				catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); return; }
				let initial = "";
				try { initial = await readFile(target, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
				const edited = await ctx.ui.editor(`Edit memory: ${relative(cfg.dir, target)}`, initial);
				if (edited === undefined || edited === initial) { ctx.ui.notify("No changes.", "info"); return; }
				await mkdir(cfg.dir, { recursive: true });
				await writeFile(target, edited, "utf8");
				ctx.ui.notify(`Saved ${relative(cfg.dir, target)}`, "info");
				renderStatus(ctx, config(ctx));
				return;
			}

			// status (default)
			const relDir = relative(ctx.cwd, cfg.dir) || cfg.dir;
			const state = cfg.enabled ? (trusted ? "on" : "on (needs project trust)") : "off";
			const head = trusted ? await readHead(cfg.dir) : {};
			const files = trusted ? await listMemoryFiles(cfg.dir) : [];
			const summary = [
				`Auto-memory: ${state}`,
				`Directory: ${relDir}`,
				`Files: ${files.length}`,
				head.head ? `MEMORY.md: ${countLines(head.head)}+ lines${head.truncated ? " (head shown)" : ""}` : `No ${MEMORY_FILE} yet`,
			].join("\n");
			ctx.ui.notify(summary, "info");
		},
	});
}
