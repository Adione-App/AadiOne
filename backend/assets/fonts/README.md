# Fonts for generated PDFs (seller settlement statements)

| File | Font | Licence |
|---|---|---|
| NotoSans-Regular.ttf, NotoSans-Bold.ttf | Noto Sans (Latin, incl. ₹) — unhinted static TTF from notofonts/notofonts.github.io | SIL OFL 1.1 — `OFL-NotoSans.txt` |
| NotoSansDevanagari-Regular.ttf, NotoSansDevanagari-Bold.ttf | Noto Sans Devanagari (Hindi store / seller names) | SIL OFL 1.1 — `OFL-NotoSansDevanagari.txt` |

Used by `src/modules/sellers/seller-statement-pdf.ts`; the Docker runtime image copies this folder (`COPY assets ./assets`).
