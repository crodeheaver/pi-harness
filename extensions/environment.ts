import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";

const GLOBAL_SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
const PROJECT_SETTINGS_PATH = join(".pi", "settings.json");
const GLOBAL_LABEL = "~/.pi/agent/settings.json";
const PROJECT_LABEL = ".pi/settings.json";

// `environment` is the canonical key (consistent with Pi's camelCase settings).
// `ENVIRONMENT` is accepted as an alias for convenience. If both are present,
// `environment` wins.
const ENVIRONMENT_KEYS = ["environment", "ENVIRONMENT"] as const;

/**
 * Validate a raw environment object into a plain string map.
 *
 * Accepts string, number, and boolean values (coerced to strings, since OS
 * environment variables are always strings). Objects, arrays, and null values
 * are rejected. Returns undefined when the input is null/undefined (treated as
 * "no environment configured").
 */
export function parseEnvironmentObject(raw: unknown, label: string): Record<string, string> | undefined {
	if (raw === null || raw === undefined) return undefined;
	if (typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`${label}: environment must be an object of name/value pairs`);
	}
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
			result[key] = String(value);
		} else {
			throw new Error(`${label}: environment.${key} must be a string, number, or boolean`);
		}
	}
	return result;
}

/**
 * Extract the environment object from a parsed settings document.
 *
 * Looks up the first present key from {@link ENVIRONMENT_KEYS}. Returns
 * undefined when no environment key is present (or when the settings document
 * is not a JSON object). Throws when the key is present but malformed.
 */
export function extractEnvironment(parsed: unknown, label: string): Record<string, string> | undefined {
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const settings = parsed as Record<string, unknown>;
	for (const key of ENVIRONMENT_KEYS) {
		if (key in settings) return parseEnvironmentObject(settings[key], label);
	}
	return undefined;
}

/**
 * Read and JSON-parse a settings file. Returns undefined when the file is
 * absent. Throws on invalid JSON or unreadable files.
 */
export async function readSettings(path: string, label: string): Promise<unknown | undefined> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	try {
		return JSON.parse(text);
	} catch (error) {
		if (error instanceof SyntaxError) throw new Error(`${label} contains invalid JSON: ${error.message}`);
		throw error;
	}
}

/**
 * Apply an environment map to a target record (defaults to {@link process.env}),
 * overwriting existing values. Returns the list of keys that were set.
 */
export function applyEnvironment(env: Record<string, string>, target: Record<string, string | undefined> = process.env): string[] {
	const applied: string[] = [];
	for (const [key, value] of Object.entries(env)) {
		target[key] = value;
		applied.push(key);
	}
	return applied;
}

/**
 * Resolve the merged environment for the current session: global settings
 * overlaid with trusted project settings. Collection errors are reported via
 * the UI rather than thrown, so one bad file does not suppress the other.
 */
async function resolveAndApply(event: SessionStartEvent, ctx: ExtensionContext): Promise<void> {
	const errors: string[] = [];
	let globalEnv: Record<string, string> | undefined;
	let projectEnv: Record<string, string> | undefined;

	try {
		const parsed = await readSettings(GLOBAL_SETTINGS_PATH, GLOBAL_LABEL);
		globalEnv = parsed === undefined ? undefined : extractEnvironment(parsed, GLOBAL_LABEL);
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error));
	}

	// Project settings can load executable extensions, so they are gated on
	// project trust exactly like Pi's own resource loading.
	if (ctx.isProjectTrusted()) {
		try {
			const parsed = await readSettings(join(ctx.cwd, PROJECT_SETTINGS_PATH), PROJECT_LABEL);
			projectEnv = parsed === undefined ? undefined : extractEnvironment(parsed, PROJECT_LABEL);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}

	for (const message of errors) ctx.ui.notify(message, "error");

	// Project entries overlay global entries on key conflicts.
	const merged: Record<string, string> = { ...(globalEnv ?? {}), ...(projectEnv ?? {}) };
	const applied = applyEnvironment(merged);
	if (event.reason === "startup" && applied.length > 0) {
		ctx.ui.notify(`Applied ${applied.length} environment variable${applied.length === 1 ? "" : "s"} from Pi settings`, "info");
	}
}

export default function environmentExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async (event, ctx) => {
		await resolveAndApply(event, ctx);
	});
}
