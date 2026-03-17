# SQL Editor — Retrospective

A self-assessment of what could have been improved or done better in the solution.

---

## 🏗️ Architecture & Design

### 1. SQL parsing is too naive
The client-side SQL splitting (`splitStatements`), LIMIT injection, and first-word detection all rely on string manipulation and regex. This works for 90% of cases but breaks on edge cases like:
- Comments containing semicolons (`-- this; breaks`)
- Strings containing SQL keywords (`INSERT INTO t VALUES ('SELECT something')`)
- CTEs where the first word is `WITH`, not `SELECT`

A lightweight SQL tokenizer (even a simple state machine that tracks quoted/comment contexts) would have been more robust than regex.

### 2. No server-side query validation layer
The Express server is essentially a passthrough to ClickHouse. There's no middleware that sanitizes or validates queries before forwarding them. The client-side identifier validation is good, but a defense-in-depth approach would add a server-side allowlist or at least log suspicious patterns.

### 3. The Query Builder should have been a separate module
`QueryBuilderTab.tsx` grew into a very large component that handles UI, SQL generation, pseudo-row construction, and state management all in one file. Extracting the SQL generation logic into a pure `buildQuery(action, table, filters, changeset)` function and the pseudo-row logic into a separate utility would have made it more testable and easier to reason about.

---

## ⚡ Performance

### 4. No virtualized scrolling
The 100-row cap solves the immediate problem, but a production-grade solution would use virtualized rendering (e.g., `react-window` or `@tanstack/virtual`) to handle thousands of rows without DOM bloat. The cap is a pragmatic shortcut, but it artificially limits the tool's usefulness.

### 5. Schema fetching could use smarter invalidation
Right now, the schema cache invalidates on DDL keywords detected client-side. A cleaner approach would be to have the server return a schema version hash, and the client polls or subscribes to changes. This removes the fragile keyword-detection dependency.

---

## 🧪 Testing

### 6. No integration or E2E tests
All tests are unit-level with mocked APIs. There are no tests that actually spin up the Express server, connect to ClickHouse, and verify the full round-trip. Even one or two integration tests (using a ClickHouse test container) would dramatically increase confidence in the query execution pipeline.

### 7. Test coverage gaps on error paths
Most tests cover the happy path. Edge cases like network timeouts, ClickHouse returning unexpected formats, or partial batch failures during chunked uploads are not well covered.

---

## 🎨 UX / Frontend

### 8. No query history or saved queries
There's no way to recall previous queries. A simple `localStorage`-backed history would add significant usability for a tool like this.

### 9. No keyboard shortcuts
`Cmd+Enter` to run a query is table stakes for any SQL editor. The current implementation requires clicking the Run button. This is a small but noticeable polish gap.

### 10. Error messages could be more actionable
When ClickHouse returns an error, it's displayed raw. Parsing common error patterns (e.g., "Unknown column 'x'") and suggesting fixes ("Did you mean column 'y'?") would elevate the UX significantly.

---

## 📦 Code Quality

### 11. Styled-components could have been design tokens
The styled-components migration was good for co-location, but there's no shared theme or design token system. Colors, spacing, and font sizes are hardcoded across components. A `theme.ts` with a `ThemeProvider` would make the styling more maintainable and consistent.

### 12. The `queryApi.ts` file does too much
It handles single execution, multi-statement execution, chunking, LIMIT injection, COUNT optimization, and progress callbacks. Splitting this into focused modules (`queryExecutor.ts`, `queryChunker.ts`, `queryOptimizer.ts`) would improve readability and testability.

---

## Summary

The solution is solid for what it is — a well-structured, functional SQL editor with thoughtful decisions around safety, performance, and UX. The biggest gaps are in **robustness** (SQL parsing, error handling, integration testing) and **scalability** (virtualization, modularization). These are all things you'd naturally address in a production environment, and being able to articulate *why* you didn't do them here (scope, time, pragmatism) is just as valuable in an interview as having done them.
