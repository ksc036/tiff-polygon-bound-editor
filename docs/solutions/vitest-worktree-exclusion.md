# Vitest worktree exclusion

Run project tests with `npx vitest run --exclude '.worktrees/**'` whenever the repository contains nested worktrees. A bare `npm test` discovers their test files too, which can load a second React installation and produce unrelated hook failures.
