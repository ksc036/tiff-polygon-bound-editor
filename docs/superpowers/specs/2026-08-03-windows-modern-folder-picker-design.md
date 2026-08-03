# Windows Modern Folder Picker Design

## Goal

Replace the old tree-style Windows `FolderBrowserDialog` with the modern
Explorer-style Windows Common Item Dialog and keep that dialog above all other
application windows until the user selects a folder or cancels.

## Confirmed Behavior

- Windows uses the native `IFileOpenDialog` COM API in folder-selection mode.
- The dialog shows the current Windows Explorer-style interface, including the
  address bar, search, Quick Access, and normal drive navigation.
- The dialog receives a hidden `TopMost` WinForms owner window, so it does not
  open behind the browser or another application.
- Only filesystem folders can be selected.
- Selecting a folder returns one absolute path through stdout as UTF-8.
- Cancelling remains a normal `FOLDER_SELECTION_CANCELLED` result.
- macOS AppleScript and Linux `zenity`/`kdialog` behavior do not change.
- No npm package, Electron shell, or Windows API Code Pack dependency is added.

## Architecture

Keep the public `chooseFolder({ prompt, platform, runCommand, env })` interface
and the existing `powershell.exe -NoProfile -STA -Command` invocation. Replace
only the body of the Windows PowerShell script in `server/folderPicker.js`.

The PowerShell script compiles a small C# interop type with `Add-Type`. The C#
type owns the COM declarations for `IFileDialog`, `IFileOpenDialog`,
`IShellItem`, and the `FileOpenDialog` coclass. It exposes one method:

```csharp
public static string PickFolder(IntPtr ownerHandle, string title)
```

`PickFolder` performs this sequence:

1. Create the native `FileOpenDialog` COM object.
2. Read its existing options.
3. add `FOS_PICKFOLDERS`, `FOS_FORCEFILESYSTEM`, `FOS_PATHMUSTEXIST`, and
   `FOS_NOCHANGEDIR`.
4. Set the title from `FOLDER_PICKER_PROMPT`.
5. Show the dialog with the supplied owner handle.
6. Return `null` for HRESULT `0x800704C7` (`ERROR_CANCELLED`).
7. Throw for any other failed HRESULT.
8. Read the selected item with `SIGDN_FILESYSPATH` and return its absolute
   filesystem path.
9. Release COM objects and unmanaged path memory in `finally` blocks.

The existing Node adapter still treats empty successful output or PowerShell
exit code `1` without diagnostics as cancellation. Unexpected COM or PowerShell
errors continue to map to `FOLDER_PICKER_FAILED` without leaking native details
through the API.

## Topmost Ownership

Before opening `IFileOpenDialog`, PowerShell creates a minimal WinForms owner:

```powershell
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedToolWindow
$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$owner.Location = New-Object System.Drawing.Point(-32000, -32000)
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Opacity = 0
$owner.Show()
```

The picker is opened with `$owner.Handle`. Because the native dialog is owned by
a topmost window, Windows keeps it in the topmost z-order group while it is
open. The owner itself is invisible, off-screen, and absent from the taskbar.

Owner cleanup is mandatory:

```powershell
try {
  $selectedPath = [ModernFolderPicker]::PickFolder($owner.Handle, $env:FOLDER_PICKER_PROMPT)
} finally {
  $owner.Close()
  $owner.Dispose()
}
```

The script writes the selected path and exits `0`. A `null` or empty result exits
`1` without stderr, preserving the existing cancellation contract.

## Error And Resource Handling

- `[Console]::OutputEncoding` remains explicitly UTF-8 before path output.
- `Marshal.ThrowExceptionForHR` handles unexpected native failures.
- `Marshal.FreeCoTaskMem` frees the path returned by `IShellItem`.
- `Marshal.FinalReleaseComObject` releases the selected shell item and dialog.
- The hidden owner is closed and disposed in a PowerShell `finally` block.
- API responses continue to use the existing safe status and message mapping.

## Testing

Automated tests continue to inject `runCommand` and never open a real dialog.
The Windows command test will assert that the generated PowerShell script:

- declares and creates `IFileOpenDialog`;
- enables `FOS_PICKFOLDERS` and filesystem-only selection;
- passes a hidden `TopMost` owner handle to the native dialog;
- closes and disposes the owner in `finally`;
- configures UTF-8 output;
- no longer references `FolderBrowserDialog`.

Existing cancellation, Unicode-path, macOS, Linux, API, client, and build tests
must remain green.

Manual Windows acceptance checks:

1. `Find root` opens the Windows 10/11 Explorer-style picker.
2. The picker appears in front of the browser and remains above other windows.
3. Address-bar, search, Quick Access, and drive navigation work.
4. Selecting a folder loads the image root.
5. Cancelling produces the normal cancellation message.
6. A path containing Korean characters is returned unchanged.

## Alternatives Considered

### Keep `FolderBrowserDialog` And Enable Visual Styles

Rejected because Windows PowerShell and .NET Framework can still render the old
tree-style dialog. Visual styles do not reliably switch it to the Common Item
Dialog.

### Use The Current Foreground Window As Owner

Rejected because focus can change while PowerShell starts. The resulting dialog
can still open behind another window.

### Call `SetForegroundWindow` After Opening

Rejected because it introduces a timing race and Windows foreground-activation
restrictions. A topmost owner establishes the correct relationship before the
dialog is shown.

## Out Of Scope

- Changing macOS or Linux folder-picker behavior;
- selecting files instead of folders;
- remembering the last Windows picker directory;
- installing Windows API Code Pack or another native dependency;
- changing the API or client request contract.
