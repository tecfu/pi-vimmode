---
title: "feat: an agent-visible prompt queue with provenance, cross-session posts, and branch checkpoints"
type: feat
status: active
date: 2026-11-01
origin: docs/adr/0005-prompt-queue-owns-its-store.md
---

# feat: an agent-visible prompt queue with provenance, cross-session posts, and branch checkpoints

## Summary

Move the queue-mode buffer out of memory and into a file store pi-vimmode owns, so
the model can read and edit what is waiting, every entry carries who wrote it and
when, one session can place work on another session's queue, and a session that
branches off into a discussion snapshots what it owed itself before it deviates.
pi-intercom stays the transport for waking and addressing a live peer; pi-vimmode
stays the queue of record.

---

## Problem Frame

`docs/adr/0005-prompt-queue-owns-its-store.md` fixes the backend choice: a shared
directory store, not an intercom extension-channel namespace and not a forked
broker. Today the queue is `PromptQueue` (`src/prompt-queue.ts`), an in-memory list
of `{ id: number, text: string }` owned by `EditorState.queue`
(`src/lifecycle.ts:150`), emptied on every `session_start`
(`src/lifecycle.ts:401`) and drained one head per `agent_settled`
(`src/lifecycle.ts:415`). It has no author, no timestamp, no durability, and no
surface any model can call — pi itself exposes only `hasPendingMessages()`, so
nothing else in the process can see it either.

The features requested need those four properties, plus the ability to write into a
_foreign_ queue and to preserve pending work across a fork.

---

## Requirements

- R1. Every entry records `author` (session name, session id, cwd) and `createdAt`,
  for entries made by the human, by the local agent, by a remote agent, and by a
  checkpoint.
- R2. Pending entries survive an extension reload, a pi restart, and a crash:
  `session_start` rehydrates instead of clearing.
- R3. The model can list, add, edit, delete, reorder, deliver-now and checkpoint the
  queue through one `queue` tool with a structured output schema, so codemode and
  non-TUI modes get JSON rather than prose.
- R4. A session can post an entry to another session's queue by name, id, id prefix
  or cwd, using the addressing pi-intercom already implements.
- R5. An entry posted from another process is never delivered twice, and never
  delivered to the wrong session, even though it reached the target by both the
  file path and an intercom message.
- R6. A `kind: "note"` entry is context only and never fires as a prompt by itself.
- R7. Before a fork or a `newSession`, the pending queue plus a bounded context
  digest is written to a durable checkpoint that can be listed and restored, by the
  deviating branch or by the parent afterwards.
- R8. One writer per queue file _at a time_. Mutating a live peer's queue is
  expressed as an appended operation record that the peer applies to its own file;
  a file whose owner pid is dead is claimed by the editor, which then writes it
  directly. Neither path lets two processes edit one file.
- R9. With pi-intercom absent or its broker down, the local queue keeps full
  function; foreign posts are held in the inbox and report as undelivered rather
  than lost.
- R10. No test, probe or benchmark writes to the real store: `PI_VIMMODE_QUEUE_DIR`
  overrides the location and defaults to a temp dir under test.
- R11. The manager overlay shows author, age, kind and origin; it opens another
  session's queue and edits it, and stays keyboard-only (`j/k`, `J/K`, `d`, `u`, `e`,
  `Enter`, `q`).
- R12. Every function stays under 100 lines (`docs/rules/0001-lines-of-codes/RULE.md`),
  which is why the store, the model, the tool and the overlay are separate modules.
- R13. Behavior changes land in `docs/features.md`, config keys in
  `docs/settings.md` and generated `docs/config.md`.
- R14. `bun run test` gains no new failing test names versus the `main` baseline.

---

## Design

### Store layout

```
$PI_VIMMODE_QUEUE_DIR           default ~/.pi/agent/queues
  live/<sessionId>.json         queue of record; written only by its owning process
  inbox/<claim>/<opId>.json     one file per delegated mutation; claim = name or id
  archive/<checkpointId>.json   branch snapshots and swept history, append-only
```

`<claim>` resolution is deliberately loose: a session absorbs every inbox dir whose
name matches its session id, its id prefix, or its session name (`pi.setSessionName`
/ `ctx.sessionManager.getSessionName()`), which is how a post addressed to "the
planner session" survives that session restarting under a new id. Ambiguous matches
(a live session and a stale claim sharing a name) are reported in the manager rather
than guessed.

Each file is written temp → `fsync` → `rename`, and read back with an envelope
`{ formatVersion: 1, sessionId, name, cwd, pid, revision, updatedAt, entries,
appliedOps }`. Corruption degrades to the `.bak` of the previous revision, the same
discipline `pi-intercom/broker/extension-state.ts` uses.

### Entry

```ts
type QueueEntry = {
  readonly id: string; // sha256(author.session, createdAt, text)[0:12]
  readonly text: string;
  readonly kind: "prompt" | "note";
  readonly createdAt: number; // epoch ms
  readonly author: {
    readonly session: string; // display name, or id prefix when unnamed
    readonly sessionId: string;
    readonly cwd: string;
    readonly via: "key" | "tool" | "peer" | "checkpoint" | "ex";
  };
  readonly state: "pending" | "delivered" | "dropped";
  readonly deliveredAt?: number;
  readonly attempts: number;
  readonly replyTo?: string; // id of the entry this one answers
};
```

`id` is content-addressed on purpose: it is the dedupe key that makes R5 true, and an
identical prompt from the same author at the same millisecond is a duplicate by
definition. Rehydrating a session never invents new ids.

### Ownership and ingest

The owning process claims `live/<sessionId>.json` with its pid. On `session_start` it
loads its file, then drains `inbox/<each of my claims>/`: each record is applied as an
operation against its own queue (an `add` appends an entry, skipping one whose `id` is
already held) and unlinked. `fs.watch` on the store roots drives the refresh, with a
reconcile pass on a timer (2 s while the manager is open, 15 s otherwise) because watch
events coalesce.

### Editing a peer's queue

An editor that is not the owner never writes the owner's file. It appends an
operation record instead:

```ts
type QueueOpRecord = {
  formatVersion: 1;
  opId: string; // content-addressed: the idempotence key
  at: number;
  origin: { session: string; sessionId: string; cwd: string };
  target: { sessionId: string; revision: number }; // what the editor read
  op: {
    kind: "add" | "delete" | "move" | "edit" | "release";
    id?: string;
    text?: string;
    direction?: QueueDirection;
    index?: number;
  };
};
```

The owner applies pending records at ingest, in file order, skipping any `opId`
already in the file's `appliedOps` (bounded to the last 256). Because the applying
session is the only writer, `appliedOps` makes a record that is watched twice,
reconciled twice, and redelivered twice still change the queue once. A record whose
`target.revision` is not the file's current revision is refused as `stale` and kept in
`archive/` as a rejected op, so "someone tried to delete #3 against a newer queue"
stays answerable. `appliedOps` doubles as the audit trail: every delegated change
names its origin, its op, and when it landed.

A file whose owner pid is dead is different: it is history, and history is editable.
The editor checks liveness (`process.kill(pid, 0)`), requires `updatedAt` to be older
than `takeoverAfterMs` (60 s default) so a session that is merely slow is never stolen
from, then renames its own claim into the file with a revision guard and writes
directly from then on. If the revision moved between reading and claiming, the claim
is retried against the re-read content rather than forced.

In the manager, `:queue <session>` opens a peer queue and every key behaves the same
in both cases; the status line says whether a change was applied directly, delegated,
refused, or blocked by `peerTrust: "manual"`, because that difference is visible to the
human and should not be hidden. An entry edited into a live peer's queue still carries
its original author; the change itself is attributed in `appliedOps`, not by rewriting
provenance.

### Delivery policy

| author                | kind   | session idle    | session busy                    |
| --------------------- | ------ | --------------- | ------------------------------- |
| local human (`key`)   | prompt | deliver at once | deliver one per `agent_settled` |
| local agent (`tool`)  | prompt | deliver at once | one per settle                  |
| peer session (`peer`) | prompt | deliver at once | one per settle                  |
| any                   | note   | hold            | hold                            |

Delivering a foreign-prompt immediately is what makes posting useful, and it is also
the part of this design a user might want switched off, so it is a setting
(`piVimMode.queue.peerTrust: "auto" | "manual"`, default `auto`), not a rule. The same
key governs delegated mutation, because splitting them would let a peer change the
queue it cannot wake and wake a queue it cannot change — two halves of one trust
decision. A note is held until a human or the model sends it with `deliver_now`.

Before sending, the entry is marked `delivered` with `deliveredAt` and the file
committed; the send then happens. A send that throws rolls the entry back to
`pending` and increments `attempts`, after which it is reported and skipped rather
than retried forever. Recording first costs a duplicate on a crash mid-send and buys
an infinite loop for free; the ordering is chosen because the duplicate is visible in
the transcript and the loop is not.

### Peer posts

`queue(action=enqueue, session="planner", text=...)` is just an `add`-kind record at
`inbox/planner/<opId>.json` (see "Editing a peer's queue" above), announced through
intercom's documented extension
outbox (`INTERCOM_OUTBOX_REQUEST_EVENT`, terminal results `sent | rejected | blocked
| failed`) so the peer wakes and ingests it. The announce message is a one-line
notice, never the prompt body: intercom injects its inbound messages as
`customType: "intercom_message"` with `deliverAs: "steer"`
(`pi-intercom/index.ts:1336`), and a body arriving that way would bypass our
ordering, kind and dedupe rules. Feature detection is `snapshot().supported` on the
channel; when absent, the record just waits, which satisfies R9. The record is the
payload of record and the announce is only a wake signal, so a lost announce delays an
entry and can never lose one.

### Checkpoints

`session_before_fork` (typed in the pinned 0.77 typings) and an explicit
`queue(action=checkpoint)` both write `archive/<checkpointId>.json`:

```ts
{ formatVersion: 1, checkpointId, sessionId, name, cwd, at: number,
  entries: QueueEntry[], context: { fromEntryId, toEntryId, digest: string },
  branch: { targetId?, label? } }
```

`digest` is a bounded (≤ 2 KiB) rendering of the last few user turns and any active
instructions, taken from `branchEntries` on the event, and `context` names the entry
range it summarized so a later reader knows what was current at the fork point. The
checkpoint entry list is the pre-fork pending set with its ids preserved, so
`queue(action=restore, checkpoint=<id>)` re-enqueues exactly what was owed, tagged
`via: "checkpoint"`, in both the branch and the parent.

### Tool surface

One tool, action enum, `outputSchema` so the result is structured:

```
queue({ action: "list" | "enqueue" | "edit" | "delete" | "move" | "deliver_now"
              | "checkpoint" | "restore" | "sessions",
        id?, index?, text?, kind?, direction?, checkpoint?, includeDropped?, session? })
```

`list` returns `{ session, queueMode, revision, entries: [...], peers: [...] }`.
Omitting `session` addresses the caller's own queue; naming one routes every mutating
action through the delegation path above, and the result reports
`{ applied: "direct" | "delegated" | "refused", reason? }`. `sessions` is a
`readdir`-derived roster with age, count and live pid, which is also how a peer name is
resolved. Nothing mutates a foreign queue without saying which route it took.
Registration uses `pi.registerTool` and stays active in every mode; `promptSnippet` is
a single line so the loadout cost is one row.

### Configuration

Three keys, because each costs a canonical metadata entry, a `docs/settings.md` row
and a generated `docs/config.md` block:

- `piVimMode.queueDir` (env `PI_VIMMODE_QUEUE_DIR`) — store location.
- `piVimMode.queue.peerTrust` — `auto | manual`: whether another session's prompts
  deliver on their own and whether it may delegate mutations into this queue.
- `piVimMode.queue.ttlHours` (default 24) — `dropped` entries and undelivered inbox
  records older than this are swept to `archive/`, and the manager counts them.

### Failure modes

| condition                                       | behavior                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| pid in `live/*.json` is dead                    | file is history: claimable and editable directly, never drained                             |
| two sessions, same cwd, same name               | claims diverge by id; manager lists both, warns                                             |
| entry text absurdly large                       | stored, but the overlay previews the first line and `list` truncates with `truncated: true` |
| `fs.watch` unavailable or event-starved         | reconcile timer converges within 15 s                                                       |
| broker down / intercom absent                   | local delivery unaffected; peer posts wait and are reported                                 |
| write fails (disk, perms)                       | the mutation is refused and surfaced in the border status; nothing is dropped silently      |
| op record applied twice (watch + reconcile)     | `appliedOps` idempotence absorbs it                                                         |
| op record built against a superseded revision   | refused as `stale`, archived, reported at both ends                                         |
| owner returns to a file another session claimed | it sees a foreign live pid, reclaims only once that pid is dead, and reports the handoff    |

---

## Scope Boundaries

- No fork of pi-intercom, and no `patches/` entry for it: we call its documented
  outbox and never its internals (ADR 0005).
- No attempt to read or reorder pi's own follow-up queue. It remains unreachable
  (`hasPendingMessages()` is the whole API); our store is the only queue of record.
- No new Vim mode, and no new normal-mode binding: `sq`, `:queue`, and the manager's
  own keys are the whole surface.
- No cross-machine delivery. A post to a session on another box reports as
  undelivered; intercom's transports own that case.
- No signing or trust model on op records: they carry an origin, not credentials, and
  the audit trail is honesty plus a file. Sessions on one box are not adversaries.

---

## Implementation

1. `src/queue-model.ts` — entry type, deterministic id, pure reducers.
2. `src/queue-store.ts` — layout, atomic envelope IO, claims, sweeper, watcher.
3. `src/prompt-queue.ts` — re-point `PromptQueue` at the store; `id` becomes
   `string`; keep `PromptQueueFacade` so the overlay and its tests barely move.
4. `src/lifecycle.ts` — rehydrate on `session_start`, drain inbox, deliver per
   policy, `agent_settled` unchanged in shape.
5. `src/queue-peer.ts` — inbox records, outbox announce, feature detection.
6. `src/queue-ops.ts` — op records: apply, `opId` idempotence, revision precondition,
   dead-owner takeover and claim.
7. `src/queue-checkpoint.ts` — fork hook, write, list, restore.
8. `src/queue-tool.ts` — `registerTool`, schema, `outputSchema`, `applied` reporting.
9. `src/queue-manager-overlay.ts` — author/age/kind/origin columns, `:queue <session>`,
   `e` body editor, direct/delegated/refused status line.
10. Config keys, generated reference, `docs/features.md`, `docs/settings.md`, README.

---

## Verification

- Unit: envelope round-trip and `.bak` recovery; id stability across rehydration;
  reducer ops and edge refusals; delivery table for all four policy rows; rollback
  after a throwing send; absorb-by-id dedupe when the same record arrives twice;
  checkpoint write/restore preserving ids; `readdir`-derived session roster.
- Integration: two real `VimEditor`s over one temp store, A posts, B ingests and
  delivers once; A deletes an entry in live B and the change lands exactly once via
  `appliedOps`; A's stale op is refused and archived; A takes over B's file only after
  B's pid is dead and its `updatedAt` ages out; `PI_VIMMODE_QUEUE_DIR` respected so no
  test touches `~/.pi/agent/queues` (R10).
- Manual in Pi: `queue(action="list")` from the model shows the author and age of an
  entry typed with `sq`; a fork restores the parent's pending set after a
  throwaway branch; killing intercom leaves local queue mode working; opening a live
  peer's queue and pressing `d` reports `delegated` and the peer's border notes it.

---

## Risks

- **Wake races.** A peer post that both ingests and receives an intercom wake can
  attempt two deliveries; the `delivered`-before-send rule plus R5's id dedupe cover
  it, but this is the path most likely to need field correction.
- **Delegated mutation.** Q3's answer means one session can reorder, rewrite or delete
  another's pending work. Mitigation is that the target always applies the change
  itself, idempotent by `opId`, preconditioned on revision, and named in `appliedOps`;
  `peerTrust: "manual"` is the off switch for the whole arrangement.
- **Name collisions.** Addressing by session name is convenient and ambiguous. We
  warn instead of guessing, which can make a post wait when the user expected it to
  land.
- **Watch coverage.** `fs.watch` on Linux is inotify and reliable; a network-mounted
  `~/.pi/agent` may not notify, which is what the reconcile timer exists for.
- **Config ceremony.** Each new key touches canonical metadata and generated docs;
  the count is capped at three for that reason.

---

## Resolutions

- Q1 (2026-11-01, user): **auto.** `piVimMode.queue.peerTrust` defaults to `"auto"`,
  so a peer-posted prompt runs on the target's next turn as its own would.
- Q2 (2026-11-01, user): **TTL sweep.** Deletes mark `dropped` and stay in the file
  until the `ttlHours` sweep moves them to `archive/`, which makes `u` survive a
  restart and keeps the queue auditable.
- Q3 (2026-11-01, user): **editable.** Peer queues are mutable, which is what
  "Editing a peer's queue" exists to make safe. It replaced the read-only stance in
  R8 and brought the `e` body editor into scope, since a queue you may delete from but
  not correct is half a feature.
- Q4 (2026-11-01, assistant, to revisit): Q1 and Q3 together made peer _delivery_
  configurable and peer _mutation_ unconditional, an asymmetry with no principle behind
  it. Resolved by folding both under one key, `queue.peerTrust`, rather than adding a
  fourth config key. If a real need for mutate-without-wake or wake-without-mutate
  appears, splitting it into two keys is a mechanical change to this one setting.
