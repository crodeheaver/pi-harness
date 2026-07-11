import { readFile, readdir, stat } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

const PROFILE_STATE_ENTRY = "audited-harness:active-profile";
const PROFILE_ROOT_NAME = "pi";
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const);
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ProfileSettings {
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: ThinkingLevel;
	theme?: string;
	tools?: string[];
	instructions?: string;
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

export interface ProfileBaseline {
	provider?: string;
	model?: string;
	thinkingLevel: ThinkingLevel;
	tools: string[];
	theme?: string;
}

export interface ProfileState {
	name: string | null;
	baseline: ProfileBaseline;
}

export interface ProfileDefinition {
	name: string;
	directory: string;
	settings: ProfileSettings;
	instructions?: string;
	skillPaths: string[];
	promptPaths: string[];
	themePaths: string[];
}

function stringField(value: unknown, key: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value.trim()) throw new Error(`settings.json: ${key} must be a non-empty string`);
	return value;
}

function stringArrayField(value: unknown, key: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
		throw new Error(`settings.json: ${key} must be an array of non-empty strings`);
	}
	return value;
}

export function parseProfileSettings(value: unknown): ProfileSettings {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("settings.json must contain a JSON object");
	}
	const input = value as Record<string, unknown>;
	const thinking = stringField(input.defaultThinkingLevel, "defaultThinkingLevel");
	if (thinking !== undefined && !THINKING_LEVELS.has(thinking as ThinkingLevel)) {
		throw new Error("settings.json: defaultThinkingLevel must be off, minimal, low, medium, high, xhigh, or max");
	}
	return {
		defaultProvider: stringField(input.defaultProvider, "defaultProvider"),
		defaultModel: stringField(input.defaultModel, "defaultModel"),
		defaultThinkingLevel: thinking as ThinkingLevel | undefined,
		theme: stringField(input.theme, "theme"),
		tools: stringArrayField(input.tools, "tools"),
		instructions: stringField(input.instructions, "instructions"),
		skills: stringArrayField(input.skills, "skills"),
		prompts: stringArrayField(input.prompts, "prompts"),
		themes: stringArrayField(input.themes, "themes"),
	};
}

export async function listProfiles(cwd: string): Promise<string[]> {
	try {
		return (await readdir(join(cwd, PROFILE_ROOT_NAME), { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort((a, b) => a.localeCompare(b));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

function listProfilesSync(cwd: string): string[] {
	try {
		return readdirSync(join(cwd, PROFILE_ROOT_NAME), { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort((a, b) => a.localeCompare(b));
	} catch {
		return [];
	}
}

async function isDirectory(path: string): Promise<boolean> {
	try { return (await stat(path)).isDirectory(); }
	catch { return false; }
}

function resolveProfilePath(profileDirectory: string, configuredPath: string): string {
	if (isAbsolute(configuredPath)) throw new Error(`settings.json: resource path must be relative to the profile: ${configuredPath}`);
	const absolutePath = resolve(profileDirectory, configuredPath);
	const rel = relative(profileDirectory, absolutePath);
	if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
		throw new Error(`settings.json: resource path escapes the profile: ${configuredPath}`);
	}
	return absolutePath;
}

async function resourcePaths(profileDirectory: string, conventionalName: string, configured: string[] | undefined): Promise<string[]> {
	const paths: string[] = [];
	const conventionalPath = join(profileDirectory, conventionalName);
	if (await isDirectory(conventionalPath)) paths.push(conventionalPath);
	for (const path of configured ?? []) paths.push(resolveProfilePath(profileDirectory, path));
	return [...new Set(paths)];
}

async function optionalFile(path: string): Promise<string | undefined> {
	try {
		const content = await readFile(path, "utf8");
		return content.trim() ? content.trim() : undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export async function loadProfileDefinition(cwd: string, name: string): Promise<ProfileDefinition> {
	const names = await listProfiles(cwd);
	if (!names.includes(name)) throw new Error(`Unknown profile "${name}"`);
	const directory = join(cwd, PROFILE_ROOT_NAME, name);
	let settings: ProfileSettings = {};
	const settingsText = await optionalFile(join(directory, "settings.json"));
	if (settingsText !== undefined) {
		try { settings = parseProfileSettings(JSON.parse(settingsText)); }
		catch (error) {
			if (error instanceof SyntaxError) throw new Error(`settings.json contains invalid JSON: ${error.message}`);
			throw error;
		}
	}
	const appendSystem = await optionalFile(join(directory, "APPEND_SYSTEM.md"));
	const instructions = [settings.instructions, appendSystem].filter(Boolean).join("\n\n") || undefined;
	return {
		name,
		directory,
		settings,
		instructions,
		skillPaths: await resourcePaths(directory, "skills", settings.skills),
		promptPaths: await resourcePaths(directory, "prompts", settings.prompts),
		themePaths: await resourcePaths(directory, "themes", settings.themes),
	};
}

export function latestProfileState(entries: readonly unknown[]): ProfileState | undefined {
	let state: ProfileState | undefined;
	for (const value of entries) {
		const entry = value as { type?: unknown; customType?: unknown; data?: unknown };
		if (entry.type !== "custom" || entry.customType !== PROFILE_STATE_ENTRY) continue;
		const data = entry.data as { name?: unknown; baseline?: Record<string, unknown> } | undefined;
		const baseline = data?.baseline;
		const validOptionalStrings = baseline !== undefined
			&& [baseline.provider, baseline.model, baseline.theme].every((field) => field === undefined || typeof field === "string");
		if (
			(typeof data?.name === "string" || data?.name === null)
			&& validOptionalStrings
			&& typeof baseline.thinkingLevel === "string"
			&& THINKING_LEVELS.has(baseline.thinkingLevel as ThinkingLevel)
			&& Array.isArray(baseline.tools)
			&& baseline.tools.every((tool) => typeof tool === "string")
		) {
			state = {
				name: data.name as string | null,
				baseline: {
					...(typeof baseline.provider === "string" ? { provider: baseline.provider } : {}),
					...(typeof baseline.model === "string" ? { model: baseline.model } : {}),
					...(typeof baseline.theme === "string" ? { theme: baseline.theme } : {}),
					thinkingLevel: baseline.thinkingLevel as ThinkingLevel,
					tools: baseline.tools as string[],
				},
			};
		}
	}
	return state;
}

export default function profilesExtension(pi: ExtensionAPI) {
	let state: ProfileState | undefined;
	let activeProfile: ProfileDefinition | undefined;
	let profileCwd = process.cwd();
	let themeTimer: NodeJS.Immediate | undefined;

	function captureBaseline(ctx: ExtensionContext): ProfileBaseline {
		return {
			provider: ctx.model?.provider,
			model: ctx.model?.id,
			thinkingLevel: pi.getThinkingLevel(),
			tools: pi.getActiveTools(),
			theme: ctx.ui.theme.name,
		};
	}

	async function setModel(provider: string | undefined, modelId: string | undefined, ctx: ExtensionContext, label: string): Promise<boolean> {
		if (!provider || !modelId) return true;
		if (ctx.model?.provider === provider && ctx.model.id === modelId) return true;
		const model = ctx.modelRegistry.find(provider, modelId);
		if (!model) {
			if (ctx.hasUI) ctx.ui.notify(`${label}: model ${provider}/${modelId} was not found`, "warning");
			return false;
		}
		const success = await pi.setModel(model);
		if (!success && ctx.hasUI) ctx.ui.notify(`${label}: no credentials for ${provider}/${modelId}`, "warning");
		return success;
	}

	function setTransientTheme(name: string | undefined, ctx: ExtensionContext): { success: boolean; error?: string } {
		if (!name) return { success: true };
		const selected = ctx.ui.getTheme(name);
		if (!selected) return { success: false, error: `theme ${name} was not found` };
		// Passing a Theme object switches the UI without writing the profile choice
		// into the user's persistent Pi settings.
		return ctx.ui.setTheme(selected);
	}

	async function restoreBaseline(ctx: ExtensionContext): Promise<{ availableTools: Set<string>; modelRestored: boolean }> {
		const availableTools = new Set(pi.getAllTools().map((tool) => tool.name));
		if (!state) return { availableTools, modelRestored: true };
		const baseline = state.baseline;
		const modelRestored = await setModel(baseline.provider, baseline.model, ctx, "Profile baseline");
		if (!modelRestored) return { availableTools, modelRestored };
		pi.setThinkingLevel(baseline.thinkingLevel);
		pi.setActiveTools(baseline.tools.filter((tool) => availableTools.has(tool)));
		setTransientTheme(baseline.theme, ctx);
		return { availableTools, modelRestored };
	}

	async function applyProfile(ctx: ExtensionContext) {
		if (!state) return;
		const baseline = state.baseline;
		const { availableTools } = await restoreBaseline(ctx);
		if (!activeProfile) return;

		const settings = activeProfile.settings;
		await setModel(settings.defaultProvider ?? baseline.provider, settings.defaultModel ?? baseline.model, ctx, `Profile "${activeProfile.name}"`);
		if (settings.defaultThinkingLevel) pi.setThinkingLevel(settings.defaultThinkingLevel);
		if (settings.tools) {
			const valid = settings.tools.filter((tool) => availableTools.has(tool));
			const invalid = settings.tools.filter((tool) => !availableTools.has(tool));
			pi.setActiveTools(valid);
			if (invalid.length && ctx.hasUI) ctx.ui.notify(`Profile "${activeProfile.name}": unknown tools: ${invalid.join(", ")}`, "warning");
		}
	}

	function updateStatus(ctx: ExtensionContext) {
		ctx.ui.setStatus(
			"audited-harness:profile",
			activeProfile ? ctx.ui.theme.fg("accent", `profile:${activeProfile.name}`) : undefined,
		);
	}

	pi.registerCommand("profile", {
		description: "Load one ./pi profile, replacing the active profile",
		getArgumentCompletions(prefix) {
			const items: AutocompleteItem[] = listProfilesSync(profileCwd)
				.filter((name) => name.startsWith(prefix))
				.map((name) => ({ value: name, label: name }));
			if ("--clear".startsWith(prefix)) items.push({ value: "--clear", label: "--clear", description: "Unload the active profile" });
			return items.length ? items : null;
		},
		async handler(args, ctx) {
			if (!ctx.isProjectTrusted()) {
				ctx.ui.notify("Profiles are disabled until this project is trusted", "error");
				return;
			}
			let selected = args.trim();
			if (!selected) {
				const profiles = await listProfiles(ctx.cwd);
				if (!profiles.length) {
					ctx.ui.notify(`No profiles found under ${join(ctx.cwd, PROFILE_ROOT_NAME)}`, "warning");
					return;
				}
				if (!ctx.hasUI) {
					ctx.ui.notify("Usage: /profile <name> or /profile --clear", "warning");
					return;
				}
				selected = (await ctx.ui.select("Load profile", [...profiles, "(none)"])) ?? "";
				if (!selected) return;
				if (selected === "(none)") selected = "--clear";
			}

			const baseline = state?.baseline ?? captureBaseline(ctx);
			if (selected === "--clear") {
				if (!state?.name) {
					ctx.ui.notify("No profile is active", "info");
					return;
				}
				const restored = await restoreBaseline(ctx);
				if (!restored.modelRestored) return;
				state = { name: null, baseline };
				pi.appendEntry(PROFILE_STATE_ENTRY, state);
				ctx.ui.notify("Unloading profile and reloading Pi resources", "info");
				await ctx.reload();
				return;
			}

			try { await loadProfileDefinition(ctx.cwd, selected); }
			catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}
			const restored = await restoreBaseline(ctx);
			if (!restored.modelRestored) return;
			state = { name: selected, baseline };
			pi.appendEntry(PROFILE_STATE_ENTRY, state);
			ctx.ui.notify(`Loading profile "${selected}" and reloading Pi resources`, "info");
			await ctx.reload();
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		profileCwd = ctx.cwd;
		state = latestProfileState(ctx.sessionManager.getEntries());
		activeProfile = undefined;
		if (!state || !ctx.isProjectTrusted()) {
			updateStatus(ctx);
			return;
		}
		if (state.name) {
			try { activeProfile = await loadProfileDefinition(ctx.cwd, state.name); }
			catch (error) {
				if (ctx.hasUI) ctx.ui.notify(`Could not load profile "${state.name}": ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		}
		await applyProfile(ctx);
		updateStatus(ctx);
	});

	pi.on("resources_discover", (_event, ctx) => {
		if (!activeProfile || !ctx.isProjectTrusted()) return;
		if (themeTimer) clearImmediate(themeTimer);
		if (activeProfile.settings.theme) {
			const themeName = activeProfile.settings.theme;
			const profileName = activeProfile.name;
			themeTimer = setImmediate(() => {
				const result = setTransientTheme(themeName, ctx);
				if (!result.success && ctx.hasUI) ctx.ui.notify(`Profile "${profileName}": ${result.error ?? `theme ${themeName} was not found`}`, "warning");
				updateStatus(ctx);
			});
		}
		return {
			skillPaths: activeProfile.skillPaths,
			promptPaths: activeProfile.promptPaths,
			themePaths: activeProfile.themePaths,
		};
	});

	pi.on("before_agent_start", (event) => {
		if (!activeProfile?.instructions) return;
		return { systemPrompt: `${event.systemPrompt}\n\n## Active profile: ${activeProfile.name}\n${activeProfile.instructions}` };
	});

	pi.on("session_shutdown", async (event, ctx) => {
		if (themeTimer) clearImmediate(themeTimer);
		themeTimer = undefined;
		// A replacement session may not contain this session's profile entry. Remove
		// runtime overlays before Pi carries model/tool state into that session.
		if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
			await restoreBaseline(ctx);
		}
	});
}
