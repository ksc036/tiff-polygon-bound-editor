---
title: Windows Find root picker opens behind the browser
date: 2026-08-04
category: integration-issues
module: Native folder picker
problem_type: integration_issue
component: tooling
symptoms:
  - "The Windows Find root folder picker opens behind the browser that initiated the request."
  - "Making the hidden WinForms owner topmost and active does not reliably keep IFileOpenDialog in front."
root_cause: wrong_api
resolution_type: code_fix
severity: medium
tags:
  - windows
  - folder-picker
  - powershell
  - ifileopendialog
  - win32
  - window-z-order
  - foreground-activation
---

# Windows Find root picker opens behind the browser

## Problem

The browser initiates an HTTP request, but the server launches the native picker
from a separate PowerShell process. Windows can deny foreground activation to
that process, so promoting only an invisible owner form does not guarantee that
the user-visible picker appears above the browser.

## Symptoms

- `IFileOpenDialog` is created successfully but appears behind the browser.
- The application looks unresponsive because the obscured picker is modal.

## What Didn't Work

The first implementation set a hidden WinForms owner to `TopMost`, showed and
activated it, then passed its handle to `IFileOpenDialog.Show`. That relied on
owner-window Z-order inheritance and did not target the actual dialog HWND.

## Solution

Run a guard for the lifetime of `IFileOpenDialog.Show`:

```csharp
EnumWindows(findOwnedDialog, IntPtr.Zero);
SetWindowPos(dialogHandle, HWND_TOPMOST, 0, 0, 0, 0,
    SwpNoSize | SwpNoMove | SwpNoActivate | SwpShowWindow);
SetForegroundWindow(dialogHandle);
```

The guard enumerates visible top-level windows, identifies the one whose
`GA_ROOTOWNER` is the hidden owner, and applies `HWND_TOPMOST` directly to that
dialog. `SetForegroundWindow` remains best effort because Windows may deny it.
The same-STA WinForms timer stops after promotion, detaches its handler, and is
disposed when `Show` returns, so no native callback can outlive the dialog.

## Why This Works

The Z-order operation now targets the window the user actually sees. Direct
`HWND_TOPMOST` promotion keeps the picker above normal browser windows even when
foreground focus cannot be transferred across the browser, server, and
PowerShell process boundary.

## Prevention

- Apply native Z-order operations to the user-visible dialog HWND.
- Treat foreground activation as fallible and keep the picker usable if denied.
- Scope polling and native resources to the modal dialog lifetime.
- Lock the owner lookup and direct `HWND_TOPMOST` call with structural tests.
- Verify desktop focus behavior on a real Windows machine before release.

## Related Issues

- [Native folder picker encoding and error precedence](native-folder-picker-encoding-and-error-precedence.md)
- [Local Tool API Contracts](../local-tool-api-contracts.md)
