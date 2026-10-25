# DBIDE

A fast, keyboard-first data IDE for backend developers: **MySQL, MongoDB, Redis and RabbitMQ** in one
app, with the same grid, value viewer, shortcuts and production safeguards everywhere. Runs on macOS,
Windows and Linux.

The product plan, competitor research and roadmap live in [PLAN.md](PLAN.md). This file is about the code.

## Status

**M0 (foundations)** is done except SSH tunnels, Storybook and signed installers.
**M1 (MySQL)** is feature-complete for the planned scope: the driver, the schema tree with a filter, the SQL
editor, the streamed result grid (wide and million-row results included), the **value viewer and record
view**, **staged row editing** with a commit shortcut, **generated UPDATE and DELETE statements**, **jumping
along foreign keys**, **scripts as files with local history**, **query history**, and **export** to CSV, TSV,
JSON, JSON Lines, SQL, Markdown and Excel. It works with **MySQL 5.5.3 and newer** and with MariaDB, and is
verified against the demo engine and against real servers (**MySQL 5.5, 5.6, 5.7, 8.0 and 8.4, and MariaDB
11.8**; see _Testing the MySQL driver_).
**M3 (MongoDB)** has its first full pass: connect (plain, `mongodb+srv`, replica sets, login, TLS with a
client certificate), a tree of databases, collections, views and indexes, **mongosh-style scripts** with
autocomplete and live error marks, results as a **table or a tree**, a **document inspector**, and **staged
document editing** (cells, whole documents as text, add, clone, delete) that saves in one transaction where
the server has transactions. It works with **MongoDB 4.4 and newer** and is verified against real servers
(**4.4, 7.0 and 8.0, an 8.0 replica set, and servers that require a login or TLS**; see _Testing the MongoDB
driver_).
**M4 (RabbitMQ)** has its first full pass: a tree of vhosts, queues, exchanges and bindings; tabs for a
**vhost** (every queue in a sortable, filterable list), a **queue** (counts, consumers, bindings, details) and an
**exchange**; **peeking at messages without consuming them**, with each payload decoded (JSON, Base64,
compressed, JWT, hex); **publishing**; **purging**; creating and deleting queues and exchanges; adding and
removing bindings; and a broker overview. Everything that changes the broker is locked until the connection
is unlocked, and a production broker asks first (and for the connection's name before a purge or a delete).
It talks to the broker's **management API** and is verified against real brokers (**RabbitMQ 3.13 and 4.4**; see
_Testing the RabbitMQ driver_).
**M2 (Redis)** has its first full pass: a tree of databases and **folders of keys** (split at a separator you
choose), a **key browser** built on `SCAN` that never blocks the server (pattern and type filters, TTL and type
per key, paging, sizes on demand), a **tab for every key** with an editor for each type (**string, hash, list,
set, sorted set and stream**, with consumer groups and pending entries), **TTL**, rename, duplicate and delete,
**bulk delete by pattern** (count first, then delete in batches, stoppable), a **console** with completion,
syntax hints and history, and a **server dashboard**. It works with **Redis 5 and newer and Valkey**, as a single
server, behind **Sentinel**, or as a **cluster**, with login (including ACL users) and TLS, and is verified against
real servers (**Redis 5.0, 7.4, Valkey 8, and servers with a login, TLS, a cluster and a Sentinel**; see _Testing the
Redis driver_).

## Getting started

Requires Node 24 (see `.nvmrc`) and pnpm 12.

```bash
pnpm install
pnpm dev
```

| Command                     | What it does                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| `pnpm dev`                  | Run the app with hot reload                                                               |
| `pnpm typecheck`            | Type-check the Node side and the renderer                                                 |
| `pnpm lint` / `pnpm format` | ESLint / Prettier                                                                         |
| `pnpm test`                 | Unit tests (Vitest)                                                                       |
| `pnpm smoke`                | Build, boot the real app headless, and drive renderer → core → SQLite → secrets           |
| `pnpm smoke:shots`          | Same, and save a screenshot of each main screen to `.shots/`                              |
| `pnpm package`              | Unsigned app bundle in `release/`                                                         |
| `pnpm smoke:packaged <exe>` | The same smoke test against a packaged build instead of the sources                       |
| `pnpm smoke:live`           | The real app against a real MySQL or MariaDB server (needs `DBIDE_TEST_MYSQL_URL`)        |
| `pnpm smoke:mongo`          | The real app against a real MongoDB server (needs `DBIDE_TEST_MONGO_URL`)                 |
| `pnpm smoke:rabbitmq`       | The RabbitMQ screens against a stand-in broker, or a real one (`DBIDE_TEST_RABBITMQ_URL`) |
| `pnpm smoke:redis`          | The Redis screens against a stand-in server, or a real one (`DBIDE_TEST_REDIS_URL`)       |

`pnpm smoke` launches the app twice on one data folder: the first run checks everything, the second shows
that open tabs, scripts and history come back after a restart.

Linux CI needs a virtual display: `xvfb-run -a pnpm smoke`.

### Developing without a database

`DBIDE_DEMO_ENGINE=1` swaps the MySQL driver for an in-memory stand-in
([`src/core/drivers/demo`](src/core/drivers/demo/driver.ts)) that serves a made-up `shop` schema and
generates rows on demand: 25 rows by default, `LIMIT n` for more, `SELECT n FROM big` for 1.5 million,
`SELECT n FROM slow_big` for 100,000 that arrive slowly (to cancel an export part-way),
`SELECT * FROM shop.wide` for a result with 300 columns, `SELECT SLEEP(n)` to try cancelling, and a table called `bad` that always fails. The smoke test runs
against it. It says nothing about how `mysql2` behaves on the wire.

### Testing the MySQL driver

The live-server tests in
[`mysql.integration.test.ts`](src/core/drivers/mysql/mysql.integration.test.ts) skip unless you point
them at a server whose user may create and drop databases:

```bash
DBIDE_TEST_MYSQL_URL=mysql://root:secret@127.0.0.1:3306 pnpm test
```

`pnpm smoke:live` goes further: it seeds a `dbide_live` schema (50 customers, 300,000 orders whose values
follow a formula), boots the built app without the demo engine, and drives it through the tree, runs, types,
cancel, a 300,000-row result, row editing, foreign keys, generated statements and export, reading the
exported files back from disk. It drops the schema afterwards. CI runs both against MySQL 5.5, 5.6, 5.7, 8.0,
8.4 and MariaDB 11. To try it locally with a throwaway server:

```bash
docker run -d --name dbide-mysql -e MYSQL_ROOT_PASSWORD=secret -p 127.0.0.1:3306:3306 mysql:8.4
DBIDE_TEST_MYSQL_URL=mysql://root:secret@127.0.0.1:3306 pnpm smoke:live
docker rm -f dbide-mysql
```

Types differ a little between servers, and the driver follows the server: MySQL types a literal such as
`SELECT 1` as BIGINT, which arrives as exact text, while MariaDB types it INT, which arrives as a number.
BIGINT and DECIMAL columns are always exact text.

### Testing the MongoDB driver

The live-server tests in
[`mongodb.integration.test.ts`](src/core/drivers/mongodb/mongodb.integration.test.ts) skip unless you point
them at a server whose user may create and drop databases:

```bash
DBIDE_TEST_MONGO_URL=mongodb://127.0.0.1:27017 pnpm test
```

`pnpm smoke:mongo` boots the built app against the same server and drives it the way a person would. It seeds
a `dbide_mongo_live` database (2,000 orders whose values follow a formula, and a view) and checks the tree,
queries, the table and tree views, the inspector, editing a cell and a whole document, adding, deleting and
saving, an edit that loses a race, cancelling a query that is running on the server, the read-only lock, the
editor's error marks, and the connection form. It drops the database afterwards. Set
`DBIDE_SMOKE_SHOTS=<folder>` to save a screenshot of each step. CI runs both against MongoDB 4.4, 7.0 and
8.0.

Other setups the tests understand:

- **A replica set** (`DBIDE_TEST_MONGO_RS=1`, reached through one member with `directConnection`): edits are
  then one transaction, and the tests expect that.
- **A server that requires a login**: put the credentials in the URL, percent-encoded
  (`mongodb://root:p%40ss@127.0.0.1:27017`).
- **TLS** (`DBIDE_TEST_MONGO_TLS_URL` and `DBIDE_TEST_MONGO_CA`) and **a client certificate**
  (`DBIDE_TEST_MONGO_MTLS_URL`, `DBIDE_TEST_MONGO_CLIENT_CERT`, `DBIDE_TEST_MONGO_CLIENT_KEY`).

To try it locally with a throwaway server:

```bash
docker run -d --name dbide-mongo -p 127.0.0.1:27017:27017 mongo:8.0
DBIDE_TEST_MONGO_URL=mongodb://127.0.0.1:27017 pnpm smoke:mongo
docker rm -f dbide-mongo
```

### Testing the RabbitMQ driver

`pnpm smoke:rabbitmq` needs nothing installed: it starts an in-memory stand-in for the management API
([`fake-broker.ts`](src/core/drivers/rabbitmq/fake-broker.ts), which also backs the driver's unit tests) and
drives the real app through the tree, the vhost, queue and exchange tabs, peeking, publishing, purging, creating,
deleting, bindings, the production lock and the connection form. The same script runs against a real broker:

```bash
docker run -d --name dbide-rabbit -p 127.0.0.1:5672:5672 -p 127.0.0.1:15672:15672 rabbitmq:4-management
DBIDE_TEST_RABBITMQ_URL=amqp://guest:guest@127.0.0.1:5672 pnpm smoke:rabbitmq
DBIDE_TEST_RABBITMQ_URL=amqp://guest:guest@127.0.0.1:5672 pnpm test    # the driver's live tests
docker rm -f dbide-rabbit
```

`DBIDE_TEST_RABBITMQ_MANAGEMENT_PORT` (default 15672) says where the management API is. Both make and remove
only things named `dbide-smoke-…` or `dbide-it-…`. The broker's statistics update every few seconds, so the
tests wait for counts rather than read them at once. `DBIDE_SMOKE_SHOTS=<folder>` saves a screenshot per step.

### Testing the Redis driver

`pnpm smoke:redis` needs nothing installed: it starts an in-memory stand-in that speaks the real protocol
([`fake-redis.ts`](src/core/drivers/redis/fake-redis.ts), which also backs the driver's unit tests) and drives the
real app through the tree, the key browser, every kind of key, TTLs, bulk delete, the console, the server tab and
the production lock. The same script and the driver's live tests run against real servers:

```bash
scripts/redis-test-servers.sh up        # Redis 7 (6390), Valkey 8 (6391), Redis 5 (6392), a login (6393), TLS (6394),
                                        # a 3-primary cluster (7000-7002) and a Sentinel (26380); prints the variables
DBIDE_TEST_REDIS_URL=redis://127.0.0.1:6390 pnpm smoke:redis
DBIDE_TEST_REDIS_URL=redis://127.0.0.1:6390 pnpm test                  # the driver's live tests
scripts/redis-test-servers.sh down
```

`DBIDE_TEST_REDIS_AUTH_URL`, `DBIDE_TEST_REDIS_TLS_URL` (with `DBIDE_TEST_REDIS_CA`), `DBIDE_TEST_REDIS_CLUSTER_URL`
and `DBIDE_TEST_REDIS_SENTINEL_URL` switch on the suites for those setups. Everything is made under keys named
`dbide-it-…` or `dbide-smoke-…` and removed afterwards; nothing flushes a database.

### Which servers it supports

MySQL **5.5.3 and newer** (5.5.3 is where `utf8mb4`, which every connection uses, arrived) and MariaDB of any
age. A server older than that is turned away at login with a message that says which versions work. The
differences between versions are handled where they show:

- **Read-only.** `SET SESSION TRANSACTION READ ONLY` exists from MySQL 5.6.5. On a server without it (5.5)
  the driver can't ask the server to refuse writes, so it refuses them itself: before anything is sent, a
  statement that isn't plainly a read is rejected, including `INTO OUTFILE`, `SET GLOBAL` and `CALL`. The
  window says so once when a production connection opens, because this is a weaker promise: a stored function
  that changes data when a `SELECT` calls it can't be seen. Servers are detected by what they answer, not by
  their version number.
- **JSON columns** exist from MySQL 5.7.8 and **generated columns** from 5.7.6; older servers simply have
  neither, and the app only shows what the server reports.
- **Which tables point at this one** (for _Find the rows that point at this one_) needs a scan of every
  table on a 5.x server, which can be slow on a big one. It gets five seconds on 5.7.8 and newer; if it
  doesn't answer, the rest of the table's description is still used and that one lookup is skipped.
- **TLS.** A 5.5 or 5.6 server built with yaSSL speaks TLS 1.0 only, which Node doesn't allow by default.
  TLS to such a server has not been tried; plain TCP has.

### MongoDB

**MongoDB 4.4 and newer.** The `mongodb` driver that DBIDE uses refuses older servers at login, and the message
says which version the server is. (An older driver reaches back to 3.6; ask if you need that.)

- **Scripts** are `.mongodb` files, one statement per run, written as in `mongosh`:
  `db.orders.find({ status: "paid" }).sort({ at: -1 }).limit(20)`, `db.orders.aggregate([...])`,
  `db.getCollection("order-items")`, `db.getSiblingDB("other")`, `use shop`, `show collections`. Statements
  end at a `;` or at a line that starts a new `db…`; a line that starts with `.sort(...)` continues the one
  above. Arguments are JavaScript values: bare keys, either quote, regex literals, comments, trailing
  commas, `ObjectId("…")`, `ISODate("…")`, `NumberLong("…")`, `NumberDecimal("…")`, `UUID("…")`,
  `BinData(…)`, `Timestamp(…)`, `new Date(Date.now() - 86400000)`, and arithmetic.
- **What is not supported** is said by name instead of failing obscurely: variables, functions, loops and
  `.forEach` (a script is a list of statements, not a program), `mapReduce`, and the legacy `insert`, `update`,
  `remove` and `save` (each message names its replacement). Supported: `find`, `findOne`, `aggregate`,
  `countDocuments`, `estimatedDocumentCount`, `distinct`, `getIndexes`, `explain`, the `insert`, `update`,
  `replace`, `delete` and `findOneAnd…` methods, `bulkWrite`, `createIndex`, `dropIndex`, `drop`,
  `renameCollection`, `db.createCollection`, `db.createView`, `db.dropDatabase`, `db.runCommand`,
  `db.adminCommand`, and the usual `db.stats()`-style helpers. Cursors take `sort`, `limit`, `skip`,
  `project`, `hint`, `collation`, `maxTimeMS`, `batchSize`, `comment`, `allowDiskUse`, `explain` and `count`.
- **Types are never lost.** Documents travel as canonical Extended JSON, so an Int32, a Double and an Int64
  stay three things from the server to the grid. Numbers in a script follow the shell: `5` is an Int32,
  `5.0` is a Double, and `NumberLong("5")` is an Int64. The text of a document is shown the same way, so what
  you copy from the inspector can be pasted into a script.
- **Results are documents in one column**, so paging, the core's disk spill and cancel work as they do for
  SQL. The window keeps the first 20,000 documents of a result (documents are bigger than rows); the rest is
  held by the core and is read-only. The table has a column per top-level field, found as documents arrive
  (up to 150); nested values show their size and open in the inspector. The tree opens a document, then its
  fields, then nested ones.
- **Editing** is staged and reviewable as the commands that will run, like SQL edits. A cell is edited as
  text in the shell's notation (strings keep their quotes); the inspector edits a whole document. Saving
  writes only the fields that changed (`$set` and `$unset`, as dotted paths into sub-documents), so a change
  somebody else made to another field is left alone, and it addresses documents by `_id`: if one is gone, the
  save fails and says so. On a replica set or a sharded cluster all the changes are one transaction; on a
  standalone server there are none, so a failure stops the rest and the message says how many were already
  made. Only a plain `find` or `findOne` is editable; an aggregation is not.
- **Read-only is guarded by the app**, not by the server, because MongoDB has no read-only session. The
  window blocks anything that isn't plainly a read before it is sent (including `$out` and `$merge`), the
  driver checks again, and the window says so once when a production connection opens. For a hard
  guarantee, connect with a user that only has the `read` role.
- **Cancel** closes the cursor and kills the operation on the server (found by a comment tag in `currentOp`).
  A cursor that has waited ten minutes for you to ask for more is closed by the server; run the query again.
- **Replica sets, SRV and TLS.** The connection form takes the authentication database, the replica set,
  the read preference, several hosts, "connect to this host only" (for a replica set whose members advertise
  names this machine can't reach), `mongodb+srv`, a CA, and a client certificate and key.

### Redis

DBIDE talks to Redis through `ioredis`, speaking RESP2 (which every server speaks), so it works with Redis 5 and
newer, Valkey, and anything that answers like them. The connection form takes the host, port, database index, an
optional ACL user name and password, TLS (a CA and a client certificate), and a **deployment**: a single server, a
**Sentinel** (the host is a sentinel; it asks where the primary is and follows it) or a **cluster** (the host is any
node; keys are searched on every primary, and a cluster has only database 0).

- **Keys are found with `SCAN`, never `KEYS`.** A search asks for a page at a time and says how many keys it has
  looked at, so a keyspace of millions of keys never stalls the server. Plain text matches anywhere in a key; use
  `*` and `?` for a pattern. A page may be shorter than asked for, because SCAN filters after it reads; **Load more**
  continues where it stopped. Servers older than 6.0 can't filter by type themselves, so the app asks each key's type.
- **The tree is a sample.** It reads up to 5,000 keys under a folder and groups them at the separator (a colon unless
  the connection says otherwise, or says not to group at all). A folder with more says so; the key browser searches
  all of them.
- **Keys and values are bytes.** Text shows as text, and anything that is not valid UTF-8 as `\xNN` escapes, in the tree,
  the browser, the editors and the console, and can be opened, renamed and deleted like any other key.
- **Editing.** A string is edited as text (up to 1 MB; a longer one is read-only), keeping its TTL. A hash, list, set
  or sorted set lists its members a page at a time and adds, edits and removes them; a list item is removed by
  position (by overwriting it with a marker and removing that, in one transaction), and a hash field can be renamed. A
  stream lists entries newest first, adds and deletes them, and shows consumer groups, their consumers and what is
  pending. A JSON document (RedisJSON) is shown; other module types can be renamed, expired and deleted.
- **Rename, duplicate, TTL.** Duplicate uses `COPY` (6.2+), or `DUMP` and `RESTORE` on an older server, and can copy into
  another database. A TTL is set in seconds to days, or removed.
- **Bulk delete** counts the matching keys first, then deletes them in batches with `UNLINK` (`DEL` before 4.0), with
  a pause between batches. Both steps show progress and stop when asked, and what was deleted before stopping stays deleted.
- **The console** runs a line at a time on a connection of its own, so `MULTI`, `SELECT` and `WATCH` carry from line to
  line. It reads quotes and escapes as redis-cli does, completes command names, shows the arguments of a command as it
  is typed, and remembers history. `SUBSCRIBE`, `MONITOR` and `HELLO 3` are not supported here. A command that waits
  (`BLPOP`) can be stopped, which drops the connection (the only way to stop it).
- **Changes are locked until unlocked**, the same way as for RabbitMQ: one lock per connection, locked on production, and
  the core refuses a change that doesn't say writes are unlocked. The console classifies each command itself (a read, a
  change, an administration command, or something destructive such as `DEL`, `FLUSHALL` or `SHUTDOWN`); a command it does not
  know counts as a change. A production connection asks before any change, and asks for the connection's name before
  a destructive one. Redis has no read-only session, so the window says once, when a production server opens, that this
  guard is the app's, and that **an ACL user limited to `+@read`** is the real guarantee; such a user can browse keys
  (the tree then has no counts, because it may not run `INFO`).
- Not here yet: Pub/Sub, `MONITOR`, `SLOWLOG`, the client list, a big-key analyzer, the bitmap and HyperLogLog viewers,
  and editing a JSON document or a module's key.

### RabbitMQ

DBIDE browses and changes a broker through its **management API** (HTTP), because it is the only way to list what
exists. The connection holds the AMQP address as usual (`amqp://user:pass@host:5672`, `amqps://` for TLS); the
API is by default the same host on port 15672 (15671 with TLS), or whatever is written in the connection's
"Management API address" (another port, a proxy, a path). The login needs the `management` tag (or `monitoring`,
for reading), and permissions on the vhost. The connection test checks that address, not the AMQP port.

- **Looking at messages does not consume them, but it is not free.** The broker has no read-only way to look
  inside a queue. A peek is what its own web UI does: take the first N messages and put them straight back
  where they were. They come back marked _redelivered_, and **on a quorum queue each look counts as a delivery
  attempt**, so a message looked at too often can reach the queue's delivery limit and be dead-lettered. The queue
  tab says so before the first peek. Streams can't be read this way. A payload is read up to 100,000 bytes.
- **Payloads are decoded** like the inspector decodes a cell: JSON laid out, Base64 and gzip unwrapped, a JWT read, an
  image shown, or a hex dump. A binary payload arrives as base64 and is shown as such.
- **Changes are locked until unlocked.** The lock belongs to the connection (one toggle covers all its tabs),
  starts locked on production, and the core refuses a change that doesn't say writes are unlocked. A production
  broker asks before any change, and asks for the connection's name before a purge or a delete; staging asks
  for the name before those two. RabbitMQ has no read-only session, so the window says once, when a production
  broker opens, that this guard is the app's, and that a user with only read permissions is the real guarantee.
- **Publishing** goes through an exchange (or the default one, to the queue named by the routing key) with
  properties and headers, and tells you when the broker accepted the message but no queue took it.
- **Counts lag a little.** The broker refreshes its statistics every few seconds, so a number can trail what
  was just done. Tabs refresh themselves every 5 seconds while they are on screen.
- A vhost lists up to 5,000 queues; the tree shows the first 1,000 of a group and says how many more there are.

## How it is put together

```
src/
  shared/    Types and plain logic every process can import: RPC, connection model, URI parser, API contracts
  main/      Electron main process (thin): windows, native menu, OS keychain, supervises the core
  preload/   The narrow window.dbide bridge exposed to the page
  core/      Utility process: drivers, sessions, SQLite storage, validation. No UI, no Electron imports
  renderer/  React UI: shell, design tokens, command registry, palette, features
```

- **Three processes.** The renderer is sandboxed with no Node access. Database work runs in a separate
  utility process (the _core_), so a slow query or a crashing driver cannot freeze or close a window. The
  main process restarts the core if it dies, and windows reconnect on their own.
- **Typed RPC over MessagePort.** Each window talks to the core through its own `MessagePort`
  ([`src/shared/rpc.ts`](src/shared/rpc.ts)). Calls can be cancelled, the core can push events, and every
  input is validated in the core.
- **Secrets stay out of config.** Passwords are encrypted by the main process with the OS keychain
  (`safeStorage`). The core asks for them by key. If a Linux desktop has no keyring, saving a password is
  refused rather than stored in plain text.
- **Results stream with backpressure.** A run sends `query.event` messages to the window that started it
  while the call is still open. The driver pauses the database socket when the consumer falls behind, and
  a statement stops after the first 1,000 rows until the window asks for more, so no result is ever
  buffered whole. Cancel kills the statement on the server (`KILL QUERY` from a second connection).
- **Big results live in the core.** The window keeps the first 100,000 rows of a result. Rows past those go
  to a scratch SQLite file in the core, stored in the batches they arrive in, and the grid fetches the page it
  is scrolled to (`results.fetch`), draws a placeholder until it arrives, and lets pages go when they are not
  used. Selection statistics over those rows are added up in the core; copying them fetches them (up to
  250,000 rows; Export takes more). Such a result is read-only. A run replacing another, closing the tab, or
  closing the window lets go of what was held. The scratch folder is emptied when the core starts.
- **Only the columns on screen are drawn.** The grid draws the columns that are in view, plus some room, and
  stands in for the rest with a spacer, so a result with hundreds of columns scrolls like a narrow one.
- **Each SQL tab has its own connection**, so `USE`, session variables and open transactions never leak
  between tabs. The shared connection that serves the tree and autocomplete is separate again.
- **Edits are staged, then saved in one transaction.** A result is editable when it is a plain read of one
  table that includes the whole primary key; otherwise the grid says why. Changes are addressed by primary
  key, run on a private connection (so a transaction open in the script is never touched), and each update or
  delete must hit exactly one row or everything rolls back.
- **Scripts are files.** Every SQL tab is a `.sql` file in the scripts folder (`<data folder>/scripts`, shown
  in Settings), so it can be opened, searched and backed up with any other tool, and files dropped into the
  folder show up in the Scripts list. SQLite keeps what a file can't: the connection, the open tabs, and
  **local history**. Typing saves a moment after the last key (atomically: write beside, then rename).
  Before a file is replaced, the version being replaced is kept in local history when it is due, always
  when it was changed outside the app, and always for the text that is run. A file deleted behind the
  app's back is restored from history when the script is opened. Files keep their line endings, and a file
  that is not valid UTF-8 is left alone rather than damaged. Tabs, their order and the one in front come
  back after a restart; the read-only lock does not, so a production script always starts locked.
- **Query history** records each statement when it finishes (a result that waits for more rows is recorded at
  its first page), with its connection, environment, time, rows or rows affected, and the error. It is
  stored locally, capped by count and age, can be turned off in Settings, and is searchable by every word.
- **Export streams.** "Export…" re-runs the query on its own read-only connection and writes every row to
  the file as it arrives, with back-pressure and no row limit (a grid holds 1,000,000). Only a single
  statement that reads can be exported. The file name comes from the native save dialog, which the core
  asks the main process to show, so the page never supplies a path. The file is written beside its
  destination and renamed when complete; cancelling removes it.
- **Foreign keys can be followed.** The description of each table a result reads from includes the keys that
  leave it and the keys of other tables that point at it. A marked column opens the row it points at on
  ⌘-click (Ctrl-click off the Mac) or ⌘⌥J; "Find the rows that point at this one" goes the other way. Both
  open a new script that runs at once. A key of several columns needs all of them in the result.
- **Production connections are read-only on the server** (`SET SESSION TRANSACTION READ ONLY`), and the app
  blocks writes before sending them. Destructive statements ask first, and on guarded environments the user
  types the connection's name.
- **Storage** is SQLite through Node's built-in `node:sqlite`, so there is no native module to rebuild per OS.
- **Drivers** implement one small interface ([`src/shared/driver.ts`](src/shared/driver.ts)) with optional
  capabilities; shared UI lights up per capability. Engines whose milestone has not landed are registered as
  placeholders with real metadata.
- **Commands.** Everything the user can do is a command in one registry. The palette, keyboard shortcuts and
  native menus all read from it. Shortcuts are written with `Mod` (⌘ or Ctrl) and match the physical key, so
  they work on non-Latin keyboard layouts.
- **Layering is enforced by ESLint**: the renderer cannot import Node, Electron or `core/`; `core/` and
  `shared/` cannot import UI or main code.

## Design tokens

All colors, spacing, type and density live in [`tokens.css`](src/renderer/src/styles/tokens.css). Dark mode
follows `prefers-color-scheme`, which the main process drives from the Theme setting. Red, amber and green
are reserved for status and environments: a red window border always means production.

## Adding an engine driver

1. Implement `Driver` from `src/shared/driver.ts` in `src/core/drivers/<engine>/`.
2. Replace its `plannedDriver(...)` entry in `src/core/drivers/registry.ts`.
3. Add integration tests against a Docker container, and an engine panel in the renderer if the shared UI
   isn't enough.
