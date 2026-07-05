# Reference Behavior And Persistence Wiring

When a feature says to follow a reference implementation, port the reference's observable edge behavior, not only the obvious happy path. For 16-bit TIFF display, ImageJ `ImageDescription` `min=` / `max=` metadata is part of the display contract; pixel min/max is only a fallback.

When an API accepts configuration such as `dataDir`, add a test proving that configuration changes durable behavior. Passing a parameter through constructors is not enough if the downstream layer ignores it. For local tools, "remember last root" means writing and reading a real settings file under the configured data directory.

Apply this check before declaring server/API integration complete.
