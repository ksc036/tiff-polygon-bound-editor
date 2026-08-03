---
title: Native folder picker encoding and error precedence
date: 2026-08-03
category: integration-issues
module: Native folder picker
problem_type: integration_issue
component: service_object
symptoms:
  - "Windows folder paths containing non-ASCII characters can be corrupted before Node decodes stdout."
  - "Linux display failures reported only in the process error message can be misclassified as user cancellation."
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags:
  - folder-picker
  - powershell
  - stdout-encoding
  - error-classification
  - linux-display
---

# Native folder picker encoding and error precedence

## Problem

Native folder-picker adapters cross two fragile boundaries: subprocess text encoding and platform-specific error reporting. Configuring only Node's stdout decoder does not control the bytes emitted by PowerShell, while a broad exit-code rule can hide a more specific Linux display diagnostic.

## Symptoms

- Windows paths containing Korean or other non-ASCII characters can arrive corrupted when PowerShell writes with a legacy console code page and Node decodes the bytes as UTF-8.
- A Linux dialog failure with exit code 1, empty stderr, and a display diagnostic in `error.message` can be reported as cancellation instead of picker unavailability.

## What Didn't Work

- Setting `{ encoding: "utf8" }` on `execFile` controls decoding in Node but does not configure the child process's output encoding.
- Checking exit code 1 with empty stderr before inspecting all diagnostics treats a generic cancellation convention as more authoritative than a specific display failure.

## Solution

Configure PowerShell's output encoding inside the script before it writes the selected path:

```powershell
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::Out.Write($dialog.SelectedPath)
```

Order Linux classification from specific diagnostics to generic process conventions:

```js
if (isDisplayFailure(error)) throw unavailable(error);
if (error?.code === 1 && !String(error?.stderr ?? "").trim()) throw cancelled(error);
```

Use injected command runners in regression tests to inspect the exact PowerShell command and to model errors whose diagnostic exists only in `message`.

## Why This Works

The producer and consumer now agree on UTF-8, preserving the selected path before Node receives it. On Linux, specific evidence about an unusable graphical session wins over the ambiguous exit-code-1 convention, while genuine silent cancellations retain their existing classification.

## Prevention

- At subprocess boundaries, configure both the producer's output encoding and the consumer's decoder.
- Order error classifiers from the most specific diagnostic to the broadest status-code fallback.
- Test diagnostic channels independently because native wrappers may place the same failure in `stderr`, `message`, or both.

## Related Issues

- [Local Tool API Contracts](../local-tool-api-contracts.md)
