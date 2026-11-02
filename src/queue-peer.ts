import type { QueueSummary } from "./queue-store.ts";

/**
 * The pi-intercom seam (ADR-0005).
 *
 * Exactly one thing is rented from intercom: a knock on a live session's door. Naming
 * sessions comes from the store's own files, and the queue itself is never carried over
 * intercom's channel — inbound intercom messages arrive as a *steer* delivery, which would
 * take a peer's prompt past the front of the human's queue, so the only traffic here is a
 * one-line notice whose body lives in a file both sides can read.
 *
 * Deliberately *not* done: registering an intercom extension namespace. The outbox request
 * is a public event contract that needs no registration, so this feature leaves intercom's
 * state store, caps, and owner election entirely alone. Without intercom loaded every call
 * here is a no-op and posting still works — the target's next session start reconciles its
 * inbox whether or not anyone knocked.
 */

/** Event names pi-intercom listens for on pi.events. */
export const INTERCOM_EVENTS = {
  outboxRequest: "intercom:outbox-request",
  outboxResult: "intercom:outbox-result",
} as const;

/** The one-line notice sent with a peer post. Never the prompt body. */
export function wakeMessage(count: number): string {
  return `pi-vimmode: ${count === 1 ? "1 op" : `${count} ops`} waiting in your prompt queue`;
}

type EventBus = {
  emit?: (type: string, payload: unknown) => void;
  on?: (type: string, handler: (payload: unknown) => void) => () => void;
};

/** How a knock was received. Anything but `sent` still means the op landed on disk. */
export type WakeOutcome = "sent" | "no-intercom" | "rejected" | "unknown";

export interface PeerKnocker {
  /** True once any traffic has proved pi-intercom is loaded in this process. */
  present(): boolean;
  /** Best-effort nudge. Never throws, never waits: the file is the delivery, this is the knock. */
  wake(to: string, message: string): WakeOutcome;
}

/**
 * Probe pi's event bus for an intercom listener. No handshake is attempted: the bus either
 * answers outbox requests or it does not, and the answer arrives as a result event.
 */
export function connectIntercom(events: unknown): PeerKnocker | null {
  const bus = events as EventBus | undefined;
  if (!bus || typeof bus.emit !== "function" || typeof bus.on !== "function") return null;

  let present = false;
  const settled = new Set<string>();
  let requestSeq = 0;
  let unsubscribe: (() => void) | undefined;
  try {
    unsubscribe = bus.on(INTERCOM_EVENTS.outboxResult, (payload) => {
      const event = payload as { requestId?: string; status?: string };
      present = true;
      if (typeof event?.requestId === "string") settled.add(event.requestId);
    });
  } catch {
    try {
      unsubscribe?.();
    } catch {
      /* An unusable bus is indistinguishable from no bus. */
    }
    return null;
  }

  return {
    present: () => present,
    wake: (to, message) => {
      const requestId = `pi-vimmode-queue-${Date.now().toString(36)}-${++requestSeq}`;
      try {
        bus.emit?.(INTERCOM_EVENTS.outboxRequest, {
          version: 1,
          requestId,
          extensionId: "pi-vimmode",
          extensionName: "pi-vimmode queue",
          to,
          message,
        });
      } catch {
        return "rejected";
      }
      // The result is asynchronous and the op is already durable; report what is
      // knowable at return time and let the next wake see the earlier answer.
      if (settled.has(requestId)) return "sent";
      return present ? "unknown" : "no-intercom";
    },
  };
}

/** A session visible to the queue system, from whichever source can see it. */
export interface PeerSession {
  sessionId: string;
  name?: string;
  cwd: string;
  alive: boolean;
  /** Pending + held notes in that session's queue, when a file exists to count. */
  pending: number;
}

/**
 * Sessions are the union of what has a queue file. There is no other directory of live
 * pi sessions available to an extension without a broker, and inventing one would make
 * the queue's view of the fleet diverge from the queue's own records.
 */
export function sessionsFromQueues(queues: QueueSummary[], selfSessionId: string): PeerSession[] {
  return queues.map((queue) => ({
    sessionId: queue.sessionId,
    name: queue.name,
    cwd: queue.cwd ?? "",
    alive: queue.sessionId === selfSessionId ? true : queue.alive,
    pending: queue.pending + queue.held,
  }));
}

/** Resolve a `session` argument: an exact id first, then a unique name. */
export function resolvePeer(
  peers: PeerSession[],
  ref: string,
): { found?: PeerSession; ambiguous: boolean } {
  const byId = peers.find((peer) => peer.sessionId === ref);
  if (byId) return { found: byId, ambiguous: false };
  const byName = peers.filter((peer) => peer.name === ref);
  if (byName.length === 1) return { found: byName[0], ambiguous: false };
  return { ambiguous: byName.length > 1 };
}
