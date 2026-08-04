# Frontend Contract And Pointer Guards

Before saving loaded or imported user data, normalize it to the current server contract. Legacy files can contain stale `connectionMode` values or missing point ids even if newly-created editor state is valid.

Client API code must check `response.ok` before mutating local state or marking work clean. A failed save should keep the editor dirty and surface a safe error status.

For SVG/canvas editors, stop both pointer and click propagation on draggable handles. A handle drag or click should not bubble to the stage and trigger a separate add-point action. Clear drag state on pointer cancel/leave as well as pointer up, and prefer pointer capture where practical.

For hover overlays constrained to a rendered canvas, clear the previous pointer when coordinate resolution moves outside that canvas. Test the transition from an active hover target to surrounding annotations; starting outside the canvas cannot expose stale tooltip state.
