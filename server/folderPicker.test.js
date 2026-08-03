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

  test("uses an STA PowerShell FolderBrowserDialog and passes the prompt through env", async () => {
    const runCommand = vi.fn().mockResolvedValue({ stdout: "C:\\\\Fiber data 한글\r\n", stderr: "" });

    await expect(chooseFolder({
      prompt: "Choose heatmap batch folder",
      platform: "win32",
      runCommand,
      env: { PATH: "C:\\\\Windows" },
    })).resolves.toBe("C:\\\\Fiber data 한글");

    expect(runCommand).toHaveBeenCalledWith(
      "powershell.exe",
      ["-NoProfile", "-STA", "-Command", expect.stringContaining("FolderBrowserDialog")],
      expect.objectContaining({
        encoding: "utf8",
        windowsHide: true,
        env: expect.objectContaining({ FOLDER_PICKER_PROMPT: "Choose heatmap batch folder" }),
      }),
    );
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
