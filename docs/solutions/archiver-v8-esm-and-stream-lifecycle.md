# Archiver v8 ESM And Stream Lifecycle

## Context

A ZIP export plan used the historical `archiver("zip", options)` factory API, but installing the required `archiver@^8.0.0` produced a pure ESM package with no default callable export.

## Rule

- Verify a newly installed major dependency's actual exports before copying API examples from an implementation plan.
- With Archiver 8, import `ZipArchive` and construct it with `new ZipArchive(options)`.
- Keep archive and output error listeners active through finalization, and await output completion separately from `archive.finalize()`.
- For bounded memory, append one source or generated buffer and wait for its matching `entry` event before creating or appending the next artifact.
- Route caller aborts, archive errors, and output failures through one lifecycle signal so pending entry waits and active renderer handles are closed together.

## Regression Coverage

Exercise a real archive from streaming through extraction. A helper-only test cannot detect an ESM export mismatch or a destination stream that never closes after early failure.
