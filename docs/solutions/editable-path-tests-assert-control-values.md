# Editable Path Tests Assert Control Values

When replacing a visible path display with an editable input, update every consumer test that reads the path. Assert the accessible input value with `getByLabelText` and `toHaveValue` rather than looking for path text in the document, so tests remain aligned with the user-facing form contract.
