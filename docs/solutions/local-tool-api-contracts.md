# Local Tool API Contracts

Local-only apps still need deliberate API contracts. Do not serialize raw filesystem or library error messages directly to the browser; map storage, validation, and decoder failures to short user-facing messages and keep absolute paths/internal details server-side.

If the UI promises a native folder picker, the production server must wire a real picker implementation, not only a test-injected callback. For macOS local tools, an AppleScript `choose folder` helper behind `/api/root/select` is acceptable, with a typed-path fallback for environments where the picker is unavailable.

For JSON saved to user data folders, validate the request body before writing. Schema defaults are not validation. Check group and point shapes, finite coordinates, expected connection mode, and basic string fields so future UI mistakes cannot persist malformed files.

Apply this checklist before connecting a frontend editor to local filesystem APIs.
