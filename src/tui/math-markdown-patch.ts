import { Markdown } from "@earendil-works/pi-tui";
import type { MathImage } from "../renderer/math-image.js";
import { containsPotentialMath, findMath } from "../parser/markdown.js";

export const GENERATED_MATH_FENCE = "````pi-sixel-math";

/** FNV-1a; used to derive stable image ids and reserved-row tags from content. */
export function hashString(value: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash >>> 0;
}

const FENCE_OPEN = /^\s*`{3,}\s*pi-sixel-math\s*$/;
const FENCE_CLOSE = /^\s*`{3,}\s*$/;

export interface BlockPlacement {
	marker: string;
	latex: string;
	image: MathImage;
	/** The image line plus the rows reserved for it. */
	lines: string[];
}

export interface InlinePlacement {
	marker: string;
	latex: string;
	/** Escape sequence that draws the image and returns the cursor. */
	sequence: string;
	columns: number;
}

export interface MathPlan {
	source: string;
	transformed: string;
	blocks: BlockPlacement[];
	inlines: InlinePlacement[];
}

/**
 * A terminal line carrying a SIXEL image.
 *
 * The line is shaped for pi-tui's existing kitty-image handling:
 *  - the trailing `\x1b_G...;` makes `isImageLine()` true, so the renderer stops
 *    measuring and wrapping the line, and
 *  - its `r=` parameter makes `getKittyImageReservedRows()` reserve `rows` rows.
 *
 * Windows Terminal ignores the APC sequence, but the renderer then pre-scrolls
 * `rows - 1` lines before drawing, which guarantees the image fits on screen and
 * therefore never scrolls the terminal behind the TUI's back. The trailing
 * cursor-up puts the text cursor back on the anchor row, where the renderer
 * expects it after writing an image line.
 */
export function buildSixelLine(image: MathImage, imageId: number, tag: number, leftPad = 0): string {
	const cursorRestore = image.cursorAdvance > 0 ? `\x1b[${image.cursorAdvance}A` : "";
	const header = `\x1b_Gi=${imageId},r=${image.rows};q\x1b\\`;
	return `${" ".repeat(Math.max(0, leftPad))}${image.dcs}${cursorRestore}${header}`;
}

/**
 * Zero-visible-width marker stored on the rows reserved for an image.
 *
 * pi-tui decides how many rows an image occupies by scanning the following
 * lines until it finds one with visible content, so those rows must measure 0
 * cells wide. The escape still has to *differ* whenever the image changes, so
 * that a redraw always rewrites the whole block: an SGR color sequence encodes a
 * content hash at zero width.
 */
export function reservedRowTag(tag: number): string {
	const r = (tag >>> 16) & 0xff;
	const g = (tag >>> 8) & 0xff;
	const b = tag & 0xff;
	return `\x1b[38;2;${r};${g};${b}m`;
}

export interface PlanOptions {
	/** Columns available for the image. */
	maxColumns: number;
	/** Left margin the Markdown component adds around content. */
	paddingX?: number;
	/** Render a formula to an image; return undefined to fall back to text. */
	render: (latex: string, display: boolean, maxColumns: number) => MathImage | undefined;
	/** Whether `$...$` / `\(...\)` formulas should become inline images. */
	inlineImages?: boolean;
	/** Center block images inside the available width (default true). */
	center?: boolean;
}

/** Rewrite a Markdown document: formulas become markers, everything else is untouched. */
export function createMathPlan(source: string, options: PlanOptions): MathPlan | undefined {
	if (!containsPotentialMath(source)) return undefined;
	const matches = findMath(source);
	if (matches.length === 0) return undefined;

	const blocks: BlockPlacement[] = [];
	const inlines: InlinePlacement[] = [];
	const pieces: string[] = [];
	let copiedThrough = 0;

	matches.forEach((match, index) => {
		const marker = `PI-SIXEL-MATH-${index}-${hashString(`${match.latex}\u0000${match.display}\u0000${match.inline}`).toString(36)}`;
		const display = match.display || !match.inline;
		const image = options.render(match.latex, display, options.maxColumns);
		if (!image) return;

		if (display) {
			pieces.push(source.slice(copiedThrough, match.start));
			const indent = /^[ \t]*/.exec(source.slice(source.lastIndexOf("\n", match.start - 1) + 1, match.start))?.[0] ?? "";
			const lead = match.inline ? `\n\n` : "";
			const trail = match.inline ? `\n\n` : "";
			pieces.push(`${lead}${indent}${GENERATED_MATH_FENCE}\n${indent}${marker}\n${indent}\`\`\`\`${trail}`);
			copiedThrough = match.end;

			const tag = hashString(`${image.dcs}\u0000${image.columns}\u0000${image.rows}`);
			const imageId = (tag % 0xffffff) || 1;
			const margin = Math.max(0, options.paddingX ?? 0);
			const centered = options.center === false ? 0 : Math.max(0, Math.floor((options.maxColumns - image.columns) / 2));
			const line = buildSixelLine(image, imageId, tag, margin + centered);
			const lines = [line, ...Array.from({ length: Math.max(0, image.rows - 1) }, () => reservedRowTag(tag))];
			blocks.push({ marker, latex: match.latex, image, lines });
			return;
		}

		if (!options.inlineImages || image.rows !== 1) return;
		pieces.push(source.slice(copiedThrough, match.start));
		pieces.push(marker);
		copiedThrough = match.end;
		const sequence = `${" ".repeat(image.columns)}\x1b[${image.columns}D${image.dcs}\x1b[${image.columns}C`;
		inlines.push({ marker, latex: match.latex, sequence, columns: image.columns });
	});

	if (blocks.length === 0 && inlines.length === 0) return undefined;
	pieces.push(source.slice(copiedThrough));

	return { source, transformed: pieces.join(""), blocks, inlines };
}

/** Replace markers with image lines in rendered Markdown output. */
export function applyMathPlan(lines: string[], plan: MathPlan): string[] {
	if (plan.blocks.length === 0 && plan.inlines.length === 0) return lines;
	const output: string[] = [];

	for (let index = 0; index < lines.length; index++) {
		let line = lines[index];

		const block = plan.blocks.find((candidate) => line.includes(candidate.marker));
		if (block) {
			if (output.length > 0 && FENCE_OPEN.test(stripSgr(output[output.length - 1]))) output.pop();
			if (index + 1 < lines.length && FENCE_CLOSE.test(stripSgr(lines[index + 1]))) index++;
			output.push(...block.lines);
			continue;
		}

		for (const inline of plan.inlines) {
			if (!line.includes(inline.marker)) continue;
			line = line.replace(inline.marker, () => inline.sequence);
		}
		output.push(line);
	}

	return output;
}

function stripSgr(value: string): string {
	// eslint-disable-next-line no-control-regex
	return value.replace(/\u001b\[[0-9;:]*m/g, "");
}

/** Minimal structural type of the Markdown component internals the patch touches. */
interface MarkdownInternals {
	text: string;
	paddingX?: number;
}

export interface MathMarkdownPatchOptions extends PlanOptions {
	enabled: () => boolean;
	/** Called when a plan was produced, for diagnostics. */
	onPlan?: (plan: MathPlan) => void;
}

export interface MathMarkdownPatch {
	uninstall(): void;
	clearCache(): void;
	readonly cacheSize: number;
}

const MAX_PLAN_CACHE = 256;

/**
 * Wrap `Markdown.prototype.render` so that rendered formulas are replaced with
 * SIXEL images.
 *
 * The document text is swapped only for the duration of the original render
 * call, so the conversation (and therefore the model context) always keeps the
 * original LaTeX.
 */
export function installMathMarkdownPatch(options: MathMarkdownPatchOptions): MathMarkdownPatch {
	const originalRender = Markdown.prototype.render;
	let cache = new Map<string, MathPlan | undefined>();

	const patched = function render(this: Markdown, width: number): string[] {
		const internals = this as unknown as MarkdownInternals;
		const source = internals.text;
		if (!options.enabled() || typeof source !== "string" || !containsPotentialMath(source)) {
			return originalRender.call(this, width);
		}

		const paddingX = typeof internals.paddingX === "number" && internals.paddingX > 0 ? internals.paddingX : 0;
		const contentWidth = Math.max(1, width - paddingX * 2);
		const key = `${width}\u0000${contentWidth}\u0000${source}`;

		let plan: MathPlan | undefined;
		if (cache.has(key)) {
			plan = cache.get(key);
		} else {
			try {
				plan = createMathPlan(source, { ...options, maxColumns: contentWidth, paddingX });
			} catch {
				plan = undefined;
			}
			if (cache.size >= MAX_PLAN_CACHE) cache = new Map();
			cache.set(key, plan);
			if (plan) options.onPlan?.(plan);
		}

		if (!plan) return originalRender.call(this, width);

		const saved = internals.text;
		let lines: string[];
		try {
			internals.text = plan.transformed;
			lines = originalRender.call(this, width);
		} finally {
			internals.text = saved;
		}
		return applyMathPlan(lines, plan);
	};

	Markdown.prototype.render = patched as typeof Markdown.prototype.render;

	return {
		uninstall() {
			if (Markdown.prototype.render === patched) {
				Markdown.prototype.render = originalRender;
			}
			cache = new Map();
		},
		clearCache() {
			cache = new Map();
		},
		get cacheSize() {
			return cache.size;
		},
	};
}
