# Server-Confirmed State and Stale Save Guards

## Problem

An editable input was used as proof that a root was active, so entering a path
enabled a server-side export before the root-change request succeeded. Separately,
an asynchronous bounds save always applied its response, allowing an older save
to replace newer local editing and clear the dirty indicator.

## Rule

- Keep draft input state separate from server-confirmed state when a UI action
  depends on a server capability. Enable that action only from the confirmed
  value, and retain the last confirmed value when a replacement request fails.
- For asynchronous persistence of editable state, capture the target identity
  and local revision at request start. Apply the response and clear dirty state
  only when both still match at response time. A stale response may still be
  useful to its original operation, but must not overwrite current local UI.

## Regression Coverage

- A typed-but-unapplied root leaves export disabled; a successful apply enables it.
- A delayed auto-save followed by a new geometry edit retains the new geometry
  and dirty state after the old response returns.
