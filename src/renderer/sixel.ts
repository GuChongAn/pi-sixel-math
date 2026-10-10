import type { Rgb, RgbaImage } from "./raster.js";

export interface SixelPalette {
	colors: Rgb[];
	/** Per-pixel palette index, `-1` meaning "do not paint" (transparent). */
	indices: Int16Array;
}

export interface SixelEncodeOptions {
	/** Maximum palette entries (SIXEL allows 256). */
	maxColors?: number;
	/** Color treated as transparent (usually the terminal background). */
	transparent?: Rgb;
	/** Distance below which a pixel counts as the transparent color. */
	transparentTolerance?: number;
	/**
	 * Sixel "pixel aspect" declared in the raster attributes command. `1` means
	 * one sixel row is 6 device pixels tall, which is what Windows Terminal uses
	 * for its 10x20 virtual cell grid.
	 */
	aspectNumerator?: number;
	aspectDenominator?: number;
}

export const SIXEL_MAX_COLORS = 256;

function colorKey(r: number, g: number, b: number): number {
	return (r << 16) | (g << 8) | b;
}

function colorDistance(a: Rgb, b: Rgb): number {
	const dr = a.r - b.r;
	const dg = a.g - b.g;
	const db = a.b - b.b;
	return dr * dr + dg * dg + db * db;
}

interface ColorBox {
	colors: number[];
	weight: number;
}

/**
 * Median-cut quantization.
 *
 * Anti-aliased math produces many nearly identical shades; median cut keeps
 * those shades close to the original gradient, which matters far more than the
 * exact palette size.
 */
export function quantize(image: RgbaImage, maxColors: number): SixelPalette {
	const { data, width, height } = image;
	const counts = new Map<number, number>();
	for (let i = 0; i < data.length; i += 4) {
		const key = colorKey(data[i], data[i + 1], data[i + 2]);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}

	const limit = Math.max(2, Math.min(SIXEL_MAX_COLORS, maxColors));
	const all = [...counts.keys()];
	if (all.length <= limit) {
		return { colors: all.map(keyToRgb), indices: mapToPalette(image, all) };
	}

	let boxes: ColorBox[] = [{ colors: all, weight: totalWeight(all, counts) }];
	while (boxes.length < limit) {
		// Split the box with the widest channel spread; give up when nothing can be split.
		let targetIndex = -1;
		let targetSpread = -1;
		for (let i = 0; i < boxes.length; i++) {
			const spread = boxSpread(boxes[i].colors);
			if (spread <= 0) continue;
			if (boxes[i].colors.length < 2) continue;
			if (spread > targetSpread) {
				targetSpread = spread;
				targetIndex = i;
			}
		}
		if (targetIndex === -1) break;

		const box = boxes[targetIndex];
		const axis = dominantAxis(box.colors);
		const sorted = [...box.colors].sort((a, b) => channel(a, axis) - channel(b, axis));
		let splitIndex = 1;
		let bestDelta = Number.POSITIVE_INFINITY;
		let accumulated = 0;
		const total = box.weight;
		for (let i = 0; i < sorted.length - 1; i++) {
			accumulated += counts.get(sorted[i]) ?? 0;
			const delta = Math.abs(accumulated - total / 2);
			if (delta < bestDelta) {
				bestDelta = delta;
				splitIndex = i + 1;
			}
		}
		const left = sorted.slice(0, splitIndex);
		const right = sorted.slice(splitIndex);
		if (left.length === 0 || right.length === 0) {
			boxes.splice(targetIndex, 1);
			continue;
		}
		boxes.splice(targetIndex, 1, { colors: left, weight: totalWeight(left, counts) }, { colors: right, weight: totalWeight(right, counts) });
	}

	const colors = boxes.map((box) => averageColor(box, counts));
	return { colors, indices: mapToPalette(image, colors.map(rgbToKey)) };
}

function totalWeight(colors: number[], counts: Map<number, number>): number {
	let sum = 0;
	for (const color of colors) sum += counts.get(color) ?? 0;
	return sum;
}

function channel(key: number, axis: 0 | 1 | 2): number {
	return axis === 0 ? (key >> 16) & 0xff : axis === 1 ? (key >> 8) & 0xff : key & 0xff;
}

function boxSpread(colors: number[]): number {
	const min = [255, 255, 255];
	const max = [0, 0, 0];
	for (const key of colors) {
		for (let axis = 0; axis < 3; axis++) {
			const value = channel(key, axis as 0 | 1 | 2);
			if (value < min[axis]) min[axis] = value;
			if (value > max[axis]) max[axis] = value;
		}
	}
	return Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
}

function dominantAxis(colors: number[]): 0 | 1 | 2 {
	const min = [255, 255, 255];
	const max = [0, 0, 0];
	for (const key of colors) {
		for (let axis = 0; axis < 3; axis++) {
			const value = channel(key, axis as 0 | 1 | 2);
			if (value < min[axis]) min[axis] = value;
			if (value > max[axis]) max[axis] = value;
		}
	}
	const spreads = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
	return spreads.indexOf(Math.max(...spreads)) as 0 | 1 | 2;
}

function averageColor(box: ColorBox, counts: Map<number, number>): Rgb {
	let r = 0;
	let g = 0;
	let b = 0;
	let weight = 0;
	for (const key of box.colors) {
		const count = counts.get(key) ?? 1;
		r += ((key >> 16) & 0xff) * count;
		g += ((key >> 8) & 0xff) * count;
		b += (key & 0xff) * count;
		weight += count;
	}
	if (weight === 0) return { r: 0, g: 0, b: 0 };
	return { r: Math.round(r / weight), g: Math.round(g / weight), b: Math.round(b / weight) };
}

function mapToPalette(image: RgbaImage, paletteKeys: number[]): Int16Array {
	const { data } = image;
	const indices = new Int16Array(data.length / 4);
	const colors = paletteKeys.map(keyToRgb);
	const cache = new Map<number, number>();
	for (let i = 0, p = 0; i < data.length; i += 4, p++) {
		const key = colorKey(data[i], data[i + 1], data[i + 2]);
		const cached = cache.get(key);
		if (cached !== undefined) {
			indices[p] = cached;
			continue;
		}
		const target: Rgb = { r: data[i], g: data[i + 1], b: data[i + 2] };
		let best = 0;
		let bestDistance = Number.POSITIVE_INFINITY;
		for (let c = 0; c < colors.length; c++) {
			const distance = colorDistance(target, colors[c]);
			if (distance < bestDistance) {
				bestDistance = distance;
				best = c;
			}
		}
		cache.set(key, best);
		indices[p] = best;
	}
	return indices;
}

function keyToRgb(key: number): Rgb {
	return { r: (key >> 16) & 0xff, g: (key >> 8) & 0xff, b: key & 0xff };
}

function rgbToKey(color: Rgb): number {
	return colorKey(color.r, color.g, color.b);
}

/**
 * Mark palette entries that match the background as transparent, or — when no
 * background is known — leave every mostly-transparent pixel unpainted.
 *
 * A typeset formula is mostly empty space. Making that space transparent both
 * shrinks the encoded image dramatically and lets the terminal's own background
 * (color, wallpaper or acrylic) show through, so the image blends into the
 * transcript instead of forming a visible rectangle.
 */
function applyTransparency(palette: SixelPalette, image: RgbaImage, background: Rgb | undefined, tolerance: number): SixelPalette {
	const { data } = image;
	const indices = new Int16Array(palette.indices);

	if (!background) {
		for (let i = 3, p = 0; i < data.length; i += 4, p++) {
			if (data[i] < 128) indices[p] = -1;
		}
		return { colors: palette.colors, indices };
	}

	const threshold = tolerance * tolerance;
	const transparentIndices = new Set<number>();
	for (let i = 0; i < palette.colors.length; i++) {
		if (colorDistance(palette.colors[i], background) <= threshold) transparentIndices.add(i);
	}
	if (transparentIndices.size === 0) return palette;
	for (let p = 0; p < indices.length; p++) {
		if (transparentIndices.has(indices[p])) indices[p] = -1;
	}
	return { colors: palette.colors, indices };
}

function encodeRle(values: number[]): string {
	let out = "";
	let index = 0;
	while (index < values.length) {
		const value = values[index];
		let run = 1;
		while (index + run < values.length && values[index + run] === value) run++;
		const char = String.fromCharCode(63 + Math.max(0, Math.min(63, value)));
		if (run >= 4) out += `!${run}${char}`;
		else out += char.repeat(run);
		index += run;
	}
	return out;
}

/** Encode an indexed image as a SIXEL DCS string (including `\x1bP` ... `\x1b\\`). */
export function encodeSixel(image: RgbaImage, palette: SixelPalette, options: SixelEncodeOptions = {}): string {
	const { width, height } = image;
	const { indices, colors } = palette;
	if (width <= 0 || height <= 0) return "";
	const aspectNumerator = options.aspectNumerator ?? 1;
	const aspectDenominator = options.aspectDenominator ?? 1;

	const bands = Math.ceil(height / 6);
	// `P2 = 1` is the DEC "background transparent" selection, which is also what
	// Windows Terminal checks to decide whether it fills the image area. Using
	// `P2 = 0` (the default) makes the terminal paint the whole raster rectangle
	// with the current background color, which shows up as a black box around the
	// formula.
	let out = `\x1bP0;1;0q"${aspectNumerator};${aspectDenominator};${width};${height}`;
	for (let i = 0; i < colors.length; i++) {
		const color = colors[i];
		const grey = Math.round((color.r * 100) / 255);
		const green = Math.round((color.g * 100) / 255);
		const blue = Math.round((color.b * 100) / 255);
		out += `#${i};2;${grey};${green};${blue}`;
	}

	for (let band = 0; band < bands; band++) {
		const rowStart = band * 6;
		// Which palette entries actually occur in this 6-pixel band?
		const used = new Set<number>();
		for (let y = rowStart; y < Math.min(rowStart + 6, height); y++) {
			const rowOffset = y * width;
			for (let x = 0; x < width; x++) {
				const index = indices[rowOffset + x];
				if (index >= 0) used.add(index);
			}
		}
		const ordered = [...used].sort((a, b) => a - b);
		if (ordered.length === 0) {
			// Empty band still has to advance the sixel cursor.
			if (band < bands - 1) out += "-";
			continue;
		}

		let first = true;
		for (const colorIndex of ordered) {
			if (!first) out += "$";
			first = false;
			out += `#${colorIndex}`;
			const values: number[] = new Array(width);
			for (let x = 0; x < width; x++) {
				let bits = 0;
				for (let bit = 0; bit < 6; bit++) {
					const y = rowStart + bit;
					if (y >= height) break;
					if (indices[y * width + x] === colorIndex) bits |= 1 << bit;
				}
				values[x] = bits;
			}
			out += encodeRle(values);
		}
		if (band < bands - 1) out += "-";
	}

	out += "\x1b\\";
	return out;
}

/** Convenience: quantize an opaque image and encode it in one step. */
export function imageToSixel(image: RgbaImage, options: SixelEncodeOptions = {}): string {
	const palette = applyTransparency(
		quantize(image, options.maxColors ?? 32),
		image,
		options.transparent,
		options.transparentTolerance ?? 24,
	);
	return encodeSixel(image, palette, options);
}

export interface DecodedSixel {
	width: number;
	height: number;
	/** RGBA pixels; unpainted pixels keep alpha 0. */
	pixels: Uint8Array;
}

/**
 * Minimal SIXEL decoder used by the test suite to prove that the encoder output
 * really round-trips (and is not just "some bytes that look plausible").
 */
export function decodeSixel(input: string): DecodedSixel {
	const start = input.indexOf("q");
	if (start === -1) throw new Error("not a sixel string");
	const body = input.slice(start + 1, input.endsWith("\x1b\\") ? -2 : undefined);

	const raster = /^"(\d+);(\d+);(\d+);(\d+)/.exec(body);
	let width = raster ? Number(raster[3]) : 0;
	let height = raster ? Number(raster[4]) : 0;
	let data = body.slice(raster ? raster[0].length : 0);

	const colors = new Map<number, Rgb>();
	let colorIndex = 0;
	// Raster attributes may only be known after the data; decode into a growable grid.
	const pixels: number[][] = [];
	let x = 0;
	let y = 0;
	let maxX = 0;
	let maxY = 0;

	const ensure = (px: number, py: number): number[] => {
		while (pixels.length <= py) pixels.push([]);
		const row = pixels[py];
		while (row.length <= px) row.push(-1);
		return row;
	};

	let i = 0;
	while (i < data.length) {
		const char = data[i];
		if (char === "#") {
			let j = i + 1;
			let numberText = "";
			while (j < data.length && /[0-9]/.test(data[j])) numberText += data[j++];
			colorIndex = Number(numberText || "0");
			if (data[j] === ";") {
				const parts: number[] = [];
				j++;
				let current = "";
				while (j < data.length && data[j] !== "#" && !/[A-Za-z?@~]/.test(data[j])) {
					if (data[j] === ";") {
						parts.push(Number(current));
						current = "";
					} else if (/[0-9]/.test(data[j])) {
						current += data[j];
					} else {
						break;
					}
					j++;
				}
				parts.push(Number(current));
				if (parts[0] === 2 && parts.length >= 4) {
					colors.set(colorIndex, {
						r: Math.round((parts[1] * 255) / 100),
						g: Math.round((parts[2] * 255) / 100),
						b: Math.round((parts[3] * 255) / 100),
					});
				}
			}
			i = j;
			continue;
		}
		if (char === "!") {
			let j = i + 1;
			let countText = "";
			while (j < data.length && /[0-9]/.test(data[j])) countText += data[j++];
			const count = Number(countText || "1");
			const value = data.charCodeAt(j) - 63;
			for (let n = 0; n < count; n++) {
				for (let bit = 0; bit < 6; bit++) {
					if (value & (1 << bit)) {
						ensure(x + n, y + bit)[x + n] = colorIndex;
					}
				}
			}
			x += count;
			maxX = Math.max(maxX, x);
			maxY = Math.max(maxY, y + 6);
			i = j + 1;
			continue;
		}
		if (char === "$") {
			x = 0;
			i++;
			continue;
		}
		if (char === "-") {
			x = 0;
			y += 6;
			i++;
			continue;
		}
		if (char === '"' || char === "\n" || char === "\r") {
			i++;
			continue;
		}
		const value = data.charCodeAt(i) - 63;
		if (value >= 0 && value <= 63) {
			for (let bit = 0; bit < 6; bit++) {
				if (value & (1 << bit)) {
					ensure(x, y + bit)[x] = colorIndex;
				}
			}
			x++;
			maxX = Math.max(maxX, x);
			maxY = Math.max(maxY, y + 6);
		}
		i++;
	}

	const finalWidth = Math.max(width, maxX);
	const finalHeight = Math.max(height, maxY);
	const out = new Uint8Array(finalWidth * finalHeight * 4);
	if (!width) width = finalWidth;
	if (!height) height = finalHeight;
	for (let py = 0; py < finalHeight; py++) {
		const row = pixels[py];
		if (!row) continue;
		for (let px = 0; px < row.length; px++) {
			const index = row[px];
			if (index < 0) continue;
			const color = colors.get(index) ?? { r: 0, g: 0, b: 0 };
			const offset = (py * finalWidth + px) * 4;
			out[offset] = color.r;
			out[offset + 1] = color.g;
			out[offset + 2] = color.b;
			out[offset + 3] = 255;
		}
	}
	return { width: finalWidth, height: finalHeight, pixels: out };
}
