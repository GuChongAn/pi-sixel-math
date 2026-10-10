import { Resvg } from "@resvg/resvg-js";

export interface RgbaImage {
	width: number;
	height: number;
	/** Straight (non-premultiplied) RGBA, 4 bytes per pixel. */
	data: Uint8Array;
}

/**
 * Rasterize an SVG into straight RGBA pixels.
 *
 * `scale` supersamples: the SVG is rendered `scale` times larger and then box
 * filtered down, which gives much smoother anti-aliased glyph edges than asking
 * the rasterizer for the tiny final bitmap directly.
 *
 * System fonts are *not* loaded by default. MathJax emits glyph outlines, so the
 * font database is not needed, and enumerating the Windows font directory costs
 * ~150 ms per call, which would dominate the render time.
 */
export function rasterize(
	svg: string,
	widthPx: number,
	heightPx: number,
	scale = 4,
	options: { loadSystemFonts?: boolean } = {},
): RgbaImage {
	const bigWidth = Math.max(1, Math.round(widthPx * scale));
	const loadSystemFonts = options.loadSystemFonts ?? process.env.PI_SIXEL_MATH_SYSTEM_FONTS === "1";
	const resvg = new Resvg(svg, {
		fitTo: { mode: "width", value: bigWidth },
		background: undefined,
		logLevel: "error",
		font: loadSystemFonts ? { loadSystemFonts: true } : { loadSystemFonts: false, defaultFontFamily: "sans-serif" },
	});
	const rendered = resvg.render();
	const data = new Uint8Array(
		rendered.pixels.buffer.slice(rendered.pixels.byteOffset, rendered.pixels.byteOffset + rendered.pixels.byteLength),
	);
	const image: RgbaImage = { width: rendered.width, height: rendered.height, data };

	return downsample(image, widthPx, heightPx);
}

/** Box-filter downscale (premultiplied average) to the requested size. */
export function downsample(image: RgbaImage, targetWidth: number, targetHeight: number): RgbaImage {
	const { width, height, data } = image;
	const tw = Math.max(1, Math.round(targetWidth));
	const th = Math.max(1, Math.round(targetHeight));
	if (width === tw && height === th) return image;

	const out = new Uint8Array(tw * th * 4);
	for (let ty = 0; ty < th; ty++) {
		const y0 = Math.floor((ty * height) / th);
		const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * height) / th));
		for (let tx = 0; tx < tw; tx++) {
			const x0 = Math.floor((tx * width) / tw);
			const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * width) / tw));

			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			let count = 0;
			for (let y = y0; y < y1; y++) {
				let index = (y * width + x0) * 4;
				for (let x = x0; x < x1; x++, index += 4) {
					const alpha = data[index + 3] / 255;
					// Average in premultiplied space so transparent pixels do not leak their color.
					r += data[index] * alpha;
					g += data[index + 1] * alpha;
					b += data[index + 2] * alpha;
					a += alpha;
					count++;
				}
			}
			const offset = (ty * tw + tx) * 4;
			const alphaSum = a / count;
			if (alphaSum <= 0) {
				out[offset + 3] = 0;
				continue;
			}
			out[offset] = Math.min(255, Math.round(r / count / alphaSum));
			out[offset + 1] = Math.min(255, Math.round(g / count / alphaSum));
			out[offset + 2] = Math.min(255, Math.round(b / count / alphaSum));
			out[offset + 3] = Math.min(255, Math.round(alphaSum * 255));
		}
	}
	return { width: tw, height: th, data: out };
}

export interface Rgb {
	r: number;
	g: number;
	b: number;
}

/** Format an RGB color as `#rrggbb`. */
export function toHex(color: Rgb): string {
	const part = (value: number): string => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
	return `#${part(color.r)}${part(color.g)}${part(color.b)}`;
}

const HEX_PATTERN = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** Parse `#rgb`, `#rrggbb` (alpha ignored) into 0-255 components. */
export function parseColor(value: string): Rgb | undefined {
	const match = HEX_PATTERN.exec(value.trim());
	if (!match) return undefined;
	let hex = match[1];
	if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
	const int = Number.parseInt(hex.slice(0, 6), 16);
	return { r: (int >> 16) & 0xff, g: (int >> 8) & 0xff, b: int & 0xff };
}

/**
 * Composite straight alpha pixels over an opaque background color.
 *
 * The result has no transparency at all, which is what the SIXEL encoder wants:
 * the image is then quantized as a plain opaque picture and every "background"
 * pixel can be dropped by the encoder as transparent again at no visual cost.
 */
export function compositeOver(image: RgbaImage, background: Rgb): RgbaImage {
	const out = new Uint8Array(image.data.length);
	const { data } = image;
	for (let i = 0; i < data.length; i += 4) {
		const alpha = data[i + 3] / 255;
		if (alpha >= 1) {
			out[i] = data[i];
			out[i + 1] = data[i + 1];
			out[i + 2] = data[i + 2];
		} else {
			out[i] = Math.round(data[i] * alpha + background.r * (1 - alpha));
			out[i + 1] = Math.round(data[i + 1] * alpha + background.g * (1 - alpha));
			out[i + 2] = Math.round(data[i + 2] * alpha + background.b * (1 - alpha));
		}
		out[i + 3] = 255;
	}
	return { width: image.width, height: image.height, data: out };
}
