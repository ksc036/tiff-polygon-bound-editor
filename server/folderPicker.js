import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const FOLDER_PICKER_CODES = Object.freeze({
  CANCELLED: "FOLDER_SELECTION_CANCELLED",
  UNAVAILABLE: "FOLDER_PICKER_UNAVAILABLE",
  FAILED: "FOLDER_PICKER_FAILED",
});

export class FolderPickerError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "FolderPickerError";
    this.code = code;
  }
}

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

  $selectedPath = [ModernFolderPicker]::PickFolder($owner.Handle,
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

function selectedPath(stdout) {
  return String(stdout ?? "").replace(/[\r\n]+$/, "");
}

function pickerError(code, message, cause) {
  return new FolderPickerError(code, message, { cause });
}

function isMissingCommand(error) {
  return error?.code === "ENOENT";
}

function isDisplayFailure(error) {
  return /cannot open display|failed to open display|could not connect to display|qt\.qpa/i.test(
    `${error?.stderr ?? ""}\n${error?.message ?? ""}`,
  );
}

function cancelled(cause) {
  return pickerError(FOLDER_PICKER_CODES.CANCELLED, "Folder selection was cancelled.", cause);
}

function unavailable(cause) {
  return pickerError(FOLDER_PICKER_CODES.UNAVAILABLE, "Folder picker is unavailable.", cause);
}

function failed(cause) {
  return pickerError(FOLDER_PICKER_CODES.FAILED, "Folder picker failed.", cause);
}

function requireSelectedPath(stdout) {
  const value = selectedPath(stdout);
  if (!value) throw cancelled();
  return value;
}

async function chooseWithAppleScript({ prompt, runCommand, env }) {
  try {
    const { stdout } = await runCommand(
      "osascript",
      ["-e", `POSIX path of (choose folder with prompt ${JSON.stringify(prompt)})`],
      { encoding: "utf8", env },
    );
    return requireSelectedPath(stdout);
  } catch (error) {
    if (error instanceof FolderPickerError) throw error;
    if (isMissingCommand(error)) throw unavailable(error);
    if (/user canceled|\(-128\)/i.test(`${error?.stderr ?? ""}\n${error?.message ?? ""}`)) {
      throw cancelled(error);
    }
    throw failed(error);
  }
}

async function chooseWithPowerShell({ prompt, runCommand, env }) {
  try {
    const { stdout } = await runCommand(
      "powershell.exe",
      ["-NoProfile", "-STA", "-Command", WINDOWS_SCRIPT],
      {
        encoding: "utf8",
        windowsHide: true,
        env: { ...env, FOLDER_PICKER_PROMPT: prompt },
      },
    );
    return requireSelectedPath(stdout);
  } catch (error) {
    if (error instanceof FolderPickerError) throw error;
    if (isMissingCommand(error)) throw unavailable(error);
    if (error?.code === 1 && !String(error?.stderr ?? "").trim()) throw cancelled(error);
    throw failed(error);
  }
}

async function runLinuxDialog({ command, args, runCommand, env }) {
  try {
    const { stdout } = await runCommand(command, args, { encoding: "utf8", env });
    return requireSelectedPath(stdout);
  } catch (error) {
    if (error instanceof FolderPickerError || isMissingCommand(error)) throw error;
    if (isDisplayFailure(error)) throw unavailable(error);
    if (error?.code === 1 && !String(error?.stderr ?? "").trim()) throw cancelled(error);
    throw failed(error);
  }
}

async function chooseWithLinuxDialog({ prompt, runCommand, env }) {
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) throw unavailable();

  try {
    return await runLinuxDialog({
      command: "zenity",
      args: ["--file-selection", "--directory", "--title", prompt],
      runCommand,
      env,
    });
  } catch (error) {
    if (!isMissingCommand(error)) throw error;
  }

  try {
    return await runLinuxDialog({
      command: "kdialog",
      args: ["--getexistingdirectory", ".", "--title", prompt],
      runCommand,
      env,
    });
  } catch (error) {
    if (isMissingCommand(error)) throw unavailable(error);
    throw error;
  }
}

export async function chooseFolder({
  prompt = "Choose folder",
  platform = process.platform,
  runCommand = execFileAsync,
  env = process.env,
} = {}) {
  if (platform === "darwin") return chooseWithAppleScript({ prompt, runCommand, env });
  if (platform === "win32") return chooseWithPowerShell({ prompt, runCommand, env });
  if (platform === "linux") return chooseWithLinuxDialog({ prompt, runCommand, env });
  throw unavailable();
}
