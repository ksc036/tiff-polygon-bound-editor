# Empty Status Fallbacks Need Logical Or

When a status formatter returns an empty string for an inactive state, use `||` to fall back to the next status source. `??` only falls back for `null` and `undefined`, so it suppresses valid secondary status text when the primary formatter returns `""`.

Add a focused rendering test for the inactive-primary path whenever a UI combines status messages this way.
