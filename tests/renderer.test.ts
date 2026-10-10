import assert from "node:assert/strict";
import { test } from "node:test";
import { initMathJax, isMathJaxReady, normalizeLatex, typesetSync, withPixelBox } from "../src/renderer/latex.js";
import { renderMathToImageSync, WT_VIRTUAL_CELL_HEIGHT, WT_VIRTUAL_CELL_WIDTH } from "../src/renderer/math-image.js";
import { decodeSixel } from "../src/renderer/sixel.js";

const foreground = { r: 0xe5, g: 0xe5, b: 0xe7 };
const background = { r: 0x0c, g: 0x0c, b: 0x0c };

await initMathJax();

test("MathJax is initialized", () => {
	assert.equal(isMathJaxReady(), true);
});

test("typeset reports ex dimensions and a viewBox", () => {
	const result = typesetSync(String.raw`\frac{a}{b}`, true);
	assert.ok(result.widthEx > 0);
	assert.ok(result.heightEx > 0);
	assert.ok(result.viewBox.width > 0);
	assert.ok(result.svg.startsWith("<svg"));
});

test("withPixelBox produces a standalone, sized svg", () => {
	const result = typesetSync(String.raw`x^2`, false);
	const svg = withPixelBox(result, 40, 20, "#ff0000");
	assert.ok(svg.includes('width="40"'));
	assert.ok(svg.includes('height="20"'));
	assert.ok(svg.includes("preserveAspectRatio"));
	assert.ok(svg.includes("#ff0000"), "currentColor must be resolved for the rasterizer");
	assert.equal(svg.includes("currentColor"), false);
});

test("renders a formula into a decodable sixel image", () => {
	const { image, raster } = renderMathToImageSync(String.raw`\sum_{i=1}^{n} x_i^2`, {
		display: true,
		maxColumns: 80,
		foreground,
		background,
	});
	assert.ok(image.columns >= 1);
	assert.ok(image.rows >= 1);
	assert.ok(image.dcs.startsWith("\x1bP0;1;0q"), "formulas must use a transparent image background");
	assert.equal(image.heightPx % 6, 0, "height must be a whole number of sixel bands");
	assert.equal(raster.width, image.widthPx);
	assert.equal(raster.height, image.heightPx);

	const decoded = decodeSixel(image.dcs);
	assert.equal(decoded.width, image.widthPx);
	assert.ok(decoded.height >= image.heightPx - 6);

	// The image must line up with the terminal grid it claims to occupy.
	assert.equal(image.columns, Math.ceil(image.widthPx / WT_VIRTUAL_CELL_WIDTH));
	assert.equal(image.rows, Math.ceil(image.heightPx / WT_VIRTUAL_CELL_HEIGHT));
});

test("long formulas are scaled down to the available width", () => {
	const latex = String.raw`L(\theta)=-\frac{1}{N}\sum_{i=1}^{N}\log\frac{\exp(s_{i,i}/\tau)}{\sum_{j=1}^{N}\exp(s_{i,j}/\tau)}`;
	const wide = renderMathToImageSync(latex, { display: true, maxColumns: 200, foreground, background });
	const narrow = renderMathToImageSync(latex, { display: true, maxColumns: 15, foreground, background });
	assert.ok(wide.image.widthPx > narrow.image.widthPx);
	assert.ok(narrow.image.scaled);
	assert.ok(narrow.image.columns <= 15, `expected <= 15 columns, got ${narrow.image.columns}`);
	assert.ok(wide.image.columns > 15);
});

test("maxRows caps the height", () => {
	const latex = String.raw`\begin{bmatrix}a&b\\c&d\\e&f\\g&h\end{bmatrix}`;
	const { image } = renderMathToImageSync(latex, { display: true, maxColumns: 80, foreground, background, maxRows: 2 });
	assert.ok(image.rows <= 2, `expected <= 2 rows, got ${image.rows}`);
});

test("cursorAdvance matches the last sixel band", () => {
	const { image } = renderMathToImageSync(String.raw`\frac{a}{b}`, { display: true, maxColumns: 40, foreground, background });
	const bands = image.heightPx / 6;
	assert.equal(image.cursorAdvance, Math.floor((6 * (bands - 1)) / WT_VIRTUAL_CELL_HEIGHT));
	assert.ok(image.cursorAdvance < image.rows);
});

test("invalid LaTeX throws instead of rendering garbage", () => {
	assert.throws(() => typesetSync(String.raw`\frac{1}{`, true));
	assert.throws(() => typesetSync("", true));
});

test("normalizeLatex strips document-only markup", () => {
	assert.equal(normalizeLatex(String.raw`\begin{equation}x^2\label{eq:a}\end{equation}`), "x^2");
	assert.equal(normalizeLatex(String.raw`E=mc^2\notag`), "E=mc^2");
	assert.equal(normalizeLatex(String.raw`x+y\tag{1}`), String.raw`x+y\qquad\mathrm{(1)}`);
});

test("the same formula renders identically twice (deterministic cache key)", () => {
	const first = renderMathToImageSync(String.raw`\alpha+\beta`, { display: true, maxColumns: 60, foreground, background });
	const second = renderMathToImageSync(String.raw`\alpha+\beta`, { display: true, maxColumns: 60, foreground, background });
	assert.equal(first.image.dcs, second.image.dcs);
});

test("transparent mode leaves the background unpainted", () => {
	const { image } = renderMathToImageSync(String.raw`\frac{a}{b}`, {
		display: true,
		maxColumns: 40,
		foreground,
	});
	const decoded = decodeSixel(image.dcs);
	let painted = 0;
	for (let i = 3; i < decoded.pixels.length; i += 4) {
		if (decoded.pixels[i] > 0) painted++;
	}
	const coverage = painted / (decoded.width * decoded.height);
	assert.ok(coverage > 0.05, `expected glyphs to be painted, coverage was ${coverage}`);
	assert.ok(coverage < 0.6, `expected most of the image to stay transparent, coverage was ${coverage}`);
});

test("transparency keeps the payload small for sparse formulas", () => {
	const { image } = renderMathToImageSync(String.raw`\int_0^1 x\,dx`, { display: true, maxColumns: 60, foreground, background });
	assert.ok(image.dcs.length < 6000, `sixel payload unexpectedly large: ${image.dcs.length}`);
});
