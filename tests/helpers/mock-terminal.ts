/**
 * A tiny terminal emulator that understands the escape sequences pi-tui emits,
 * including Windows Terminal's SIXEL cursor semantics.
 *
 * It exists so the SIXEL TUI integration can be verified automatically:
 * the differential renderer's cursor arithmetic is invisible in a plain string
 * comparison, but it is exactly what breaks when images have the wrong height.
 */
import type { Terminal } from "@earendil-works/pi-tui";

export interface RenderedImage {
	row: number;
	column: number;
	widthPx: number;
	heightPx: number;
	bands: number;
	advance: number;
}

export class MockTerminal implements Terminal {
	readonly grid: string[][] = [];
	cursorRow = 0;
	cursorColumn = 0;
	readonly images: RenderedImage[] = [];
	cursorHidden = false;
	writes: string[] = [];
	private pendingWrap = false;

	constructor(
		public columns: number,
		public rows: number,
		/** Cell height in virtual pixels, as Windows Terminal uses for SIXEL. */
		public readonly cellHeightPx = 20,
	) {
		this.reset();
	}

	get kittyProtocolActive(): boolean {
		return false;
	}

	reset(): void {
		this.grid.length = 0;
		for (let row = 0; row < this.rows; row++) {
			this.grid.push(new Array(this.columns).fill(" "));
		}
		this.images.length = 0;
		this.cursorRow = 0;
		this.cursorColumn = 0;
		this.pendingWrap = false;
		this.writes = [];
	}

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	moveBy(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {
		this.reset();
	}
	setTitle(): void {}
	setProgress(): void {}
	setProgramStatus(): void {}
	hideCursor(): void {
		this.cursorHidden = true;
	}
	showCursor(): void {
		this.cursorHidden = false;
	}

	/** All characters of a row, trailing spaces trimmed. */
	line(row: number): string {
		return (this.grid[row] ?? []).join("").replace(/\s+$/, "");
	}

	/** Row index containing the given marker text, or -1. */
	findRow(text: string): number {
		for (let row = 0; row < this.grid.length; row++) {
			if (this.line(row).includes(text)) return row;
		}
		return -1;
	}

	write(data: string): void {
		this.writes.push(data);
		let index = 0;
		while (index < data.length) {
			const char = data[index];
			if (char === "\x1b") {
				index += this.handleEscape(data, index);
				continue;
			}
			if (char === "\r") {
				this.cursorColumn = 0;
				this.pendingWrap = false;
				index++;
				continue;
			}
			if (char === "\n") {
				this.lineFeed();
				index++;
				continue;
			}
			this.putChar(char);
			index++;
		}
	}

	private putChar(char: string): void {
		if (this.pendingWrap) {
			this.cursorColumn = 0;
			this.lineFeed();
			this.pendingWrap = false;
		}
		if (this.cursorColumn < this.columns) {
			this.grid[this.cursorRow][this.cursorColumn] = char;
		}
		if (this.cursorColumn === this.columns - 1) {
			this.pendingWrap = true;
		} else {
			this.cursorColumn++;
		}
	}

	private lineFeed(): void {
		if (this.cursorRow < this.rows - 1) {
			this.cursorRow++;
		} else {
			// Scroll: drop the top row and append an empty one, images included.
			this.grid.shift();
			this.grid.push(new Array(this.columns).fill(" "));
			for (const image of this.images) image.row--;
		}
	}

	private handleEscape(data: string, start: number): number {
		const type = data[start + 1];
		if (type === "P") {
			// DCS: the only one we care about is SIXEL.
			const end = data.indexOf("\x1b\\", start);
			const body = data.slice(start + 2, end === -1 ? undefined : end);
			if (body.startsWith("q") || /^\d*;?\d*;?\d*q/.test(body)) {
				this.renderSixel(body);
			}
			return (end === -1 ? data.length : end + 2) - start;
		}
		if (type === "]" || type === "_" || type === "^" || type === "X") {
			let end = data.indexOf("\x07", start);
			const st = data.indexOf("\x1b\\", start);
			if (end === -1 || (st !== -1 && st < end)) end = st === -1 ? data.length - 2 : st;
			return (end === -1 ? data.length : end + (data.startsWith("\x07", end) ? 1 : 2)) - start;
		}
		if (type === "[") {
			let end = start + 2;
			while (end < data.length && !/[@-~]/.test(data[end])) end++;
			const params = data.slice(start + 2, end);
			this.handleCsi(params, data[end]);
			return end + 1 - start;
		}
		if (type === "7") {
			this.savedCursor = { row: this.cursorRow, column: this.cursorColumn };
			return 2;
		}
		if (type === "8") {
			if (this.savedCursor) {
				this.cursorRow = this.savedCursor.row;
				this.cursorColumn = this.savedCursor.column;
			}
			return 2;
		}
		return 2;
	}

	private savedCursor: { row: number; column: number } | undefined;

	private handleCsi(params: string, final: string): void {
		// Cursor movement and erase controls cancel the pending end-of-line wrap,
		// exactly like Windows Terminal does ("the ED control is expected to reset
		// the delayed wrap flag").
		if ("ABCDGHfJK".includes(final)) this.pendingWrap = false;
		const private_ = params.startsWith("?");
		const numbers = params
			.replace(/^[?>!]/, "")
			.split(";")
			.map((value) => (value === "" ? 0 : Number(value)));
		const first = numbers[0] ?? 0;
		const amount = first === 0 ? 1 : first;
		switch (final) {
			case "A":
				this.cursorRow = Math.max(0, this.cursorRow - amount);
				break;
			case "B":
				this.cursorRow = Math.min(this.rows - 1, this.cursorRow + amount);
				break;
			case "C":
				this.cursorColumn = Math.min(this.columns - 1, this.cursorColumn + amount);
				break;
			case "D":
				this.cursorColumn = Math.max(0, this.cursorColumn - amount);
				break;
			case "G":
				this.cursorColumn = Math.max(0, Math.min(this.columns - 1, amount - 1));
				break;
			case "H":
			case "f": {
				const row = (numbers[0] ?? 1) - 1;
				const column = (numbers[1] ?? 1) - 1;
				this.cursorRow = Math.max(0, Math.min(this.rows - 1, row));
				this.cursorColumn = Math.max(0, Math.min(this.columns - 1, column));
				break;
			}
			case "J": {
				if (first === 2 || first === 3) {
					for (const row of this.grid) row.fill(" ");
					this.images.length = 0;
					if (first === 2) {
						this.cursorRow = 0;
						this.cursorColumn = 0;
					}
				} else if (first === 0) {
					for (let column = this.cursorColumn; column < this.columns; column++) this.grid[this.cursorRow][column] = " ";
					this.eraseImageRows(this.cursorRow + 1, this.rows - 1);
				}
				break;
			}
			case "K": {
				const startColumn = first === 2 ? 0 : first === 1 ? 0 : this.cursorColumn;
				const endColumn = first === 0 ? this.columns - 1 : first === 1 ? this.cursorColumn : this.columns - 1;
				for (let column = startColumn; column <= endColumn; column++) this.grid[this.cursorRow][column] = " ";
				break;
			}
			default:
				break;
		}
		void private_;
	}

	private eraseImageRows(from: number, to: number): void {
		for (let index = this.images.length - 1; index >= 0; index--) {
			const image = this.images[index];
			if (image.row >= from && image.row <= to) this.images.splice(index, 1);
		}
	}

	/** Mirror Windows Terminal: draw at the cursor, then advance to the last band's row. */
	private renderSixel(body: string): void {
		const raster = /^[^"]*"(\d+);(\d+);(\d+);(\d+)/.exec(body);
		const widthPx = raster ? Number(raster[3]) : 0;
		const heightPx = raster ? Number(raster[4]) : 0;
		const bands = Math.max(1, Math.ceil(heightPx / 6));
		const advance = Math.floor((6 * (bands - 1)) / this.cellHeightPx);
		this.images.push({
			row: this.cursorRow,
			column: this.cursorColumn,
			widthPx,
			heightPx,
			bands,
			advance,
		});
		this.cursorRow = Math.min(this.rows - 1, this.cursorRow + advance);
	}
}
