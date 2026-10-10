/**
 * Isolated Pi TUI experiment for SIXEL math.
 *
 * Runs pi-tui's real main-screen renderer (the same class Pi uses in
 * `"tuiMode": "regular"`) with a fake transcript, so the SIXEL integration can be
 * validated without touching a running Pi session.
 *
 * What it checks:
 *  1. a formula image appears inline in a Markdown message
 *  2. streaming (appending text every 300 ms) keeps images and text aligned
 *  3. appending a *second* formula shifts the first one correctly
 *  4. forcing a full redraw does not leave ghost images
 *  5. after the TUI stops, the shell prompt works normally
 *
 * Run with `npm run tui-experiment`.
 */
import { Container, Markdown, ProcessTerminal, Spacer, Text, TuiMainScreen, type MarkdownTheme } from "@earendil-works/pi-tui";
import { initMathJax } from "../src/renderer/latex.js";
import { renderMathToImageSync } from "../src/renderer/math-image.js";
import { installMathMarkdownPatch } from "../src/tui/math-markdown-patch.js";

const identity = (text: string): string => text;
const theme: MarkdownTheme = {
	heading: (text) => `\x1b[1;36m${text}\x1b[0m`,
	link: identity,
	linkUrl: (text) => `\x1b[2m${text}\x1b[0m`,
	code: (text) => `\x1b[33m${text}\x1b[0m`,
	codeBlock: (text) => `\x1b[32m${text}\x1b[0m`,
	codeBlockBorder: (text) => `\x1b[2m${text}\x1b[0m`,
	quote: identity,
	quoteBorder: identity,
	hr: identity,
	listBullet: (text) => `\x1b[35m${text}\x1b[0m`,
	bold: (text) => `\x1b[1m${text}\x1b[0m`,
	italic: (text) => `\x1b[3m${text}\x1b[0m`,
	strikethrough: identity,
	underline: identity,
};

const INTRO = [
	"pi-sixel-math TUI experiment",
	"",
	"阶段 1：静态消息 + 一个公式",
	"阶段 2：每 300ms 追加文本（模拟流式输出）",
	"阶段 3：追加第二个公式",
	"阶段 4：强制整屏重绘（模拟终端尺寸变化）",
	"约 12 秒后自动结束。请观察下方消息里的公式是否始终对齐、不重叠、不闪烁。",
].join("\n");

function renderFormula(latex: string, display: boolean, maxColumns: number) {
	return renderMathToImageSync(latex, {
		display,
		maxColumns,
		foreground: { r: 0xe5, g: 0xe5, b: 0xe7 },
		background: { r: 0x0c, g: 0x0c, b: 0x0c },
	}).image;
}

async function main(): Promise<void> {
	await initMathJax();
	const patch = installMathMarkdownPatch({
		enabled: () => true,
		maxColumns: 80,
		render: (latex, display, maxColumns) => {
			try {
				return renderFormula(latex, display, maxColumns);
			} catch {
				return undefined;
			}
		},
	});

	const terminal = new ProcessTerminal();
	const tui = new TuiMainScreen(terminal, false);
	tui.setClearOnShrink(false);
	tui.addChild(new Text(INTRO, 1, 0));
	tui.addChild(new Spacer(1));

	const message = new Container();
	const markdown = new Markdown("这是一个公式：\n\n$$\\frac{a+b}{c+d}$$\n", 1, 0, theme, undefined, {});
	message.addChild(markdown);
	tui.addChild(message);
	tui.addChild(new Spacer(1));
	tui.addChild(new Text("\x1b[2m> 这里是编辑器占位行，它必须始终待在公式下方。\x1b[0m", 1, 0));

	tui.start();

	let text = "这是一个公式：\n\n$$\\frac{a+b}{c+d}$$\n";
	const sentence = "追加的中文说明文本，用于验证流式输出时公式位置是否稳定。";
	let step = 0;

	const timer = setInterval(() => {
		step++;
		if (step <= 6) {
			text += `\n${sentence} (${step})`;
		} else if (step <= 9) {
			text += "\n";
		} else if (step === 10) {
			text += "\n第二个公式：\n\n$$\\sum_{i=1}^{n} x_i^2 = \\int_{-\\infty}^{+\\infty} e^{-x^2}\\,dx$$\n";
		} else if (step === 14) {
			text += "\n矩阵：\n\n$$A=\\begin{bmatrix}1&2&3\\\\4&5&6\\end{bmatrix}$$\n";
		} else if (step === 18) {
			tui.requestRender(true);
		}

		if (step <= 20) {
			markdown.setText(text);
			tui.requestRender();
		} else {
			clearInterval(timer);
			finish();
		}
	}, 400);

	const finish = (): void => {
		try {
			tui.stop({ preserveScreen: true });
		} catch {
			tui.stop();
		}
		patch.uninstall();
		process.stdout.write("\n\x1b[32mexperiment finished\x1b[0m — the prompt below must work normally.\n");
		const after = renderFormula(String.raw`\oint_\gamma f(z)\,dz`, true, 60);
		process.stdout.write(`${after.dcs}\x1b[${after.rows - after.cursorAdvance}B\r`);
		process.stdout.write("第二张图（TUI 停止后直接输出）也必须正常显示。\n");
		process.exit(0);
	};
}

main().catch((error: unknown) => {
	console.error("tui-experiment failed:", error);
	process.exitCode = 1;
});
