import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const HARNESS_MODES = ["inspect", "plan", "default", "permissive", "yolo", "isolated"] as const;
export type HarnessMode = typeof HARNESS_MODES[number];

export function isHarnessMode(value: unknown): value is HarnessMode {
	return typeof value === "string" && (HARNESS_MODES as readonly string[]).includes(value);
}
export type Decision =
	| { action: "allow" }
	| { action: "confirm"; category: string; reason: string }
	| { action: "block"; category: string; reason: string };

const ALWAYS_BLOCKED_COMMANDS: Array<[RegExp, string]> = [
	[/\b(?:rm|busybox\s+rm)\s+[^\n;&|]*(?:-\w*r\w*f|-\w*f\w*r|--recursive)[^\n;&|]*\s+(?:\/|~|\$HOME)(?:\s|$)/i, "filesystem-root-delete"],
	[/\bRemove-Item\b[^\n;|]*(?:-[A-Za-z]*Recurse|\/s\b)[^\n;|]*(?:[A-Za-z]:\\(?:\s|$)|\$HOME)/i, "filesystem-root-delete"],
	[/:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;\s*:/, "fork-bomb"],
	[/\bdd\b[^\n;&|]*\bof=(?:\/dev\/(?:sd|nvme|vd)|\\\\\.\\PhysicalDrive)/i, "raw-disk-write"],
];

const CONFIRM_COMMANDS: Array<[RegExp, string, string]> = [
	[/\b(?:sudo|doas|runas)\b|Start-Process\b[^\n;|]*-Verb\s+RunAs/i, "privilege-elevation", "requests elevated privileges"],
	[/\b(?:rm|rmdir)\b[^\n;&|]*(?:-\w*r|--recursive)|\bRemove-Item\b[^\n;|]*-Recurse/i, "recursive-delete", "recursively deletes files"],
	[/\bgit\s+(?:reset\s+--hard|clean\s+-[^\s]*f|checkout\s+--\s+\.|restore\s+--(?:source|staged)|push\b[^\n;&|]*(?:--force|-f\b))/i, "destructive-git", "can discard work or rewrite remote history"],
	[/\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|remove|uninstall|update|upgrade)\b|\b(?:pip|pipx|poetry|uv)\s+(?:install|uninstall|add|remove|sync)\b/i, "dependency-change", "changes installed dependencies or lockfiles"],
	[/\b(?:apt(?:-get)?|dnf|yum|pacman|brew|choco|winget)\s+(?:install|remove|upgrade|update)\b/i, "system-package-change", "changes system packages"],
	[/\b(?:terraform\s+(?:apply|destroy)|kubectl\s+(?:apply|delete|replace)|helm\s+(?:install|upgrade|uninstall)|(?:vercel|netlify|flyctl)\s+deploy)\b/i, "deployment", "changes external infrastructure or deploys software"],
	[/\b(?:prisma|sequelize|typeorm|knex|alembic|rails|django-admin)\b[^\n;&|]*\b(?:migrate|db:|upgrade)\b/i, "database-migration", "may modify a database schema or data"],
	[/\b(?:curl|wget)\b[^\n;&|]*(?:--data|-d\b|--upload-file|-T\b)|\b(?:scp|sftp)\b|\brsync\b[^\n;&|]*\s+[^\s]+:[^\s]*/i, "network-upload", "may transmit local data"],
	[/\b(?:chmod|chown|icacls|takeown)\b/i, "permission-change", "changes file ownership or permissions"],
	[/\b(?:kill|killall|pkill|taskkill|Stop-Process)\b/i, "process-termination", "terminates processes"],
];

const READ_ONLY_CUSTOM_TOOLS = new Set(["ask_user", "web_fetch", "task", "todo"]);
const MUTATING_TOOL_NAME = /(?:write|edit|replace|patch|delete|remove|upload|deploy|apply|execute|run|shell|bash)/i;
const PATH_KEYS = /^(?:path|file|filePath|filename|directory|dir|cwd|root|target)$/i;

function cleanPath(path: string): string {
	return path.startsWith("@") ? path.slice(1) : path;
}

export function absolutePath(cwd: string, path: string): string {
	return resolve(cwd, cleanPath(path));
}

/** Resolve existing path segments so symlink aliases cannot escape the workspace gate. */
export function canonicalPath(cwd: string, path: string): string {
	const target = absolutePath(cwd, path);
	if (existsSync(target)) return realpathSync.native(target);
	let parent = dirname(target);
	while (parent !== dirname(parent) && !existsSync(parent)) parent = dirname(parent);
	if (!existsSync(parent)) return target;
	const canonicalParent = realpathSync.native(parent);
	return resolve(canonicalParent, relative(parent, target));
}

export function isInsideWorkspace(cwd: string, path: string): boolean {
	const root = existsSync(resolve(cwd)) ? realpathSync.native(resolve(cwd)) : resolve(cwd);
	const target = canonicalPath(cwd, path);
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function pathParts(path: string): string[] {
	return path.replaceAll("\\", "/").toLowerCase().split("/").filter(Boolean);
}

function isEnvironmentSecret(parts: string[]): boolean {
	const name = parts.at(-1) ?? "";
	if (name === ".env.example" || name === ".env.sample" || name === ".env.template") return false;
	return name === ".env" || name.startsWith(".env.");
}

export function sensitivePathCategory(path: string): string | undefined {
	const parts = pathParts(path);
	const name = parts.at(-1) ?? "";
	if (parts.includes(".ssh")) return "ssh-credentials";
	if (parts.includes(".aws") || parts.includes(".azure") || (parts.includes(".config") && parts.includes("gcloud"))) return "cloud-credentials";
	if (parts.includes(".pi") && parts.includes("agent") && name === "auth.json") return "pi-credentials";
	if (isEnvironmentSecret(parts)) return "environment-secrets";
	if (/^(?:id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:pem|p12|pfx|key))$/i.test(name)) return "private-key";
	return undefined;
}

export function protectedWriteCategory(cwd: string, path: string): string | undefined {
	if (!isInsideWorkspace(cwd, path)) return "outside-workspace";
	const parts = pathParts(relative(resolve(cwd), absolutePath(cwd, path)));
	if (parts.includes(".git")) return "git-internals";
	if (parts.includes("node_modules")) return "dependency-directory";
	return sensitivePathCategory(canonicalPath(cwd, path));
}

export function classifyFileTool(
	mode: HarnessMode,
	toolName: string,
	cwd: string,
	path: string,
	planPath?: string,
): Decision {
	if (mode === "permissive" || mode === "yolo") return { action: "allow" };
	const mutating = toolName === "write" || toolName === "edit";
	if (mode === "inspect" && mutating) {
		return { action: "block", category: "inspect-read-only", reason: "inspect mode is read-only" };
	}
	if (mode === "plan" && mutating) {
		if (!planPath || canonicalPath(cwd, path) !== canonicalPath(cwd, planPath)) {
			return { action: "block", category: "plan-file-only", reason: "plan mode can only modify its selected plan file" };
		}
	}
	if (mutating) {
		const category = protectedWriteCategory(cwd, path);
		if (category) return { action: "block", category, reason: `writes to ${category.replaceAll("-", " ")} are prohibited` };
		return { action: "allow" };
	}
	const category = sensitivePathCategory(canonicalPath(cwd, path));
	if (category) return { action: "confirm", category, reason: `reads potentially sensitive ${category.replaceAll("-", " ")}` };
	if (!isInsideWorkspace(cwd, path)) {
		return { action: "confirm", category: "external-directory", reason: "accesses a path outside the workspace" };
	}
	return { action: "allow" };
}

function hasUnbalancedQuotes(command: string): boolean {
	let single = false;
	let double = false;
	let escaped = false;
	for (const char of command) {
		if (escaped) { escaped = false; continue; }
		if (char === "\\" && !single) { escaped = true; continue; }
		if (char === "'" && !double) single = !single;
		if (char === '"' && !single) double = !double;
	}
	return single || double || escaped;
}

function shellSegments(command: string): string[][] {
	const segments: string[][] = [];
	let segment: string[] = [];
	let word = "";
	let quote: "'" | '"' | undefined;

	const flushWord = () => {
		if (word) segment.push(word);
		word = "";
	};
	const flushSegment = () => {
		flushWord();
		if (segment.length) segments.push(segment);
		segment = [];
	};

	for (let index = 0; index < command.length; index++) {
		const char = command[index];
		if (quote) {
			if (char === quote) quote = undefined;
			else if (char === "\\" && quote === '"' && index + 1 < command.length && /[\\"$`\n]/.test(command[index + 1])) word += command[++index];
			else word += char;
			continue;
		}
		if (char === "'" || char === '"') { quote = char; continue; }
		if (char === "\\" && index + 1 < command.length) {
			word += command[++index];
			continue;
		}
		if (/\s/.test(char)) { flushWord(); continue; }
		if (char === ";" || char === "&" || char === "|" || char === "(" || char === ")") { flushSegment(); continue; }
		if (char === "#" && !word) { flushSegment(); while (index + 1 < command.length && command[index + 1] !== "\n") index++; continue; }
		word += char;
	}
	flushSegment();
	return segments;
}

function executableName(value: string): string {
	return basename(value.replaceAll("\\", "/")).toLowerCase();
}

function rmIndex(segment: string[]): number | undefined {
	let index = 0;
	while (index < segment.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[index])) index++;
	const first = executableName(segment[index] ?? "");
	if (first === "rm" || first === "rm.exe") return index;
	if (first === "busybox" && ["rm", "rm.exe"].includes(executableName(segment[index + 1] ?? ""))) return index + 1;
	if (first === "command" || first === "builtin" || first === "exec" || first === "nohup") {
		while (segment[++index]?.startsWith("-")) { /* skip wrapper options */ }
		return ["rm", "rm.exe"].includes(executableName(segment[index] ?? "")) ? index : undefined;
	}
	if (first === "sudo" || first === "doas" || first === "env" || first === "xargs") {
		const found = segment.findIndex((token, candidate) => candidate > index && ["rm", "rm.exe"].includes(executableName(token)));
		return found >= 0 ? found : undefined;
	}
	return undefined;
}

function expandShellPath(path: string): string | undefined {
	const temp = tmpdir();
	if (/^(?:\$TMPDIR|\$TEMP|\$TMP|\$\{(?:TMPDIR|TEMP|TMP)\}|%TEMP%|%TMP%)(?:[\\/]|$)/i.test(path)) {
		return path.replace(/^(?:\$TMPDIR|\$TEMP|\$TMP|\$\{(?:TMPDIR|TEMP|TMP)\}|%TEMP%|%TMP%)/i, temp);
	}
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) return resolve(homedir(), path.slice(2));
	if (/[`$%]|[<>]\(/.test(path)) return undefined;
	return path;
}

function isAllowedRemovalPath(projectCwd: string, executionCwd: string, path: string): boolean {
	const expanded = expandShellPath(path);
	if (!expanded) return false;
	const target = resolve(executionCwd, expanded);
	return isInsideWorkspace(projectCwd, target) || isInsideWorkspace(tmpdir(), target);
}

function removesOutsideAllowedScope(command: string, cwd: string): boolean {
	const segments = shellSegments(command);
	const hasRm = segments.some((segment) => rmIndex(segment) !== undefined
		|| segment.some((token) => /\brm(?:\.exe)?\b/i.test(token)))
		|| /(?:`|\$\()[^\n]*\br\\?m\b/i.test(command);
	if (!hasRm) return false;

	// Shell state and indirect operand sources cannot be modeled safely. Fail closed
	// rather than assuming rm will execute from the original working directory.
	if (segments.some((segment) => ["cd", "pushd", "popd"].includes(executableName(segment[0] ?? "")))) return true;
	if (segments.some((segment) => segment.some((token) => /^(?:TMPDIR|TEMP|TMP)=/i.test(token)))) return true;
	if (/(?:`|\$\()[^\n]*\br\\?m\b/i.test(command)) return true;

	for (const segment of segments) {
		const first = executableName(segment[0] ?? "");
		const index = rmIndex(segment);
		if (index === undefined) {
			if (first === "find" && segment.some((token) => ["rm", "rm.exe"].includes(executableName(token)))) return true;
			if (["bash", "sh", "zsh", "pwsh", "powershell", "eval"].includes(first)) {
				const commandIndex = first === "eval" ? 1 : segment.findIndex((token) => token === "-c" || token.toLowerCase() === "-command");
				const nested = first === "eval" ? segment.slice(commandIndex).join(" ") : segment[commandIndex + 1];
				if (nested && removesOutsideAllowedScope(nested, cwd)) return true;
			}
			continue;
		}
		if (first === "xargs") return true;
		let optionsEnded = false;
		for (const token of segment.slice(index + 1)) {
			if (!optionsEnded && token === "--") { optionsEnded = true; continue; }
			if (!optionsEnded && token.startsWith("-")) continue;
			if (!isAllowedRemovalPath(cwd, cwd, token)) return true;
		}
	}
	return false;
}

export function classifyCommand(mode: HarnessMode, command: string, cwd = process.cwd()): Decision {
	if (mode === "yolo") return { action: "allow" };
	if (mode === "permissive") {
		if (removesOutsideAllowedScope(command, cwd)) {
			return { action: "block", category: "rm-outside-scope", reason: "permissive mode only allows rm inside the project or temporary directory" };
		}
		return { action: "allow" };
	}
	if (mode === "inspect" || mode === "plan") {
		return { action: "block", category: `${mode}-shell-disabled`, reason: `shell execution is disabled in ${mode} mode` };
	}
	for (const [pattern, category] of ALWAYS_BLOCKED_COMMANDS) {
		if (pattern.test(command)) return { action: "block", category, reason: `${category.replaceAll("-", " ")} is never allowed` };
	}
	if (hasUnbalancedQuotes(command) || /\b(?:eval|bash|sh|zsh|pwsh|powershell)\s+(?:-c|-Command|-EncodedCommand)\b/i.test(command)) {
		return { action: "confirm", category: "opaque-shell-wrapper", reason: "cannot be classified reliably without executing an opaque shell wrapper" };
	}
	if (/(?:^|[\s"'])(?:~\/|\$HOME\/|[A-Za-z]:\\Users\\[^\\]+\\)(?:\.ssh|\.aws|\.azure|\.pi[\\/]agent[\\/]auth\.json)/i.test(command)) {
		return { action: "confirm", category: "credential-access", reason: "may access credentials" };
	}
	if (/(?:^|[\s>])(?:\.env(?:\.[\w-]+)?|[^\s]+\.(?:pem|p12|pfx|key))(?:\s|$)/i.test(command)) {
		return { action: "confirm", category: "secret-file-access", reason: "may access a secret-bearing file" };
	}
	for (const [pattern, category, reason] of CONFIRM_COMMANDS) {
		if (pattern.test(command)) return { action: "confirm", category, reason };
	}
	return { action: "allow" };
}

function collectPaths(value: unknown, key = "", paths: string[] = []): string[] {
	if (typeof value === "string" && PATH_KEYS.test(key)) paths.push(value);
	else if (Array.isArray(value)) for (const item of value) collectPaths(item, key, paths);
	else if (value && typeof value === "object") {
		for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) collectPaths(child, childKey, paths);
	}
	return paths;
}

function collectCommands(value: unknown, key = "", commands: string[] = []): string[] {
	if (typeof value === "string" && /^(?:command|cmd|script)$/i.test(key)) commands.push(value);
	else if (Array.isArray(value)) for (const item of value) collectCommands(item, key, commands);
	else if (value && typeof value === "object") {
		for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) collectCommands(child, childKey, commands);
	}
	return commands;
}

export function classifyCustomTool(
	mode: HarnessMode,
	toolName: string,
	cwd: string,
	input: unknown,
): Decision {
	if (mode === "yolo") return { action: "allow" };
	if (mode === "permissive") {
		for (const command of collectCommands(input)) {
			const decision = classifyCommand(mode, command, cwd);
			if (decision.action === "block") return decision;
		}
		return { action: "allow" };
	}
	const lower = toolName.toLowerCase();
	const paths = collectPaths(input);
	for (const path of paths) {
		const category = sensitivePathCategory(canonicalPath(cwd, path));
		if (category) return { action: "confirm", category, reason: `may access sensitive ${category.replaceAll("-", " ")}` };
		if (!isInsideWorkspace(cwd, path)) {
			return { action: "confirm", category: "external-directory", reason: "may access a path outside the workspace" };
		}
	}
	if (mode === "inspect" || mode === "plan") {
		if (READ_ONLY_CUSTOM_TOOLS.has(lower)) return { action: "allow" };
		return { action: "block", category: `${mode}-custom-tool`, reason: `custom tool ${toolName} is not allowlisted in ${mode} mode` };
	}
	if (lower === "mcp" || lower.includes("mcp_")) {
		return { action: "confirm", category: "mcp-operation", reason: "invokes an external MCP capability" };
	}
	if (lower.includes("subagent") || lower === "agent" || lower === "task_agent") {
		const request = input as { run_in_background?: unknown; subagent_type?: unknown } | undefined;
		if (request?.run_in_background === true) {
			return { action: "confirm", category: "subagent-background", reason: "starts an agent that continues after the current tool call" };
		}
		if (lower === "subagent" && typeof request?.subagent_type === "string") {
			const agentType = request.subagent_type.toLowerCase();
			if (agentType !== "explore" && agentType !== "plan") {
				return { action: "confirm", category: "subagent-mutation", reason: "starts an agent type that may modify the workspace" };
			}
		}
		return { action: "confirm", category: "subagent-operation", reason: "starts or controls another agent process" };
	}
	if (MUTATING_TOOL_NAME.test(lower)) {
		return { action: "confirm", category: "custom-tool-effect", reason: `custom tool ${toolName} may have external or mutating effects` };
	}
	return { action: "confirm", category: "third-party-tool", reason: `custom tool ${toolName} is not part of the audited harness allowlist` };
}
