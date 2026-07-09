# Root Vitest Runs Must Exclude Nested Worktrees

## Context

While integrating `feature/outward-roi-analysis` into `main`, running `npm test` from the main repository root also discovered tests inside `.worktrees/outward-roi-analysis`.

## Lesson

Nested git worktrees can contain their own `node_modules`. If Vitest discovers tests inside those worktrees, React tests may mix React from the main root with React DOM from the nested worktree and fail with invalid hook call errors such as `Cannot read properties of null (reading 'useRef')`.

## Applied Rule

When verifying the main root while nested worktrees are present, run Vitest with `.worktrees/**` excluded, for example:

```bash
npx vitest run --exclude ".worktrees/**"
```

Use the normal `npm test` command inside an individual worktree, where the test root and dependency tree are aligned.
