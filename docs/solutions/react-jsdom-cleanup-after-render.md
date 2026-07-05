# React jsdom tests need explicit cleanup after render

When adding React component tests in this project, call Testing Library `cleanup()` in `afterEach`.
Vitest did not automatically remove prior rendered apps in this task, which made later tests query
multiple copies of the editor and obscured the real behavior failures.
