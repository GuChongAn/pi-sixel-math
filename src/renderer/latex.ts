/**
 * LaTeX -> SVG typesetting through MathJax.
 *
 * MathJax is expensive to load, so it is imported lazily and shared through
 * module state. After {@link initMathJax} resolves, {@link typesetSync} is fully
 * synchronous: the Pi transcript renderer must produce lines synchronously, so
 * nothing in the render path may await.
 */

export interface TypesetSvg {
	/** Serialized `<svg>` element without the surrounding `mjx-container`. */
	svg: string;
	/** Natural width of the formula in ex units, as reported by MathJax. */
	widthEx: number;
	/** Natural height of the formula in ex units, as reported by MathJax. */
	heightEx: number;
	/** Distance the formula descends below the baseline, in ex units. */
	depthEx: number;
	/** MathJax viewBox (in ex units): `minX minY width height`. */
	viewBox: { x: number; y: number; width: number; height: number };
}

export interface MathJaxOptions {
	/** Extra TeX packages; defaults to every MathJax package. */
	packages?: string[];
	/** Extra TeX macros, e.g. `{ "\\RR": "\\mathbb{R}" }`. */
	macros?: Record<string, string>;
}

export class LatexError extends Error {
	readonly latex: string;
	constructor(message: string, latex: string) {
		super(message);
		this.name = "LatexError";
		this.latex = latex;
	}
}

type MathJaxRuntime = {
	convert: (tex: string, options: { display: boolean }) => unknown;
	innerHTML: (node: unknown) => string;
};

let runtime: MathJaxRuntime | undefined;
let runtimePromise: Promise<MathJaxRuntime> | undefined;
let initOptions: MathJaxOptions = {};

async function loadRuntime(): Promise<MathJaxRuntime> {
	const [
		{ mathjax },
		{ TeX },
		{ SVG },
		{ liteAdaptor },
		{ RegisterHTMLHandler },
		{ AllPackages },
	] = await Promise.all([
		import("mathjax-full/js/mathjax.js"),
		import("mathjax-full/js/input/tex.js"),
		import("mathjax-full/js/output/svg.js"),
		import("mathjax-full/js/adaptors/liteAdaptor.js"),
		import("mathjax-full/js/handlers/html.js"),
		import("mathjax-full/js/input/tex/AllPackages.js"),
	]);

	const adaptor = liteAdaptor();
	RegisterHTMLHandler(adaptor);

	const packages = initOptions.packages;
	const tex = new TeX({
		packages: packages?.length ? packages : AllPackages,
		macros: initOptions.macros ?? {},
	});
	const svg = new SVG({ fontCache: "local" });
	const document = mathjax.document("", { InputJax: tex, OutputJax: svg });

	return {
		convert: (source, options) => document.convert(source, options) as never,
		innerHTML: (node) => adaptor.innerHTML(node as never),
	};
}

/** Load and configure MathJax. Safe to call repeatedly; only the first call does work. */
export function initMathJax(options: MathJaxOptions = {}): Promise<void> {
	initOptions = { ...initOptions, ...options };
	runtimePromise ??= loadRuntime().then((value) => {
		runtime = value;
		return value;
	});
	return runtimePromise.then(() => undefined);
}

export function isMathJaxReady(): boolean {
	return runtime !== undefined;
}

/**
 * Rewrite the MathJax `<svg>` root so the formula rasterizes into an explicit
 * pixel box while keeping the original viewBox (i.e. no distortion).
 *
 * MathJax paints with `currentColor`, which a standalone rasterizer cannot
 * resolve, so the concrete foreground color is substituted in as well.
 */
export function withPixelBox(typesetSvg: TypesetSvg, widthPx: number, heightPx: number, foreground = "#e5e5e7"): string {
	const { x, y, width, height } = typesetSvg.viewBox;
	const match = /<svg\b[^>]*>/i.exec(typesetSvg.svg);
	if (!match) throw new Error("SVG root element not found");
	const openTag = match[0];
	const inner = typesetSvg.svg
		.slice(match.index + openTag.length)
		.replace(/<\/svg>\s*$/i, "")
		.replace(/currentColor/g, foreground);

	const kept = openTag
		.slice(0, -1)
		.replace(/\s*\/$/, "")
		.replace(/\s(width|height|viewBox|preserveAspectRatio|style)\s*=\s*"[^"]*"/gi, "");
	const attrs = ` xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}" viewBox="${x} ${y} ${width} ${height}" preserveAspectRatio="xMidYMid meet"`;
	return `${kept}${attrs}>${inner}</svg>`;
}

function parseEx(value: string | undefined, fallback = 0): number {
	if (!value) return fallback;
	const match = /(-?\d*\.?\d+(?:e[-+]?\d+)?)\s*ex/i.exec(value);
	if (match) return Number.parseFloat(match[1]);
	const px = /(-?\d*\.?\d+)\s*px/i.exec(value);
	if (px) return Number.parseFloat(px[1]);
	const bare = /(-?\d*\.?\d+)/.exec(value);
	return bare ? Number.parseFloat(bare[1]) : fallback;
}

function parseViewBox(value: string | undefined): TypesetSvg["viewBox"] | undefined {
	if (!value) return undefined;
	const parts = value.trim().split(/[\s,]+/).map(Number);
	if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return undefined;
	return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
}

/**
 * Typeset LaTeX into an SVG string.
 *
 * MathJax sizes its output in `ex` units relative to the surrounding text, which
 * is exactly what is needed to keep formulas the same visual size as the
 * terminal font: one `ex` is roughly half a character cell.
 */
export function typesetSync(latex: string, display = true): TypesetSvg {
	if (!runtime) throw new LatexError("MathJax is not initialized", latex);
	const source = normalizeLatex(latex);
	if (!source.trim()) throw new LatexError("Formula is empty", latex);

	let html: string;
	try {
		html = runtime.innerHTML(runtime.convert(source, { display }));
	} catch (error) {
		throw new LatexError(error instanceof Error ? error.message : String(error), latex);
	}

	if (html.includes("data-mml-node=\"merror\"") || html.includes("mjx-merror")) {
		throw new LatexError("MathJax reported a TeX error", latex);
	}

	const svg = /<svg\b[^>]*>[\s\S]*<\/svg>/i.exec(html)?.[0];
	if (!svg) throw new LatexError("MathJax did not produce an SVG element", latex);

	const openTag = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? "";
	const attr = (name: string): string | undefined => {
		const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i").exec(openTag);
		return match?.[1];
	};

	const widthEx = parseEx(attr("width"));
	const heightEx = parseEx(attr("height"));
	if (!(widthEx > 0) || !(heightEx > 0)) {
		throw new LatexError("MathJax produced an SVG without usable dimensions", latex);
	}
	const depthMatch = /vertical-align:\s*(-?[\d.]+)\s*ex/i.exec(attr("style") ?? "");
	const depthEx = depthMatch ? -Number.parseFloat(depthMatch[1]) : 0;
	const viewBox = parseViewBox(attr("viewBox"));

	return {
		svg,
		widthEx,
		heightEx,
		depthEx,
		viewBox: viewBox ?? { x: 0, y: -depthEx, width: widthEx, height: heightEx },
	};
}

/**
 * Wrap display environments such as `\begin{align}` that MathJax refuses to
 * typeset in inline mode.
 */
export function needsDisplayMode(latex: string): boolean {
	return /\\begin\{(align|alignat|gather|multline|equation|flalign|eqnarray)\*?\}/.test(latex);
}

function isEscaped(text: string, index: number): boolean {
	let backslashes = 0;
	for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) backslashes++;
	return backslashes % 2 === 1;
}

function findMatchingBrace(text: string, opening: number): number {
	let depth = 0;
	for (let i = opening; i < text.length; i++) {
		if (isEscaped(text, i)) continue;
		if (text[i] === "{") depth++;
		else if (text[i] === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

function stripBracedCommand(input: string, command: "label" | "tag" | "notag"): string {
	let output = input;
	let from = 0;
	const marker = `\\${command}`;
	while (from < output.length) {
		const start = output.indexOf(marker, from);
		if (start < 0) break;
		let cursor = start + marker.length;
		if (command === "tag" && output[cursor] === "*") cursor++;
		if (/[A-Za-z]/.test(output[cursor] ?? "")) {
			from = cursor;
			continue;
		}
		while (/\s/.test(output[cursor] ?? "")) cursor++;
		if (output[cursor] !== "{") {
			if (command === "notag") {
				output = output.slice(0, start) + output.slice(cursor);
				from = start;
				continue;
			}
			from = cursor;
			continue;
		}
		const closing = findMatchingBrace(output, cursor);
		if (closing < 0) break;
		const body = output.slice(cursor + 1, closing);
		const replacement = command === "tag" ? `\\qquad\\mathrm{(${body})}` : "";
		output = output.slice(0, start) + replacement + output.slice(closing + 1);
		from = start + replacement.length;
	}
	return output;
}

const REDUNDANT_ENVIRONMENTS = /^\\begin\{(equation\*?|displaymath|math)\}/;
const REDUNDANT_ENVIRONMENTS_END = (name: string): string => `\\end{${name}}`;

/**
 * Remove markup that only makes sense in a full LaTeX document, so a model that
 * emits `\begin{equation}...\label{eq:x}\end{equation}` still renders.
 */
export function normalizeLatex(input: string): string {
	let latex = stripBracedCommand(input.trim(), "label");
	latex = stripBracedCommand(latex, "tag");
	latex = latex.replace(/\\(?:notag|nonumber)\b/g, "").trim();

	for (;;) {
		const opening = REDUNDANT_ENVIRONMENTS.exec(latex);
		if (!opening) break;
		const closing = REDUNDANT_ENVIRONMENTS_END(opening[1]);
		if (!latex.endsWith(closing)) break;
		latex = latex.slice(opening[0].length, -closing.length).trim();
	}
	return latex;
}
