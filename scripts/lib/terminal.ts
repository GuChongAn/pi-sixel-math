import { initMathJax } from "../../src/renderer/latex.js";
import { renderMathToImageSync, WT_VIRTUAL_CELL_HEIGHT, WT_VIRTUAL_CELL_WIDTH } from "../../src/renderer/math-image.js";
import type { MathImage } from "../../src/renderer/math-image.js";
import type { Rgb } from "../../src/renderer/raster.js";

export interface TerminalRenderOptions {
	foreground?: Rgb;
	background?: Rgb;
	columns?: number;
	maxRows?: number;
	exPx?: number;
}

export function terminalColumns(): number {
	return Math.max(40, process.stdout.columns ?? 100);
}

/**
 * Print a formula as a SIXEL image and leave the cursor on the row below it.
 *
 * In a plain terminal (no TUI) Windows Terminal moves the text cursor to the
 * cell intersected by the top of the last sixel band, so the remaining rows have
 * to be skipped explicitly.
 */
export function printFormula(latex: string, options: TerminalRenderOptions = {}): MathImage {
	const columns = options.columns ?? terminalColumns();
	const { image } = renderMathToImageSync(latex, {
		display: true,
		maxColumns: Math.max(8, columns - 2),
		foreground: options.foreground ?? { r: 0xe5, g: 0xe5, b: 0xe7 },
		background: options.background ?? { r: 0x0c, g: 0x0c, b: 0x0c },
		cellWidthPx: WT_VIRTUAL_CELL_WIDTH,
		cellHeightPx: WT_VIRTUAL_CELL_HEIGHT,
		exPx: options.exPx,
		maxRows: options.maxRows ?? 20,
		ssaa: 4,
		maxColors: 32,
	});
	const skip = Math.max(0, image.rows - image.cursorAdvance);
	process.stdout.write(image.dcs);
	process.stdout.write(`\x1b[${skip}B\r`);
	return image;
}

export { initMathJax };
