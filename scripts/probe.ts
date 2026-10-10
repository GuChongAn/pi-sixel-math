/**
 * Windows Terminal SIXEL calibration probe.
 *
 * Measures what a terminal actually does with a SIXEL image so the Pi TUI
 * integration can place images without guessing:
 *   - how many text rows an image of N virtual pixels occupies
 *   - where the text cursor ends up after the image (the value the TUI has to
 *     compensate for)
 *   - whether the `\x1b_G...;` marker used to reserve rows for the image is
 *     harmless
 *   - the terminal's background color, so formulas can be blended against it
 *
 * Run with `npm run probe` (also invoked by `npm run visual-test`). Writes
 * `tmp/probe-report.json` next to the project.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initMathJax } from "../src/renderer/latex.js";
import { renderMathToImageSync, WT_VIRTUAL_CELL_HEIGHT, WT_VIRTUAL_CELL_WIDTH } from "../src/renderer/math-image.js";
import { imageToSixel } from "../src/renderer/sixel.js";
import type { RgbaImage } from "../src/renderer/raster.js";

export interface ProbeReport {
	tty: boolean;
	columns?: number;
	rows?: number;
	terminal?: string;
	background?: string;
	foreground?: string;
	measurements: {
		heightPx: number;
		rows: number;
		cursorAdvanceMeasured: number;
		cursorAdvanceExpected: number;
	}[];
	markerLineSafe: boolean;
	cursorRestoreWorks: boolean;
	notes: string[];
}

/** A synthetic test image: a solid rectangle of virtual pixels. */
function solidImage(widthPx: number, heightPx: number, color: { r: number; g: number; b: number }): string {
	const data = new Uint8Array(widthPx * heightPx * 4);
	for (let i = 0; i < widthPx * heightPx; i++) {
		data[i * 4] = color.r;
		data[i * 4 + 1] = color.g;
		data[i * 4 + 2] = color.b;
		data[i * 4 + 3] = 255;
	}
	const image: RgbaImage = { width: widthPx, height: heightPx, data };
	return imageToSixel(image, { aspectNumerator: 1, aspectDenominator: 1, maxColors: 2, transparent: color });
}

async function main(): Promise<void> {
	const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
	const report: ProbeReport = {
		tty,
		terminal: process.env.WT_SESSION ? "Windows Terminal" : process.env.TERM_PROGRAM ?? process.env.TERM,
		measurements: [],
		markerLineSafe: false,
		cursorRestoreWorks: false,
		notes: [],
	};
	if (!tty) {
		report.notes.push("Not running on a TTY; SIXEL probe skipped (run this directly in Windows Terminal).");
		writeReport(report);
		printSummary(report);
		return;
	}

	report.columns = process.stdout.columns;
	report.rows = process.stdout.rows;

	const stdin = process.stdin;
	stdin.setRawMode?.(true);
	stdin.resume();
	stdin.setEncoding("utf8");
	let pending = "";
	stdin.on("data", (chunk: string) => {
		pending += chunk;
	});

	const readReply = async (timeoutMs: number): Promise<string> => {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 15));
			if (pending.length > 0) {
				const value = pending;
				pending = "";
				return value;
			}
		}
		const value = pending;
		pending = "";
		return value;
	};

	const query = async (sequence: string, timeoutMs = 300): Promise<string | undefined> => {
		pending = "";
		process.stdout.write(sequence);
		const reply = await readReply(timeoutMs);
		return reply.length > 0 ? reply : undefined;
	};

	const cursorRow = async (): Promise<number | undefined> => {
		const reply = await query("\x1b[6n");
		const match = /\x1b\[(\d+);(\d+)R/.exec(reply ?? "");
		return match ? Number(match[1]) : undefined;
	};

	const parseOscColor = (reply: string | undefined): string | undefined => {
		if (!reply) return undefined;
		const match = /rgb:([0-9a-f]{2,4})\/([0-9a-f]{2,4})\/([0-9a-f]{2,4})/i.exec(reply);
		if (!match) return undefined;
		const component = (value: string): number => {
			const scaled = value.length === 1 ? Number.parseInt(value, 16) * 17 : value.length === 2 ? Number.parseInt(value, 16) : Number.parseInt(value.slice(0, 2), 16);
			return Math.max(0, Math.min(255, scaled));
		};
		const hex = (value: number): string => value.toString(16).padStart(2, "0");
		return `#${hex(component(match[1]))}${hex(component(match[2]))}${hex(component(match[3]))}`;
	};

	try {
		process.stdout.write("\x1b[2J\x1b[H");
		const colors = await query("\x1b]10;?\x07\x1b]11;?\x07", 400);
		if (colors) {
			const parts = colors.split("\x1b]");
			for (const part of parts) {
				if (part.startsWith("11;")) report.background = parseOscColor(part);
				if (part.startsWith("10;")) report.foreground = parseOscColor(part);
			}
		}

		await initMathJax();

		// --- how many rows does an image of N virtual pixels occupy, and where does the cursor end? ---
		for (const heightPx of [20, 40, 60, 120]) {
			process.stdout.write("\x1b[2J\x1b[H");
			process.stdout.write("anchor\r\n");
			const before = await cursorRow();
			const dcs = solidImage(60, heightPx, { r: 0x30, g: 0x90, b: 0xd0 });
			process.stdout.write(dcs);
			const after = await cursorRow();
			const bands = Math.ceil(heightPx / 6);
			report.measurements.push({
				heightPx,
				rows: Math.ceil(heightPx / WT_VIRTUAL_CELL_HEIGHT),
				cursorAdvanceMeasured: before !== undefined && after !== undefined ? after - before : -1,
				cursorAdvanceExpected: Math.floor((6 * (bands - 1)) / WT_VIRTUAL_CELL_HEIGHT),
			});
			// Clean up: move below the image again so the next measurement starts fresh.
			process.stdout.write(`\x1b[${Math.ceil(heightPx / WT_VIRTUAL_CELL_HEIGHT)}B\r`);
		}

		// --- does the renderer's SIXEL line shape keep the cursor on the anchor row? ---
		{
			process.stdout.write("\x1b[2J\x1b[H");
			const heightPx = 60;
			const rows = Math.ceil(heightPx / WT_VIRTUAL_CELL_HEIGHT);
			const bands = Math.ceil(heightPx / 6);
			const advance = Math.floor((6 * (bands - 1)) / WT_VIRTUAL_CELL_HEIGHT);
			process.stdout.write("anchor\r\n");
			const before = await cursorRow();
			const dcs = solidImage(60, heightPx, { r: 0x30, g: 0x90, b: 0xd0 });
			const restore = advance > 0 ? `\x1b[${advance}A` : "";
			process.stdout.write(`${dcs}${restore}\x1b_Gi=4242,r=${rows};q\x1b\\`);
			const after = await cursorRow();
			report.cursorRestoreWorks = before !== undefined && after !== undefined && before === after;
			report.markerLineSafe = after !== undefined;
			process.stdout.write(`\x1b[${rows}B\r`);
		}

		// --- does a formula image land where the reserved rows are? ---
		{
			process.stdout.write("\x1b[2J\x1b[H");
			process.stdout.write("above the formula\r\n");
			const before = await cursorRow();
			const { image } = renderMathToImageSync(String.raw`\sum_{i=1}^{n} x_i^2`, {
				display: true,
				maxColumns: Math.max(20, (report.columns ?? 100) - 4),
				foreground: { r: 0xe5, g: 0xe5, b: 0xe7 },
				background: { r: 0x0c, g: 0x0c, b: 0x0c },
				cellWidthPx: WT_VIRTUAL_CELL_WIDTH,
				cellHeightPx: WT_VIRTUAL_CELL_HEIGHT,
				ssaa: 4,
			});
			process.stdout.write(`${image.dcs}${image.cursorAdvance > 0 ? `\x1b[${image.cursorAdvance}A` : ""}`);
			const after = await cursorRow();
			report.notes.push(
				`formula: ${image.columns}x${image.rows} cells, measured advance ${
					before !== undefined && after !== undefined ? after - before : "?"
				} (expected ${image.cursorAdvance})`,
			);
			process.stdout.write(`\x1b[${image.rows}B\rbelow the formula\r\n`);
		}

		process.stdout.write("\x1b[0m");
	} finally {
		stdin.setRawMode?.(false);
		stdin.pause();
	}

	writeReport(report);
	printSummary(report);
}

function writeReport(report: ProbeReport): void {
	const here = dirname(fileURLToPath(import.meta.url));
	const target = resolve(here, "..", "tmp", "probe-report.json");
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
	console.log(`probe report: ${target}`);
}

function printSummary(report: ProbeReport): void {
	const bold = (text: string): string => `\x1b[1m${text}\x1b[0m`;
	console.log(bold("Windows Terminal SIXEL probe"));
	console.log(`  tty=${report.tty} terminal=${report.terminal} columns=${report.columns} rows=${report.rows}`);
	console.log(`  background=${report.background ?? "unknown"} foreground=${report.foreground ?? "unknown"}`);
	for (const measurement of report.measurements) {
		console.log(
			`  ${String(measurement.heightPx).padStart(3)}px -> rows=${measurement.rows} ` +
				`advance measured=${measurement.cursorAdvanceMeasured} expected=${measurement.cursorAdvanceExpected}`,
		);
	}
	console.log(`  cursor restore to anchor row: ${report.cursorRestoreWorks ? "OK" : "MISMATCH"}`);
	console.log(`  \\x1b_G marker accepted: ${report.markerLineSafe ? "yes" : "no reply"}`);
	for (const note of report.notes) console.log(`  note: ${note}`);
	if (report.background) {
		console.log(`  suggested config: { "background": "${report.background}" }  (~/.pi/agent/sixel-math.json)`);
	}
}

main().catch((error: unknown) => {
	console.error("probe failed:", error);
	process.exitCode = 1;
});
