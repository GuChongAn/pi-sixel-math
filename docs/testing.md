# Testing

```powershell
npm test                # 51 tests, no terminal needed
npm run typecheck
npm run build
npm run smoke           # SIXEL dumps + PNG previews in tmp/smoke
npm run probe           # measures Windows Terminal, writes tmp/probe-report.json
npm run demo            # standalone renderer demo (visual)
npm run visual-test     # probe + the six acceptance formulas (visual)
npm run tui-experiment  # isolated pi-tui session with streaming and redraws
```

## Automated tests

| File | Covers |
| --- | --- |
| `tests/parser.test.ts` | `$$…$$`, `\[…\]`, `\(…\)`, `$…$`; code fences, tilde fences, unterminated fences, inline code, escaped dollars, prices, multi-line math, matrices, CRLF, streaming-incomplete formulas |
| `tests/renderer.test.ts` | MathJax dimensions, SVG rewriting, formula → SIXEL, decodability, width and height caps, cursor advance, TeX error handling, determinism |
| `tests/sixel.test.ts` | SIXEL well-formedness, encoder/decoder round-trips, transparency, run-length encoding, multi-band images, quantization, compositing, downsampling |
| `tests/patch.test.ts` | Marker/fence layout, code preservation, fallback on failure, cache behaviour, component text preservation, clean uninstall |
| `tests/tui-lines.test.ts` | Image rows, reserved rows and text alignment while streaming, after appending formulas, after in-place formula changes and after full redraws |

`tests/tui-lines.test.ts` runs pi-tui's real main-screen renderer against
`tests/helpers/mock-terminal.ts` — a small terminal emulator that understands the
escape sequences the TUI emits *and* Windows Terminal's SIXEL cursor semantics
(draw at the cursor, then move to the last band). This makes the layout
verifiable without a human watching a screen; the mock caught two off-by-one bugs
that a plain string comparison would have missed.

## Visual tests

The visual commands must run inside Windows Terminal. They are the only way to
verify what the terminal actually paints.

`npm run probe` prints a table and writes `tmp/probe-report.json`:

```
 20px -> rows=1 advance measured=0 expected=0
 40px -> rows=2 advance measured=1 expected=1
 60px -> rows=3 advance measured=2 expected=2
120px -> rows=6 advance measured=5 expected=5
cursor restore to anchor row: OK
\x1b_G marker accepted: yes
```

If `advance measured` ever differs from `expected`, `cursorAdvance` in
`src/renderer/math-image.ts` needs to follow the terminal instead — that value is
the only terminal-specific magic number in the pipeline.

`npm run visual-test` renders the six acceptance formulas (fraction, scripts and
sum, reinforcement-learning objective, matrix, integral, complex nesting) with
labels, then returns to a working prompt.

`npm run tui-experiment` drives the real pi-tui renderer outside of Pi: a static
message, five streamed paragraphs, a second formula, a third formula and a forced
full redraw. It exists so the TUI integration can be checked without touching a
running Pi session.

## Reproducing the acceptance run

```powershell
npm ci
npm test
npm run build
npm run visual-test
npm run tui-experiment
pi -e .\src\index.ts     # then: /sixel-math status, /sixel-math demo, ask for math
```
