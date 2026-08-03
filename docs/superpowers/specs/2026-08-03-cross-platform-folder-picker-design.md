# Cross-Platform Folder Picker Design

## Goal

Make `Find root` and the Heatmap batch folder selector work on macOS,
Windows, and Linux without adding an Electron shell or a native npm module.
Keep typed absolute paths as the universal fallback.

## Confirmed Behavior

- macOS uses AppleScript `choose folder` through `osascript`.
- Windows uses PowerShell with `System.Windows.Forms.FolderBrowserDialog`.
- Linux tries `zenity --file-selection --directory` first and then
  `kdialog --getexistingdirectory` when `zenity` is unavailable.
- Linux systems without either dialog command receive an actionable message
  telling the user to enter an absolute path in `Root path` and press
  `Set root`.
- No new runtime npm dependency is added.
- The selected image root still passes the existing storage validation. Folder
  selection does not weaken image, mask, or directory validation.

## Architecture

Add `server/folderPicker.js` as the single owner of operating-system folder
selection. It exposes a platform-neutral function that accepts a prompt and
returns one absolute path.

`server/index.js` injects this picker into both existing server callbacks:

- image sequence root selection;
- Heatmap batch root selection.

The picker detects `process.platform` and runs one of these adapters:

```text
darwin -> osascript
win32  -> powershell.exe
linux  -> zenity, then kdialog when the command is unavailable
other  -> unavailable error
```

Command execution is injected in tests so automated tests never open a real
desktop dialog.

## Error Contract

Folder-picker failures use stable internal codes:

- `FOLDER_SELECTION_CANCELLED`: the user closed or cancelled the dialog;
- `FOLDER_PICKER_UNAVAILABLE`: the OS has no supported dialog command or no
  graphical session;
- `FOLDER_PICKER_FAILED`: the native command ran but failed unexpectedly.

The API returns concise messages without exposing host paths or raw command
output:

- cancelled: `Root selection was cancelled.`;
- unavailable: `Folder picker is unavailable. Enter an absolute path in Root path and press Set root.`;
- selected root invalid: `Selected folder is not a valid image root.`;
- unexpected failure: `Folder picker failed. Enter an absolute path in Root path and press Set root.`

Heatmap folder selection uses the same distinctions with Heatmap-specific
wording where appropriate.

The client continues to show API error text through the existing status area.
No new modal or layout is required.

## Platform Details

### macOS

Use the existing AppleScript prompt and convert the chosen alias to a POSIX
path. AppleScript error `-128` and equivalent user-cancel output map to
`FOLDER_SELECTION_CANCELLED`.

### Windows

Run Windows PowerShell in STA mode and open `FolderBrowserDialog`. Print only
the selected path to stdout. Empty output maps to cancellation.

### Linux

Run `zenity` first. If command startup fails with `ENOENT`, try `kdialog`.
If both commands are absent, report `FOLDER_PICKER_UNAVAILABLE`. A normal
dialog cancel maps to `FOLDER_SELECTION_CANCELLED`. Display/session failures
map to unavailable so the manual-path instruction is shown.

## Testing

Add unit tests for:

- command and argument selection on macOS, Windows, and Linux;
- path trimming without modifying valid spaces or Unicode;
- Linux fallback from missing `zenity` to `kdialog`;
- cancellation, unavailable command, and unexpected failure codes;
- API status and safe user-facing messages;
- invalid selected image roots remaining distinct from picker failures.

Run the complete existing test suite and production build after integration.

## Documentation

Update the README to state that `Find root` supports macOS, Windows, and Linux,
describe the Linux `zenity`/`kdialog` fallback, and retain direct absolute-path
and `BOUND_EDITOR_ROOT` instructions for headless environments.

## Out Of Scope

- Installing Linux desktop packages automatically;
- selecting a folder on a remote machine different from the server host;
- converting the application to Electron or Tauri;
- browser File System Access API integration, which cannot provide a reusable
  server-side absolute path.

