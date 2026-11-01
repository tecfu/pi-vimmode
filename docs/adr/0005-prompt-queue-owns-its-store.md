# The prompt queue owns its store and rents intercom's transport

The agent-visible prompt queue will keep its source of truth in pi-vimmode's own
file store (`$PI_VIMMODE_QUEUE_DIR`, default `~/.pi/agent/queues/`) and use
pi-intercom only for waking and addressing another live session. It will not
register an intercom extension-channel namespace and it will not fork
pi-intercom. The reason is measured, not stylistic: `broker/broker.ts:1812-1836`
restricts `commitState` to the elected owner of a namespace, so a shared blob has
exactly one writer and every peer edit must round-trip through an owner that may
change epoch when a socket is replaced; the same contract caps state at 64 KiB per
namespace and payloads at 16 KiB (`README.md`, "Extension channels"), which is
smaller than a queue of real prompts; and namespace traffic reaches only sessions
that registered that namespace string, with no enumeration, so "show me every
session's queue" needs a `listSessions()` walk plus late registration per peer.
Directory files give us all three properties for free — `readdir` enumerates, size
is bounded by the disk, and a queue survives the session that wrote it as history
rather than as the one `.bak` revision the broker keeps.

The split of responsibility is the decision, not the storage medium. pi-vimmode
owns entries, order, provenance, delivery policy, and branch checkpoints.
pi-intercom owns wake-up, session addressing, presence, receipts, and the
consent-gated user-visible send, because serializing a wake against a session that
may be mid-prompt is exactly the race its `idle-wake.ts` already solves ("a second
wake sent in that gap throws 'Agent is already processing a prompt'"), and a queue
that loses turns to that exception is worse than a queue with no history. Forking
the broker would cost roughly 7.2k lines (`index.ts` 3431 plus `broker/` 3816) of
transport, election, receipt and cross-machine code to obtain per-entry operations
that a file store already provides.

Consequences we accept: two processes can name the same queue, so **one writer per
queue file at a time** is load-bearing — a live peer is mutated by appending an
operation record that the peer applies to its own file, and only a file whose owner
pid is dead may be claimed and edited directly; ids must be deterministic, so an entry
that arrives by both the file path and an intercom message is absorbed once, and the
same idempotence by operation id is what makes the delegated edit safe to retry; and
where pi-intercom is not loaded the queue still functions, delivering to its own
session and holding peer posts in the inbox until their target is claimed, without
wake-on-idle for foreign sessions.
