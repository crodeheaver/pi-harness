import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export type HarnessProfile = "inspect" | "plan" | "develop" | "isolated";
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
	profile: HarnessProfile,
	toolName: string,
	cwd: string,
	path: string,
	planPath?: string,
): Decision {
	const mutating = toolName === "write" || toolName === "edit";
	if (profile === "inspect" && mutating) {
		return { action: "block", category: "inspect-read-only", reason: "the inspect profile is read-only" };
	}
	if (profile === "plan" && mutating) {
		if (!planPath || canonicalPath(cwd, path) !== canonicalPath(cwd, planPath)) {
			return { action: "block", category: "plan-file-only", reason: "the plan profile can only modify its selected plan file" };
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

export function classifyCommand(profile: HarnessProfile, command: string): Decision {
	if (profile === "inspect" || profile === "plan") {
		return { action: "block", category: `${profile}-shell-disabled`, reason: `shell execution is disabled in the ${profile} profile` };
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

export function classifyCustomTool(
	profile: HarnessProfile,
	toolName: string,
	cwd: string,
	input: unknown,
): Decision {
	const lower = toolName.toLowerCase();
	const paths = collectPaths(input);
	for (const path of paths) {
		const category = sensitivePathCategory(canonicalPath(cwd, path));
		if (category) return { action: "confirm", category, reason: `may access sensitive ${category.replaceAll("-", " ")}` };
		if (!isInsideWorkspace(cwd, path)) {
			return { action: "confirm", category: "external-directory", reason: "may access a path outside the workspace" };
		}
	}
	if (profile === "inspect" || profile === "plan") {
		if (READ_ONLY_CUSTOM_TOOLS.has(lower)) return { action: "allow" };
		return { action: "block", category: `${profile}-custom-tool`, reason: `custom tool ${toolName} is not allowlisted in the ${profile} profile` };
	}
	if (lower === "mcp" || lower.includes("mcp_")) {
		return { action: "confirm", category: "mcp-operation", reason: "invokes an external MCP capability" };
	}
	if (lower.includes("subagent") || lower === "agent" || lower === "task_agent") {
		return { action: "confirm", category: "subagent-operation", reason: "starts or controls another agent process" };
	}
	if (MUTATING_TOOL_NAME.test(lower)) {
		return { action: "confirm", category: "custom-tool-effect", reason: `custom tool ${toolName} may have external or mutating effects` };
	}
	return { action: "confirm", category: "third-party-tool", reason: `custom tool ${toolName} is not part of the audited harness allowlist` };
}
