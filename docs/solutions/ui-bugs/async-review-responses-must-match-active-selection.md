---
title: Async Review Responses Must Match the Active Selection
date: 2026-08-15
last_updated: 2026-08-15
category: ui-bugs
module: Inference review UI
problem_type: ui_bug
component: frontend_stimulus
symptoms:
  - A delayed review response can replace the threshold and metrics for a newer image selection.
  - Reference propagation can begin before an edited threshold finishes saving.
  - Root changes can reuse image ids and expose stale job, review, or overlay state from the prior root.
root_cause: race_condition
resolution_type: code_fix
severity: medium
tags: [react, async-state, request-ordering, inference-review, tdd]
---

# Async Review Responses Must Match the Active Selection

## Problem

The inference review page issues overlapping requests when users navigate images, change ROI selection, or commit a threshold. A slower earlier request could overwrite the current review, and propagation could read persisted reference settings before an in-flight threshold save completed.

## Symptoms

- The heading and raw canvas show the newly selected image while threshold and area-fraction values jump back to the previous image.
- Clicking the reference action immediately after editing can send propagation before the threshold PUT resolves.
- Tests pass with immediate mocks but fail when responses are deliberately reordered.

## Solution

Track both the current image identity and a monotonically increasing review request ID. Apply a response only when both still match:

```jsx
const activeImageIdRef = useRef(activeImageId);
const reviewRequestIdRef = useRef(0);
activeImageIdRef.current = activeImageId;

async function loadReview(imageId) {
  const requestId = ++reviewRequestIdRef.current;
  const payload = await fetchReview(imageId);
  if (activeImageIdRef.current !== imageId || requestId !== reviewRequestIdRef.current) return;
  setReview(payload);
}
```

Store the active threshold-save promise in a ref. Blur, Enter, and explicit propagation then share and await the same save instead of launching independent operations.

Treat the confirmed root as part of every transient inference identity. Reject root changes while a job is active, clear completed jobs and source status after a successful switch, and key source state with a root-derived path rather than a root-relative image id. In the UI, reset review, ROI, job, raw-image, and overlay state whenever the server-confirmed root changes, even when the next root returns the same image ids.

Guard the image-list request that drives those states as well. Capture the confirmed root, root generation, and list request ID before fetching; apply the response only if all three are still current. Increment the generation and invalidate outstanding list requests when a root switch starts, not only after it succeeds, so an old polling response cannot re-confirm the prior root while the switch is in flight.

An overlay also needs explicit render identity instead of a bare blob URL:

```jsx
const overlay = { url, rootPath, imageId, threshold };
const visible = overlay?.rootPath === activeRootPath &&
  overlay?.imageId === activeImageId &&
  overlay?.threshold === normalizedThreshold;
```

Clear that object synchronously in source and threshold change handlers. Effect cleanup still revokes the old object URL, while the render guard prevents it from appearing during the transition.

Normalize threshold values to the shared `0.001` grid before persistence or derived work. The normalized value must feed review metrics, overlays, and generated masks; formatting only the URL or input text leaves semantic divergence.

## Why This Works

Mounted-state checks prevent updates after unmount but do not establish which in-flight request is authoritative. Identity and sequence guards encode that authority directly. Sharing the save promise also preserves the required ordering between persistence and propagation.

## Prevention

- Add deferred-promise tests that resolve requests in the opposite order from which they were sent.
- Test action dependencies with a deliberately pending mutation and assert the dependent request has not started.
- Make every action that consumes persisted edits await the same save promise and abort when it resolves unsuccessfully.
- Include the confirmed root in transient identities and test switches between roots that intentionally reuse timestamp folders, filenames, and opaque ids.
- Hold an old-root list poll across a root switch and assert that releasing it cannot restore the old root or rows.
- Store render identity beside object URLs and assert stale overlays disappear synchronously before replacement requests resolve.
- Centralize numeric grid normalization at the service boundary and mirror it in UI requests; test one off-grid input through persistence and every derived artifact.
- Use mounted checks for lifecycle safety and request identity checks for selection safety; they solve different races.
