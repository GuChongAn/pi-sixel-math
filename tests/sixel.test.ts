import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeSixel, encodeSixel, imageToSixel, quantize } from "../src/renderer/sixel.js";
import { compositeOver, downsample, parseColor, toHex, type RgbaImage } from "../src/renderer/raster.js";

function makeImage(width: number, height: number, paint: (x: number, y: number) => [number, number, number, number]): RgbaImage {
	const data = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const [r, g, b, a] = paint(x, y);
			const offset = (y * width + x) * 4;
			data[offset] = r;
			data[offset + 1] = g;
			data[offset + 2] = b;
			data[offset + 3] = a;
		}
	}
	return { width, height, data };
}

test("sixel output is a well-formed DCS string", () => {
	const image = makeImage(4, 6, () => [255, 255, 255, 255]);
	const palette = quantize(image, 4);
	const encoded = encodeSixel(image, palette);
	assert.ok(encoded.startsWith("\x1bP"));
	assert.ok(encoded.endsWith("\x1b\\"));
	assert.ok(encoded.includes('"1;1;4;6'));
	// No stray escape sequences inside the payload, which would break the TUI.
	assert.equal(encoded.slice(2, -2).includes("\x1b"), false);
});

test("sixel round-trips through the decoder", () => {
	const image = makeImage(12, 12, (x, y) => (x < 6 ? [255, 0, 0, 255] : y < 6 ? [0, 255, 0, 255] : [0, 0, 255, 255]));
	const encoded = encodeSixel(image, quantize(image, 8));
	const decoded = decodeSixel(encoded);
	assert.equal(decoded.width, 12);
	assert.equal(decoded.height, 12);

	const at = (x: number, y: number): [number, number, number] => {
		const offset = (y * decoded.width + x) * 4;
		return [decoded.pixels[offset], decoded.pixels[offset + 1], decoded.pixels[offset + 2]];
	};
	assert.deepEqual(at(1, 1), [255, 0, 0]);
	assert.deepEqual(at(9, 1), [0, 255, 0]);
	assert.deepEqual(at(9, 9), [0, 0, 255]);
});

test("pixels matching the background become transparent", () => {
	const background = { r: 0x0c, g: 0x0c, b: 0x0c };
	const image = makeImage(12, 6, (x) => (x < 6 ? [background.r, background.g, background.b, 255] : [255, 255, 255, 255]));
	const encoded = imageToSixel(image, { transparent: background, maxColors: 4 });
	const decoded = decodeSixel(encoded);
	const alphaAt = (x: number, y: number): number => decoded.pixels[(y * decoded.width + x) * 4 + 3];
	assert.equal(alphaAt(0, 0), 0, "background pixels must not be painted");
	assert.equal(alphaAt(9, 0), 255, "formula pixels must be painted");
	// Transparency also shrinks the payload: only half of every band is emitted.
	const opaqueEncoded = imageToSixel(image, { maxColors: 4 });
	assert.ok(encoded.length < opaqueEncoded.length);
});

test("run length encoding keeps repeated pixels", () => {
	const image = makeImage(24, 6, () => [200, 30, 30, 255]);
	const encoded = encodeSixel(image, quantize(image, 2));
	assert.ok(encoded.includes("!24"), `expected an RLE run in ${encoded}`);
	const decoded = decodeSixel(encoded);
	assert.equal(decoded.width, 24);
});

test("tall images use multiple sixel bands", () => {
	const image = makeImage(6, 20, (x, y) => [x * 40, y * 10, 0, 255]);
	const encoded = encodeSixel(image, quantize(image, 16));
	assert.ok(encoded.includes("-"), "a multi-band image must advance with '-'");
	const decoded = decodeSixel(encoded);
	assert.equal(decoded.height, 24, "4 bands of 6 pixels");
});

test("quantize respects the palette limit", () => {
	const image = makeImage(16, 16, (x, y) => [x * 16, y * 16, (x + y) * 8, 255]);
	const palette = quantize(image, 8);
	assert.ok(palette.colors.length <= 8);
	assert.ok(palette.colors.length > 1);
});

test("raster helpers handle color parsing and compositing", () => {
	assert.deepEqual(parseColor("#ff8800"), { r: 255, g: 136, b: 0 });
	assert.deepEqual(parseColor("#f80"), { r: 255, g: 136, b: 0 });
	assert.equal(parseColor("not-a-color"), undefined);
	assert.equal(toHex({ r: 12, g: 12, b: 12 }), "#0c0c0c");

	const transparent = makeImage(2, 2, () => [255, 255, 255, 0]);
	const composited = compositeOver(transparent, { r: 0, g: 0, b: 0 });
	assert.deepEqual([...composited.data.slice(0, 4)], [0, 0, 0, 255]);
});

test("downsampling averages instead of dropping pixels", () => {
	const image = makeImage(4, 4, (x) => [x < 2 ? 0 : 255, 0, 0, 255]);
	const small = downsample(image, 2, 2);
	assert.equal(small.width, 2);
	assert.equal(small.height, 2);
	assert.equal(small.data[0], 0);
	assert.equal(small.data[4], 255);
});

test("downsampling keeps transparency transparent", () => {
	const image = makeImage(4, 4, () => [10, 20, 30, 0]);
	const small = downsample(image, 2, 2);
	assert.equal(small.data[3], 0);
});
