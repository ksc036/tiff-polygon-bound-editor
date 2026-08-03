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
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = $env:FOLDER_PICKER_PROMPT
$dialog.ShowNewFolderButton = $true
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dialog.SelectedPath)
  exit 0
}
exit 1
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
