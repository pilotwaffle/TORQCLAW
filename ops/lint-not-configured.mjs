#!/usr/bin/env node
// G1D-FABLE-CLEANUP-DOCS-TRUTH-2026-08-23, Item 9 (reduced per B-6): `pnpm lint`
// must be self-describing rather than a vacuous 0-task `turbo run lint` green
// (no package in this repo defines a `lint` script, so turbo silently no-ops
// and exits 0, which is indistinguishable from "lint ran and passed").
//
// This script makes the honest state visible: it prints a message clearly
// distinguishable from a lint PASS, and exits 0 (this is a known, filed gap,
// not a build failure -- see docs/FOLLOWUPS-CI-E2E-GATES.md's ESLint adoption
// task for the scoped follow-up). No ESLint dependency, config, or per-package
// script is added by this change.
console.log('lint not configured — no ESLint in this repo; see docs/FOLLOWUPS-CI-E2E-GATES.md (ESLint adoption task)');
process.exit(0);
