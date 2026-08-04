---
title: Browser dialog verification needs an evidence map
date: 2026-08-05
module: E2E verification
problem_type: workflow_issue
component: testing_framework
severity: medium
tags: [e2e, browser-dialogs, verification, evidence-map]
---

# Browser Dialog Verification Needs an Evidence Map

Before claiming E2E completion, map every plan step to an evidence source and
verify browser dialog-control capabilities early. When approved browser tooling
auto-accepts dialogs or forbids mutating page runtime, exercise every writable
production UI path it supports and use focused integration tests for blocked
cancel and `beforeunload` paths. Document the limitation precisely, and never
substitute a direct API call for a required UI-success path.
