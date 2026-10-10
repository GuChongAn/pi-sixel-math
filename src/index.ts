import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Markdown, colorToRgb, type Color } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { loadConfig, type SixelMathConfig } from "./config.js";
import { initMathJax, isMathJaxReady } from "./renderer/latex.js";
import { renderMathToImageSync, type MathImage } from "./renderer/math-image.js";
import type { Rgb } from "./renderer/raster.js";
import { installMathMarkdownPatch, type MathPlan, type MathMarkdownPatch } from "./tui/math-markdown-patch.js";

const STATUS_KEY = "sixel-math";
const DEMO_TYPE = "sixel-math-demo";

const DEMO_MARKDOWN = [
	"### SIXEL math demo",
	"",
	"Basic fraction, superscripts and a sum:",
	"",
	"$$\\frac{a+b}{c+d}\\qquad \\sum_{i=1}^{n} x_i^2$$",
	"",
	"Reinforcement-learning objective:",
	"",
	"$$J(\\theta)=\\mathbb{E}_{\\tau\\sim\\pi_\\theta}\\left[\\sum_{t=0}^{T}\\gamma^t r_t\\right]$$",
	"",
	"A matrix and an integral:",
	"",
	"$$A=\\begin{bmatrix}1&2&3\\\\4&5&6\\\\7&8&9\\end{bmatrix}\\qquad \\int_{-\\infty}^{+\\infty} e^{-x^2}\\,dx=\\sqrt{\\pi}$$",
	"",
	"Complex nesting:",
	"",
	"$$L(\\theta)=-\\frac{1}{N}\\sum_{i=1}^{N}\\log\\frac{\\exp(s_{i,i}/\\tau)}{\\sum_{j=1}^{N}\\exp(s_{i,j}/\\tau)}$$",
	"",
	"The formulas above are the original LaTeX, typeset by MathJax and sent to the",
	"terminal as SIXEL images.",
].join("\n");

interface FormulaCacheEntry {
	image: MathImage;
}

function colorToRgbTuple(color: Color | undefined): Rgb | undefined {
	if (!color) return undefined;
	try {
		const rgb = colorToRgb(color);
		return { r: rgb.r, g: rgb.g, b: rgb.b };
	} catch {
		return undefined;
	}
}

export default function piSixelMath(pi: ExtensionAPI): void {
	const config: SixelMathConfig = loadConfig();
	let enabled = config.enabled;
	let patch: MathMarkdownPatch | undefined;
	let ready = false;
	let initError: string | undefined;
	let foreground: Rgb = { r: 0xe5, g: 0xe5, b: 0xe7 };
	let background: Rgb | undefined;
	let lastStatus: string | undefined;
	const formulaCache = new Map<string, MathImage | undefined>();

	const refreshColors = (ctx: ExtensionContext): void => {
		try {
			const theme = ctx.ui.theme;
			const explicitForeground = config.foreground ? parseHex(config.foreground) : undefined;
			const fg = explicitForeground ?? colorToRgbTuple(theme.colors.text);
			if (fg) foreground = fg;
			const bg = config.background;
			if (bg && bg !== "transparent") {
				background = parseHex(bg);
			} else if (bg === "transparent") {
				background = undefined;
			} else {
				// No explicit background: blend glyph edges toward the terminal default the
				// theme is designed for. The encoder keeps that color transparent in the
				// image itself, so the real terminal background still shows through.
				background = theme.appearance === "light" ? { r: 0xff, g: 0xff, b: 0xff } : { r: 0x0c, g: 0x0c, b: 0x0c };
			}
			formulaCache.clear();
		} catch {
			// A theme that cannot be resolved keeps the previous colors.
		}
	};

	const renderFormula = (latex: string, display: boolean, maxColumns: number): MathImage | undefined => {
		const key = `${display ? "d" : "i"}\u0000${maxColumns}\u0000${foreground.r},${foreground.g},${foreground.b}\u0000${
			background ? `${background.r},${background.g},${background.b}` : "none"
		}\u0000${latex}`;
		if (formulaCache.has(key)) return formulaCache.get(key);

		let image: MathImage | undefined;
		try {
			const result = renderMathToImageSync(latex, {
				display,
				maxColumns: Math.max(4, maxColumns),
				foreground,
				// Without a known background the formula is composited onto black and the
				// encoder keeps the background transparent, which is indistinguishable on
				// dark terminals and still readable on light ones.
				background: background ?? { r: 0x1e, g: 0x1e, b: 0x1e },
				cellWidthPx: config.cellWidthPx,
				cellHeightPx: config.cellHeightPx,
				exPx: config.exPx,
				maxRows: config.maxRows,
				ssaa: config.supersample,
				maxColors: config.maxColors,
			});
			image = result.image;
			if (image.rows > config.maxRows) image = undefined;
		} catch {
			image = undefined;
		}

		if (formulaCache.size > 256) formulaCache.clear();
		formulaCache.set(key, image);
		return image;
	};

	const statusText = (): string => {
		const state = !enabled ? "off" : initError ? "error" : ready ? "on" : "loading";
		return state === "on" ? "∑ img" : state === "loading" ? "∑ …" : state === "error" ? "∑ !" : "∑ off";
	};

	const updateStatus = (ctx: ExtensionContext): void => {
		if (!config.showStatus || ctx.mode !== "tui") return;
		const text = statusText();
		if (text === lastStatus) return;
		lastStatus = text;
		try {
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", text));
		} catch {
			// Status is cosmetic; never let it break the session.
		}
	};

	const ensurePatch = (ctx: ExtensionContext): void => {
		if (patch || ctx.mode !== "tui") return;
		patch = installMathMarkdownPatch({
			enabled: () => enabled && ready && isMathJaxReady(),
			maxColumns: 80,
			inlineImages: config.inlineImages,
			center: config.center,
			render: renderFormula,
			onPlan: (_plan: MathPlan) => undefined,
		});
	};

	pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
		refreshColors(ctx);
		ensurePatch(ctx);
		enabled = config.enabled;
		if (ctx.mode !== "tui") return;
		if (!config.enabled) {
			updateStatus(ctx);
			return;
		}
		// MathJax is heavy; load it in the background so Pi startup stays fast.
		initMathJax()
			.then(() => {
				ready = true;
				initError = undefined;
			})
			.catch((error: unknown) => {
				initError = error instanceof Error ? error.message : String(error);
			})
			.finally(() => {
				// A status update also nudges the TUI to repaint, so formulas rendered as
				// Unicode while MathJax was loading turn into images without user action.
				lastStatus = undefined;
				updateStatus(ctx);
			});
	});

	pi.on("turn_start", (_event: unknown, ctx: ExtensionContext) => {
		refreshColors(ctx);
		updateStatus(ctx);
	});

	pi.on("session_shutdown", () => {
		patch?.uninstall();
		patch = undefined;
		formulaCache.clear();
	});

	pi.registerMessageRenderer(DEMO_TYPE, (message, options) => {
		const content = typeof message.content === "string"
			? message.content
			: message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
		return new Markdown(content, options.outputPad, 0, getMarkdownTheme());
	});

	pi.registerCommand("sixel-math", {
		description: "Control SIXEL math rendering: on, off, status, demo, clear, bg <#rrggbb|transparent>",
		handler: async (args, ctx) => {
			const [action, value] = args.trim().split(/\s+/, 2);
			switch ((action ?? "status").toLowerCase()) {
				case "on": {
					enabled = true;
					lastStatus = undefined;
					updateStatus(ctx);
					ctx.ui.notify("SIXEL math rendering enabled", "info");
					return;
				}
				case "off": {
					enabled = false;
					lastStatus = undefined;
					updateStatus(ctx);
					ctx.ui.notify("SIXEL math rendering disabled", "info");
					return;
				}
				case "toggle": {
					enabled = !enabled;
					lastStatus = undefined;
					updateStatus(ctx);
					ctx.ui.notify(`SIXEL math rendering ${enabled ? "enabled" : "disabled"}`, "info");
					return;
				}
				case "clear": {
					formulaCache.clear();
					patch?.clearCache();
					ctx.ui.notify("SIXEL math caches cleared", "info");
					return;
				}
				case "bg": {
					if (!value) {
						ctx.ui.notify(`Background: ${config.background ?? "auto"}`, "info");
						return;
					}
					config.background = value === "auto" ? undefined : value;
					refreshColors(ctx);
					patch?.clearCache();
					ctx.ui.notify(`SIXEL math background: ${config.background ?? "auto"}`, "info");
					return;
				}
				case "demo": {
					pi.sendMessage({ customType: DEMO_TYPE, content: DEMO_MARKDOWN, display: true });
					return;
				}
				case "status": {
					const lines = [
						`SIXEL math: ${enabled ? "enabled" : "disabled"}${ready ? "" : initError ? ` (MathJax failed: ${initError})` : " (MathJax loading)"}`,
						`foreground: #${hex(foreground)}  background: ${config.background ?? "auto"}`,
						`grid: ${config.cellWidthPx}x${config.cellHeightPx}px/cell  ex=${config.exPx}px  maxRows=${config.maxRows}  colors=${config.maxColors}`,
						`cached formulas: ${formulaCache.size}  plans: ${patch?.cacheSize ?? 0}`,
					];
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}
				default:
					ctx.ui.notify("Usage: /sixel-math on|off|toggle|status|demo|clear|bg <#rrggbb|transparent|auto>", "warning");
			}
		},
	});
}

function parseHex(value: string): Rgb | undefined {
	const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
	if (!match) return undefined;
	const int = Number.parseInt(match[1], 16);
	return { r: (int >> 16) & 0xff, g: (int >> 8) & 0xff, b: int & 0xff };
}

function hex(color: Rgb): string {
	const part = (value: number): string => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
	return `${part(color.r)}${part(color.g)}${part(color.b)}`;
}
