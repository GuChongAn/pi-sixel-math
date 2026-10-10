import assert from "node:assert/strict";
import { test } from "node:test";
import { containsPotentialMath, findMath, splitMath } from "../src/parser/markdown.js";

test("finds display math in all supported delimiters", () => {
	const dollar = findMath("前文\n\n$$a+b$$\n\n后文");
	assert.equal(dollar.length, 1);
	assert.equal(dollar[0].latex, "a+b");
	assert.equal(dollar[0].display, true);
	assert.equal(dollar[0].inline, false);

	const bracket = findMath("前文\n\n\\[a+b\\]\n\n后文");
	assert.equal(bracket.length, 1);
	assert.equal(bracket[0].latex, "a+b");
	assert.equal(bracket[0].display, true);
});

test("finds inline math", () => {
	const matches = findMath("公式 $x^2$ 与 \\(y^2\\) 都在这里。");
	assert.equal(matches.length, 2);
	assert.deepEqual(matches.map((match) => match.latex), ["x^2", "y^2"]);
	assert.equal(matches[0].display, false);
	assert.equal(matches[0].inline, true);
});

test("ignores math inside fenced code blocks", () => {
	const source = ["```python", "x = $$not math$$", "```", "", "$$real$$"].join("\n");
	const matches = findMath(source);
	assert.equal(matches.length, 1);
	assert.equal(matches[0].latex, "real");
});

test("ignores math inside tilde fences and unterminated fences", () => {
	const tilde = findMath("~~~\n$$nope$$\n~~~\n$$yes$$");
	assert.deepEqual(tilde.map((match) => match.latex), ["yes"]);

	const unterminated = findMath("```\n$$nope$$");
	assert.equal(unterminated.length, 0);
});

test("ignores math inside inline code spans", () => {
	const matches = findMath("使用 `$a+b$` 表示和，而 $c+d$ 是公式。");
	assert.deepEqual(matches.map((match) => match.latex), ["c+d"]);
});

test("ignores escaped dollar signs", () => {
	const matches = findMath("价格是 \\$5 而不是公式。");
	assert.equal(matches.length, 0);
	assert.equal(containsPotentialMath("价格是 \\$5"), true);
});

test("does not treat prices as inline math", () => {
	assert.equal(findMath("It costs $5 today.").length, 0);
	assert.equal(findMath("It costs $5.00 today.").length, 0);
	assert.equal(findMath("So $5x$ is math.").length, 1);
});

test("handles multi-line display math", () => {
	const matches = findMath("$$\n\\sum_{i=1}^{n}\n  x_i\n$$");
	assert.equal(matches.length, 1);
	assert.equal(matches[0].latex.trim(), "\\sum_{i=1}^{n}\n  x_i");
});

test("inline math must close on the same line", () => {
	assert.equal(findMath("a $x\nb$ y").length, 0);
});

test("supports matrices and nested braces", () => {
	const matches = findMath("$$A=\\begin{bmatrix}1&2\\\\3&4\\end{bmatrix}$$");
	assert.equal(matches.length, 1);
	assert.equal(matches[0].latex, "A=\\begin{bmatrix}1&2\\\\3&4\\end{bmatrix}");
});

test("an unterminated formula is left alone while streaming", () => {
	assert.equal(findMath("正在生成 $$\\frac{1}{").length, 0);
	assert.equal(findMath("行内 $x^2").length, 0);
});

test("splitMath returns text and math segments in order", () => {
	const segments = splitMath("a $$b$$ c");
	assert.equal(segments.length, 3);
	assert.equal(segments[0].text, "a ");
	assert.equal(segments[1].text, "$$b$$");
	assert.equal(segments[1].match.latex, "b");
	assert.equal(segments[2].text, " c");
});

test("windows-style CRLF documents still parse", () => {
	const matches = findMath("前文\r\n\r\n$$a+b$$\r\n\r\n后文");
	assert.equal(matches.length, 1);
	assert.equal(matches[0].latex, "a+b");
});
