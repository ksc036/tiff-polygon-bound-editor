# Cross-Platform Folder Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make both folder-selection workflows work on macOS, Windows, and Linux while preserving direct absolute-path entry as a reliable fallback.

**Architecture:** Add a focused server-side folder-picker module with one platform-neutral API and injected command execution for deterministic tests. Route handlers translate stable picker error codes into safe user-facing responses, while the Heatmap batch panel gains a controlled path input so headless or picker-less systems remain fully usable.

**Tech Stack:** Node.js ESM, `node:child_process`, Express, React 18, Vitest, Testing Library, CSS.

## Global Constraints

- macOS uses `osascript` and AppleScript `choose folder`.
- Windows uses `powershell.exe -NoProfile -STA` and `System.Windows.Forms.FolderBrowserDialog`.
- Linux tries `zenity` first and falls back to `kdialog` only when `zenity` is unavailable.
- No new npm runtime dependency is added.
- Native picker tests inject a command runner and never open a real GUI dialog.
- Picker errors use only `FOLDER_SELECTION_CANCELLED`, `FOLDER_PICKER_UNAVAILABLE`, and `FOLDER_PICKER_FAILED`.
- Selected image roots continue through the existing storage validation; folder selection must not weaken path, image, or mask validation.
- API responses must not expose raw command output, host paths, or native error details.
- Existing `Root path` plus `Set root` and `BOUND_EDITOR_ROOT` remain supported.
- Heatmap generation remains fixed to cell sizes `20`, `50`, and `100`.

---

## File Map

- Create `server/folderPicker.js`: platform detection, native command adapters, output normalization, and stable picker errors.
- Create `server/folderPicker.test.js`: OS command selection and error classification without opening native dialogs.
- Modify `server/index.js`: inject the shared `chooseFolder` function into the existing root and Heatmap callbacks.
- Modify `server/app.js`: map picker errors and invalid selected roots to distinct safe API responses.
- Modify `server/app.test.js`: verify status codes, messages, and path redaction for both selection endpoints.
- Modify `src/App.jsx`: expose the Heatmap batch root as a controlled absolute-path input and invalidate stale picker responses after manual edits.
- Modify `src/App.test.jsx`: verify picker-filled and manually typed Heatmap paths, request payloads, and stale-response protection.
- Modify `src/styles.css`: retain the compact Heatmap panel layout while styling the new input.
- Modify `README.md`: document supported platforms and manual/headless fallback behavior.

### Task 1: Platform-Neutral Native Folder Picker

**Files:**
- Create: `server/folderPicker.js`
- Create: `server/folderPicker.test.js`

**Interfaces:**
- Consumes: Node's `execFile` through a default promisified runner.
- Produces: `FOLDER_PICKER_CODES`, `FolderPickerError`, and `chooseFolder({ prompt, platform, runCommand, env }): Promise<string>`.
- `runCommand` signature: `(command: string, args: string[], options?: object) => Promise<{ stdout?: string, stderr?: string }>`.

- [ ] **Step 1: Write failing tests for macOS and Windows command construction**

Create `server/folderPicker.test.js` with the imports, a successful runner, and assertions that prompts are passed safely and selected paths are returned without changing Unicode or embedded spaces:

```js
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
});
```

- [ ] **Step 2: Run the new test file and confirm the module is missing**

Run: `npx vitest run server/folderPicker.test.js`

Expected: FAIL because `server/folderPicker.js` does not exist.

- [ ] **Step 3: Write failing Linux selection and fallback tests**

Extend the same `describe` block with:

```js
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
```

- [ ] **Step 4: Write failing error-classification tests**

Add explicit tests for every stable code and for fallback boundaries:

```js
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
```

- [ ] **Step 5: Implement the shared picker and OS adapters**

Create `server/folderPicker.js` with these public definitions and adapter rules:

```js
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
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = $env:FOLDER_PICKER_PROMPT
$dialog.ShowNewFolderButton = $true
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dialog.SelectedPath)
  exit 0
}
exit 1
`;
```

Implement these private helpers in the same file:

```js
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
```

Implement `chooseFolder` with the exact signature below. Use `encoding: "utf8"` on every command, `windowsHide: true` on PowerShell, and `{ ...env, FOLDER_PICKER_PROMPT: prompt }` for the Windows environment. Treat empty successful stdout as cancellation. On macOS, only `-128` or `User canceled` is cancellation. On Linux, exit code `1` without stderr is cancellation, display errors are unavailable, and `kdialog` is attempted only for `ENOENT` from `zenity`.

```js
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
    if (error?.code === 1 && !String(error?.stderr ?? "").trim()) throw cancelled(error);
    if (isDisplayFailure(error)) throw unavailable(error);
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
```

This keeps unsupported platforms classified as unavailable, wraps unexpected native failures as `FOLDER_PICKER_FAILED`, and preserves the original error only in `cause`.

- [ ] **Step 6: Run focused tests**

Run: `npx vitest run server/folderPicker.test.js`

Expected: all folder-picker tests PASS and no native dialog opens.

- [ ] **Step 7: Commit the picker module**

```bash
git add server/folderPicker.js server/folderPicker.test.js
git commit -m "feat: add cross-platform folder picker"
```

### Task 2: Server Wiring And Safe API Error Contract

**Files:**
- Modify: `server/index.js`
- Modify: `server/app.js`
- Modify: `server/app.test.js`

**Interfaces:**
- Consumes: `chooseFolder(options)` and `FOLDER_PICKER_CODES` from `server/folderPicker.js`.
- Produces: safe JSON errors for `POST /api/root/select` and `POST /api/heatmaps/select-folder`.

- [ ] **Step 1: Replace the generic root-selection API test with code-specific cases**

Import the constants in `server/app.test.js`:

```js
import { FOLDER_PICKER_CODES, FolderPickerError } from "./folderPicker.js";
```

Keep the existing successful selection assertion, then split failures into these tests:

```js
test.each([
  [FOLDER_PICKER_CODES.CANCELLED, 400, "Root selection was cancelled."],
  [
    FOLDER_PICKER_CODES.UNAVAILABLE,
    503,
    "Folder picker is unavailable. Enter an absolute path in Root path and press Set root.",
  ],
  [
    FOLDER_PICKER_CODES.FAILED,
    500,
    "Folder picker failed. Enter an absolute path in Root path and press Set root.",
  ],
])("maps root picker %s to a safe response", async (code, status, message) => {
  const secretPath = "/private/secret/image-root";
  const app = createApp({
    rootDir: await createTempRoot(),
    selectRoot: async () => {
      throw new FolderPickerError(code, `native failure at ${secretPath}`);
    },
  });

  const response = await jsonRequest(app, "/api/root/select", { method: "POST" });
  expect(response.status).toBe(status);
  const body = await response.json();
  expect(body).toEqual({ error: message });
  expect(JSON.stringify(body)).not.toContain(secretPath);
});
```

Add a selected-but-invalid-root test to prove storage validation remains distinct:

```js
test("reports an invalid selected image root separately from picker failures", async () => {
  const invalidRoot = await createTempRoot();
  const response = await jsonRequest(createApp({
    rootDir: await createTempRoot(),
    selectRoot: async () => invalidRoot,
  }), "/api/root/select", { method: "POST" });

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "Selected folder is not a valid image root." });
});
```

- [ ] **Step 2: Add Heatmap picker error-contract tests**

Replace the generic Heatmap cancellation assertion with:

```js
test.each([
  [FOLDER_PICKER_CODES.CANCELLED, 400, "Heatmap folder selection was cancelled."],
  [
    FOLDER_PICKER_CODES.UNAVAILABLE,
    503,
    "Heatmap folder picker is unavailable. Enter an absolute path in the Heatmap batch path field.",
  ],
  [
    FOLDER_PICKER_CODES.FAILED,
    500,
    "Heatmap folder picker failed. Enter an absolute path in the Heatmap batch path field.",
  ],
])("maps Heatmap picker %s to a safe response", async (code, status, message) => {
  const secretPath = "/private/secret/heatmap-root";
  const app = createApp({
    rootDir: await createTempRoot(),
    selectHeatmapRoot: async () => {
      throw new FolderPickerError(code, `native failure at ${secretPath}`);
    },
  });

  const response = await jsonRequest(app, "/api/heatmaps/select-folder", { method: "POST" });
  expect(response.status).toBe(status);
  const body = await response.json();
  expect(body).toEqual({ error: message });
  expect(JSON.stringify(body)).not.toContain(secretPath);
});
```

Add this generic-error table to prevent unknown errors from being mislabeled as user cancellation:

```js
test.each([
  [
    "/api/root/select",
    { selectRoot: async () => { throw new Error("unexpected native failure"); } },
    "Folder picker failed. Enter an absolute path in Root path and press Set root.",
  ],
  [
    "/api/heatmaps/select-folder",
    { selectHeatmapRoot: async () => { throw new Error("unexpected native failure"); } },
    "Heatmap folder picker failed. Enter an absolute path in the Heatmap batch path field.",
  ],
])("maps an unknown selection error from %s to a safe 500", async (endpoint, picker, message) => {
  const response = await jsonRequest(
    createApp({ rootDir: await createTempRoot(), ...picker }),
    endpoint,
    { method: "POST" },
  );

  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: message });
});
```

- [ ] **Step 3: Run the API tests and confirm the old generic responses fail**

Run: `npx vitest run server/app.test.js`

Expected: FAIL because both endpoints still return the old combined cancellation/failure messages with status `400`.

- [ ] **Step 4: Add one safe picker-response mapper to `server/app.js`**

Import the picker type contract:

```js
import { FOLDER_PICKER_CODES, FolderPickerError } from "./folderPicker.js";
```

Add a private mapper near `safeErrorResponse`:

```js
function folderPickerResponse(error, { heatmap = false } = {}) {
  const messages = heatmap
    ? {
        [FOLDER_PICKER_CODES.CANCELLED]: "Heatmap folder selection was cancelled.",
        [FOLDER_PICKER_CODES.UNAVAILABLE]:
          "Heatmap folder picker is unavailable. Enter an absolute path in the Heatmap batch path field.",
        [FOLDER_PICKER_CODES.FAILED]:
          "Heatmap folder picker failed. Enter an absolute path in the Heatmap batch path field.",
      }
    : {
        [FOLDER_PICKER_CODES.CANCELLED]: "Root selection was cancelled.",
        [FOLDER_PICKER_CODES.UNAVAILABLE]:
          "Folder picker is unavailable. Enter an absolute path in Root path and press Set root.",
        [FOLDER_PICKER_CODES.FAILED]:
          "Folder picker failed. Enter an absolute path in Root path and press Set root.",
      };

  const code = error instanceof FolderPickerError
    ? error.code
    : FOLDER_PICKER_CODES.FAILED;
  const status = code === FOLDER_PICKER_CODES.CANCELLED
    ? 400
    : code === FOLDER_PICKER_CODES.UNAVAILABLE
      ? 503
      : 500;

  return { status, body: { error: messages[code] ?? messages[FOLDER_PICKER_CODES.FAILED] } };
}
```

Replace the `/api/root/select` catch body with:

```js
} catch (error) {
  if (isInvalidStorageRootError(error)) {
    response.status(400).json({ error: "Selected folder is not a valid image root." });
    return;
  }

  const safeError = folderPickerResponse(error);
  response.status(safeError.status).json(safeError.body);
  return;
}
```

Replace the `/api/heatmaps/select-folder` catch body with:

```js
} catch (error) {
  const safeError = folderPickerResponse(error, { heatmap: true });
  response.status(safeError.status).json(safeError.body);
}
```

This keeps a selected empty/non-image root distinct from picker failures and prevents either route from exposing `error.message`.

- [ ] **Step 5: Replace AppleScript-only startup wiring**

In `server/index.js`, delete the `execFile`, `promisify`, `execFileAsync`, and `chooseFolderWithAppleScript` code. Import `chooseFolder` and inject it into both callbacks:

```js
import { chooseFolder } from "./folderPicker.js";

selectRoot: () => chooseFolder({ prompt: "Choose image sequence root folder" }),
selectHeatmapRoot: () => chooseFolder({ prompt: "Choose heatmap batch folder" }),
```

Keep `startServer`, `BOUND_EDITOR_ROOT`, the persisted `data` directory, and port handling unchanged.

- [ ] **Step 6: Run server-side regression tests**

Run: `npx vitest run server/folderPicker.test.js server/app.test.js server/storage.test.js`

Expected: all selected test files PASS.

- [ ] **Step 7: Commit server integration**

```bash
git add server/index.js server/app.js server/app.test.js
git commit -m "fix: report folder selection failures clearly"
```

### Task 3: Manual Heatmap Batch Path Fallback

**Files:**
- Modify: `src/App.jsx`
- Modify: `src/App.test.jsx`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: the existing `/api/heatmaps/generate` body `{ rootPath, cellSizes }` and picker response `{ rootPath }`.
- Produces: a controlled input labeled `Heatmap batch path` whose value is used directly for generation.

- [ ] **Step 1: Update the picker-filled path test to assert input state**

In `src/App.test.jsx`, change the existing Heatmap batch test so the selected path is asserted through the input:

```jsx
fireEvent.click(await screen.findByRole("button", { name: "Choose heatmap folder" }));
expect(await screen.findByLabelText("Heatmap batch path")).toHaveValue("/selected/heatmap-root");
```

Retain the existing `20 x 20`, `50 x 50`, `100 x 100`, Generate button, request-body, and result-summary assertions.

- [ ] **Step 2: Add a failing direct-entry test**

Add:

```jsx
test("generates Heatmaps from a manually entered absolute path", async () => {
  const { fetchMock } = mockApi();
  render(<App />);

  const pathInput = await screen.findByLabelText("Heatmap batch path");
  fireEvent.change(pathInput, { target: { value: "/manual/heatmap-root" } });
  fireEvent.click(screen.getByRole("button", { name: "Generate Heatmaps" }));

  await waitFor(() => {
    const call = fetchMock.mock.calls.find(
      ([url, options]) => url === "/api/heatmaps/generate" && options?.method === "POST",
    );
    expect(JSON.parse(call[1].body)).toEqual({
      rootPath: "/manual/heatmap-root",
      cellSizes: [20, 50, 100],
    });
  });
});
```

- [ ] **Step 3: Add a failing stale-picker-response test for manual edits**

Add:

```jsx
test("keeps a manually edited Heatmap path when an older picker request resolves", async () => {
  const pendingSelection = deferred();
  mockApi({ selectHeatmapFolderResponse: () => pendingSelection.promise });
  render(<App />);

  fireEvent.click(await screen.findByRole("button", { name: "Choose heatmap folder" }));
  const pathInput = screen.getByLabelText("Heatmap batch path");
  fireEvent.change(pathInput, { target: { value: "/manual/newer-root" } });

  await act(async () => {
    pendingSelection.resolve(await jsonResponse({ rootPath: "/picker/stale-root" }));
  });

  expect(pathInput).toHaveValue("/manual/newer-root");
});
```

Update existing stale-generation assertions from `findByText`/`queryByText` to `toHaveValue` on the path input.

- [ ] **Step 4: Run focused UI tests and verify they fail**

Run: `npx vitest run src/App.test.jsx -t "Heatmap|heatmap"`

Expected: FAIL because the current path is a non-editable `<span>` and manual edits cannot invalidate a pending picker response.

- [ ] **Step 5: Implement the controlled Heatmap path input**

Add a handler beside `handleSelectHeatmapFolder`:

```js
function handleHeatmapBatchRootChange(event) {
  heatmapBatchRequestRef.current += 1;
  setHeatmapBatchRoot(event.target.value);
  setHeatmapBatchError("");
  setHeatmapBatchResult(null);
}
```

Replace the path `<span>` with an accessible input:

```jsx
<label className="heatmap-batch-path" htmlFor="heatmap-batch-path">
  <span>Batch path</span>
  <input
    id="heatmap-batch-path"
    type="text"
    aria-label="Heatmap batch path"
    value={heatmapBatchRoot}
    placeholder="No folder selected"
    disabled={heatmapBatchLoading}
    onChange={handleHeatmapBatchRootChange}
  />
</label>
```

Keep the Choose Folder button behavior: a successful native selection fills this same input and clears the old generation result. Keep the Generate button disabled for an empty string or while generation is running.

- [ ] **Step 6: Style the input without enlarging the side panel**

Replace the span-specific `.heatmap-batch-path` rule with a two-row compact label and input rules:

```css
.heatmap-batch-path {
  display: grid;
  gap: 3px;
  min-width: 0;
  color: #9faeba;
  font-size: 0.76rem;
}

.heatmap-batch-path input {
  min-width: 0;
  min-height: 28px;
  padding: 0 7px;
  overflow: hidden;
  color: #d8e0e7;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

Do not change the Heatmap panel structure, preset controls, or surrounding layout.

- [ ] **Step 7: Run the full client test files**

Run: `npx vitest run src/App.test.jsx src/styles.test.js`

Expected: both files PASS, including existing request-race and compact-layout behavior.

- [ ] **Step 8: Commit the manual fallback**

```bash
git add src/App.jsx src/App.test.jsx src/styles.css
git commit -m "feat: allow manual Heatmap batch paths"
```

### Task 4: Documentation And End-To-End Verification

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: the completed picker and direct-entry behavior.
- Produces: installation and fallback instructions that apply to macOS, Windows, Linux, and headless machines.

- [ ] **Step 1: Update README run and picker documentation**

Keep the current folder shape, test commands, and bounds explanation. Replace the single picker sentence under `Run` with:

```markdown
You can choose an image root from the app with `Find root`, or enter an absolute
path in `Root path` and press `Set root`. The Heatmap batch panel also accepts an
absolute path directly.

Native folder selection uses:

- macOS: AppleScript through `osascript`;
- Windows: PowerShell `System.Windows.Forms.FolderBrowserDialog`;
- Linux: `zenity`, with `kdialog` as a fallback.

On Linux without `zenity`/`kdialog`, or on a headless server, enter an absolute
path directly or start the server with `BOUND_EDITOR_ROOT=/absolute/path/to/root`.
The selected folder is always on the machine running the Express server.
```

- [ ] **Step 2: Run the complete automated test suite**

Run: `npx vitest run --exclude '.worktrees/**'`

Expected: all tests PASS with no native folder dialog opening.

- [ ] **Step 3: Build the production client**

Run: `npm run build`

Expected: Vite exits `0` and writes the production bundle to `dist/`.

- [ ] **Step 4: Start the server on an available local port**

Run:

```bash
PORT=52931 npm run server
```

If `52931` is occupied by this repository's existing process, stop that process and restart it on `52931`. If it belongs to another project, use the next available port and record the actual URL.

Expected: `Server listening on http://localhost:52931` or the selected replacement port.

- [ ] **Step 5: Verify the fallback workflow in the browser**

Open the running app and verify:

1. `Root path` remains editable and `Set root` still loads a valid image root.
2. `Heatmap batch path` accepts an absolute path directly.
3. `Generate Heatmaps` submits the typed path and keeps fixed sizes `20`, `50`, and `100`.
4. The side panel remains readable without horizontal overflow at the current desktop viewport.

Do not invoke native chooser dialogs during automated verification; OS adapter behavior is covered by `server/folderPicker.test.js`.

- [ ] **Step 6: Review the final diff for scope and safety**

Run:

```bash
git diff --check
git status --short
git diff -- README.md server/folderPicker.js server/folderPicker.test.js server/index.js server/app.js server/app.test.js src/App.jsx src/App.test.jsx src/styles.css
```

Expected: no whitespace errors, no new dependency changes, no raw native error text in API responses, and only the planned files changed.

- [ ] **Step 7: Commit documentation**

```bash
git add README.md
git commit -m "docs: explain cross-platform folder selection"
```
