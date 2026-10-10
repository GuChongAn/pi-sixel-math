/**
 * Standalone renderer demo: LaTeX -> MathJax -> SVG -> raster -> SIXEL -> terminal.
 *
 * Run with `npm run demo` inside Windows Terminal. It should show a typeset
 * formula (not LaTeX source, not Unicode art) and return to a working prompt.
 */
import { initMathJax } from "../src/renderer/latex.js";
import { printFormula, terminalColumns } from "./lib/terminal.js";

const cyan = (text: string): string => `\x1b[36m${text}\x1b[0m`;
const dim = (text: string): string => `\x1b[2m${text}\x1b[0m`;

async function main(): Promise<void> {
	const started = Date.now();
	await initMathJax();
	const loadMs = Date.now() - started;

	console.log(`${cyan("pi-sixel-math")} demo — MathJax ready in ${loadMs} ms, terminal width ${terminalColumns()} columns`);
	console.log(dim("中文说明文本（公式上方）"));
	console.log("");

	const first = printFormula(String.raw`\frac{a+b}{c+d}=\frac{1}{2}`, {});
	console.log(dim(`^ 分数 ${first.columns}x${first.rows} cells, ${first.widthPx}x${first.heightPx} virtual px, ${first.dcs.length} bytes`));
	console.log("");

	console.log(dim("中文说明文本（公式下方）"));
	console.log("");
	printFormula(String.raw`\sum_{i=1}^{n} x_i^2 \qquad \int_0^1 f(x)\,dx \qquad \sqrt{\alpha^2+\beta^2}`, {});
	console.log(dim("^ 求和 / 积分 / 根式"));
	console.log("");
	console.log(cyan("done"));
}

main().catch((error: unknown) => {
	console.error("demo failed:", error);
	process.exitCode = 1;
});
