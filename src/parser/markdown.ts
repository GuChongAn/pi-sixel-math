/**
 * LaTeX extraction from Markdown.
 *
 * The scanner is deliberately conservative: it never touches fenced code blocks,
 * indented code blocks, inline code spans, or escaped dollar signs, and it
 * tolerates incomplete delimiters so streaming output does not flicker.
 */

export interface MathMatch {
	/** Offset of the first delimiter character in the source. */
	start: number;
	/** Offset just past the last delimiter character in the source. */
	end: number;
	latex: string;
	/** `true` for `$$...$$` and `\[...\]`. */
	display: boolean;
	/** `true` when the formula shares its line with other text. */
	inline: boolean;
}

const MAX_FORMULA_LENGTH = 20_000;

function isEscaped(source: string, index: number): boolean {
	let backslashes = 0;
	for (let i = index - 1; i >= 0 && source[i] === "\\"; i--) backslashes++;
	return backslashes % 2 === 1;
}

interface FenceState {
	marker: string;
	indent: string;
}

/** Find fenced code block ranges (``` or ~~~), so math inside them is ignored. */
function findCodeRegions(source: string): [number, number][] {
	const regions: [number, number][] = [];
	const lines = source.split("\n");
	let offset = 0;
	let fence: FenceState | undefined;
	let fenceStart = 0;

	for (const line of lines) {
		const lineStart = offset;
		const lineEnd = offset + line.length;
		const match = /^(\s{0,3})(`{3,}|~{3,})(.*)$/.exec(line);
		if (fence) {
			if (match && match[2][0] === fence.marker[0] && match[2].length >= fence.marker.length) {
				// The whole block, delimiters included, is code.
				regions.push([fenceStart, lineEnd]);
				fence = undefined;
			}
		} else if (match) {
			fence = { marker: match[2], indent: match[1] };
			fenceStart = lineStart;
		}
		offset = lineEnd + 1;
	}

	// An unterminated fence swallows the rest of the document.
	if (fence) regions.push([fenceStart, source.length]);
	return regions;
}

function inRegions(index: number, regions: [number, number][]): boolean {
	return regions.some(([start, end]) => index >= start && index <= end);
}

/** Skip inline code spans, returning the index just past a span if one starts here. */
function codeSpanEnd(source: string, index: number): number | undefined {
	if (source[index] !== "`") return undefined;
	let ticks = 0;
	while (source[index + ticks] === "`") ticks++;
	const closing = source.indexOf("`".repeat(ticks), index + ticks);
	if (closing === -1) return undefined;
	let end = closing + ticks;
	while (source[end] === "`") end++;
	return end;
}

function isBlank(value: string): boolean {
	return value.trim().length === 0;
}

function standalone(source: string, start: number, end: number): boolean {
	const lineStart = source.lastIndexOf("\n", start - 1) + 1;
	const lineEndIndex = source.indexOf("\n", end);
	const lineEnd = lineEndIndex === -1 ? source.length : lineEndIndex;
	const before = source.slice(lineStart, start);
	const after = source.slice(end, lineEnd);
	return isBlank(before) && isBlank(after);
}

/**
 * Find every LaTeX formula in a Markdown document.
 *
 * Supported delimiters: `$$...$$`, `\[...\]`, `\(...\)` and `$...$`.
 */
export function findMath(source: string): MathMatch[] {
	const codeRegions = findCodeRegions(source);
	const matches: MathMatch[] = [];
	let index = 0;

	while (index < source.length) {
		const char = source[index];

		if (char === "\\" && !isEscaped(source, index)) {
			const next = source[index + 1];
			if (next === "[" || next === "(") {
				const closer = next === "[" ? "\\]" : "\\)";
				const closeIndex = findClosing(source, index + 2, closer, codeRegions);
				if (closeIndex === -1) {
					index += 2;
					continue;
				}
				const end = closeIndex + closer.length;
				matches.push({
					start: index,
					end,
					latex: source.slice(index + 2, closeIndex),
					display: next === "[",
					inline: !standalone(source, index, end),
				});
				index = end;
				continue;
			}
			index += 2;
			continue;
		}

		if (char === "`" && !inRegions(index, codeRegions)) {
			const end = codeSpanEnd(source, index);
			if (end !== undefined) {
				index = end;
				continue;
			}
		}

		if (char === "$" && !isEscaped(source, index) && !inRegions(index, codeRegions)) {
			const double = source[index + 1] === "$";
			const opener = double ? "$$" : "$";
			if (!double && !looksLikeInlineMath(source, index)) {
				index++;
				continue;
			}
			const closeIndex = findDollarClosing(source, index + opener.length, double, codeRegions);
			if (closeIndex === -1) {
				index += opener.length;
				continue;
			}
			const end = closeIndex + opener.length;
			const latex = source.slice(index + opener.length, closeIndex);
			if (latex.trim().length === 0) {
				index = end;
				continue;
			}
			matches.push({
				start: index,
				end,
				latex,
				display: double,
				inline: !standalone(source, index, end),
			});
			index = end;
			continue;
		}

		index++;
	}

	return matches;
}

/** Math must not start with whitespace, and must not look like a plain "$5". */
function looksLikeInlineMath(source: string, index: number): boolean {
	const next = source[index + 1];
	if (next === undefined) return false;
	if (/\s/.test(next)) return false;
	if (/\d/.test(next)) {
		// `$5` and `$5.00` are prices, `$5x$` is math.
		const rest = source.slice(index + 1);
		if (/^\d+(?:[.,]\d+)?(?:\s|$)/.test(rest)) return false;
	}
	return true;
}

function findDollarClosing(source: string, from: number, double: boolean, codeRegions: [number, number][]): number {
	for (let i = from; i < source.length && i - from < MAX_FORMULA_LENGTH; i++) {
		if (source[i] === "\\") {
			i++;
			continue;
		}
		if (source[i] === "\n" && !double) return -1;
		if (source[i] === "`" && !inRegions(i, codeRegions)) {
			const end = codeSpanEnd(source, i);
			if (end !== undefined) {
				i = end - 1;
				continue;
			}
		}
		if (source[i] !== "$") continue;
		if (inRegions(i, codeRegions)) continue;
		if (double) {
			if (source[i + 1] === "$") return i;
			continue;
		}
		if (source[i + 1] === "$") continue;
		if (i === from) continue;
		return i;
	}
	return -1;
}

function findClosing(source: string, from: number, closer: string, codeRegions: [number, number][]): number {
	for (let i = from; i < source.length && i - from < MAX_FORMULA_LENGTH; i++) {
		if (source[i] !== "\\") continue;
		if (source.startsWith(closer, i)) return i;
		i++;
	}
	return -1;
}

/** Cheap pre-check used to skip all math work for messages without formulas. */
export function containsPotentialMath(source: string): boolean {
	return source.includes("$") || source.includes("\\[") || source.includes("\\(");
}

export interface MathSegment {
	match: MathMatch;
	text: string;
}

/**
 * Split Markdown into plain text and math segments.
 *
 * Callers use this to rewrite the document with placeholders while keeping the
 * original LaTeX in the session transcript.
 */
export function splitMath(source: string): MathSegment[] {
	const matches = findMath(source);
	const segments: MathSegment[] = [];
	let index = 0;
	for (const match of matches) {
		if (match.start > index) segments.push({ match: { ...match, start: index, end: match.start, latex: "", display: false, inline: false }, text: source.slice(index, match.start) });
		segments.push({ match, text: source.slice(match.start, match.end) });
		index = match.end;
	}
	if (index < source.length) {
		segments.push({ match: { start: index, end: source.length, latex: "", display: false, inline: false }, text: source.slice(index) });
	}
	return segments;
}
