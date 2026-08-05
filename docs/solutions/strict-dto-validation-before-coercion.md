# Strict DTO Validation Before Coercion

When validating persisted numeric DTO fields, explicitly check that each field is a safe integer before using arithmetic or comparisons. JavaScript numeric coercion can allow string values to participate in calculations and hide malformed serialized data. Add a regression test for representative string and range violations, and use field-specific validation errors so the rejected contract is clear.

## Return a closed public DTO

Validation is not sanitization when the validated object is returned with object spread. Checking `maskSource.file` does not make `{ ...maskSource }` safe because internal fields such as an absolute `path` remain present. Likewise, `{ ...payload }` preserves unknown top-level fields even when every known field passed validation.

After validation, construct the returned DTO from an explicit allowlist at every object level:

```js
return {
  schemaVersion: payload.schemaVersion,
  imageFolder: payload.imageFolder,
  maskSource: {
    file: payload.maskSource.file,
    size: payload.maskSource.size,
  },
  cells: payload.cells.map(({ row, column, pixelDensity }) => ({
    row,
    column,
    pixelDensity,
  })),
};
```

Time fields are the exception to structural numeric validation when they are kept
only for audit display. Copy them only when already well formed, otherwise omit them;
never let `mtimeMs` or `updatedAt` decide whether scientific data is accepted.

Reject `.` and `..` path segments in public filenames for both slash styles, and test injected absolute paths at nested and top-level positions. The safe contract is the object returned after validation, not merely the set of fields that happened to be checked.
