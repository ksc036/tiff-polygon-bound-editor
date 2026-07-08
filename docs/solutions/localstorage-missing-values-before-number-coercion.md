# Check localStorage presence before numeric coercion

## Context

While adding the draggable analysis panel height, the initial state read the saved height with:

```js
const stored = Number(localStorage.getItem(KEY));
```

When the key is absent, `localStorage.getItem(KEY)` returns `null`, and `Number(null)` becomes `0`. The clamp then treated the missing value as a real number and snapped the default panel height to the minimum.

## Rule

When reading optional numeric values from `localStorage`, check for `null` before calling `Number(...)`.

```js
const storedValue = localStorage.getItem(KEY);
if (storedValue === null) return DEFAULT_VALUE;

const stored = Number(storedValue);
return Number.isFinite(stored) ? clamp(stored, MIN, MAX) : DEFAULT_VALUE;
```
