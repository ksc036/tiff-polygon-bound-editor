import { describe, expect, test, vi } from "vitest";
import {
  FOLDER_PICKER_CODES,
  FolderPickerError,
  chooseFolder,
} from "./folderPicker.js";

describe("chooseFolder", () => {
  test("uses AppleScript on macOS and preserves spaces and Unicode in the path", async () => {
    const runCommand = vi.fn().mockResolvedValue({
      stdout: "/Users/test/Fiber data 한글\n",
      stderr: "",
    });

    await expect(chooseFolder({
      prompt: "Choose image sequence root folder",
      platform: "darwin",
      runCommand,
    })).resolves.toBe("/Users/test/Fiber data 한글");

    expect(runCommand).toHaveBeenCalledWith(
      "osascript",
      ["-e", expect.stringContaining("choose folder with prompt")],
      expect.objectContaining({ encoding: "utf8" }),
    );
  });

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
    expect(script).toMatch(
      /\[Guid\("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7"\)\]\s*internal class FileOpenDialogComObject/,
    );
    expect(script).toMatch(
      /\[Guid\("D57C7288-D4AD-4768-BE02-9D969532D960"\)\]\s*\[InterfaceType\(ComInterfaceType\.InterfaceIsIUnknown\)\]\s*internal interface IFileOpenDialog/,
    );
    expect(script).toMatch(
      /\[Guid\("43826D1E-E718-42EE-BC55-A1E261C37BFE"\)\]\s*\[InterfaceType\(ComInterfaceType\.InterfaceIsIUnknown\)\]\s*internal interface IShellItem/,
    );

    const fileOpenDialogBody = script.match(
      /internal interface IFileOpenDialog\s*\{([\s\S]*?)\n\}/,
    )?.[1];
    expect(fileOpenDialogBody).toBeDefined();
    expect(fileOpenDialogBody.split("\n").map((line) => line.trim()).filter(Boolean)).toEqual([
      "[PreserveSig]",
      "int Show(IntPtr owner);",
      "void SetFileTypes(uint count, IntPtr filterSpec);",
      "void SetFileTypeIndex(uint index);",
      "void GetFileTypeIndex(out uint index);",
      "void Advise(IntPtr events, out uint cookie);",
      "void Unadvise(uint cookie);",
      "void SetOptions(FileOpenOptions options);",
      "void GetOptions(out FileOpenOptions options);",
      "void SetDefaultFolder(IShellItem shellItem);",
      "void SetFolder(IShellItem shellItem);",
      "void GetFolder(out IShellItem shellItem);",
      "void GetCurrentSelection(out IShellItem shellItem);",
      "void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);",
      "void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);",
      "void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);",
      "void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);",
      "void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);",
      "void GetResult(out IShellItem shellItem);",
      "void AddPlace(IShellItem shellItem, int alignment);",
      "void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);",
      "void Close(int result);",
      "void SetClientGuid(ref Guid guid);",
      "void ClearClientData();",
      "void SetFilter(IntPtr filter);",
      "void GetResults(out IntPtr shellItems);",
      "void GetSelectedItems(out IntPtr shellItems);",
    ]);

    const optionsCall = script.match(/dialog\.SetOptions\(\s*([\s\S]*?)\s*\);/)?.[1];
    expect(optionsCall?.replace(/\s+/g, "")).toBe(
      "options|FileOpenOptions.FOS_PICKFOLDERS|FileOpenOptions.FOS_FORCEFILESYSTEM"
      + "|FileOpenOptions.FOS_PATHMUSTEXIST|FileOpenOptions.FOS_NOCHANGEDIR",
    );

    const resultHandling = script.slice(
      script.indexOf("int result;"),
      script.indexOf("dialog.GetResult(out selectedItem);"),
    );
    expect(resultHandling).toMatch(
      /int result;[\s\S]*using \(TopmostDialogGuard topmostGuard = new TopmostDialogGuard\(ownerHandle\)\)[\s\S]*result = dialog\.Show\(ownerHandle\);[\s\S]*if \(result == ErrorCancelledHResult\)[\s\S]*return null;[\s\S]*Marshal\.ThrowExceptionForHR\(result\);/,
    );

    const nativeFinallyStart = script.indexOf(
      "        finally\n        {",
      script.indexOf("public static string PickFolder"),
    );
    const nativeFinallyEnd = script.indexOf("\n        }\n    }\n}\n'@", nativeFinallyStart);
    expect(nativeFinallyStart).toBeGreaterThan(-1);
    expect(nativeFinallyEnd).toBeGreaterThan(nativeFinallyStart);

    const nativeFinally = script.slice(nativeFinallyStart, nativeFinallyEnd);
    expect(nativeFinally).toMatch(
      /if \(pathPointer != IntPtr\.Zero\)[\s\S]*Marshal\.FreeCoTaskMem\(pathPointer\);[\s\S]*if \(selectedItem != null\)[\s\S]*Marshal\.FinalReleaseComObject\(selectedItem\);[\s\S]*if \(dialog != null\)[\s\S]*Marshal\.FinalReleaseComObject\(dialog\);/,
    );
    expect(script).toContain("SIGDN_FILESYSPATH");
    expect(script).not.toContain("FolderBrowserDialog");
  });

  test("owns the Windows picker with a hidden topmost form and always disposes it", async () => {
    const runCommand = vi.fn().mockResolvedValue({ stdout: "C:\\\\data", stderr: "" });

    await chooseFolder({ platform: "win32", runCommand, env: {} });

    const script = runCommand.mock.calls[0][1][3];
    expect(script).toContain("$owner.TopMost = $true");
    expect(script).toContain("$owner.ShowInTaskbar = $false");
    expect(script).toContain("$owner.Opacity = 0");
    expect(script).toContain(
      "$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen",
    );
    expect(script).not.toContain("System.Drawing.Point(-32000, -32000)");
    expect(script).toContain("$owner.Show()");
    expect(script).toContain("PickFolder($owner.Handle");

    const ownerScript = script.slice(script.indexOf("$owner = $null"));
    const ownerFinallyStart = ownerScript.indexOf("} finally {");
    const closeIndex = ownerScript.indexOf("$owner.Close()", ownerFinallyStart);
    const disposeIndex = ownerScript.indexOf("$owner.Dispose()", ownerFinallyStart);
    const failureCheckIndex = ownerScript.indexOf("if ($null -ne $pickerFailure)");

    expect(ownerFinallyStart).toBeGreaterThan(-1);
    expect(closeIndex).toBeGreaterThan(ownerFinallyStart);
    expect(disposeIndex).toBeGreaterThan(closeIndex);
    expect(failureCheckIndex).toBeGreaterThan(disposeIndex);

    const ownerCleanup = ownerScript.slice(ownerFinallyStart, failureCheckIndex);
    expect(ownerCleanup).toMatch(
      /^\} finally \{[\s\S]*if \(\$null -ne \$owner\) \{[\s\S]*\$owner\.Close\(\)[\s\S]*\$owner\.Dispose\(\)[\s\S]*\}\s*\}\s*$/,
    );
  });

  test("promotes the actual Windows picker above other applications", async () => {
    const runCommand = vi.fn().mockResolvedValue({ stdout: "C:\\\\data", stderr: "" });

    await chooseFolder({ platform: "win32", runCommand, env: {} });

    const script = runCommand.mock.calls[0][1][3];
    expect(script).toContain(
      "Add-Type -ReferencedAssemblies System.Windows.Forms.dll -TypeDefinition @'",
    );
    expect(script).toContain("internal sealed class TopmostDialogGuard");
    expect(script).toContain("private const uint GaRootOwner = 3;");
    expect(script).toContain("private const uint SwpNoSize = 0x0001;");
    expect(script).toContain("private const uint SwpNoMove = 0x0002;");
    expect(script).toContain("private const uint SwpNoActivate = 0x0010;");
    expect(script).toContain("private const uint SwpShowWindow = 0x0040;");
    expect(script).toContain("private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);");
    expect(script).toMatch(
      /\[DllImport\("user32\.dll"\)\][\s\S]*bool EnumWindows\(EnumWindowsProc callback, IntPtr parameter\);/,
    );
    expect(script).toMatch(
      /\[DllImport\("user32\.dll"\)\][\s\S]*IntPtr GetAncestor\(IntPtr windowHandle, uint flags\);/,
    );
    expect(script).toMatch(
      /EnumWindows\(findOwnedDialog, IntPtr\.Zero\);/,
    );
    expect(script).toMatch(
      /candidate != ownerHandle[\s\S]*IsWindowVisible\(candidate\)[\s\S]*GetAncestor\(candidate, GaRootOwner\) == ownerHandle/,
    );
    expect(script).toMatch(
      /private readonly System\.Windows\.Forms\.Timer timer;[\s\S]*timer = new System\.Windows\.Forms\.Timer\(\);[\s\S]*timer\.Tick \+= PromoteOwnedDialog;[\s\S]*timer\.Start\(\);/,
    );
    expect(script).toMatch(
      /SetWindowPos\(dialogHandle, HWND_TOPMOST,[\s\S]*SwpShowWindow\);[\s\S]*SetForegroundWindow\(dialogHandle\);/,
    );
    const dialogPromotionFlags = script.match(
      /bool elevated = SetWindowPos\(dialogHandle, HWND_TOPMOST, 0, 0, 0, 0,\s*([\s\S]*?)\);/,
    )?.[1];
    expect(dialogPromotionFlags?.replace(/\s+/g, "")).toBe(
      "SwpNoSize|SwpNoMove|SwpShowWindow",
    );
    expect(script).toMatch(
      /public void Dispose\(\)[\s\S]*timer\.Stop\(\);[\s\S]*timer\.Tick -= PromoteOwnedDialog;[\s\S]*timer\.Dispose\(\);/,
    );
    expect(script).not.toContain("System.Threading.Timer");
    expect(script).not.toContain("SwpAsyncWindowPos");

    const showStart = script.indexOf("using (TopmostDialogGuard topmostGuard");
    const showCall = script.indexOf("dialog.Show(ownerHandle)", showStart);
    expect(showStart).toBeGreaterThan(-1);
    expect(showCall).toBeGreaterThan(showStart);
  });

  test("configures PowerShell stdout as UTF-8 before returning the selected path", async () => {
    const runCommand = vi.fn().mockResolvedValue({ stdout: "C:\\\\Fiber data 한글", stderr: "" });

    await chooseFolder({ platform: "win32", runCommand, env: {} });

    expect(runCommand).toHaveBeenCalledWith(
      "powershell.exe",
      [
        "-NoProfile",
        "-STA",
        "-Command",
        expect.stringContaining(
          "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
        ),
      ],
      expect.any(Object),
    );
  });

  test("uses zenity in a Linux graphical session", async () => {
    const runCommand = vi.fn().mockResolvedValue({ stdout: "/data/root\n", stderr: "" });

    await expect(chooseFolder({
      prompt: "Choose root",
      platform: "linux",
      runCommand,
      env: { DISPLAY: ":0" },
    })).resolves.toBe("/data/root");

    expect(runCommand).toHaveBeenCalledWith(
      "zenity",
      ["--file-selection", "--directory", "--title", "Choose root"],
      expect.objectContaining({ encoding: "utf8" }),
    );
  });

  test("falls back to kdialog only when zenity is unavailable", async () => {
    const missingZenity = Object.assign(new Error("spawn zenity ENOENT"), { code: "ENOENT" });
    const runCommand = vi.fn()
      .mockRejectedValueOnce(missingZenity)
      .mockResolvedValueOnce({ stdout: "/data/fallback\n", stderr: "" });

    await expect(chooseFolder({
      prompt: "Choose root",
      platform: "linux",
      runCommand,
      env: { WAYLAND_DISPLAY: "wayland-0" },
    })).resolves.toBe("/data/fallback");

    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      "kdialog",
      ["--getexistingdirectory", ".", "--title", "Choose root"],
      expect.objectContaining({ encoding: "utf8" }),
    );
  });

  test("maps native cancellation to FOLDER_SELECTION_CANCELLED", async () => {
    const cancelled = Object.assign(new Error("execution error: User canceled. (-128)"), {
      code: 1,
      stderr: "execution error: User canceled. (-128)",
    });

    await expect(chooseFolder({ platform: "darwin", runCommand: vi.fn().mockRejectedValue(cancelled) }))
      .rejects.toMatchObject({ code: FOLDER_PICKER_CODES.CANCELLED });
  });

  test("maps a Linux dialog exit code 1 with no diagnostics to cancellation", async () => {
    const cancelled = Object.assign(new Error("Command failed"), { code: 1, stderr: "" });

    await expect(chooseFolder({
      platform: "linux",
      runCommand: vi.fn().mockRejectedValue(cancelled),
      env: { DISPLAY: ":0" },
    })).rejects.toMatchObject({ code: FOLDER_PICKER_CODES.CANCELLED });
  });

  test("reports unavailable when Linux has no graphical session", async () => {
    const runCommand = vi.fn();

    await expect(chooseFolder({ platform: "linux", runCommand, env: {} }))
      .rejects.toMatchObject({ code: FOLDER_PICKER_CODES.UNAVAILABLE });
    expect(runCommand).not.toHaveBeenCalled();
  });

  test("reports unavailable when both Linux dialog commands are missing", async () => {
    const missingCommand = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });

    await expect(chooseFolder({
      platform: "linux",
      runCommand: vi.fn().mockRejectedValue(missingCommand),
      env: { DISPLAY: ":0" },
    })).rejects.toMatchObject({ code: FOLDER_PICKER_CODES.UNAVAILABLE });
  });

  test("maps Linux display connection failures to unavailable", async () => {
    const displayFailure = Object.assign(new Error("Command failed"), {
      code: 1,
      stderr: "Gtk-WARNING **: cannot open display: :0",
    });

    await expect(chooseFolder({
      platform: "linux",
      runCommand: vi.fn().mockRejectedValue(displayFailure),
      env: { DISPLAY: ":0" },
    })).rejects.toMatchObject({ code: FOLDER_PICKER_CODES.UNAVAILABLE });
  });

  test("maps message-only Linux display failures to unavailable", async () => {
    const displayFailure = Object.assign(new Error("Failed to open display :0"), {
      code: 1,
      stderr: "",
    });

    await expect(chooseFolder({
      platform: "linux",
      runCommand: vi.fn().mockRejectedValue(displayFailure),
      env: { DISPLAY: ":0" },
    })).rejects.toMatchObject({ code: FOLDER_PICKER_CODES.UNAVAILABLE });
  });

  test("maps an empty successful Windows result to cancellation", async () => {
    await expect(chooseFolder({
      platform: "win32",
      runCommand: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
      env: {},
    })).rejects.toMatchObject({ code: FOLDER_PICKER_CODES.CANCELLED });
  });

  test("does not fall back to kdialog after an unexpected zenity failure", async () => {
    const failed = Object.assign(new Error("zenity crashed"), { code: 2, stderr: "native detail" });
    const runCommand = vi.fn().mockRejectedValue(failed);

    await expect(chooseFolder({
      platform: "linux",
      runCommand,
      env: { DISPLAY: ":0" },
    })).rejects.toMatchObject({ code: FOLDER_PICKER_CODES.FAILED });
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  test("reports unsupported platforms as unavailable", async () => {
    await expect(chooseFolder({ platform: "aix", runCommand: vi.fn() }))
      .rejects.toBeInstanceOf(FolderPickerError);
    await expect(chooseFolder({ platform: "aix", runCommand: vi.fn() }))
      .rejects.toMatchObject({ code: FOLDER_PICKER_CODES.UNAVAILABLE });
  });
});
