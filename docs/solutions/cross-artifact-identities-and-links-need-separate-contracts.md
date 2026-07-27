# Cross-Artifact Identities And Links Need Separate Contracts

## Context

An export can show one ROI in the editor, a rendered image, and an Excel workbook. Two subtle mistakes appear when these surfaces are planned independently: replacing the saved internal group ID with a display ID breaks state maps, and calculating workbook links from the ZIP root produces invalid relative paths.

## Rule

Keep internal and display identities as separate fields. For example, preserve `sourceGroupId` for draw/statistics visibility maps and derive `groupId: "G01"` plus `roiId: "G01-N"` for user-facing artifacts. Generate every display ID through one shared helper used by the client, renderer, and workbook.

Resolve artifact links from the directory containing the referencing file. A workbook stored at `image/statistics/file.xlsx` links to `image/roi/report.png` as `../roi/report.png`, not `../../roi/report.png`.

## Regression Tests

Test one mixed inside/outside dataset across all surfaces. Assert that editor labels, exported labels, workbook rows, and saved colors match while visibility remains keyed by the original group ID. Reopen the generated workbook, inspect its hyperlink values, and resolve each link against the workbook's archive directory to confirm the target entry exists.
