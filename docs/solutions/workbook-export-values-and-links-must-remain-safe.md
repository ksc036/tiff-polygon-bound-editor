# Workbook Export Values And Links Must Remain Safe

## Context

The per-image workbook combines optional source metadata with paths supplied by export orchestration. Direct JavaScript coercion and unchecked archive paths can silently produce misleading or unsafe spreadsheet content.

## Rule

- Treat `null`, `undefined`, and empty optional measurements or timestamps as blank cells before numeric or date coercion.
- Build artifact hyperlinks only from non-empty, non-traversing path segments rooted in their expected archive directory. Workbook links from `statistics/` must begin with `../roi/` or `../heatmap/`.
- When an artifact is unavailable or its path is invalid, render safe fallback text instead of a hyperlink.
- Treat exported workbook headers as an exact schema contract. Regression tests must assert the complete ordered header row, not only columns whose values are consumed by application code.

## Regression Tests

Reopen generated workbooks with ExcelJS and assert that missing timestamps are blank, source filenames contain no absolute path, and paths such as `roi/../private.png` do not produce links.
