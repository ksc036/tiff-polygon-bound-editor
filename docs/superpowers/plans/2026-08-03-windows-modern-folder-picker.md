# Windows Modern Folder Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the legacy Windows folder tree with a modern Explorer-style `IFileOpenDialog` that remains above all other windows while open.

**Architecture:** Preserve the public Node folder-picker interface and PowerShell process boundary. Replace only the Windows inline script with a dependency-free C# COM interop wrapper plus a hidden topmost WinForms owner, while leaving macOS, Linux, API, and client contracts unchanged.

**Tech Stack:** Node.js ESM, Windows PowerShell STA, C# COM interop, WinForms owner window, Vitest.

## Global Constraints

- Windows uses native `IFileOpenDialog` with `FOS_PICKFOLDERS`.
- The Windows dialog is owned by a hidden `TopMost` WinForms window and remains in the topmost z-order group until closed.
- The picker supports the modern Explorer address bar, search, Quick Access, and drive navigation.
- Only existing filesystem folders can be selected.
- Selected paths are emitted as UTF-8 and preserve Korean and other non-ASCII characters.
- Native cancel remains `FOLDER_SELECTION_CANCELLED`; unexpected native failures remain `FOLDER_PICKER_FAILED`.
- macOS `osascript` and Linux `zenity`/`kdialog` behavior do not change.
- No npm dependency, Windows API Code Pack, Electron shell, or client/API contract is added.
- Automated tests inject `runCommand` and never open a real native dialog.

---

## File Map

- Modify `server/folderPicker.js`: replace the Windows `FolderBrowserDialog` script with modern COM interop and topmost ownership.
- Modify `server/folderPicker.test.js`: assert the modern dialog contract, owner lifecycle, UTF-8 output, and removal of the legacy picker.
- Modify `README.md`: document the Windows Common Item Dialog implementation.

### Task 1: Modern Topmost Windows Folder Picker

**Files:**
- Modify: `server/folderPicker.test.js`
- Modify: `server/folderPicker.js`

**Interfaces:**
- Consumes: existing `chooseFolder({ prompt, platform, runCommand, env }): Promise<string>`.
- Produces: unchanged Node interface and picker error contract.
- Native C# entry point: `ModernFolderPicker.PickFolder(IntPtr ownerHandle, string title): string | null`.

- [ ] **Step 1: Replace the legacy Windows command test with a failing modern-dialog test**

Replace the test named `uses an STA PowerShell FolderBrowserDialog and passes the prompt through env` with:

```js
test("uses a modern Windows IFileOpenDialog and passes the prompt through env", async () => {
  const runCommand = vi.fn().mockResolvedValue({ stdout: "C:\\\\Fiber data 한글\r\n", stderr: "" });

  await expect(chooseFolder({
    prompt: "Choose heatmap batch folder",
    platform: "win32",
    runCommand,
    env: { PATH: "C:\\\\Windows" },
  })).resolves.toBe("C:\\\\Fiber data 한글");

  expect(runCommand).toHaveBeenCalledWith(
    "powershell.exe",
    ["-NoProfile", "-STA", "-Command", expect.any(String)],
    expect.objectContaining({
      encoding: "utf8",
      windowsHide: true,
      env: expect.objectContaining({ FOLDER_PICKER_PROMPT: "Choose heatmap batch folder" }),
    }),
  );

  const script = runCommand.mock.calls[0][1][3];
  expect(script).toContain("interface IFileOpenDialog");
  expect(script).toContain("FOS_PICKFOLDERS");
  expect(script).toContain("FOS_FORCEFILESYSTEM");
  expect(script).toContain("FOS_PATHMUSTEXIST");
  expect(script).toContain("FOS_NOCHANGEDIR");
  expect(script).toContain("SIGDN_FILESYSPATH");
  expect(script).not.toContain("FolderBrowserDialog");
});
```

- [ ] **Step 2: Add a failing topmost-owner lifecycle test**

Add this adjacent Windows test:

```js
test("owns the Windows picker with a hidden topmost form and always disposes it", async () => {
  const runCommand = vi.fn().mockResolvedValue({ stdout: "C:\\\\data", stderr: "" });

  await chooseFolder({ platform: "win32", runCommand, env: {} });

  const script = runCommand.mock.calls[0][1][3];
  expect(script).toContain("$owner.TopMost = $true");
  expect(script).toContain("$owner.ShowInTaskbar = $false");
  expect(script).toContain("$owner.Opacity = 0");
  expect(script).toContain("$owner.Show()");
  expect(script).toContain("PickFolder($owner.Handle");
  expect(script).toMatch(/finally\s*\{[\s\S]*\$owner\.Close\(\)[\s\S]*\$owner\.Dispose\(\)/);
});
```

Keep the existing UTF-8 test and empty-output cancellation test unchanged.

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
npx vitest run server/folderPicker.test.js -t "modern Windows|topmost form"
```

Expected: both tests FAIL because the current script contains `FolderBrowserDialog`, does not declare `IFileOpenDialog`, and does not create a topmost owner.

- [ ] **Step 4: Replace `WINDOWS_SCRIPT` with the modern COM implementation**

Replace only the `WINDOWS_SCRIPT` constant in `server/folderPicker.js` with this complete script:

```js
const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[Flags]
internal enum FileOpenOptions : uint
{
    FOS_NOCHANGEDIR = 0x00000008,
    FOS_PICKFOLDERS = 0x00000020,
    FOS_FORCEFILESYSTEM = 0x00000040,
    FOS_PATHMUSTEXIST = 0x00000800
}

internal enum ShellDisplayName : uint
{
    SIGDN_FILESYSPATH = 0x80058000
}

[ComImport]
[Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
internal class FileOpenDialogComObject
{
}

[ComImport]
[Guid("D57C7288-D4AD-4768-BE02-9D969532D960")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IFileOpenDialog
{
    [PreserveSig]
    int Show(IntPtr owner);

    void SetFileTypes(uint count, IntPtr filterSpec);
    void SetFileTypeIndex(uint index);
    void GetFileTypeIndex(out uint index);
    void Advise(IntPtr events, out uint cookie);
    void Unadvise(uint cookie);
    void SetOptions(FileOpenOptions options);
    void GetOptions(out FileOpenOptions options);
    void SetDefaultFolder(IShellItem shellItem);
    void SetFolder(IShellItem shellItem);
    void GetFolder(out IShellItem shellItem);
    void GetCurrentSelection(out IShellItem shellItem);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void GetResult(out IShellItem shellItem);
    void AddPlace(IShellItem shellItem, int alignment);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
    void Close(int result);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr filter);
    void GetResults(out IntPtr shellItems);
    void GetSelectedItems(out IntPtr shellItems);
}

[ComImport]
[Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IShellItem
{
    void BindToHandler(IntPtr bindContext, ref Guid handler, ref Guid interfaceId, out IntPtr result);
    void GetParent(out IShellItem parent);
    void GetDisplayName(ShellDisplayName displayName, out IntPtr name);
    void GetAttributes(uint mask, out uint attributes);
    void Compare(IShellItem other, uint hint, out int order);
}

public static class ModernFolderPicker
{
    private const int ErrorCancelledHResult = unchecked((int)0x800704C7);

    public static string PickFolder(IntPtr ownerHandle, string title)
    {
        IFileOpenDialog dialog = null;
        IShellItem selectedItem = null;
        IntPtr pathPointer = IntPtr.Zero;

        try
        {
            dialog = (IFileOpenDialog)new FileOpenDialogComObject();

            FileOpenOptions options;
            dialog.GetOptions(out options);
            dialog.SetOptions(
                options
                | FileOpenOptions.FOS_PICKFOLDERS
                | FileOpenOptions.FOS_FORCEFILESYSTEM
                | FileOpenOptions.FOS_PATHMUSTEXIST
                | FileOpenOptions.FOS_NOCHANGEDIR
            );

            if (!String.IsNullOrWhiteSpace(title))
            {
                dialog.SetTitle(title);
            }

            int result = dialog.Show(ownerHandle);
            if (result == ErrorCancelledHResult)
            {
                return null;
            }

            Marshal.ThrowExceptionForHR(result);
            dialog.GetResult(out selectedItem);
            selectedItem.GetDisplayName(ShellDisplayName.SIGDN_FILESYSPATH, out pathPointer);
            return Marshal.PtrToStringUni(pathPointer);
        }
        finally
        {
            if (pathPointer != IntPtr.Zero)
            {
                Marshal.FreeCoTaskMem(pathPointer);
            }

            if (selectedItem != null)
            {
                Marshal.FinalReleaseComObject(selectedItem);
            }

            if (dialog != null)
            {
                Marshal.FinalReleaseComObject(dialog);
            }
        }
    }
}
'@

$owner = $null
$selectedPath = $null
$pickerFailure = $null

try {
  $owner = New-Object System.Windows.Forms.Form
  $owner.TopMost = $true
  $owner.ShowInTaskbar = $false
  $owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedToolWindow
  $owner.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
  $owner.Location = New-Object System.Drawing.Point(-32000, -32000)
  $owner.Size = New-Object System.Drawing.Size(1, 1)
  $owner.Opacity = 0
  $owner.Show()
  $owner.Activate()

  $selectedPath = [ModernFolderPicker]::PickFolder(
    $owner.Handle,
    $env:FOLDER_PICKER_PROMPT
  )
} catch {
  $pickerFailure = $_.Exception
} finally {
  if ($null -ne $owner) {
    $owner.Close()
    $owner.Dispose()
  }
}

if ($null -ne $pickerFailure) {
  [Console]::Error.Write($pickerFailure.Message)
  exit 2
}

if ([String]::IsNullOrWhiteSpace($selectedPath)) {
  exit 1
}

[Console]::Out.Write($selectedPath)
exit 0
`;
```

Do not change `chooseWithPowerShell`: it must continue to run `powershell.exe` with `-NoProfile`, `-STA`, and UTF-8 decoding, pass the prompt through `FOLDER_PICKER_PROMPT`, classify silent exit code `1` as cancellation, and classify diagnostic failures as `FOLDER_PICKER_FAILED`.

- [ ] **Step 5: Run focused Windows picker tests and verify GREEN**

Run:

```bash
npx vitest run server/folderPicker.test.js
```

Expected: all folder-picker tests PASS; no native dialog opens.

- [ ] **Step 6: Run server integration tests**

Run:

```bash
npx vitest run server/app.test.js server/folderPicker.test.js
```

Expected: picker API mapping, path redaction, cancellation, and platform adapter tests PASS.

- [ ] **Step 7: Commit the implementation**

```bash
git add server/folderPicker.js server/folderPicker.test.js
git commit -m "feat: use modern topmost Windows folder picker"
```

### Task 2: Documentation And Final Verification

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: completed modern Windows picker behavior from Task 1.
- Produces: accurate platform documentation and final verification evidence.

- [ ] **Step 1: Update Windows picker documentation**

Replace this README line:

```markdown
- Windows: PowerShell `System.Windows.Forms.FolderBrowserDialog`;
```

with:

```markdown
- Windows: PowerShell with the modern Windows Common Item Dialog (`IFileOpenDialog`);
```

Do not change the macOS, Linux, direct-path, or `BOUND_EDITOR_ROOT` instructions.

- [ ] **Step 2: Run the complete automated suite**

Run:

```bash
npm test -- --exclude '.worktrees/**'
```

Expected: all test files PASS and no native folder dialog opens.

- [ ] **Step 3: Build the production client**

Run:

```bash
npm run build
```

Expected: Vite exits `0` and writes the production bundle to `dist/`.

- [ ] **Step 4: Inspect the final scope**

Run:

```bash
git diff --check
git status --short
git diff main...HEAD -- README.md server/folderPicker.js server/folderPicker.test.js
```

Expected: no whitespace errors, no dependency changes, no macOS/Linux implementation changes, and only the planned Windows picker, tests, design/plan docs, and README changes.

- [ ] **Step 5: Commit the documentation**

```bash
git add README.md
git commit -m "docs: describe modern Windows folder picker"
```

- [ ] **Step 6: Perform Windows acceptance verification after integration**

On the Windows clone, stop the old server, update the integrated branch, and restart:

```powershell
Stop-Process -Id 25572 -ErrorAction SilentlyContinue
git pull --ff-only origin main
npm ci
npm run build
npm run server
```

At `http://localhost:3000`, verify:

1. `Find root` opens the modern Explorer-style dialog rather than the old tree dialog.
2. The dialog appears above the browser and remains above other windows while open.
3. Address bar, search, Quick Access, and drive navigation are present.
4. Selecting a valid root loads its ordered images.
5. Cancelling returns the normal cancellation message.
6. A selected path containing Korean characters is preserved.
