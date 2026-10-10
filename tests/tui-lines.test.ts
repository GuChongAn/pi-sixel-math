import assert from "node:assert/strict";
import { test } from "node:test";
import { Container, Markdown, Spacer, Text, TuiMainScreen, type MarkdownTheme } from "@earendil-works/pi-tui";
import { installMathMarkdownPatch } from "../src/tui/math-markdown-patch.js";
import type { MathImage } from "../src/renderer/math-image.js";
import { MockTerminal } from "./helpers/mock-terminal.js";

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

const FAKE_ROWS = 3;
const FAKE_HEIGHT_PX = 60;
const FAKE_ADVANCE = 2;

/** Deterministic stand-in for a rendered formula: 3 rows tall, cursor advance 2. */
function fakeImage(latex: string, display: boolean, maxColumns: number): MathImage {
	// The width follows the formula length, so changing the formula produces a
	// different payload — exactly like a real re-render does.
	const columns = Math.max(2, Math.min(Math.min(maxColumns, 8), 2 + (latex.length % 7)));
	const widthPx = 10 * columns;
	return {
		dcs: `\x1bP0;0;0q"1;1;${widthPx};${FAKE_HEIGHT_PX}#0;2;90;90;90#0!${widthPx}~\x1b\\`,
		columns,
		rows: FAKE_ROWS,
		widthPx,
		heightPx: FAKE_HEIGHT_PX,
		cursorAdvance: FAKE_ADVANCE,
		latex,
		display,
		scaled: false,
	};
}

function createHarness(text: string) {
	const terminal = new MockTerminal(60, 24);
	const tui = new TuiMainScreen(terminal, false);
	tui.setClearOnShrink(false);
	tui.addChild(new Text("header line", 0, 0));
	tui.addChild(new Spacer(1));

	const markdown = new Markdown(text, 1, 0, theme, undefined, {});
	const container = new Container();
	container.addChild(markdown);
	tui.addChild(container);
	tui.addChild(new Spacer(1));
	tui.addChild(new Text("> editor", 0, 0));

	const patch = installMathMarkdownPatch({
		enabled: () => true,
		maxColumns: 60,
		render: fakeImage,
	});

	const internals = tui as unknown as { doRender(): void; resetRenderState(): void };

	return {
		terminal,
		tui,
		markdown,
		render: () => internals.doRender(),
		fullRedraw: () => {
			internals.resetRenderState();
			internals.doRender();
		},
		dispose: () => {
			patch.uninstall();
		},
	};
}

test("a formula image is written with reserved rows and a cursor restore", () => {
	const harness = createHarness("前文\n\n$$x^2$$\n\n后文");
	harness.render();

	const all = harness.terminal.writes.join("");
	assert.ok(all.includes("\x1bP0;0;0q"), "the SIXEL sequence must be written");
	assert.ok(all.includes("\x1b_Gi="), "the row-reservation marker must be written");
	assert.ok(all.includes(`\x1b[${FAKE_ADVANCE}A`), "the cursor must be restored to the anchor row");

	const image = harness.terminal.images[0];
	assert.ok(image);
	assert.equal(image.heightPx, FAKE_HEIGHT_PX);
	assert.equal(image.advance, FAKE_ADVANCE);

	// Layout: text, blank line, image block (3 rows), blank line, text.
	const anchor = harness.terminal.findRow("前文");
	assert.ok(anchor >= 0);
	assert.equal(image.row, anchor + 2);
	assert.equal(harness.terminal.findRow("后文"), anchor + 2 + FAKE_ROWS + 1);

	harness.dispose();
});

test("streaming text keeps the image and the following text aligned", () => {
	const harness = createHarness("前文\n\n$$x^2$$\n\n后文");
	harness.render();
	const anchor = harness.terminal.findRow("前文");
	const renderedImages = harness.terminal.images.length;
	assert.equal(renderedImages, 1);

	let text = "前文\n\n$$x^2$$\n\n后文";
	for (let step = 1; step <= 5; step++) {
		// Each append is a new paragraph, which is how a streaming assistant message grows.
		text += `\n\n追加段落 ${step}`;
		harness.markdown.setText(text);
		harness.render();
	}

	assert.equal(harness.terminal.findRow("前文"), anchor, "content above the image must not move");
	assert.equal(harness.terminal.images.length, renderedImages, "the image must not be redrawn");
	assert.equal(harness.terminal.findRow("后文"), anchor + 2 + FAKE_ROWS + 1);
	assert.equal(harness.terminal.findRow("追加段落 1"), harness.terminal.findRow("后文") + 2);
	assert.ok(harness.terminal.findRow("追加段落 5") > harness.terminal.findRow("追加段落 1"));
	assert.equal(harness.terminal.images[0].row, anchor + 2);

	harness.dispose();
});

test("a second formula pushes the first one down without corrupting the layout", () => {
	const harness = createHarness("前文\n\n$$x^2$$\n\n中间\n\n$$y^2$$\n\n后文");
	harness.render();

	assert.equal(harness.terminal.images.length, 2);
	const [first, second] = harness.terminal.images;
	assert.ok(first && second);

	const anchor = harness.terminal.findRow("前文");
	assert.equal(first.row, anchor + 2);
	const middle = harness.terminal.findRow("中间");
	assert.equal(middle, first.row + FAKE_ROWS + 1);
	assert.equal(second.row, middle + 2);
	assert.equal(harness.terminal.findRow("后文"), second.row + FAKE_ROWS + 1);

	harness.dispose();
});

test("streaming a new formula below an existing one keeps both aligned", () => {
	const harness = createHarness("前文\n\n$$x^2$$");
	harness.render();
	const anchor = harness.terminal.findRow("前文");
	assert.equal(harness.terminal.images.length, 1);

	harness.markdown.setText("前文\n\n$$x^2$$\n\n更多说明\n\n$$y^2$$\n\n结束");
	harness.render();

	assert.equal(harness.terminal.findRow("前文"), anchor, "the first line must stay in place");
	assert.equal(harness.terminal.images.length, 2);
	const [first, second] = harness.terminal.images;
	assert.ok(first && second);
	const middle = harness.terminal.findRow("更多说明");
	assert.equal(middle, first.row + FAKE_ROWS + 1);
	assert.equal(second.row, middle + 2);
	assert.equal(harness.terminal.findRow("结束"), second.row + FAKE_ROWS + 1);

	harness.dispose();
});

test("a taller formula in a full redraw replaces the old image instead of stacking", () => {
	const harness = createHarness("前文\n\n$$x^2$$\n\n后文");
	harness.render();
	const anchor = harness.terminal.findRow("前文");
	assert.equal(harness.terminal.images.length, 1);

	harness.markdown.setText("前文\n\n$$\\sum_{i=1}^{n} x_i^2$$\n\n后文");
	harness.fullRedraw();

	assert.equal(harness.terminal.images.length, 1, "the previous image must not survive a full redraw");
	assert.equal(harness.terminal.findRow("后文"), anchor + 2 + FAKE_ROWS + 1);

	harness.dispose();
});

test("text after a formula is never written into the reserved rows", () => {
	const harness = createHarness("前文\n\n$$x^2$$\n\n后文");
	harness.render();

	for (const image of harness.terminal.images) {
		// The reserved rows must be blank: writing text there would erase the image,
		// because Windows Terminal clears image pixels under written cells.
		for (let row = image.row; row < image.row + FAKE_ROWS; row++) {
			if (row === image.row) continue;
			assert.equal(harness.terminal.line(row), "", `row ${row} must stay empty`);
		}
	}

	harness.dispose();
});

test("changing a formula in place redraws the block without erasing it", () => {
	const harness = createHarness("前文\n\n$$x^2$$\n\n后文");
	harness.render();
	const anchor = harness.terminal.findRow("前文");
	assert.equal(harness.terminal.images.length, 1);

	// A longer formula: same number of rows, different payload.
	harness.markdown.setText("前文\n\n$$x^2+\\alpha+\\beta+\\gamma$$\n\n后文");
	harness.render();

	assert.equal(harness.terminal.findRow("前文"), anchor);
	assert.equal(harness.terminal.findRow("后文"), anchor + 2 + FAKE_ROWS + 1);
	assert.equal(harness.terminal.images.length, 2, "the block must be redrawn when the formula changes");
	assert.equal(harness.terminal.images[1].row, harness.terminal.images[0].row);
	assert.equal(harness.terminal.images[1].widthPx !== harness.terminal.images[0].widthPx, true);

	harness.dispose();
});

test("a message without math renders exactly like the built-in renderer", () => {
	const plain = "纯文本消息\n\n- 列表项\n\n```js\nconst x = 1;\n```\n";
	const withPatch = createHarness(plain);
	withPatch.render();
	const patchedLines = withPatch.terminal.grid.map((_, row) => withPatch.terminal.line(row));
	withPatch.dispose();

	const terminal = new MockTerminal(60, 24);
	const tui = new TuiMainScreen(terminal, false);
	tui.setClearOnShrink(false);
	tui.addChild(new Text("header line", 0, 0));
	tui.addChild(new Spacer(1));
	const container = new Container();
	container.addChild(new Markdown(plain, 1, 0, theme, undefined, {}));
	tui.addChild(container);
	tui.addChild(new Spacer(1));
	tui.addChild(new Text("> editor", 0, 0));
	(tui as unknown as { doRender(): void }).doRender();
	const plainLines = terminal.grid.map((_, row) => terminal.line(row));

	assert.deepEqual(patchedLines, plainLines);
});
