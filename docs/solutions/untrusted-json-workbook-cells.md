# Treat loaded JSON as untrusted workbook input

## Context

Export workbooks combine saved bounds, analysis JSON, heatmap metadata, and export-report text. These files can be edited outside the application, so values read from them must not be passed to ExcelJS as arbitrary cell values.

## Rule

Only application-constructed formulas or hyperlinks may use ExcelJS object cell values. Loaded text must be accepted only when it is a primitive string. Numeric measurements must be finite primitive numbers or numeric strings, dates must be valid primitive timestamps or application `Date` instances, and colors must match the expected `#RRGGBB` format. Invalid values become blank or a documented fallback.

This keeps strings such as `=SUM(A1:A2)` as literal text and prevents loaded objects such as `{ formula: ... }` from becoming formula cells.

## Regression coverage

`server/exportWorkbook.test.js` loads a workbook built from formula-like strings and a formula object, then checks that no cell is an ExcelJS formula cell. `shared/analysisRows.test.js` also checks that each analysis group keeps its own saved ROI bands in export rows.
