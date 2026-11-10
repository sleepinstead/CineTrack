# Paper theme backup

The original **Paper** theme, preserved exactly as it was before the theme redesigns. Paper is the active light theme again (see `src/styles/themes.css`). This folder is the reference copy, and `test/theme.test.ts` checks that the live Paper colours still match `paper.css`, apart from the accent, which was brightened from `#7a2318` to `#a32d1e`.

| File | What it holds |
| --- | --- |
| `paper.css` | The original `:root` colour tokens and derived tokens, plus the dotted "paper tooth" body texture. In the original app that texture was covered by the page's solid background, so it was never visible. |
| `paper.ts` | The original picker entry (name, note, swatch), its colour defaults, and the original marked-episode colour. |

## If Paper's colours drift

Copy the hex values from `paper.css` back into the `[data-theme='paper']` block in `src/styles/themes.css`, then run `npm test`.
