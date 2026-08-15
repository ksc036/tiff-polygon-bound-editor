---
title: Async Review Responses Must Match the Active Selection
date: 2026-08-15
category: ui-bugs
module: Inference review UI
problem_type: ui_bug
component: frontend_stimulus
symptoms:
  - A delayed review response can replace the threshold and metrics for a newer image selection.
  - Reference propagation can begin before an edited threshold finishes saving.
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

## Why This Works

Mounted-state checks prevent updates after unmount but do not establish which in-flight request is authoritative. Identity and sequence guards encode that authority directly. Sharing the save promise also preserves the required ordering between persistence and propagation.

## Prevention

- Add deferred-promise tests that resolve requests in the opposite order from which they were sent.
- Test action dependencies with a deliberately pending mutation and assert the dependent request has not started.
- Use mounted checks for lifecycle safety and request identity checks for selection safety; they solve different races.
