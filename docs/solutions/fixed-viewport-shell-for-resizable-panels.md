# Fixed viewport shell for resizable panels

## Context

The analysis panel can be dragged upward to take more vertical space from the image stage. After the image stage began sizing itself from its available frame, the app shell still used `min-height: 100vh`.

That let the whole page grow taller when the analysis panel height increased, instead of forcing the image-stage row to shrink. The result was a resize handle that updated state but did not visibly reclaim enough image space.

## Rule

For split-pane or resizable-panel layouts, the outer shell must have a fixed viewport height and hidden page overflow. Scrolling should happen inside the relevant panels.

```css
.app-shell {
  height: 100dvh;
  min-height: 0;
  overflow: hidden;
}

.side-panel {
  overflow: auto;
}
```
