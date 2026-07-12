# Embedded scripts need literal shell quoting

## Context

Passing JavaScript to `node -e` inside a double-quoted shell argument allows shell expansion to process JavaScript template literals, backticks, and `${...}` before Node receives the source. The resulting command can execute unintended substitutions or produce corrupted JavaScript.

## Rule

When a shell command must carry an embedded script, place the script inside a literal single-quoted shell boundary and escape any embedded single quotes explicitly. Do not rely on JSON double-quoting for source that contains backticks or dollar substitutions.

Prefer a real script file supplied by the project when one exists. For temporary fixture generation, verify the command's exit status before treating the fixture as valid.
