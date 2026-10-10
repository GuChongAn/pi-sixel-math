/* Scratch smoke test for the renderer pipeline: writes SIXEL dumps and PNG previews. */
import { mkdirSync, writeFileSync } from "node:fs";
import { renderMathToImage } from "../src/renderer/math-image.js";
import { decodeSixel } from "../src/renderer/sixel.js";
import { encodePng, upscale } from "./lib/png.js";

const outDir = process.env.SMOKE_OUT ?? "tmp/smoke";
mkdirSync(outDir, { recursive: true });

const formulas: [string, string][] = [
	["fraction", String.raw`\frac{a+b}{c+d}`],
	["sum", String.raw`\sum_{i=1}^{n} x_i^2`],
	["rl", String.raw`J(\theta)=\mathbb{E}_{\tau\sim\pi_\theta}\left[\sum_{t=0}^{T}\gamma^t r_t\right]`],
	["matrix", String.raw`A=\begin{bmatrix}1&2&3\\4&5&6\\7&8&9\end{bmatrix}`],
	["integral", String.raw`\int_{-\infty}^{+\infty} e^{-x^2}\,dx=\sqrt{\pi}`],
	["nested", String.raw`L(\theta)=-\frac{1}{N}\sum_{i=1}^{N}\log\frac{\exp(s_{i,i}/\tau)}{\sum_{j=1}^{N}\exp(s_{i,j}/\tau)}`],
	["inline", String.raw`x^2+y^2=r^2`],
	["greek", String.raw`\alpha\beta\gamma\delta\epsilon\theta\lambda\mu\pi\sigma\phi\omega`],
];

for (const [name, latex] of formulas) {
	const { image, raster } = await renderMathToImage(latex, {
		maxColumns: 100,
		foreground: { r: 0xe5, g: 0xe5, b: 0xe7 },
		background: { r: 0x1e, g: 0x1e, b: 0x1e },
	});
	const decoded = decodeSixel(image.dcs);
	console.log(
		`${name.padEnd(9)} ${String(image.widthPx).padStart(3)}x${String(image.heightPx).padStart(3)}px ` +
			`-> ${image.columns}x${image.rows} cells cursorAdvance=${image.cursorAdvance} ` +
			`bytes=${image.dcs.length} decoded=${decoded.width}x${decoded.height}`,
	);
	writeFileSync(`${outDir}/${name}.sixel`, image.dcs);
	const preview = upscale(raster.data, raster.width, raster.height, 8);
	writeFileSync(`${outDir}/${name}.png`, encodePng(preview.width, preview.height, preview.data));
}
