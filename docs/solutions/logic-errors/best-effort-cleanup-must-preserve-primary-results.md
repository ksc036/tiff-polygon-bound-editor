---
title: Best-effort cleanup must preserve primary results
date: 2026-08-04
category: logic-errors
module: Atomic file services
problem_type: logic_error
component: service_object
symptoms:
  - "A temporary-file cleanup failure replaces the real operation error."
  - "A committed save is reported as failed because a later cleanup call throws."
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags:
  - atomic-write
  - cleanup
  - error-precedence
  - temporary-files
  - rollback
---

# Best-effort cleanup must preserve primary results

## Problem

Atomic file services often remove staging and backup files in `finally`. Awaiting those removals without protection lets a secondary cleanup failure replace the operation's real result: a successful commit can be reported as failed, or a rendering error can be hidden by an unrelated `rm` error.

## Symptoms

- A public service method leaks raw filesystem errors instead of its stable domain error.
- A successful TIFF and JSON commit rejects only because temporary-file removal failed afterward.
- The error reported to the caller differs depending on whether cleanup also fails.

## What Didn't Work

- Calling `await rm(tempPath, { force: true })` directly in `finally` assumes forced removal cannot fail. Permissions, injected failures, and platform filesystem behavior can still reject.
- Mapping only the main render/write block leaves preliminary `access` checks as another raw-error escape path.

## Solution

Keep domain-visible work and best-effort cleanup separate:

```js
async function removeQuietly(filePath, rmFile) {
  try {
    await rmFile(filePath, { force: true });
  } catch {
    // Cleanup must not replace the primary operation result.
  }
}

try {
  return await commitOutput();
} catch (error) {
  throw toStableServiceError(error);
} finally {
  await removeQuietly(tempPath, rmFile);
  await removeQuietly(backupPath, rmFile);
}
```

Map non-`ENOENT` errors from existence checks to the service's stable error contract as well. Preserve the original filesystem error only as `cause`, not as the public message.

## Why This Works

The main operation remains authoritative: its success stays successful, and its failure keeps the correct domain code. Cleanup still runs on every path, but cleanup reliability no longer controls the public result.

## Prevention

- Treat temporary-file deletion as best effort unless leftover files make the committed output invalid.
- Test successful commit plus cleanup failure and primary failure plus cleanup failure as separate cases.
- Inject non-`ENOENT` failures into every preliminary filesystem probe and assert callers receive a stable domain error.
- Keep rollback failures observable through logs or diagnostics when available, without replacing the original exception.

## Related Issues

- [Heatmap batch resilience and metadata validation](../heatmap-batch-resilience-and-metadata-validation.md)
