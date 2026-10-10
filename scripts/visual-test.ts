/**
 * Visual acceptance test: renders the six required formulas as real SIXEL
 * images in Windows Terminal.
 *
 * Run with `npm run visual-test`.
 */
import { initMathJax } from "../src/renderer/latex.js";
import { printFormula, terminalColumns } from "./lib/terminal.js";

const CASES: [string, string, string][] = [
	["测试 1", "基本分数", String.raw`\frac{a+b}{c+d}`],
	["测试 2", "上下标与求和", String.raw`\sum_{i=1}^{n} x_i^2`],
	[
		"测试 3",
		"强化学习目标函数",
		String.raw`J(\theta)=\mathbb{E}_{\tau\sim\pi_\theta}\left[\sum_{t=0}^{T}\gamma^t r_t\right]`,
	],
	[
		"测试 4",
		"矩阵",
		String.raw`A=\begin{bmatrix}1&2&3\\4&5&6\\7&8&9\end{bmatrix}`,
	],
	["测试 5", "积分", String.raw`\int_{-\infty}^{+\infty} e^{-x^2}\,dx=\sqrt{\pi}`],
	[
		"测试 6",
		"复杂嵌套公式",
		String.raw`L(\theta)=-\frac{1}{N}\sum_{i=1}^{N}\log\frac{\exp(s_{i,i}/\tau)}{\sum_{j=1}^{N}\exp(s_{i,j}/\tau)}`,
	],
];

const bold = (text: string): string => `\x1b[1m${text}\x1b[0m`;
const dim = (text: string): string => `\x1b[2m${text}\x1b[0m`;

async function main(): Promise<void> {
	await initMathJax();
	const columns = terminalColumns();
	console.log(bold(`pi-sixel-math visual test — ${CASES.length} formulas, terminal width ${columns} columns`));
	console.log("");

	for (const [label, title, latex] of CASES) {
		console.log(`${bold(label)}：${title}`);
		console.log(dim(`  \\[${latex}\\]`));
		printFormula(latex, { columns });
		console.log("");
	}

	console.log(bold("visual test finished — the prompt below must still work normally."));
}

main().catch((error: unknown) => {
	console.error("visual-test failed:", error);
	process.exitCode = 1;
});
