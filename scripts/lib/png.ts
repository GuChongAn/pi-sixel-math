import { deflateSync } from "node:zlib";

function crc32(data: Uint8Array): number {
	let crc = 0xffffffff;
	for (let i = 0; i < data.length; i++) {
		crc ^= data[i];
		for (let bit = 0; bit < 8; bit++) {
			crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
	const out = new Uint8Array(body.length + 12);
	const view = new DataView(out.buffer);
	view.setUint32(0, body.length);
	for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
	out.set(body, 8);
	view.setUint32(out.length - 4, crc32(out.subarray(4, out.length - 4)));
	return out;
}

/** Minimal non-interlaced RGBA PNG encoder, used for previews and tests. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
	const stride = width * 4;
	const raw = new Uint8Array((stride + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (stride + 1)] = 0;
		raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
	}
	const header = new Uint8Array(13);
	const view = new DataView(header.buffer);
	view.setUint32(0, width);
	view.setUint32(4, height);
	header[8] = 8;
	header[9] = 6;
	const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	return concat([
		signature,
		chunk("IHDR", header),
		chunk("IDAT", new Uint8Array(deflateSync(raw))),
		chunk("IEND", new Uint8Array(0)),
	]);
}

function concat(parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

/** Nearest-neighbour upscale, so previews show the real pixel grid. */
export function upscale(rgba: Uint8Array, width: number, height: number, factor: number): { width: number; height: number; data: Uint8Array } {
	const out = new Uint8Array(width * factor * height * factor * 4);
	for (let y = 0; y < height * factor; y++) {
		for (let x = 0; x < width * factor; x++) {
			const src = (Math.floor(y / factor) * width + Math.floor(x / factor)) * 4;
			const dst = (y * width * factor + x) * 4;
			out[dst] = rgba[src];
			out[dst + 1] = rgba[src + 1];
			out[dst + 2] = rgba[src + 2];
			out[dst + 3] = rgba[src + 3];
		}
	}
	return { width: width * factor, height: height * factor, data: out };
}
