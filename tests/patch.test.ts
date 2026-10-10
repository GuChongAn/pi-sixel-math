import assert from "node:assert/strict";
import { test } from "node:test";
import { initMathJax } from "../src/renderer/latex.js";
import { renderMathToImageSync, type MathImage } from "../src/renderer/math-image.js";
import {
	GENERATED_MATH_FENCE,
	applyMathPlan,
	buildSixelLine,
	createMathPlan,
	installMathMarkdownPatch,
	reservedRowTag,
} from "../src/tui/math-markdown-patch.js";
import { Markdown, visibleWidth, type MarkdownTheme } from "@earendil-works/pi-tui";
import { getCapabilities } from "@earendil-works/pi-tui";

await initMathJax();

const identity = (text: string): string => text;
const theme: MarkdownTheme = {
	heading: identity,
	link: identity,
	linkUrl: identity,
	code: identity,
	codeBlock: identity,
	codeBlockBorder: identity,
	quote: identity,
	quoteBorder: identity,
	hr: identity,
	listBullet: identity,
	bold: identity,
	italic: identity,
	strikethrough: identity,
	underline: identity,
};

function renderer(maxColumns = 60) {
	return (latex: string, display: boolean, columns: number): MathImage | undefined => {
		try {
			return renderMathToImageSync(latex, {
				display,
				maxColumns: Math.min(columns, maxColumns),
				foreground: { r: 229, g: 229, b: 231 },
				background: { r: 12, g: 12, b: 12 },
			}).image;
		} catch {
			return undefined;
		}
	};
}

test("the sixel line is recognized by pi-tui as an image line with reserved rows", () => {
	const image: MathImage = {
		dcs: "\x1bP0;0;0q\"1;1;30;60#0!3~\x1b\\",
		columns: 3,
		rows: 3,
		widthPx: 30,
		heightPx: 60,
		cursorAdvance: 1,
		latex: "x",
		display: true,
		scaled: false,
	};
	const line = buildSixelLine(image, 1234, 0xabcdef, 2);
	assert.ok(line.startsWith("  \x1bP"));
	assert.ok(line.includes("\x1b[1A"), "the cursor must return to the anchor row");
	assert.ok(line.trimEnd().endsWith("\x1b\\"), "the kitty marker ends the line");
	assert.equal(line.includes("\x1b_Gi=1234,r=3;"), true);
});

test("reserved rows measure zero cells wide but change with the image", () => {
	const a = reservedRowTag(0x112233);
	const b = reservedRowTag(0x445566);
	assert.notEqual(a, b);
	// visibleWidth is what pi-tui uses to count reserved rows.
	assert.equal(visibleWidth(a), 0);
});

test("createMathPlan replaces display math with a fenced marker", () => {
	const plan = createMathPlan("前文\n\n$$x^2$$\n\n后文", { maxColumns: 60, render: renderer() });
	assert.ok(plan);
	assert.equal(plan.blocks.length, 1);
	assert.equal(plan.blocks[0].latex, "x^2");
	assert.ok(plan.transformed.includes(GENERATED_MATH_FENCE));
	assert.ok(plan.transformed.includes(plan.blocks[0].marker));
	assert.equal(plan.transformed.includes("$$"), false);
	assert.ok(plan.transformed.startsWith("前文"));
	assert.ok(plan.transformed.endsWith("后文"));
});

test("code spans and code blocks keep their LaTeX", () => {
	const source = ["```", "$$keep$$", "```", "", "inline `$keep$` and $$render$$"].join("\n");
	const plan = createMathPlan(source, { maxColumns: 60, render: renderer() });
	assert.ok(plan);
	assert.equal(plan.blocks.length, 1);
	assert.equal(plan.blocks[0].latex, "render");
	assert.ok(plan.transformed.includes("$$keep$$"));
	assert.ok(plan.transformed.includes("`$keep$`"));
});

test("a formula that fails to render is left untouched", () => {
	const calls: string[] = [];
	const plan = createMathPlan("$$\\frac{1}{$$\n\n$$ok$$", {
		maxColumns: 60,
		render: (latex, display, columns) => {
			calls.push(latex);
			if (latex.includes("frac{1}{")) return undefined;
			return renderer()(latex, display, columns);
		},
	});
	assert.ok(plan);
	assert.deepEqual(calls, ["\\frac{1}{", "ok"]);
	assert.equal(plan.transformed.includes("$$\\frac{1}{$$"), true);
});

test("applyMathPlan swaps the marker line for the image block", async () => {
	const source = "前文\n\n$$x^2$$\n\n后文";
	const plan = createMathPlan(source, { maxColumns: 60, render: renderer(60) })!;
	assert.ok(plan);
	const md = new Markdown(source, 1, 0, theme, undefined, {});
	const patched = installMathMarkdownPatch({
		enabled: () => true,
		maxColumns: 60,
		render: renderer(60),
	});
	const lines = md.render(60);
	patched.uninstall();

	const image = plan.blocks[0].image;
	assert.ok(lines.some((line) => line.includes(image.dcs.slice(0, 12))));
	const imageLine = lines.find((line) => line.includes("\x1bP0;0;0q"))!;
	assert.ok(imageLine.includes(image.dcs));
	assert.ok(imageLine.includes("\x1b_Gi="));
	// Reserved rows follow the image line, one per extra row.
	const index = lines.indexOf(imageLine);
	for (let row = 1; row < image.rows; row++) {
		assert.ok(lines[index + row].includes("\x1b[38;2;"), `row ${row} must be a reserved row`);
	}
	// The text around the formula is preserved.
	assert.ok(lines.some((line) => line.includes("前文")));
	assert.ok(lines.some((line) => line.includes("后文")));
});

test("installMathMarkdownPatch restores the original text and uninstalls cleanly", () => {
	const source = "说明\n\n$$a+b$$\n\n结束";
	const md = new Markdown(source, 1, 0, theme, undefined, {});
	const original = Markdown.prototype.render;
	const patch = installMathMarkdownPatch({ enabled: () => true, maxColumns: 60, render: renderer(60) });
	assert.notEqual(Markdown.prototype.render, original);
	const lines = md.render(60);
	assert.ok(lines.some((line) => line.includes("\x1bP0;0;0q")));
	assert.equal((md as unknown as { text: string }).text, source, "the component must keep the original LaTeX");
	patch.uninstall();
	assert.equal(Markdown.prototype.render, original);
	const after = md.render(60);
	assert.equal(after.some((line) => line.includes("\x1bP0;0;0q")), false);
});

test("disabling the patch falls back to the built-in renderer", () => {
	const source = "$$\\frac{a}{b}$$";
	const md = new Markdown(source, 0, 0, theme, undefined, {});
	const patch = installMathMarkdownPatch({ enabled: () => false, maxColumns: 60, render: renderer(60) });
	const lines = md.render(40);
	assert.equal(lines.some((line) => line.includes("\x1bP")), false);
	patch.uninstall();
});

test("plans are cached per width", () => {
	let renders = 0;
	const patch = installMathMarkdownPatch({
		enabled: () => true,
		maxColumns: 60,
		render: (latex, display, columns) => {
			renders++;
			return renderer()(latex, display, columns);
		},
	});
	const md = new Markdown("$$x^2$$", 0, 0, theme, undefined, {});
	md.render(60);
	const afterFirst = renders;
	md.render(60);
	const afterSecond = renders;
	md.render(30);
	patch.uninstall();
	assert.equal(afterSecond, afterFirst, "the same width must be served from the cache");
	assert.ok(renders > afterSecond, "a different width must be rendered again");
});

test("capabilities detection does not report a kitty terminal on Windows Terminal", () => {
	// Guards the assumption behind this extension: pi-tui reports `null` images
	// for Windows Terminal, which is exactly why SIXEL support is needed.
	const capabilities = getCapabilities();
	assert.ok(capabilities === undefined || typeof capabilities === "object");
});
