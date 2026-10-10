import { compositeOver, parseColor, rasterize, toHex, type Rgb, type RgbaImage } from "./raster.js";
import { imageToSixel } from "./sixel.js";
import { needsDisplayMode, typesetSync, withPixelBox } from "./latex.js";

/** Windows Terminal maps SIXEL pixels onto a fixed virtual grid of 10x20 per cell. */
export const WT_VIRTUAL_CELL_WIDTH = 10;
export const WT_VIRTUAL_CELL_HEIGHT = 20;

export interface MathImageOptions {
	display?: boolean;
	/** Columns available for the image (the transcript width). */
	maxColumns: number;
	foreground: Rgb;
	background: Rgb;
	cellWidthPx?: number;
	cellHeightPx?: number;
	/** Virtual pixels per `ex`. Defaults to `cellHeightPx / 2.5`, i.e. terminal font size. */
	exPx?: number;
	maxRows?: number;
	/** Supersampling factor used while rasterizing. */
	ssaa?: number;
	/** Load the system font database (needed for CJK inside `\text{}`). */
	loadSystemFonts?: boolean;
	maxColors?: number;
}

export interface MathImage {
	dcs: string;
	columns: number;
	rows: number;
	widthPx: number;
	heightPx: number;
	/** Rows the SIXEL advances the text cursor, measured from the anchor row. */
	cursorAdvance: number;
	latex: string;
	display: boolean;
	scaled: boolean;
}

export interface RenderedMath {
	image: MathImage;
	raster: RgbaImage;
}

export function defaultForeground(): Rgb {
	return { r: 0xe5, g: 0xe5, b: 0xe7 };
}

export function defaultBackground(): Rgb {
	return { r: 0, g: 0, b: 0 };
}

/**
 * Typeset LaTeX and rasterize it into a SIXEL image sized for the terminal's
 * virtual pixel grid.
 *
 * The whole layout works in "virtual pixels": one column is `cellWidthPx` wide
 * and one row is `cellHeightPx` tall, which is exactly how Windows Terminal
 * renders SIXEL data, so the image lines up with the surrounding text without
 * any per-terminal guessing.
 */
export async function renderMathToImage(latex: string, options: MathImageOptions): Promise<RenderedMath> {
	return renderMathToImageSync(latex, options);
}

/** Synchronous variant; requires {@link initMathJax} to have resolved. */
export function renderMathToImageSync(latex: string, options: MathImageOptions): RenderedMath {
	const display = options.display ?? true;
	const cellWidthPx = options.cellWidthPx ?? WT_VIRTUAL_CELL_WIDTH;
	const cellHeightPx = options.cellHeightPx ?? WT_VIRTUAL_CELL_HEIGHT;
	const exPx = options.exPx ?? cellHeightPx / 2.5;
	const ssaa = Math.max(1, options.ssaa ?? 4);

	const typesetResult = typesetSync(latex, display || needsDisplayMode(latex));
	const naturalWidthPx = Math.max(1, typesetResult.widthEx * exPx);
	const naturalHeightPx = Math.max(1, typesetResult.heightEx * exPx);
	const aspect = naturalWidthPx / naturalHeightPx;

	const maxWidthPx = Math.max(1, options.maxColumns * cellWidthPx);
	const maxBands = options.maxRows && options.maxRows > 0
		? Math.max(1, Math.floor((options.maxRows * cellHeightPx) / 6))
		: Number.POSITIVE_INFINITY;

	// SIXEL bands are six device pixels tall; choosing a whole number of bands
	// keeps the cursor arithmetic (and the reserved row count) exact.
	let bands = Math.max(1, Math.min(maxBands, Math.round(naturalHeightPx / 6)));
	let heightPx = bands * 6;
	let widthPx = Math.max(1, Math.round(heightPx * aspect));
	let scaled = bands * 6 < naturalHeightPx - 3;

	if (widthPx > maxWidthPx) {
		widthPx = maxWidthPx;
		bands = Math.max(1, Math.min(maxBands, Math.max(1, Math.floor(maxWidthPx / aspect / 6))));
		heightPx = bands * 6;
		scaled = true;
	}

	const finalWidthPx = widthPx;
	const finalHeightPx = heightPx;

	const svg = withPixelBox(typesetResult, finalWidthPx, finalHeightPx, toHex(options.foreground));
	// MathJax draws math glyphs as outlines, but characters outside its fonts (CJK
	// text, emoji) end up as SVG text elements, which need a real font database.
	const loadSystemFonts = options.loadSystemFonts ?? /[^\x00-\x7f]/.test(latex);
	const supersampled = rasterize(svg, finalWidthPx, finalHeightPx, ssaa, { loadSystemFonts });
	const opaque = compositeOver(supersampled, options.background);
	const dcs = imageToSixel(opaque, {
		maxColors: options.maxColors ?? 24,
		transparent: options.background,
		transparentTolerance: 18,
		aspectNumerator: 1,
		aspectDenominator: 1,
	});

	const columns = Math.max(1, Math.ceil(finalWidthPx / cellWidthPx));
	const rows = Math.max(1, Math.ceil(finalHeightPx / cellHeightPx));
	// The last band's top edge is where the text cursor stops after the image.
	const cursorAdvance = Math.floor((6 * (bands - 1)) / cellHeightPx);

	return {
		image: {
			dcs,
			columns,
			rows,
			widthPx: finalWidthPx,
			heightPx: finalHeightPx,
			cursorAdvance,
			latex,
			display,
			scaled,
		},
		raster: opaque,
	};
}

export function colorFromString(value: string | undefined, fallback: Rgb): Rgb {
	if (!value) return fallback;
	return parseColor(value) ?? fallback;
}
