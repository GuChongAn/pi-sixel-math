import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WT_VIRTUAL_CELL_HEIGHT, WT_VIRTUAL_CELL_WIDTH } from "./renderer/math-image.js";

export interface SixelMathConfig {
	/** Master switch (also toggled at runtime with `/sixel-math on|off`). */
	enabled: boolean;
	/** Terminal background, `#rrggbb`, or `transparent` to leave it unpainted. */
	background: string | undefined;
	/** Formula color; defaults to the transcript text color. */
	foreground: string | undefined;
	/** Hard cap on the rows a single formula may occupy. */
	maxRows: number;
	/** SIXEL palette size. */
	maxColors: number;
	/** Supersampling factor while rasterizing the formula. */
	supersample: number;
	cellWidthPx: number;
	cellHeightPx: number;
	/** Virtual pixels per `ex`; defaults to 2.5 virtual-pixel-rows per em. */
	exPx: number;
	/** Enable `$...$` inline images (experimental, off by default). */
	inlineImages: boolean;
	/** Center block formulas inside the transcript width. */
	center: boolean;
	/** Show a status entry in the footer. */
	showStatus: boolean;
}

const DEFAULTS: SixelMathConfig = {
	enabled: true,
	background: undefined,
	foreground: undefined,
	maxRows: 12,
	maxColors: 24,
	supersample: 4,
	cellWidthPx: WT_VIRTUAL_CELL_WIDTH,
	cellHeightPx: WT_VIRTUAL_CELL_HEIGHT,
	exPx: WT_VIRTUAL_CELL_HEIGHT / 2.5,
	inlineImages: false,
	center: true,
	showStatus: true,
};

export const CONFIG_PATH = join(homedir(), ".pi", "agent", "sixel-math.json");

function readConfigFile(path: string): Partial<SixelMathConfig> {
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object") return {};
		return parsed as Partial<SixelMathConfig>;
	} catch {
		return {};
	}
}

function envOverrides(env: NodeJS.ProcessEnv): Partial<SixelMathConfig> {
	const config: Partial<SixelMathConfig> = {};
	const background = env.PI_SIXEL_MATH_BG?.trim();
	if (background) config.background = background;
	const foreground = env.PI_SIXEL_MATH_FG?.trim();
	if (foreground) config.foreground = foreground;
	if (env.PI_SIXEL_MATH_OFF === "1" || env.PI_SIXEL_MATH_OFF === "true") config.enabled = false;
	const maxRows = Number(env.PI_SIXEL_MATH_MAX_ROWS);
	if (Number.isFinite(maxRows) && maxRows > 0) config.maxRows = Math.floor(maxRows);
	const colors = Number(env.PI_SIXEL_MATH_COLORS);
	if (Number.isFinite(colors) && colors >= 2) config.maxColors = Math.min(256, Math.floor(colors));
	const exPx = Number(env.PI_SIXEL_MATH_EX_PX);
	if (Number.isFinite(exPx) && exPx > 0) config.exPx = exPx;
	if (env.PI_SIXEL_MATH_INLINE === "1") config.inlineImages = true;
	return config;
}

/** Merge defaults, `~/.pi/agent/sixel-math.json`, and `PI_SIXEL_MATH_*` environment variables. */
export function loadConfig(path = CONFIG_PATH, env: NodeJS.ProcessEnv = process.env): SixelMathConfig {
	return { ...DEFAULTS, ...readConfigFile(path), ...envOverrides(env) };
}

export const DEFAULT_CONFIG = DEFAULTS;
