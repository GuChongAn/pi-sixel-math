/**
 * Builds `docs/images/rendered.png` from the real renderer output.
 *
 * The preview is the exact pixel data the terminal receives, only scaled 2x, so
 * what the README shows is what Windows Terminal paints.
 *
 * Run with `npm run preview`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { initMathJax } from "../src/renderer/latex.js";
import { renderMathToImageSync } from "../src/renderer/math-image.js";
import type { RgbaImage } from "../src/renderer/raster.js";
import { encodePng, upscale } from "./lib/png.js";

const BACKGROUND = { r: 0x0c, g: 0x0c, b: 0x0c };
const FOREGROUND = { r: 0xd8, g: 0xde, b: 0xe9 };
const SCALE = 2;
const MARGIN_X = 14;
const MARGIN_Y = 10;
const GAP = 12;

const FORMULAS = [
	String.raw`\frac{a+b}{c+d}\qquad \sum_{i=1}^{n} x_i^2 \qquad \int_{-\infty}^{+\infty} e^{-x^2}\,dx=\sqrt{\pi}`,
	String.raw`J(\theta)=\mathbb{E}_{\tau\sim\pi_\theta}\left[\sum_{t=0}^{T}\gamma^t r_t\right] \qquad A=\begin{bmatrix}1&2&3\\4&5&6\\7&8&9\end{bmatrix}`,
	String.raw`L(\theta)=-\frac{1}{N}\sum_{i=1}^{N}\log\frac{\exp(s_{i,i}/\tau)}{\sum_{j=1}^{N}\exp(s_{i,j}/\tau)}`,
];

function blit(target: RgbaImage, source: RgbaImage, x: number, y: number): void {
	for (let row = 0; row < source.height; row++) {
		for (let column = 0; column < source.width; column++) {
			const sourceOffset = (row * source.width + column) * 4;
			if (source.data[sourceOffset + 3] === 0) continue;
			const targetOffset = ((y + row) * target.width + x + column) * 4;
			const alpha = source.data[sourceOffset + 3] / 255;
			target.data[targetOffset] = Math.round(source.data[sourceOffset] * alpha + target.data[targetOffset] * (1 - alpha));
			target.data[targetOffset + 1] = Math.round(source.data[sourceOffset + 1] * alpha + target.data[targetOffset + 1] * (1 - alpha));
			target.data[targetOffset + 2] = Math.round(source.data[sourceOffset + 2] * alpha + target.data[targetOffset + 2] * (1 - alpha));
			target.data[targetOffset + 3] = 255;
		}
	}
}

async function main(): Promise<void> {
	await initMathJax();
	const rendered = FORMULAS.map(
		(latex) =>
			renderMathToImageSync(latex, {
				display: true,
				maxColumns: 120,
				foreground: FOREGROUND,
				background: BACKGROUND,
				ssaa: 4,
				maxColors: 32,
			}).raster,
	);

	const width = Math.max(...rendered.map((image) => image.width)) + MARGIN_X * 2;
	const height = rendered.reduce((sum, image) => sum + image.height, 0) + GAP * (rendered.length - 1) + MARGIN_Y * 2;

	const canvas: RgbaImage = { width, height, data: new Uint8Array(width * height * 4) };
	for (let i = 0; i < width * height; i++) {
		canvas.data[i * 4] = BACKGROUND.r;
		canvas.data[i * 4 + 1] = BACKGROUND.g;
		canvas.data[i * 4 + 2] = BACKGROUND.b;
		canvas.data[i * 4 + 3] = 255;
	}

	let y = MARGIN_Y;
	for (const image of rendered) {
		blit(canvas, image, Math.round((width - image.width) / 2), y);
		y += image.height + GAP;
	}

	const scaled = upscale(canvas.data, canvas.width, canvas.height, SCALE);
	mkdirSync("docs/images", { recursive: true });
	writeFileSync("docs/images/rendered.png", encodePng(scaled.width, scaled.height, scaled.data));
	console.log(`docs/images/rendered.png: ${scaled.width}x${scaled.height}px`);
}

main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
