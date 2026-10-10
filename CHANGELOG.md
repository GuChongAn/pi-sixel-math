# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-10-10

### Fixed

- Formulas no longer sit on a black box. The SIXEL introducer now selects
  `P2 = 1` (background transparent); Windows Terminal fills the whole image
  rectangle with the current background color when it sees the default
  `P2 = 0`, which painted a rectangle around every formula. See
  [`docs/how-it-works.md`](docs/how-it-works.md#7-transparent-image-backgrounds).
- Without a configured background color, mostly transparent pixels are left
  unpainted instead of being composited onto an assumed background, so formulas
  also blend with wallpapers and acrylic backgrounds.

## [0.1.0] - 2026-10-10

First release.

- LaTeX display math rendered as SIXEL images in the Pi TUI:
  MathJax → SVG → resvg → RGBA → SIXEL.
- Terminal-grid aware layout for Windows Terminal's 10×20 virtual pixel cells,
  including exact row reservation and cursor restoration.
- Median-cut quantization with run-length encoding; background pixels are left
  unpainted so the terminal background shows through.
- Markdown integration that never rewrites code blocks, inline code, escaped
  dollars or the stored conversation.
- Caches for layout plans and rendered formulas; automatic fallback to the
  original LaTeX when a formula cannot be rendered.
- `/sixel-math on|off|toggle|status|demo|clear|bg` and `PI_SIXEL_MATH_*`
  environment variables.
- Test suite: parser, renderer, SIXEL encoder round-trips, and a terminal
  emulator that verifies image rows, reserved rows and text alignment while
  streaming.
- `npm run probe` measures Windows Terminal's SIXEL cursor behaviour and the
  terminal's background color.

[0.1.1]: https://github.com/GuChongAn/pi-sixel-math/releases/tag/v0.1.1
[0.1.0]: https://github.com/GuChongAn/pi-sixel-math/releases/tag/v0.1.0
