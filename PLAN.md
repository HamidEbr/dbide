# DBIDE — Product & Delivery Plan

> A fast, keyboard-first data IDE for backend developers, on macOS, Windows and Linux.
> Phase 1 engines: **MySQL, MongoDB, Redis, RabbitMQ**.

---

## 1. Positioning

DBeaver Pro covers a lot, but it is heavy (Eclipse/JVM), slow to start, and its UX is form-heavy.
Specialist tools (MongoDB Compass, RedisInsight, the RabbitMQ management UI) are each good at one
engine, so a developer debugging one request flow ends up juggling four apps.

**Pitch:** one fast tool for everything a backend service touches — its SQL tables, its Mongo
documents, its Redis keys and its queues — with the same shortcuts, grid, value viewer and safety
rails everywhere.

**Who it is for:** backend developers and on-call engineers first, DBAs second. That settles most
trade-offs: the speed of *find → inspect → fix* beats admin depth.

## 2. Competitors and what we borrow

### 2.1 How the big three compare

| | DataGrip (JetBrains) | DBeaver (Lite / Enterprise / Ultimate) | dbForge Studio for MySQL (Devart) |
|---|---|---|---|
| **Best at** | SQL code intelligence: completion, inspections, navigation, refactoring, local history | Breadth (100+ databases), data-editor side panels, ER diagrams, data transfer, task scheduler, connection policies | MySQL productivity and automation: query profiler, schema/data compare, data generator, documenter, CLI for everything |
| **MongoDB** | Query console; secondary | JavaScript scripts and a limited SQL-to-Mongo subset (paid editions) | None |
| **Redis** | Key browser with hierarchical keys (2025.3), console | Key browser, value viewer, console (paid editions) | None |
| **RabbitMQ** | None | None | None |
| **Weak spots** | Heavy JVM IDE; NoSQL is an afterthought; subscription | Eclipse UI, slow start; the best features sit in paid editions | Windows-native (.NET); macOS/Linux only through CrossOver; MySQL only, one product per engine |
| **Recent direction** | AI agents, MCP tools, a CLI (2026.2); query files instead of consoles (2025.3) | AI assistant, cloud explorers, team edition | AI assistant, CLI automation |

**The gap we fill:** none of them handles RabbitMQ, all of them treat MongoDB and Redis as second-class,
and none is light. We take their best SQL ideas and apply them to all four engines.

### 2.2 What we take

| From | Feature | Where it lands |
|---|---|---|
| DataGrip | Schema-aware inspections with quick-fixes | P2 |
| DataGrip | ⌘-click go-to-definition and find usages across saved scripts | P2 |
| DataGrip | Rename refactoring that also updates saved scripts | P3 |
| DataGrip | Scripts as real files + automatic local history | P1 |
| DataGrip | Aggregates of the selected cells, transpose / record view | P1 |
| DataGrip | Compare two result sets | P2 |
| DataGrip | Search a value across the whole database → **we extend it across all four engines** | P2 |
| DataGrip | Run one script on many connections | P2 |
| DataGrip | Lazy introspection levels for huge schemas | P1 |
| DataGrip | MCP server so AI agents can work through your connections | P3 |
| DBeaver | Connection types (Dev / Test / Prod) as policy bundles | P1 |
| DBeaver | Generate SQL from selected rows → **we extend to Mongo and Redis** | P1 |
| DBeaver | Data-editor side panels: references, grouping, charts | P2 |
| DBeaver | Password from a shell command; hooks before/after connect | P2 |
| DBeaver | Data transfer between connections with column mapping | P3 |
| DBeaver | Saved tasks and a scheduler | P3 |
| DBeaver | Navigator filters per connection | P1 |
| dbForge | Query profiler that **compares runs** (before/after an index) → **we extend to Mongo explain** | P2 |
| dbForge | Formatter with shared profiles | P1 / P2 |
| dbForge | Master-detail browser | P2 |
| dbForge | Backup / restore, copy a database between servers | P2 |
| dbForge | Find invalid objects | P2 |
| dbForge | Schema compare and data compare with sync scripts | P3 |
| dbForge | Data generator with realistic, FK-aware generators → **we extend to Mongo documents** | P3 |
| dbForge | Documenter → **we extend to a whole service: schema, Mongo shapes, Redis namespaces, RabbitMQ topology** | P3 |
| dbForge | CLI for compare, export, backup and docs, usable in CI | P3 |
| dbForge | Pivot table on results | P3 |

### 2.3 What we skip on purpose

- **Stored-procedure debugger** (dbForge, DBeaver for PostgreSQL). MySQL has no debug API, and backend developers rarely need one.
- **Report designer, Tableau integration, cloud storage explorers, web edition, enterprise SSO / RBAC.** Not developer workflows; revisit only if a team edition happens.
- **50–100 database engines.** We go deep on four, then add engines one at a time.

## 3. UX principles

1. **Keyboard-first.** Everything is reachable from the command palette; the mouse is optional.
2. **Never block.** Every query, scan and export is cancellable and runs in the background.
3. **Safe by default.** Production looks different and is read-only until you say otherwise.
4. **Same patterns across engines.** One grid, one value viewer, one filter style, one set of shortcuts.
5. **Zero-config start.** Paste a URI or pick a Docker container and you are connected.
6. **Progressive disclosure.** Simple view first; admin depth is one click away.
7. **Native on every OS.** Each platform gets its own shortcuts, menus, window controls and theme behavior from one codebase.

## 4. Feature catalog

Phase tags: **P1** = MVP (this phase) · **P2** = power features · **P3** = Pro / differentiators.
Source tags: **[DG]** DataGrip · **[DB]** DBeaver · **[DF]** dbForge. Untagged items are ours or table stakes.

### 4.1 Core platform (shared by all engines)

**Connections**
- **P1** Connection manager with folders and search
- **P1** Connection types (Dev / Test / Prod) as policy bundles: color, read-only, confirm-before-execute, auto-commit default **[DB]**
- **P1** Paste a URI (`mysql://`, `mongodb+srv://`, `redis(s)://`, `amqp(s)://`) and the form fills itself
- **P1** SSH tunnel: password, key, ssh-agent, hosts from `~/.ssh/config`, jump host
- **P1** TLS: CA, client certificate, skip-verify for local
- **P1** Secrets stored in the OS keychain, never in config files
- **P1** Step-by-step connection test (DNS → TCP → TLS → auth) that names the failing step
- **P1** Keepalive and auto-reconnect
- **P2** Discover local Docker containers and offer one-click connections
- **P2** Built-in Kubernetes port-forward (context → namespace → service/pod)
- **P2** Password from a shell command (e.g. `vault kv get …`, `aws rds generate-db-auth-token`) and hooks before/after connect **[DB]**
- **P2** Import connections from DBeaver, DataGrip, TablePlus, `.env` and `docker-compose.yml`
- **P2** SOCKS / HTTP proxy
- **P3** AWS SSM tunnel **[DB]**
- **P3** Team connection definitions shared through git (no secrets); secret references to 1Password / Vault

**Workspace and navigation**
- **P1** Sidebar tree, tabs, split panes, status bar showing connection / database / transaction state
- **P1** Command palette (⌘⇧P) and *Go to anything* (⌘P) across tables, collections, keys and queues of all open connections
- **P1** Navigator filters: hide schemas, tables, key prefixes or vhosts by pattern, per connection **[DB]**
- **P1** Lazy introspection levels, so schemas with 10k+ tables open instantly **[DG]**
- **P1** Session restore on restart, including unsaved scripts
- **P1** Dark / light theme that follows the OS, density setting, custom keybindings
- **P2** Find in data: search a value (an order ID, an email) across MySQL tables, Mongo collections, Redis keys and queue messages, as a cancellable task **[DG, extended]**
- **P2** Bookmarks on objects, rows and script lines **[DG]**
- **P2** Vim mode in editors
- **P2** Service workspaces: group a MySQL schema, a Mongo database, a Redis key prefix and a RabbitMQ vhost as one service (e.g. `order-service`)

**Scripts and history**
- **P1** Scripts are real files in the workspace folder (git-friendly), not hidden consoles **[DG]**
- **P1** Local history: every script change is versioned automatically, with diff and restore **[DG]**
- **P1** Per-connection query history: searchable, with duration, row count and status; one-click re-run
- **P1** Snippets and live templates with tab stops and `${variables}` **[DG] [DF]**
- **P2** Run one script on several connections at once (all shards, or staging + prod), results per target **[DG]**
- **P3** Notebooks mixing SQL, Mongo, Redis and publish-message cells — runbooks and incident playbooks saved as files

**Editor intelligence** (SQL first; Mongo shell and Redis console get the same where it applies)
- **P1** Formatter **[DF]**
- **P1** Dangerous statements highlighted as you type
- **P2** Inspections with quick-fixes: unresolved or ambiguous columns, unused aliases, type mismatches **[DG]**
- **P2** ⌘-click a table or column to open it; find its usages across saved scripts **[DG]**
- **P2** Inlay hints: column names beside `INSERT … VALUES` **[DG]**
- **P2** Shared formatter profiles stored in the workspace **[DF]**
- **P3** Rename refactoring: rename a column → `ALTER` plus updated saved scripts, previewed first **[DG] [DF]**

**Results and values**
- **P1** Virtualized result grid that streams in batches and handles millions of rows
- **P1** Value viewer panel with auto-detection: JSON, JWT, base64, gzip, hex, Unix timestamps, PHP `serialize`, images
- **P1** Aggregates of the selected cells in the status bar: count, sum, avg, min, max **[DG] [DB]**
- **P1** Record view: one row or document as a form; transpose **[DG] [DB] [DF]**
- **P1** Pin a result tab; run into a new tab **[DB]**
- **P1** Copy as CSV, TSV (pastes into spreadsheets), JSON, Markdown, SQL `INSERT`
- **P1** Generate code from selected rows: SQL `INSERT`/`UPDATE`/`DELETE`, Mongo `insertMany`/`updateOne`, Redis commands that recreate a key **[DB, extended]**
- **P1** Export to CSV / JSON / NDJSON / SQL as a background task
- **P2** Compare two result sets side by side **[DG]**
- **P2** Master-detail: parent and child rows of the selection in a split panel **[DB] [DF]**
- **P2** Group-by and charts on a result set without writing a query **[DB]**
- **P2** Import CSV / JSON with column mapping
- **P2** Protobuf (import `.proto` files) and MessagePack decoding
- **P2** Excel / Parquet export
- **P3** Pivot table on a result set **[DF]**
- **P3** Custom export formats from templates **[DG]**

**Safety**
- **P1** Production guardrails from the connection type: read-only by default, colored window border, type-the-name confirmation for destructive actions
- **P1** Dangerous-statement detection: `UPDATE`/`DELETE` without `WHERE`, `DROP`/`TRUNCATE`, `FLUSHALL`/`FLUSHDB`, `KEYS *`, queue purge
- **P1** Auto-commit vs manual-transaction indicator; warning on close with a pending transaction
- **P2** Audit log of write operations per connection

**Automation**
- **P3** Data transfer between connections with column mapping (MySQL → MySQL, and Mongo ↔ MySQL) **[DB] [DF]**
- **P3** Saved tasks (export, backup, compare, run script) on demand or on a schedule **[DB] [DF]**
- **P3** `dbide` CLI for connections, export, compare, backup and docs — usable in CI **[DF] [DG]**
- **P3** Service documenter: HTML / Markdown docs covering the MySQL schema, inferred Mongo shapes, Redis namespaces and RabbitMQ topology **[DF, extended]**

**AI**
- **P3** Assistant: natural language → SQL / Mongo / Redis, explain a query or plan, fix an error. Bring-your-own key; schema-only context, opt-in per connection
- **P3** MCP server, so agents such as Claude Code can query through your connections under the same guardrails **[DG]**

**Platform**
- **P1** Background task manager with progress and cancel
- **P1** Signed installers and auto-update on macOS, Windows and Linux (section 6)
- **P1** Opt-in crash reporting; no telemetry by default
- **P1** First-run tour of the explorer, connection setup, scripts and results **[DG]**
- **P3** Public plugin API for new engines

### 4.2 MySQL (also MariaDB, Percona)

**Browse**
- **P1** Tree: databases → tables, views, routines, triggers, events; lazy-loaded and filterable, with row count and size
- **P1** DDL view for any object

**Query**
- **P1** SQL editor: highlighting, schema-aware autocomplete (tables, columns, aliases, FK-based `JOIN` suggestions)
- **P1** Run statement under cursor, selection or whole script (⌘↵ / ⌘⇧↵); one result tab per statement
- **P1** Cancel a running query (`KILL QUERY` from a side connection)
- **P1** Query parameters (`:id`, `?`) prompted on run
- **P2** Hover a table name to peek its columns and first rows
- **P3** Visual query builder **[DB] [DF]**

**Data**
- **P1** Table data view with server-side filter, sort and paging
- **P1** Inline edit / insert / delete → staged-changes panel with the generated SQL → commit or roll back
- **P1** Click a foreign-key value to jump to the referenced row
- **P1** JSON column editor

**Performance**
- **P2** `EXPLAIN` / `EXPLAIN ANALYZE` visualizer with full-scan and filesort warnings
- **P2** Query profiler: plan plus session status counters per run, and a side-by-side **compare of two runs** (before/after an index) **[DF]**
- **P2** Process list with kill, status and variables, InnoDB status, locks and deadlocks

**Design**
- **P2** Table designer (columns, indexes, FKs) that generates `ALTER` with a diff preview **[DF]**
- **P2** ER diagram generated from foreign keys **[DB] [DF]**
- **P2** Find invalid objects: views and routines that reference dropped tables or columns **[DF]**
- **P3** ER edit mode that generates the `ALTER` script **[DB] [DF]**

**Admin and lifecycle**
- **P2** Users, roles and grants **[DF]**
- **P2** Backup and restore (schema, data or both); copy a database between servers **[DF] [DB]**
- **P3** Schema compare between two connections → sync script, also from the CLI **[DF] [DB]**
- **P3** Data compare → sync script **[DF] [DB]**
- **P3** Data generator with realistic, FK-aware generators (names, emails, addresses, dates) **[DF]**
- **P3** Schema and reference data in git, with diff and commit **[DF]**

### 4.3 MongoDB

**Browse**
- **P1** Tree: databases → collections, views, indexes, with document count and size
- **P1** SRV / Atlas, replica sets, read preference, SCRAM and X.509 auth

**Query**
- **P1** Query bar (filter, projection, sort, limit, skip) with field-name autocomplete from a sampled schema
- **P1** Shell / script editor with mongosh syntax (`db.orders.find({...}).sort(...)`) and method and field autocomplete
- **P1** Results as flattened table, tree or JSON; switch with one key
- **P2** Aggregation pipeline builder: edit stage by stage with a live preview of each stage's output
- **P2** Export a query or pipeline as driver code (Go, PHP, Python, Node, Java)
- **P3** SQL `SELECT` → Mongo query translation **[DB]**

**Data**
- **P1** EJSON-aware document editor (`ObjectId`, `ISODate`, `NumberDecimal`, `Long`); insert, clone, delete
- **P1** Bulk update / delete by filter, with a count preview first
- **P3** Collection compare between two environments → sync script **[DF, extended]**
- **P3** Document generator driven by the inferred schema **[DF, extended]**

**Analysis and ops**
- **P1** Index list; create and drop indexes
- **P2** Explain-plan visualizer (COLLSCAN, index used, docs examined vs returned), with compare of two runs **[DF, extended]**
- **P2** Schema analyzer: sample N documents → field types, presence %, type conflicts (e.g. `price` is a string in 3% of documents)
- **P2** Change-stream tail: watch a collection live
- **P2** `currentOp` / `killOp`, server status, replica set status
- **P2** Charts view of a result **[DB]**
- **P3** GridFS browser
- **P3** JSON Schema validation-rule editor

### 4.4 Redis (also Valkey, KeyDB, Dragonfly, ElastiCache)

**Browse**
- **P1** Key browser built on `SCAN` (never `KEYS *`): namespace tree with a configurable separator **[DG] [DB]**, pattern and type filters, TTL and type per key, lazy paging
- **P1** DB index switcher; standalone, Sentinel and Cluster modes; ACL users; TLS
- **P1** Per-key memory usage on demand

**Edit**
- **P1** Type-aware editors: string, hash, list, set, sorted set (score editing), stream (entries, consumer groups, pending)
- **P1** String values go through the shared value viewer (JSON, PHP `serialize`, gzip, msgpack…)
- **P1** Create, rename, duplicate, set or clear TTL, delete
- **P1** Bulk delete by pattern: preview the count, then batched `SCAN` + `UNLINK` as a cancellable task
- **P2** RedisJSON, bitmap and HyperLogLog viewers

**Console and ops**
- **P1** CLI console with command autocomplete, inline syntax hints and history
- **P1** `INFO` dashboard: memory, ops/sec, hit ratio, clients, keyspace
- **P2** Pub/Sub: subscribe to channels or patterns, publish, live message list
- **P2** `SLOWLOG` viewer; `CLIENT LIST` with kill
- **P2** Big-key / memory analyzer (sampled scan, grouped by namespace)
- **P2** `MONITOR` stream (with a load warning; disabled on prod)
- **P3** Lua script / Functions editor

### 4.5 RabbitMQ

Two channels: the **Management HTTP API** (topology, stats, peek) and **AMQP 0-9-1** (publish,
consume, tail). P1 requires the management plugin on the broker. None of the three competitors
supports RabbitMQ, so everything here is ours.

**Browse**
- **P1** Overview: nodes, version, message rates, connections, channels
- **P1** Tree: vhosts → exchanges, queues (classic / quorum / stream), bindings
- **P1** Queue detail: ready and unacked counts, rates, consumers, arguments (DLX, TTL, max-length)

**Messages**
- **P1** Peek messages with payload decoding, headers and properties. Peek requeues the message, which marks it redelivered; the UI says so.
- **P1** Publish to an exchange with routing key, headers and properties; saved message templates
- **P1** Purge or delete a queue behind the prod guard
- **P1** Create and delete exchanges, queues and bindings through forms
- **P2** Dead-letter workflow: inspect a DLQ, requeue selected messages to their original exchange (from the `x-death` header)
- **P2** Move or copy messages between queues
- **P2** Live tail: bind a temporary exclusive queue to an exchange with a routing pattern to watch traffic
- **P2** Topology graph: exchange → binding → queue diagram with live rates
- **P2** Replay a message; bulk publish from a file

**Admin**
- **P2** Connections and channels list with close
- **P2** Policies, users, permissions, vhosts
- **P3** Definitions export / import and diff between environments
- **P3** Streams: read from an offset or timestamp

### 4.6 Differentiators to lead with

1. **One tool for the whole service** — SQL, documents, cache and queues with the same navigation and safety.
2. **First-class Mongo, Redis and RabbitMQ** — where DataGrip and DBeaver are thin and dbForge is absent.
3. **DataGrip-grade SQL intelligence and dbForge-grade tooling in a light, fast app.**
4. **The same polished app on macOS, Windows and Linux** — dbForge is Windows-only, DBeaver looks like Eclipse everywhere.
5. **Instant connect** — paste a URI, Docker discovery, Kubernetes port-forward.
6. **Find in data across all engines** — paste an order ID, see every table, document, key and message that holds it.
7. **Universal value viewer** — decode any blob (JSON, PHP `serialize`, protobuf, gzip, JWT) in any engine.
8. **Debug workflows others handle poorly** — Redis bulk ops by pattern, Mongo type-conflict detection, RabbitMQ DLQ requeue and live tail.

## 5. Architecture

### 5.1 Stack

Cross-platform consistency is a first-order goal, and that settles the stack:
**Electron + TypeScript + React.** Tauri 2 + Rust remains the alternative only if a small install
size matters more than identical behavior on every OS.

| | Electron + TypeScript | Tauri 2 + Rust |
|---|---|---|
| Rendering engine | The same Chromium on macOS, Windows and Linux — one target to design and QA | WebKit on macOS, Chromium (WebView2) on Windows, WebKitGTK on Linux — three engines to test |
| Linux | Same as the other OSes | WebKitGTK is the weak spot: slower canvas and scrolling, GPU and Wayland quirks |
| Footprint | ~100+ MB install, 150+ MB RAM | ~15–30 MB install, low RAM, fast start |
| Mongo shell | Embed the mongosh runtime that Compass uses — full compatibility | Build a mongosh subset on an embedded JS engine (risk) |
| Drivers | `mysql2`, `mongodb`, `ioredis`, `amqplib` | `mysql_async`, `mongodb`, `fred`, `lapin` |
| Languages | TypeScript everywhere: UI, core, CLI, MCP server | Rust core + TypeScript UI |
| Track record for this kind of app | VS Code, MongoDB Compass, RedisInsight, Beekeeper Studio | Fewer large, data-heavy desktop apps so far |

Electron's footprint is real but manageable (see 5.3). DBeaver and DataGrip are JVM apps that use
more memory than a well-built Electron app, so we still win on feel against them.

### 5.2 Process model

```
┌─────────────── Renderer (React + TypeScript, sandboxed, one per window) ──────────────┐
│ Shell: title-bar tabs · navigator · editor · results · inspector · status bar         │
│ Design system: tokens · components · themes                                           │
│ Engine panels (lazy-loaded): SQL · Mongo · Redis · RabbitMQ                           │
└───────────────▲───────────────────────────────────────────────────────────────────────┘
                │ MessagePort: commands, streamed result batches (transferable buffers), cancel
┌───────────────┴──────────────────── Core (Electron utility process, Node.js) ─────────┐
│ Session manager: connections, pools, cancellation, reconnect                          │
│ Transport: SSH tunnels · TLS · k8s port-forward · Docker discovery                    │
│ Drivers: mysql2 · mongodb + mongosh runtime · ioredis · amqplib + Management API      │
│ Language services: SQL parser, resolver, inspections, formatter                       │
│ Codecs: JSON · EJSON · PHP serialize · gzip · msgpack · protobuf                      │
│ Storage: SQLite (history, local history, settings, metadata) · result spill to disk   │
│ Task runner: background jobs with progress and cancel                                 │
└───────────────▲───────────────────────────────────────────────────────────────────────┘
                │
┌───────────────┴──────────────────── Main process (thin) ──────────────────────────────┐
│ Windows · native menus · secrets (OS keychain) · auto-update · deep links · file assoc│
└───────────────────────────────────────────────────────────────────────────────────────┘
```

### 5.3 Key design decisions

- **Capability-based drivers, not a lowest-common-denominator SQL layer.** Every driver implements
  `connect`, `test`, `children(node)` for the navigator, `execute(request) → stream of batches` and
  `cancel(id)`. Optional capabilities — `Tabular`, `Documents`, `KeyValue`, `Messaging`, `Explain`,
  `Edit`, `Search` — light up shared UI; engine panels cover the rest. Adding PostgreSQL or Kafka later
  means a new driver and maybe one panel.
- **Core in a utility process.** Drivers, tunnels and parsing never run in the renderer or the main
  process, so a slow query or a crash in a driver can't freeze the UI or kill the window.
- **Streamed results, held in the core.** Rows and documents arrive in batches of ~500–1000. The core
  keeps the result (spilling to disk past a limit); the renderer only holds what is on screen plus a
  buffer. This keeps memory flat on million-row results.
- **Staged edits.** Edits are collected in the UI and compiled by the driver into statements the user
  previews before commit.
- **Secrets only in the OS keychain.** Config files reference secrets by id, so they can be committed and shared.
- **SQL language service in the core.** DataGrip-style inspections, go-to-definition and rename need
  a real parser and a resolver against the introspected schema, not regex-based completion. Plan the
  service in M1 and grow it in Phase 2.
- **One command registry.** Every action is a command with an id, a title, a default shortcut per OS
  and an enablement rule. Palette, menus, context menus, toolbars and keybindings all read from it.
- **Headless core.** The core runs without the UI, so the P3 CLI and MCP server reuse it as is.
- **Security hardening.** Data from databases is untrusted: never render it as HTML. Renderer runs
  with `contextIsolation`, `sandbox` and no Node integration; strict CSP; IPC messages validated in
  the core; Electron fuses set (no `RunAsNode`, asar integrity); Electron kept on a supported major.
- **Memory budget.** One renderer per window (tabs are React views, not separate web views), engine
  panels lazy-loaded, idle connections closed. Target: under 300 MB with four connections open.

### 5.4 Building blocks

| Area | Choice |
|---|---|
| App shell and build | Electron, Vite (`electron-vite`), `electron-builder` for packaging and auto-update |
| UI | React, TypeScript, Radix primitives, our own design tokens, Storybook |
| Editor | CodeMirror 6 (modular, fast with big files); Monaco is a fine alternative now that Chromium is everywhere |
| Grid | Glide Data Grid (canvas; millions of rows) with an accessible keyboard and screen-reader layer |
| State | Zustand + TanStack Query |
| Palette and diagrams | `cmdk`; React Flow for ER diagrams and the RabbitMQ topology graph |
| MySQL | `mysql2`; `dt-sql-parser` (MySQL grammar) as the starting point for the language service |
| MongoDB | `mongodb` driver + the mongosh runtime packages for the shell |
| Redis | `ioredis` (Cluster and Sentinel) |
| RabbitMQ | `amqplib` + Management HTTP API |
| Transport | `ssh2` (agent, jump hosts, Windows named-pipe agent), `@kubernetes/client-node`, `dockerode` |
| Storage and secrets | Node's built-in `node:sqlite` (no native module to rebuild per OS); Electron `safeStorage` backed by Keychain / DPAPI / libsecret |
| Toolchain | Electron 45 (Node 24), Vite 8 via `electron-vite` 6, React 19, TypeScript 6 (held below 6.1 because `typescript-eslint` does not support TypeScript 7 yet), Vitest 5, pnpm 12 |

### 5.5 Testing

- Driver integration tests against Docker (testcontainers) across a version matrix:
  MySQL 5.7 / 8.0 / 8.4, MariaDB 10.11 / 11, MongoDB 6 / 7 / 8, Redis 7 / Valkey 8, RabbitMQ 3.13 / 4.x.
- SQL language-service tests on a corpus of real-world queries.
- UI component tests (Vitest) and Storybook visual-regression screenshots.
- End-to-end smoke tests (Playwright driving Electron) on macOS, Windows and Linux.
- Performance budgets checked in CI (section 7.5).

## 6. Cross-platform strategy

**Goal:** one codebase, three apps that each feel native. Everything is shared except a thin
platform layer.

### 6.1 What is shared and what is per-OS

| Layer | Shared | Per OS |
|---|---|---|
| UI | All components, design system, bundled fonts, themes | Window controls, menu placement, shortcut glyphs |
| Core | Drivers, tunnels, codecs, language services, storage | Secret-store backend, SSH-agent transport, file paths |
| Delivery | Build pipeline, update feed format | Installer format, code signing, package managers |

### 6.2 Platform-layer checklist

- **Shortcuts.** Define every shortcut with `Mod` (⌘ on macOS, Ctrl on Windows / Linux). Match letter
  shortcuts on the physical key (`event.code`), not the typed character, so they still work with
  Persian, Arabic, Russian and other non-Latin keyboard layouts. Avoid Ctrl+Alt combinations on
  Windows (they collide with AltGr). Show the right glyphs: ⌘⇧P on macOS, Ctrl+Shift+P elsewhere.
- **Menus.** macOS gets a native menu bar with the standard roles (App, File, Edit, View, Window,
  Help) so ⌘C / ⌘V / ⌘Q work in every field. Windows and Linux get a compact in-window menu built
  from the same command registry.
- **Window chrome.** The tab strip lives in the title bar (like VS Code and Arc). macOS: inset traffic
  lights. Windows: title-bar overlay that keeps the native minimize / maximize / close buttons and
  Windows 11 snap layouts. Linux: native decorations by default (Wayland and X11 vary), custom
  title bar as an option.
- **Secrets.** Keychain on macOS, DPAPI on Windows, Secret Service (libsecret / KWallet) on Linux.
  If a Linux desktop has no secret service, never fall back to plain text silently: ask for a master
  password and encrypt locally.
- **SSH agent.** Unix socket (`SSH_AUTH_SOCK`) on macOS / Linux; OpenSSH named pipe or Pageant on Windows.
- **Paths.** OS-standard config, data and cache folders; never hardcode `/` or `~`.
- **Fonts.** Bundle the UI and monospace fonts so text metrics, column widths and editor layout are
  identical everywhere. Include a fallback with Persian / Arabic glyphs (e.g. Vazirmatn) and test
  right-to-left and mixed-direction text in grid cells and the value viewer.
- **HiDPI.** The canvas grid redraws when the device pixel ratio changes (moving a window between
  monitors, fractional scaling on Windows and Linux).
- **Scrollbars.** Styled in-app, so macOS overlay scrollbars and Windows classic ones don't change layout widths.
- **OS integration.** File associations for `.sql` and `.mongodb.js`; `dbide://` links that open a
  saved connection by name (never with secrets in the link); native notifications when a background
  task finishes; follow the OS light / dark setting, reduced motion and high contrast.

### 6.3 Packaging and distribution

| | macOS | Windows | Linux |
|---|---|---|---|
| Formats | DMG + ZIP, Apple Silicon and Intel | NSIS installer, MSI for IT-managed machines, x64 and arm64 | AppImage, `.deb`, `.rpm`; Flatpak later |
| Signing | Developer ID, hardened runtime, notarization | Authenticode code-signing certificate, so SmartScreen doesn't warn | Signed package repositories and checksums |
| Updates | Auto-update from a signed feed | Auto-update from a signed feed | AppImage auto-update; apt / dnf repository for `.deb` / `.rpm` |
| Package managers | Homebrew cask | winget, Scoop | apt / dnf repository; Flathub later |

### 6.4 CI and testing per OS

- Every pull request builds and runs smoke tests on macOS (Apple Silicon), Windows and Ubuntu runners.
- Linux builds on the oldest supported Ubuntu LTS, so the AppImage runs on older glibc.
- Driver integration tests run once, on Linux with Docker; UI smoke tests and screenshots run on all three.
- Release checklist per OS: clean install, update from the previous version, keychain access, SSH
  agent, HiDPI and fractional scaling, a non-Latin keyboard layout, light and dark mode.
- Dogfood on all three: make sure someone on the team uses each OS daily.

## 7. UI/UX design

### 7.1 Who to learn from

| Product | What to take |
|---|---|
| VS Code | Shell layout, command palette, keybinding editor, themes as token files |
| DataGrip | Search Everywhere, quick-fixes on ⌥↵, a run button in the gutter beside each statement |
| Linear, Raycast | Speed as a feature, keyboard-first flows, crisp typography, restraint |
| TablePlus | Calm data editing, staged changes, native feel |
| Compass, RedisInsight | Engine-specific flows: the query bar, the key browser |

### 7.2 Main window

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│ ● ● ●  [orders.sql] [users] [cache:order:*] [orders.dlq]                 PROD ▮▮ │ ← tabs in the title bar
├─────────────┬─────────────────────────────────────────────────┬───────────────────┤
│ Navigator   │ Editor / object view                            │ Inspector         │
│ ⌕ filter    │ SQL · Mongo shell · Redis key · queue           │ Value · Record ·  │
│ ▾ prod      │                                                 │ References        │
│   ▸ mysql   ├─────────────────────────────────────────────────┤                   │
│   ▸ mongo   │ Results — one tab per statement                 │ (collapsible)     │
│   ▸ redis   │                                                 │                   │
│   ▸ rabbit  │                                                 │                   │
├─────────────┴─────────────────────────────────────────────────┴───────────────────┤
│ ● PROD · read-only · mysql 8.4 · shop · auto-commit │ 2 tasks │ Σ sum 29,437      │ ← status bar
└───────────────────────────────────────────────────────────────────────────────────┘
```

- **Tabs in the title bar.** Saves vertical space. Each tab shows an engine icon and its connection's environment color.
- **Navigator (left).** Every connection in one tree with a filter box on top.
- **Editor / object view (center).** Scripts, tables, collections, keys and queues all open as tabs; split right for side-by-side.
- **Results (below the editor).** One tab per statement; resizable; can pop out into its own tab.
- **Inspector (right, collapsible).** Value, record and references for the current selection — the same panel in every engine.
- **Status bar.** Environment badge, read-only lock, server and database, transaction state, running tasks, selection aggregates.
- **Environment tint.** A thin border in the environment color around the whole window, plus the
  badge. Production is never subtle.

### 7.3 Design system

- **Foundation.** Radix primitives for accessible behavior, our own tokens on top, Storybook as the
  component catalog. Light and dark from day one; a theme is just a token file, so user themes come free.
- **Typography.** Inter for the UI at 13 px; JetBrains Mono for code and data at 12–13 px. Tabular
  figures in grids, numbers right-aligned.
- **Spacing and density.** 4 px base unit. Three densities: compact (24 px rows), default (28 px), comfortable (32 px).
- **Color.** Neutral grays plus one accent (blue). Red, amber and green are reserved for status and
  environment meaning, so a red border always means production.
- **Environment colors.** Local gray, dev green, staging amber, prod red; overridable per connection.
- **Data in cells.** `NULL` in dim italics, empty string as a dim `""`, dates in one consistent
  format with relative time on hover, JSON / BSON truncated with an expand chevron, binary as a hex
  preview, `ObjectId` with its embedded timestamp on hover. Type badges for Redis types and BSON types.
- **Icons.** One set (Lucide) at 16 px, plus engine glyphs.
- **Motion.** 100–150 ms, only to orient (panels, popovers), never on data. Off when the OS asks for reduced motion.
- **Contrast.** WCAG AA in both themes; a visible focus ring on every interactive element.

### 7.4 Interaction rules

1. **Teach shortcuts while people click.** Shortcuts appear in tooltips, menus and palette results.
2. **Feedback by duration.** Under 100 ms: no indicator. 100 ms–1 s: inline spinner. Over 1 s:
   progress and a Cancel button. Over 10 s: offer to move it to the background and notify on finish.
3. **Inline over modal.** Filters, edits and non-destructive confirmations happen in place. Dialogs
   only for destructive confirmations and the connection editor.
4. **Undo wherever possible.** Reopen a closed tab, discard staged edits, restore a script from local history.
5. **Empty states teach.** No connections yet → "Paste a URI", "Find Docker containers", "Import from DBeaver / DataGrip".
6. **Errors explain and offer a fix.** What failed, the server's message verbatim, and the next action:
   "Access denied" → *Edit credentials*; ``Unknown column `stauts` `` → *Did you mean `status`?*
7. **Same toolbar, same shortcuts in every engine.** Run, Cancel, Filter, Refresh, Export, Inspector sit in the same place everywhere.
8. **Remember state.** Tab layout, column widths, filters and inspector visibility per object.
9. **Never truncate silently.** "1,000 of ~2.3M rows · Load more · Fetch all".

### 7.5 Performance budgets

| Interaction | Budget |
|---|---|
| Cold start to usable window | < 1.5 s |
| Open palette / each keystroke in it | < 50 ms |
| Typing latency in the editor | < 16 ms |
| Grid scroll | 60 fps on 1M rows |
| Switch tabs | < 100 ms |
| Memory with four connections open | < 300 MB |

### 7.6 Accessibility

- Full keyboard use, including the grid: arrows to move, Enter to edit, Esc to cancel, Space for the inspector.
- Screen-reader labels everywhere, and an accessible grid layer mirroring the canvas grid.
- UI zoom (⌘+ / ⌘−) independent of the OS; a high-contrast theme.

### 7.7 Design process

1. **Wireframe six core screens:** main shell, connection editor, SQL editor + results, Redis key
   browser, Mongo documents, RabbitMQ queue detail.
2. **Task-test the wireframes with five developers from your team:** "find order 9812 in every
   system", "requeue the failed messages from the DLQ", "delete the cache keys for user 42".
3. **Benchmark the same tasks in DBeaver and DataGrip:** count clicks, keystrokes and seconds. Beat them.
4. **High-fidelity design in Figma,** with tokens that map one-to-one to CSS variables.
5. **Build components in Storybook first,** with visual-regression screenshots on all three OSes.
6. **Dogfood every milestone;** track time to first query and palette usage (opt-in).

## 8. Roadmap

### Phase 1 — MVP of all four engines

Estimates assume one full-time developer; two developers roughly halve the calendar time.

| Milestone | Scope | Estimate |
|---|---|---|
| **Design sprint** (overlaps M0) | Wireframes of the six core screens, task tests with five developers, tokens and visual direction in Figma | 2 weeks |
| **M0 Foundations** | Electron + Vite + React scaffold, process model, design tokens + Storybook core components, shell with title-bar tabs, command registry + palette, themes, settings, SQLite store, secrets, connection manager with SSH/TLS and connection types, driver interface, CI building and smoke-testing on macOS / Windows / Linux | 4 weeks |
| **M1 MySQL** | Tree with filters and lazy introspection, SQL editor with autocomplete and formatter, run/cancel, streamed grid, value viewer, selection aggregates, record view, staged edits, generate SQL from rows, scripts as files + local history, query history, export | 5 weeks |
| **M2 Redis** | SCAN tree, type editors, TTL, bulk delete, CLI console, INFO dashboard (first pass done: see _M2 status_) | 3 weeks |
| **M3 MongoDB** | Tree, query bar, table/tree/JSON views, EJSON editing, mongosh shell, indexes (first pass done: see _M3 status_) | 4 weeks |
| **M4 RabbitMQ** | Overview, topology tree, queue detail, peek, publish, purge, create/delete (first pass done: see _M4 status_) | 3 weeks |
| **M5 Beta polish** | Prod guardrails end to end, URI paste, session restore, first-run tour, per-OS signing and installers, auto-update, Homebrew / winget listings, performance and accessibility pass | 3 weeks |

**About 22 weeks to a Phase 1 beta.** The design sprint runs alongside M0; M0 grew by a week for
the design system and three-OS CI.

Why this order: MySQL first because it forces the hard shared pieces — editor, streamed grid, edit
staging, tree — that every other engine reuses. Redis next: the smallest engine, and it proves the
model works for non-SQL data. MongoDB reuses all of that plus the shell. RabbitMQ last: it is the
least like a database and is mostly the HTTP API plus forms.

Ship an internal build on all three OSes after every milestone and use it daily; dogfooding is the UX test.

#### M0 status

Built and verified on macOS (Apple Silicon): the three-process architecture with a supervised core,
typed cancellable RPC over `MessagePort`, SQLite storage with migrations, the OS-keychain secret store,
connection model with environment policies and URI paste, the step-by-step connection test, the command
registry and palette, design tokens with light/dark and density, the title-bar tab shell, ESLint layering
rules, 121 unit tests, and an end-to-end smoke test that boots the real app. The CI workflow for all three
OSes is written but has not run yet.

Still open in M0: SSH tunnels (the config model and the failing-clearly test step exist), Storybook with
the core components, the per-OS signing setup, and running the smoke test on Windows and Linux.

#### M1 status

Built: the MySQL driver (`mysql2`, text protocol with exact types, one connection per script, server
enforced read-only, `KILL QUERY` cancel, backpressure), the lazy schema tree down to columns, indexes and
foreign keys, a CodeMirror 6 editor with MySQL highlighting, schema-aware autocomplete, a formatter and
run-statement / run-script / cancel, the statement splitter (`DELIMITER`, comments, quoted text), a
classifier that guards writes and destructive statements, and a virtualized result grid with paging,
selection, keyboard navigation, column resize, copy as TSV / CSV / JSON / Markdown / SQL INSERT, and
sum / average / min / max of the selection. unit tests plus an end-to-end smoke test against a demo engine.

**Verified against real servers** (MySQL 5.5.62, 5.6.51, 5.7.44, 8.0.46, 8.4.13 and MariaDB 11.8.9, in Docker;
the 5.x images run under amd64 emulation; the generated-column test skips on 5.5 and 5.6, which have none): the 25 integration
tests pass on every one, and so does `pnpm smoke:live` (55 checks each), which drives the real app against a
seeded schema. That covers pause and resume under load, `KILL QUERY`, the read-only claim for DDL, type
mapping, `describeTable` and foreign keys, transactional edits (including rollback of a half-applied batch
and a foreign key violation), a 300,000-row result held by the core, and every export format read back
from disk. What it found: a cancelled `SLEEP` ends without an error and was reported as a finished result
(now reported as cancelled); a closed session threw synchronously from `ping` and `query` instead of
rejecting; and the test expectations had assumed `SELECT 1` is a number, when MySQL types it BIGINT (exact
text) and MariaDB INT. Supporting MySQL 5.x then showed two more: MySQL 5.5 answers the read-only statement
with "Unknown system variable 'TRANSACTION'" rather than a syntax error, and the test suite used recursive
queries, which only came with 8.0. MySQL 5.5.3 is the floor (older servers are refused with a message), and
a server with no read-only mode (5.5) is guarded by the driver, with a one-time warning. Not yet exercised:
TLS (a 5.5 or 5.6 server offers only TLS 1.0), SSH tunnels, very wide or very large single values, and
Windows or Linux clients.

**Added since:** the value viewer (JSON, JWT, Base64, gzip, PHP `serialize`, Unix times, UUIDs, images, hex,
unwrapping layers such as Base64 → gzip → JSON), the record view, and staged row editing with a reviewable
SQL preview and a transactional commit that refuses to touch anything but the exact rows it expects.
Edits are guarded by the same read-only, confirm, and typed-name rules as running SQL.

**Added after that:** scripts as files, query history, and export.

- _Scripts as files._ Each tab is a `.sql` file in one folder, created at once and saved by itself. The
  Scripts list shows every file (including ones dropped in by hand), with rename, duplicate, delete (to the
  system trash), show in the file manager, and import. A script can be moved to another connection from its
  toolbar. Open tabs and the tab in front are restored on launch. Local history keeps earlier versions,
  with a diff against the current text or the version before, and restore (which is one editor edit, so Undo
  works, and which keeps what it replaced first). Outside edits, deleted files, CRLF files, BOMs and
  non-UTF-8 files are handled without losing data.
- _Query history._ A sidebar view with search, a connection filter, an errors filter, day grouping, and
  open-in-new-script, insert-at-cursor, copy and remove. Off switch and clear in Settings.
- _Export._ CSV (separator, header, NULL text, quote all, BOM, line endings, formula protection), TSV, JSON,
  JSON Lines, SQL INSERT (rows per statement) and Markdown, streamed with no row limit.
- Verified by 603 unit tests (628 with the live-server tests), and by the smoke test (200 checks plus a
  second launch that checks what survives a restart), which includes reading the exported files back from
  disk and cancelling a long export.

**Then the rest of the M1 list:**

- _Generate SQL from rows._ "Copy selected rows as SQL UPDATE / DELETE" write one statement per row,
  addressed by primary key, through the same code that builds a commit's statements. An UPDATE sets the
  selected columns (every writable column when only key columns are selected) and never a computed one.
- _Foreign keys._ The table description now carries keys in both directions. A marked column is followed with
  ⌘-click or ⌘⌥J, and "Find the rows that point at this one" goes back; both open a new script that runs.
- _Tree filter._ The navigator filter searches connection names and everything that has been loaded under
  them, keeping the way to each match and opening it up. It does not fetch what is not loaded.
- _Column virtualization._ Only the columns in view, and a little room beyond them, are drawn.
- _Core-held results._ The window keeps 100,000 rows per result; the rest is held by the core in a scratch
  SQLite file and fetched a page at a time. A million rows load in about half a second in the demo engine.
  Selection statistics are exact over held rows; copy is limited to 250,000 rows; such results are read-only.
- _Commit shortcut._ ⌘S commits the staged row changes of the front result from anywhere.
- _Excel export._ A real `.xlsx`, streamed and compressed as it is written, with a bold frozen header,
  numbers kept as numbers while Excel can hold every digit, text never read as a formula, and a new sheet
  every 1,048,576 rows. Checked with `unzip`, `xmllint` and by reading it back with openpyxl.

Along the way: the grid's "which grid do commands act on" handle was being replaced on every selection
change, so ⌘C and the copy commands stopped working after the first click; it is now one handle for the
life of the grid. And the smoke test no longer overwrites the clipboard of the person running it.

M1 has no planned feature left, and its driver has now run against real servers. What stands between it and
done is dogfooding. Smaller known gaps: scripts live in one folder (no subfolders
or linking a file elsewhere), a file edited elsewhere while its tab is open is not reloaded until it is next
saved (its other version goes to local history), a second window opening the same script has no live sync,
a core restart loses the rows it held (the grid shows placeholders until the script is run again), and
results held by the core cannot be edited.

#### M2 status (Redis)

Built: a driver over `ioredis` (single server, **Sentinel** and **Cluster**, login with ACL users, TLS with a CA and a
client certificate, forced to RESP2 so every reply has one shape), the tree (databases, then folders split at a
separator, then keys typed by icon), a key browser on `SCAN` with pattern and type filters, paging, sizes on demand and
sorting, a **tab per key** with editors for string, hash, list, set, sorted set and stream (entries, consumer groups,
consumers, pending), TTL, rename, duplicate (`COPY`, or `DUMP`/`RESTORE` before 6.2) and delete, **bulk delete** (count
first, then `UNLINK` in batches, progress and cancel), a **console** on its own connection with completion, argument
hints, history and redis-cli-style output, a **server dashboard** (memory, clients, ops/sec, hit ratio, keyspace, every
`INFO` field, sparklines), binary-safe keys and values throughout, the lock per connection with the production
confirmations, and a command classifier (read, write, admin, destructive) shared by the console, the guard and the core.
An in-memory stand-in that speaks RESP2 backs 83 smoke checks and 58 driver tests that need nothing installed.

**Verified against real servers**: the 33 live tests and `pnpm smoke:redis` (80 checks that drive the real app) pass on
Redis 5.0.14, Redis 7.4.11 and Valkey 8, and the live tests also on a server with a password and an ACL user, one
speaking TLS, a three-primary cluster and a Sentinel. What the real servers found, and the stand-in now reproduces: the
client's own default is **RESP3**, in which `ZRANGE … WITHSCORES` and `XINFO` come back nested (forcing RESP2 fixed it);
a cluster's pipeline refuses keys of different slots, which a page of keys always has (cluster commands now go out
one by one, together); and a user that may not run `INFO` could not open the tree (it now shows the database it opened
in, without a count). Found with the stand-in: a SCAN cursor that is a position skips keys while they are deleted, which a
bulk delete does (the stand-in's cursor now follows insertion order, as a real one survives deletes), and
status replies and strings arrive as the same bytes, so the console names the commands that answer with a status.

Not done from the M2 list: the **P2** items (Pub/Sub, `SLOWLOG`, client list with kill, a big-key analyzer, bitmap and
HyperLogLog viewers, `MONITOR`), editing a RedisJSON document, msgpack in the value viewer, and the Sentinel and cluster
forms beyond host and primary name. Known gaps: through an SSH tunnel a cluster's other nodes are announced with
addresses the tunnel doesn't reach; the tree samples at most 5,000 keys under a folder; a string over 1 MB can be read
but not edited; `MEMORY USAGE` is asked per key on demand and a server that forbids it shows no size.

#### M3 status (MongoDB)

Built: the driver (`mongodb` 7, one client per script, `promoteValues` off so every number keeps its BSON
type), the tree (databases, collections with counts, views, indexes), a **mongosh-subset parser** (shared
by the editor, the guard and the core: statements, `db.x.y().z()` chains, BSON helpers, arithmetic, and clear
errors for what a script can't do), results as one column of canonical Extended JSON through the existing
paging, spill and cancel, a **table view** and a **tree view**, a **document inspector** with the document
as shell text, **staged editing** (cell, whole document, add, clone, delete) with a reviewable command
preview and a transactional commit where the server has transactions, the editor (JavaScript highlighting,
suggestions for collections, methods, operators, fields sampled from the collection and BSON helpers, and
live marks for what the shell would refuse), `.mongodb` script files with local history and query history,
the connection form's MongoDB section (auth database, replica set, read preference, hosts, SRV, direct
connection, client certificate), and the guard for production (`$out`, `drop`, `deleteMany({})` and the like).

**Verified against real servers**: the 28 integration tests and `pnpm smoke:mongo` (65 checks that drive
the real app) pass on MongoDB 4.4.30, 7.0 and 8.0.34, and on an 8.0 replica set (where edits run as
transactions); the integration tests also pass against a server that requires a login (a password with
`@ : /` in it) and against servers that require TLS and a client certificate. What it found: with
`promoteValues` off, the counts in a write's reply (`deletedCount`) and the number in a server error arrive
as BSON objects, not numbers, so a delete reported nothing and a duplicate key error lost its name;
`createCollection` sends every option it doesn't know to the server, so a cancel signal made the command
fail; whole doubles are written `2.0` by the BSON library; and a server started with a CA file asks every
client for a certificate. The smoke test also showed that a click needs a moment before a key press reads
its selection, which only a script is quick enough to notice.

Not done from the M3 list: a separate **query bar** (filter, projection, sort, limit as fields; the shell
editor covers the same ground), a **JSON list view** (the tree and the inspector show documents; copy gives
JSON), **bulk update or delete by filter with a count preview** (a script can run it, and the guard asks
first), **index and collection management screens** (scripts only), and **export** of a Mongo result. Phase 2
items (aggregation builder, explain visualizer, schema analyzer, change streams, `currentOp` screen) are
untouched. Known gaps: no variables or loops in a script; field names that contain a dot can't be edited in
a cell; the field list for autocomplete is a sample of 30 documents; a 3.6 or 4.0 server is refused.

#### M4 status (RabbitMQ)

Built: a driver over the broker's management API (no AMQP client: Node's own HTTP with TLS options, a connection
kept open, every call cancellable, the broker's own reason kept in every error), the tree (vhosts, then queues
and exchanges with counts, then bindings), tabs for a vhost, a queue and an exchange, **peeking** (take and
put straight back, with the cost of that said up front), payload decoding shared with the inspector, **publish**
with properties and headers, **purge**, **create and delete** queues (classic, quorum, stream) and exchanges,
**bindings** in both directions, a broker overview on the connection's own tab, the connection form's
Management API address, a lock per connection with the production confirmations, and a connection test that
looks at the management endpoint. An in-memory stand-in of the API backs 48 smoke checks that need nothing installed.

**Verified against real brokers**: the 15 integration tests and `pnpm smoke:rabbitmq` (48 checks that drive the real
app) pass on RabbitMQ 3.13.7 and 4.4.0, as well as against the in-memory stand-in. What the real brokers found, and
the stand-in now reproduces: a purge answers 406 to a client that asks only for JSON (`Accept` is now permissive);
the broker answers 401 both for a login it refused and for an action the login may not take, and words the two
differently on 3.x and 4.x (`Not_Authorized` against `Access refused.`), so a refused delete was reported as a
wrong password; every queue lists an implicit binding to the default exchange (now shown as such, with no remove
button, and left out of the tree); and a listing shared between two callers was tied to the first one's cancel.
Statistics lag by about five seconds, which the tests and the smoke wait for. Also found on the way, in the
connection test: its DNS step ignored its own timeout, so a resolver that is slow to say a name does not exist held
the test for thirty seconds.

Not done from the M4 list: **live tail** and **DLQ requeue/move** (Phase 2), **shovel and federation**, users,
permissions and policies, vhost creation, connections and channels lists, consumer cancel, and reading a
**stream** (the management API can't). Known gaps: a peek past the first messages of a very large queue isn't
possible (the broker's `get` always starts at the head); statistics trail by a few seconds; a broker with no
management plugin can't be used at all.

### Phase 2 — power features (~3–4 months)

The P2 items, ordered by what beta users reach for. Likely first:
1. SQL inspections, go-to-definition and find usages (DataGrip parity on the editor)
2. Explain visualizers and the query profiler with run compare
3. Find in data across all engines
4. Mongo aggregation pipeline builder and schema analyzer
5. Master-detail, result compare, group-by and charts
6. ER diagram, table designer, backup / restore
7. Docker / Kubernetes discovery, password from shell command
8. RabbitMQ DLQ workflow, live tail, topology graph; Redis Pub/Sub and memory analyzer

### Phase 3 — Pro

Schema and data compare, data generator, service documenter, data transfer, saved tasks and the
`dbide` CLI, notebooks, AI assistant and MCP server, rename refactoring, team sharing — then more
engines (PostgreSQL, Kafka, Elasticsearch, ClickHouse).

## 9. Definition of done for Phase 1

On macOS, Windows and Linux, and for each of the four engines, a developer can:

1. Connect in under 30 seconds by pasting a URI, directly or through SSH.
2. Find any object with ⌘P / Ctrl+P.
3. Browse and query with results streaming in, and no UI freeze on 1M rows or 1M keys.
4. Edit data, see exactly what will run, and back out before commit.
5. Export results.
6. Get stopped before a destructive action on a prod-tagged connection.

## 10. Open decisions

1. ~~**Stack**~~ — **Decided: Electron + TypeScript + React** (identical Chromium on all three OSes,
   real mongosh, one language). M0 is scaffolded on it.
2. **Distribution model** — open-source core + paid Pro (DBeaver CE / Pro style) or closed source.
   Decides where the plugin boundary sits; can wait until M2. If there is a paid tier, the
   natural line is the P3 automation and compare features, which is where DBeaver and dbForge charge too.
3. **Public beta platforms** — CI covers all three OSes from M0; decide whether the public beta ships
   on all three at once or on the OSes your team uses first.
4. **Name.**

## 11. Risks

| Risk | Mitigation |
|---|---|
| Electron memory and install size | Core in a utility process, results held in the core, lazy-loaded panels, a 300 MB budget checked in CI |
| Untrusted data rendered in the UI | Never render database values as HTML; sandboxed renderer, strict CSP, validated IPC |
| DataGrip-level SQL intelligence is a deep investment | Start with a solid parser + resolver in M1; add inspections one by one, driven by real queries |
| Linux variety (Wayland / X11, distros, missing secret service) | AppImage + `.deb` / `.rpm`, test on Ubuntu LTS and Fedora, master-password fallback for secrets |
| Code-signing and notarization delays | Buy certificates and set up signing in M0, not at release time |
| RabbitMQ peek is not side-effect free (redelivered flag, ordering) | Say so in the UI; use offsets for streams |
| Redis `SCAN` / `MEMORY USAGE` and *find in data* load on prod | Throttle, allow pause, show progress; read replicas where available |
| Scope creep — three mature competitors with decades of features | Borrow only what section 2.2 lists; ship the P1 slice and let usage pick P2 |

## Sources

- DataGrip features overview — https://lp.jetbrains.com/features-overview/
- DataGrip 2025.3 and 2026.2 release notes — https://www.jetbrains.com/help/datagrip/release-notes-datagrip.html, https://www.componentsource.com/product/datagrip/releases/2973111
- DBeaver editions comparison — https://dbeaver.com/edition/
- DBeaver MongoDB and Redis docs — https://dbeaver.com/docs/dbeaver/MongoDB/, https://dbeaver.com/docs/dbeaver/23.3/Redis
- dbForge Studio for MySQL features — https://www.devart.com/dbforge/mysql/studio/features.html
- dbForge Studio on macOS / Linux — https://docs.devart.com/studio-for-mysql/getting-started/how-to-install-dbforge-studio-linux-mac.html
- Tauri webview engines per OS — https://v2.tauri.app/reference/webview-versions/
