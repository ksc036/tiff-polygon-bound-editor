# Task 1 Runnable Script Scope

When scaffolding a project with a constrained file list, keep required package scripts runnable within the allowed files. Do not point scripts at uncreated files unless that missing file is explicitly part of the task or clearly reported as a concern.

For server scripts, avoid inline `node -e` implementations once behavior includes more than a trivial command. Put the Express app behind a `createApp({ rootDir })` factory and test static `dist/` serving with a temporary root so tests do not depend on ambient build artifacts.
