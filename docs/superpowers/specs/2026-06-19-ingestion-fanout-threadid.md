# Ingestion Fan‑out — thread‑id branch clocking (V2)

> Companion to `2026-06-18-ingestion-execution-model.md`. That doc closed the
> **single‑branch** loop (store clocks the loader, one file at a time). This doc
> generalizes it to a **fan‑out** of N parallel branches, each clocked
> independently by a **thread id**. The single‑branch case is just N = 1.

## 1. The shape

```
loader
  ├─ splitter ── store        branch / thread 0
  ├─ splitter ── store        branch / thread 1
  └─ splitter ── store        branch / thread 2
```

The loader has **N outgoing connections**, each leading to its own
`splitter → store` chain. Each connection is a **thread** — an independent lane
that processes one file at a time and asks for the next when it's free.

## 2. The thread id = a connection's identity

At run start the loader looks at its **outgoing connections** (from the graph's
edge list) and assigns each one a **thread id**. The loader holds the
association:

```
loader.threads : { threadId → destSplitterNodeId }      # connection ↔ thread id
loader.files   : [...]                                  # enumerated ONCE
loader.cursor  : int                                    # next file to hand out
```

A thread id is **stable for the whole run** and uniquely names one fan‑out
branch. (Implementation: the thread id can simply be the destination splitter's
node id, or a 0..N‑1 index over the loader's output connections — either works,
as long as the map is 1:1.)

## 3. The primitive carries an optional thread id

The event primitive is unchanged from the execution model — only the payload
gains an **optional `threadId`**:

```
triggerEvent(destNodeId, payload)            # payload may include threadId
```

The thread id **travels with the payload down a branch and comes back up**:

```
loader  ──{text, source, threadId:t}──▶  splitter(t)
splitter ──{chunks, source, threadId:t}─▶  store(t)
store   ──{type:'next', threadId:t}─────▶  loader        # the clock tick for thread t
```

So the **store knows which thread it is** because the payload told it — no global
bookkeeping. The splitter and store stay "dumb": they process the payload and
**forward `threadId` unchanged**; only the loader interprets it.

## 4. Priming — the first round

`▶ Play` enumerates the source once, builds the `threads` map, then **seeds every
branch** by handing each thread its first file:

```
loader.onPlay():
   files  = enumerate(source)        # ONCE
   cursor = 0
   threads = assignThreadIds(outgoingConnections)
   for each threadId t in threads:                 # the "first round"
      if cursor < len(files):
         triggerEvent(threads[t], { text: load(files[cursor++]), source, threadId: t })
```

This is the only "round‑robin": one file dealt to each lane to get them all
running. After this, each lane self‑clocks.

## 5. Steady state — the store clocks its own thread

When a store finishes a file it emits `next` **carrying its thread id**, and the
loader hands that **same thread** the next file:

```
store(t).onDone():
   triggerEvent(loaderId, { type:'next', threadId: t })

loader.onEvent({ type:'next', threadId: t }):
   if cursor < len(files):
      triggerEvent(threads[t], { text: load(files[cursor++]), source, threadId: t })
   else:
      pass                          # IGNORE — thread t is drained (no work left)
```

The loader uses `t` to look up `threads[t]` — **which connection / destination
splitter** to dispatch to. Each branch pulls work at its own pace.

## 6. Why this self‑balances (dynamic, not static)

The next file goes to **whichever thread just signalled `next`**, not to
`branch[i mod N]`. So a lane that finishes a small file quickly comes back for
more, while a lane stuck on a huge PDF doesn't hold up the queue. This is
**work‑stealing load balancing**, strictly better than static round‑robin
(which stalls on the slowest lane). The thread id is exactly what makes it
possible: it tells the loader *which lane is free*.

## 7. Termination — silence, per thread then globally

When `cursor` reaches `len(files)`, every `next` is **ignored** (§5 `else`).
A thread that gets ignored is done. When the **last in‑flight file** on the last
busy thread completes and its (ignored) `next` drains, **no more events exist →
run complete** ("N files processed"). Same rule as the single‑branch loop:
*absence of more work = done* — now it just takes all N threads going quiet.

Errors stay **explicit** (red/halt on the failing node); a thread that errors on
a file still emits `next` (skip‑and‑continue) or halts, per the error policy —
it must not silently stop asking, or that lane would wedge.

## 8. Per‑file provenance is unaffected

`threadId` is **routing metadata**, separate from `source` (the file's full
path). The store still writes `metadata.source = <full path>`; the thread id
never leaks into the stored data. Two branches storing into the same collection
is fine — provenance keeps chunks distinct.

## 9. Semantics vs. real parallelism (the substrate)

This spec defines the **semantics** (who clocks whom). *Actual* concurrency is a
separate, substrate‑level choice — the thread‑id protocol layers cleanly onto any
of them:

- **Interpreted (PHP), sequential:** the event router processes one event at a
  time; branches **interleave** but don't truly overlap. Correct, but no speedup.
- **Interpreted (PHP), parallel store:** the bottleneck is the network‑bound
  store/embed call, so **`curl_multi`** can fire the in‑flight branches' store
  writes concurrently — most of the speedup for the least complexity.
- **Concurrent requests (BUILT — true multi‑core):** ▶ Start calls `run-start`
  (enumerate ONCE → a shared run on disk: a JSON of descriptors+config + a
  `.cur` cursor file), then opens **K concurrent `run-worker` SSE streams**. Each
  worker is a **separate prefork PHP process**, and each loop **atomically claims
  the next file** via `flock` on the cursor (`claimNextFile`) — work‑stealing,
  zero double‑claims (stress‑tested: 50 files / 6 procs → 50 unique, 0 dup).
  Auth is **stateless JWT** (verified: no `session_start`), so the K requests
  DON'T serialize on a PHP session lock. **K is declared in the loader node's
  "Parallel workers" field** (`config.workers`, 1..32; blank = auto =
  `min(cores, 8)`), always capped at the file count. The loader owns it because
  it owns the enumeration + the shared queue. *(No layout change needed — the
  worker pool parallelizes the existing single pipeline; you don't draw branches.
  Drawing visual branches = the multi‑target model, separate.)*
  - **Findings (local setup):** correctness ✔, work‑stealing ✔, and loader+split
    parallelizes (~2× at K=4). BUT the local **Qdrant double is single‑process
    (FastEmbed)** → store/embed throughput is capped there regardless of K (with
    store: K=4 ≈ K=1). And concurrent UniversalFS reads through local Apache
    **intermittently stall ~30 s** (hits the curl timeout — an env‑level
    localhost/Apache concurrency issue, NOT the architecture). **The payoff is in
    prod:** a scalable vector store (Qdrant Cloud) + robust storage, where the K
    real processes parallelize decode/split/network across thousands of docs.
- **Compiled (Python):** a worker pool / asyncio over the same loop.

Recommended first cut: keep the single server‑side run, add **`curl_multi`** so
the N branches' store writes overlap — real throughput gain, minimal change.

> **Already in place (the groundwork):** the vector‑DB MCP is **session‑based**,
> and the store opens **one session per run** and reuses it for every chunk write
> (`openMcpSession` + `callMcpTool`; N chunks = N+2 round‑trips instead of 3N —
> see execution‑model §8).
>
> **BUILT — parallel store writes (the "first cut"):** `callMcpToolBatch()` fires
> the chunk writes **concurrently via `curl_multi`** (windowed at 12) on the
> reused session; `VectorMcpStore::storeParallel()` builds the per‑chunk args,
> runs the batch, and counts partial success (throws only if ALL fail).
> `runStream`/`storeChunks` use it. **Confirmed: the Qdrant double tolerates
> concurrent `tools/call` on ONE `Mcp-Session-Id`** (8/8 ok). Measured 1.7× on
> the local double (32 chunks 0.68s→0.39s); much more on a latency‑bound server.
> This parallelizes **within** one branch — the **N‑branch thread‑id topology
> below is still the remaining build** (it would `curl_multi` across branches
> too).

## 10. How it slots into today's code

The current closed loop (`IngestionController::runStream`) is the **N = 1** case:
one implicit thread, `enumerate once → for each file: load→split→store`. Fan‑out
generalizes it:

- replace the single `for` with an **event router** holding `{files, cursor,
  threads}`;
- on play, **seed each connection** (§4);
- a branch's store completion enqueues `{next, threadId}` (§5);
- the SSE `node`/`log`/`progress` events already carry a node id — add `threadId`
  so the UI can glow/log **per lane**.

The loader stays a **pure producer** (it only enumerates + hands out files keyed
by thread id); all routing lives in the loader's `threads` map + the router. No
splitter/store change beyond forwarding `threadId`.

## 11. Open

- **Thread id assignment** when the fan‑out degree changes mid‑design (re‑assign
  at each run start — ids are per‑run, not persisted).
- **Back‑pressure depth** > 1 per thread (a lane buffering 2+ files) — not needed
  for v1; one‑in‑flight‑per‑thread is the simplest correct model.
- **Uneven topologies** (loader → splitter → *two* stores; or shared splitter):
  v1 assumes N independent `splitter→store` chains. Arbitrary graphs need the
  general event router (execution‑model §9).
