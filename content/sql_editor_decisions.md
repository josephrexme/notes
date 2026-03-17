# Decisions

This document captures the key architectural and implementation decisions I made while building a SQL web editor on top of ClickHouse, Express, and React. Each section follows a **Problem → Decision → Tradeoff** structure.

---

## 1. Architecture — Integrated React + Express

### The Problem

The first decision was whether to set up a separate React frontend that consumes the Express.js API endpoints or integrate React into the Express.js application.

Based on the README:

> Given the current project, let's implement a small SQL web editor using React. When opening `/`, the React application should render and display a SQL editor where users can write and execute SQL queries.

### Alternatives Considered

| Approach | Pros | Cons |
|---|---|---|
| **Separate Vite dev server + proxy** | Independent deploys, CDN-ready frontend | Two processes, CORS config, more complex setup |
| **Create React App** | Familiar tooling | No SSR path, ejecting for customization, slower HMR |
| **Vite as Express middleware** ✓ | Single port, full HMR, simple production build | Tighter coupling between frontend and backend |

### Decision

Use `vite.createServer()` in dev as middleware inside Express. In production, serve the built `dist/` as static files with `express.static()`. Single port, full React + HMR.

**Tradeoff:** Simplicity over scalability. A separate frontend could be deployed to a CDN independently, but for a local SQL editor tool, a single process is more pragmatic.

---

## 2. Caching Strategy — Consistency in CAP with Smart Invalidation

### The Problem

The app has two categories of data:

| Data Type | How it changes | Tolerance for staleness |
|---|---|---|
| **Schema metadata** (table names, columns, types) | Only when DDL runs (`CREATE`, `ALTER`, `DROP`) | Low — stale schema causes wrong column pickers, broken queries |
| **Query results** (SELECT output) | Every execution is intentional and unique | None — must always be fresh |

### CAP Theorem Reasoning

In CAP theorem terms, this is a **single-node, single-user** SQL editor. There's no partition risk (P) since the client and ClickHouse server are co-located. The real tradeoff is between **Consistency (C)** and **Availability/Performance (A)** — i.e., how aggressively I cache.

- **Query results:** I prioritize **strict consistency**. Every `▶ Run` click sends a fresh request. Results are never cached because each execution may return different data (the user may have inserted rows, changed filters, etc.). This is handled through `useMutation` which is inherently non-caching.
  - See: [`useExecuteQuery.ts`](../client/src/hooks/useExecuteQuery.ts) — uses `useMutation`, not `useQuery`.

- **Schema metadata:** I use a **balanced approach** — cache with a 5-minute stale time, but **eagerly invalidate** whenever I detect a schema-altering statement.

### Implementation

**Stale time of 5 minutes** ([`useSchema.ts`](../client/src/hooks/useSchema.ts)):
```typescript
export const SCHEMA_QUERY_KEY = ['schema'] as const;
const STALE_TIME_MS = 5 * 60 * 1000; // 5 minutes
```

**Eager invalidation on DDL** ([`useExecuteQuery.ts`](../client/src/hooks/useExecuteQuery.ts)):
```typescript
onSuccess: (_, sql) => {
  if (/CREATE|ALTER|DROP/i.test(sql)) {
    void queryClient.invalidateQueries({ queryKey: SCHEMA_QUERY_KEY });
  }
},
```

When a `CREATE TABLE`, `ALTER TABLE`, or `DROP TABLE` runs successfully, React Query immediately marks the schema cache as stale and triggers a background refetch. The Schema sidebar and Query Builder dropdown update within milliseconds.

### Why Not `staleTime: 0`?

I initially considered `staleTime: 0` for maximum consistency. However:

- **Cost:** The schema endpoint queries `system.columns` which scans ClickHouse's metadata. With `staleTime: 0`, every tab switch, window focus, or component remount triggers a fresh fetch.
- **Benefit:** Minimal — schema changes only happen through DDL statements, and I already catch those with explicit invalidation.
- **Blind spot:** External schema changes (another user, a migration script) would still be delayed by up to 5 minutes. This is acceptable for a local development tool.

**Decision:** Keep `staleTime: 5 minutes` with explicit cache invalidation on DDL. This achieves **eventual consistency within my control** (instant for in-app changes) while avoiding unnecessary network traffic.

### Tradeoff Summary

| Approach | Consistency | Performance | Chosen? |
|---|---|---|---|
| `staleTime: 0` | Highest — always fresh | Worst — fetches on every render cycle | ✗ |
| `staleTime: 5min` + invalidation | High — instant for in-app DDL, ≤5min for external | Good — minimal redundant fetches | ✓ |
| `staleTime: Infinity` (manual only) | Lowest — only refreshes on explicit action | Best — single fetch per session | ✗ |

---

## 3. Single Source of Truth for Table Lists

### The Problem

The Schema sidebar (`SchemaViewer`) and the Query Builder's table dropdown (`QueryBuilderTab`) both need the list of tables. Originally these used two independent data sources:

- `useSchema()` — fetches from `GET /schema` (queries `system.columns`)
- `useTables()` — fetched from `POST /query` (ran `SELECT name FROM system.tables`)

This meant creating a table would invalidate the schema cache (updating the sidebar) but **not** the tables cache (leaving the dropdown stale).

### Decision

Refactor `useTables` to be a **thin wrapper** around `useSchema`, deriving table names from the same cached data.

**Before** ([`useTables.ts`](../client/src/hooks/useTables.ts) — old):
```typescript
// Separate query with its own cache key and stale time
const { data } = useQuery({
  queryKey: ['tables', 'default'],
  queryFn: () => executeQuery("SELECT name FROM system.tables ..."),
});
```

**After** ([`useTables.ts`](../client/src/hooks/useTables.ts) — current):
```typescript
// Derives from useSchema — shares cache, invalidation, and stale time
const { data, isLoading, isError } = useSchema();
const tables = data?.tables.map((t) => t.name) ?? [];
```

**Tradeoff:** This loses the ability to cache table lists and schema metadata independently. In practice this doesn't matter because both come from the same underlying `system.columns` query, and having a single source of truth eliminates an entire class of sync bugs.

---

## 4. Backend Query Routing — `command()` vs `query()`

### The Problem

The ClickHouse Node.js client's `query()` method appends `FORMAT JSONEachRow` to every SQL statement. This works for `SELECT` but breaks `INSERT ... VALUES` because ClickHouse can't parse `VALUES (...) FORMAT JSONEachRow` — the two input formats are mutually exclusive.

### Decision

Detect DDL/DML statements server-side and route them to `client.command()` instead of `client.query()`.

**Implementation** ([`src/index.ts`](../src/index.ts)):
```typescript
const firstWord = sql.split(/\s+/)[0].toUpperCase();
const isDDL = ['INSERT', 'CREATE', 'ALTER', 'DROP', 'DELETE', ...].includes(firstWord);

if (isDDL) {
  await client.command({ query: sql });   // No format appended
  res.status(200).send({ rows: [] });
} else {
  const resultSet = await client.query({ query: sql, format: 'JSONEachRow' });
  const rows = await resultSet.json();
  res.status(200).send({ rows });
}
```

**Tradeoff:** First-word detection is naive — it wouldn't handle CTEs like `WITH ... INSERT` or comments before the keyword. For a SQL editor where users write straightforward statements, this is sufficient. A more robust approach would be a SQL parser, but that's overkill here.

**Why not client-side?** This is a backend concern. The ClickHouse client library controls how it communicates with the database. The frontend has no way to influence the `FORMAT` directive that gets appended.

---

## 5. DDL Feedback — Empty Table Structure Preview

### The Problem

`CREATE TABLE` and `ALTER TABLE` return no rows. The results panel showed a blank "No rows returned" message, giving no feedback that the operation succeeded.

### Decision

For `CREATE TABLE`, parse the SQL statement client-side to extract column definitions and render an empty table with those headers. For all other DDL/DML (`ALTER`, `INSERT`, `DELETE`, `DROP`, `TRUNCATE`), show a contextual success message.

**Implementation** ([`ResultsTable.tsx`](../client/src/components/ResultsTable.tsx)):
- `extractColumnsFromCreate()` — regex + depth-aware comma splitting to parse column definitions from `CREATE TABLE` SQL
- DDL message mapping — detects `ALTER`, `INSERT`, `DELETE`, `DROP`, `TRUNCATE` by first keyword and shows appropriate messages

**Tradeoff:** Parsing SQL client-side is fragile. Complex `CREATE TABLE` statements with nested types like `Array(Tuple(String, UInt64))` could confuse the parser. The depth-tracking approach handles most real-world cases, and since this is purely cosmetic feedback (the actual execution already succeeded), a parsing failure gracefully falls back to "No rows returned."

---

## 6. Custom Query Builder vs `react-querybuilder`

### The Problem

I initially included `react-querybuilder` as a dependency. It provides a generic query-building UI with rules and groups.

### Decision

Replace `react-querybuilder` with a custom implementation tailored to ClickHouse semantics.

**Reasons:**
- `react-querybuilder` doesn't understand ClickHouse-specific types (`UInt64`, `DateTime`, `Array(String)`)
- It generates generic rule trees that needed translation to ClickHouse SQL anyway
- The custom builder directly maps UI state → SQL string with no intermediate representation
- Smaller bundle size — removed a dependency and its CSS

**The custom builder** ([`QueryBuilderTab.tsx`](../client/src/components/QueryBuilderTab.tsx)) supports:
- 7 actions: List, Create, Insert, Update, Delete, Drop, Alter
- Type-aware inputs (number, date, datetime-local, checkbox) based on ClickHouse column types
- Operator filtering (string columns can't use `>`, `<`; bool columns only get `=`, `!=`)
- Logical operators (AND/OR) between filter conditions
- Changeset input as key-value pairs or JSON
- ALTER sub-actions (Add Column, Drop Column, Rename Column, Modify Type) with schema-aware column pickers

**Tradeoff:** More code to maintain, but significantly better UX for ClickHouse specifically. A generic query builder would require extensive customization to achieve the same result.

---

## 7. Query Builder Scope — Excluding Complex SQL Operations

### The Problem

SQL supports many advanced operations that compose queries in powerful ways: `JOIN`, `UNION`, `GROUP BY`, `HAVING`, `DISTINCT`, `COUNT`, subqueries, window functions, CTEs (`WITH`), and more. The question was whether to support these in the visual Query Builder.

### Decision

Intentionally **exclude** complex SQL operations from the Query Builder. These are best written in the SQL Editor tab, which provides full syntax freedom with CodeMirror's syntax highlighting and auto-completion.

### Reasoning

- **Exponential UI complexity:** Each operation dramatically increases the number of UI inputs needed. A `JOIN` alone requires a second table selector, join type dropdown (INNER, LEFT, RIGHT, FULL), and an ON clause builder with column pickers from both tables. Nesting joins, or combining `JOIN` with `GROUP BY` and `HAVING`, creates a combinatorial explosion of form states.
- **Diminishing returns:** Users who need `JOIN` or `UNION` tend to already understand SQL well enough to write it directly. The Query Builder's value is in **lowering the barrier** for simple CRUD operations — listing data, inserting rows, basic filtering — not in replicating a SQL syntax tree as a form.
- **The SQL Editor exists for this:** The application has a dedicated SQL Editor tab with full-text editing, multi-statement execution, and syntax highlighting. Complex queries belong there. The "Open in SQL Editor" button bridges the two — users can scaffold a simple query in the Builder, then refine it with `JOIN`s or aggregations in the Editor.
- **ClickHouse-specific concerns:** ClickHouse's `JOIN` semantics differ from standard SQL (e.g., `GLOBAL JOIN`, `ANY`/`ALL` modifiers, dictionary joins). A visual builder would either hide these nuances (producing suboptimal queries) or expose them (creating a confusing UI for beginners).

### What the Query Builder Covers

| Supported | Not Supported |
|---|---|
| `SELECT * ... WHERE ... LIMIT` | `JOIN` / `UNION` / `INTERSECT` |
| `INSERT INTO ... VALUES` | `GROUP BY` / `HAVING` |
| `UPDATE ... SET ... WHERE` | `DISTINCT` / `COUNT` / aggregations |
| `DELETE FROM ... WHERE` | Subqueries / CTEs (`WITH`) |
| `CREATE TABLE` / `DROP TABLE` | Window functions |
| `ALTER TABLE` (add/drop/rename/modify column) | `ORDER BY` (beyond default) |

**Tradeoff:** Power users may find the Query Builder limiting. The mitigation is the "Open in SQL Editor" button, which lets users start with a generated scaffold and add complexity manually. This keeps the Builder simple and approachable without sacrificing capability — it just lives in a different tab.

---

## 8. DML Operational Feedback — Fast Client-Side Pseudo-Rows

### The Problem

When users execute `INSERT`, `UPDATE`, or `DELETE` statements from the Query Builder, ClickHouse traditionally returns a standard success message but no impacted row data. Users want immediate feedback to visualize the shape of exactly what they just modified without having to run a blind `SELECT *` command afterwards.

### Decision

For DML operations executed from the Query Builder (`INSERT`, `UPDATE`, `DELETE`), I intercept the execution lifecycle directly within the `QueryBuilderTab.tsx`'s `handleRun` method. Instead of firing an additional `SELECT * FROM [table]` query against the backend (which presents sorting and pagination inconsistencies), I construct **local "pseudo-rows"** using the exact values the user entered into the Key-Value/JSON inputs.

**Implementation**:
- The generic `ResultsTable` was augmented to support an `__action` meta-property attached to each row object (`+` inserts, `-` deletes, `*` updates).
- The action prefix is visually colored to identify modifications instantly.
- For `UPDATE` previews (`*`), any fields that were not explicitly modified are displayed as a dash (`—`) rather than `NULL` to clearly indicate they were left untouched.

**Tradeoff**:
This provides an instantaneous, isolated visual confirmation exactly reflecting the user's intent without taxing the ClickHouse server or returning ambiguous results from an ungoverned `SELECT * LIMIT 100` query (since DB blocks won't guarantee order). Note that this preview is _optimistic_, meaning it trusts that ClickHouse successfully processed exactly what the GUI dispatched, omitting any server-side database manipulations like triggers, auto-increment keys, default values, or constraint mutations, which would remain hidden from this client-side preview until the user legitimately issues another `SELECT` themselves.

---

## 9. Client-Side SQL Safety — Defense in Depth

### The Problem

The SQL Editor and File Upload tabs intentionally pass raw SQL to the server — users type exactly what they want executed. However, the **Query Builder** constructs SQL from structured UI inputs via string interpolation. This introduces three categories of risk:

1. **Unescaped string values** — a value like `O'Brien` produces `WHERE name = 'O'Brien'`, breaking the SQL or enabling injection.
2. **Arbitrary code execution** — the "Object" input mode used `new Function('return (' + input + ')')()`, which is equivalent to `eval()`.
3. **Unsanitized identifiers** — free-text inputs for table/column names in DDL could contain special characters.

### Decision

Apply three targeted defenses in [`QueryBuilderTab.tsx`](../client/src/components/QueryBuilderTab.tsx):

#### 9a. Escape Single Quotes in String Values

Added an `escapeSql()` helper that doubles single quotes (`'` → `''`), which is SQL-standard escaping. Applied in:

- `quoteIfString()` — used by Key-Value mode for filters and changesets
- JSON mode's string interpolation — both INSERT and UPDATE paths

```typescript
function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}
```

This fixes the real-world bug where values containing apostrophes (e.g., `it's`, `O'Brien`) would generate broken SQL, and closes the injection vector as a side effect.

#### 9b. Replace `new Function()` with `JSON.parse()`

The changeset "Object" mode previously evaluated arbitrary JavaScript via `new Function()`. This was convenient (it supported unquoted keys, trailing commas) but equivalent to `eval()`.

**Before:**
```typescript
const parsed = new Function('return (' + changesetObj + ')')();
// Allows: { name: "foo" }  (JS object literal)
// Also allows: (function(){ maliciousCode(); return {} })()
```

**After:**
```typescript
const parsed = JSON.parse(changesetJson);
// Only allows: { "name": "foo" }  (strict JSON)
// Rejects any non-JSON input
```

The UI was also renamed from "Object" to "JSON" to set correct expectations — users must provide valid JSON with double-quoted keys.

**Tradeoff:** Users can no longer paste JavaScript object literals with unquoted keys or trailing commas. This is acceptable because:
- JSON is a universally understood format
- The error message (`Invalid JSON format`) guides the user clearly
- Stricter parsing means no accidental or intentional code execution

#### 9c. Sanitize Free-Text Identifiers

Table names (`newTableName`) and column names in ALTER operations (`alterColumnName`, `alterNewColumnName`) are free-text inputs interpolated into DDL. Added a `sanitizeIdentifier()` function that strips anything outside `[a-zA-Z0-9_]`:

```typescript
function sanitizeIdentifier(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '');
}
```

Note: existing column/table names from dropdowns (populated by the schema endpoint) are trusted and not sanitized — they come from ClickHouse itself, not user input.

### What I Intentionally Don't Sanitize

| Input | Reason |
|---|---|
| SQL Editor text | Raw SQL execution is the tool's purpose |
| Uploaded `.sql` files | Same as SQL Editor — raw execution by design |
| Table/column names from dropdowns | Already validated by ClickHouse schema |

### Tradeoff Summary

| Defense | What It Prevents | What It Costs |
|---|---|---|
| `escapeSql()` | Broken queries + injection via apostrophes | None — transparent to users |
| `JSON.parse()` | Arbitrary JS execution (self-XSS) | No JS object literal support (must use valid JSON) |
| `sanitizeIdentifier()` | Malformed DDL from special characters | Silent stripping of invalid characters |

---

## 10. Large Payload Batching — Frontend Statement Chunking

### The Problem

When uploading a `.sql` file with a massive INSERT (e.g., 10,000 rows), the JSON body sent to `POST /query` exceeds Express's default `body-parser` limit (100kb), causing a `PayloadTooLargeError`. The same issue can occur when pasting many INSERT statements into the SQL Editor.

### Decision

Handle this entirely on the **frontend** by splitting large INSERT statements into smaller chunks before sending. The server remains untouched.

**Implementation** in [`queryApi.ts`](../client/src/api/queryApi.ts):

1. **`splitLargeInsert(statement, maxBytes)`** — detects `INSERT INTO ... VALUES (...)` statements, parses the VALUES body into individual tuples via `parseValueTuples()` (respecting quoted strings and nested parentheses), then groups tuples into batches that stay under the byte limit (default: **50kb**).

2. **`chunkStatements(statements)`** — wraps splitting for an array of statements. Non-INSERT statements pass through unchanged. Returns chunk-to-original-statement mapping for result aggregation.

3. **`executeMultiStatement(sql, onProgress?)`** — orchestrates execution. After chunking, sends each chunk sequentially, calls the `onProgress` callback after each, and collapses chunked results back into a single `StatementResult` per original statement.

**Progress UI**:
- **File Upload**: Drives the `<FileUpload progress={...} />` prop (0–100) during batch execution
- **SQL Editor**: Shows batch counter on the Run button (`"Running 5/20…"`)
- **Query Builder**: Not batched (payloads are small by nature)

### Tradeoff

| Consideration | Decision |
|---|---|
| Threshold | 50kb — conservative, well under the 100kb default |
| Size estimation | `string.length` instead of `TextEncoder` — SQL is ASCII, and this avoids jsdom compatibility issues in tests |
| Error handling | If some batches fail but others succeed, the result aggregates errors: `"3 of 20 batches failed: [first error]"` |
| Non-INSERT statements | Pass through unchanged — only large INSERTs are chunked |

This keeps the server untouched and solves the problem entirely on the client, at the cost of slightly increased frontend complexity in the query execution pipeline.

---

## 11. Result Set Capping — Protecting the Frontend from Large Queries

### The Problem

A user running `SELECT * FROM large_table` without a `LIMIT` could return millions of rows, overwhelming the browser's DOM and causing the tab to freeze or crash. Even moderate result sets (e.g., 5,000 rows) degrade scrolling performance noticeably.

### Decision

Enforce a hard cap of **100 displayed rows** at the frontend level, with a deferred `COUNT()` query to report the true total.

**Implementation** in [`queryApi.ts`](../client/src/api/queryApi.ts) and [`ResultsTable.tsx`](../client/src/components/ResultsTable.tsx):

1. **LIMIT injection** — Before sending any `SELECT` query to the server, I rewrite or append `LIMIT 101`. If the user's query already has a `LIMIT` above 101, I cap it. The extra row (101 vs 100) acts as a sentinel: if 101 rows come back, I know the result set was truncated.

2. **Deferred COUNT optimization** — A parallel `COUNT()` subquery (e.g., `SELECT count() FROM (original_query)`) is prepared but **only executed if the initial query actually returns 101 rows**. For the vast majority of queries that return fewer than 100 rows, this saves an entire round-trip to the server.

3. **Visual truncation indicator** — If results are capped, the last visible rows fade out with a CSS gradient mask, and a `+N more rows` overlay appears at the bottom of the scrollable area. The footer updates to show `"Showing 100 of 200 rows"`.

### Tradeoff

| Consideration | Decision |
|---|---|
| Cap value | 100 rows — large enough to be useful, small enough to keep the DOM fast |
| COUNT execution | Deferred — only fires when needed, halving server load for small queries |
| User-specified LIMIT | Respected if ≤ 101; overridden if higher |
| UX for truncated results | Gradient fadeout + explicit row count — clear signal that data exists beyond what's shown |
