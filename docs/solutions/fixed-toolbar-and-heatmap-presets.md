# Fixed Toolbar And Heatmap Presets

The editor toolbar has nine independent cells in its normal image layers:
root chooser, root path, root apply, previous, image counter, next, save,
import, and ZIP export. Its desktop grid must declare all nine columns. The
two flexible cells are the root path and image counter; both may truncate,
while actions retain their natural widths. Do not use positional selectors to
repair a wrapped action because the toolbar order is part of the UI contract.

Heatmap grids are a server storage contract, not a user-tunable client
preference. The supported preset values are fixed at `20`, `50`, and `100`
pixels, in that order. The client can persist only the selected named preset.
It must discard the legacy editable-preset localStorage value and send exactly
`[20, 50, 100]` for batch generation so overlay requests and generated folders
stay aligned.
