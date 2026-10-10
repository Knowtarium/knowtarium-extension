import type { FailReason, FlushResult, SaveResult, WaitReason } from "./clipper";
import type { PairingFailure } from "./pairing";

// Every text the popup and the pairing page show for an outcome. The design's table ("The
// extension") gives the ones for the API's answers word for word; the rest follow its voice.

export type Tone = "success" | "info" | "error";

export interface Message {
  readonly tone: Tone;
  readonly text: string;
  /** Show "Connect again" with it. */
  readonly reconnect?: boolean;
}

export const TEXT = {
  disconnected: "Disconnected from Knowtarium",
  /** For pairing; a clip that waits for it gets `waitText("not_updated")`. */
  notUpdated: "Knowtarium's server isn't updated yet",
  tooLong: "This clip is too long",
  cantSave: "This page can't be saved",
  refused: "Knowtarium refused this clip",
  queueFull:
    "100 clips are already waiting to be sent. Open this popup again when Knowtarium can be reached.",
  titleTooLong: "The title is too long (at most 300 characters)",
  noteTooLong: "The note is too long (at most 4,000 characters)",
  linkTooLong: "This page's link is too long to save",
  invalid: "This clip couldn't be made. Try again.",
} as const;

/** Why a clip waits, before "This clip waits here." (the design's table, shortened to fit). */
const WAIT_CAUSE: Readonly<Record<WaitReason, string>> = {
  offline: "Knowtarium can't be reached right now.",
  server_error: "Knowtarium had a problem.",
  not_updated: "Knowtarium's server isn't updated yet.",
  rate_limited: "Too many saves.",
  inbox_full: "Your inbox has 1,000 clips waiting. Open Knowtarium to file them.",
  quota_exceeded: "Your Knowtarium storage is full.",
  unverified_key: "Knowtarium sent an inbox key this extension couldn't verify.",
  reconnect: "Knowtarium needs this extension connected again.",
};

/** Waits the person can do something about; the others clear up by themselves. */
const ERROR_WAITS: ReadonlySet<WaitReason> = new Set([
  "inbox_full",
  "quota_exceeded",
  "unverified_key",
  "reconnect",
]);
/** Waits that only connecting again ends. */
const RECONNECT_WAITS: ReadonlySet<WaitReason> = new Set(["unverified_key", "reconnect"]);

/** A time of day for "sent after ...". */
export function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** "Inbox" or "Inbox/<category>", as the clip lands. */
export function destination(category: string): string {
  return category === "" ? "Inbox" : `Inbox/${category}`;
}

/**
 * Why clips wait and that they wait here: "<cause> This clip waits here." (or "These clips wait
 * here."), with "and is sent after <time>" after a rate limit.
 */
export function waitText(
  reason: WaitReason,
  options: { readonly retryAt?: number | undefined; readonly count?: number } = {},
): string {
  const many = (options.count ?? 1) > 1;
  const subject = many ? "These clips wait here" : "This clip waits here";
  const after =
    options.retryAt === undefined
      ? ""
      : ` and ${many ? "are" : "is"} sent after ${formatTime(options.retryAt)}`;
  return `${WAIT_CAUSE[reason]} ${subject}${after}.`;
}

function waitMessage(
  reason: WaitReason,
  options: { readonly retryAt?: number | undefined; readonly count?: number } = {},
): Message {
  return {
    tone: ERROR_WAITS.has(reason) ? "error" : "info",
    text: waitText(reason, options),
    ...(RECONNECT_WAITS.has(reason) ? { reconnect: true } : {}),
  };
}

export function failText(reason: FailReason): string {
  switch (reason) {
    case "too_long":
      return TEXT.tooLong;
    case "refused":
      return TEXT.refused;
  }
}

/** What the popup says after Save. */
export function saveMessage(result: SaveResult): Message {
  switch (result.kind) {
    case "saved":
      return { tone: "success", text: `Saved to ${destination(result.category)}` };
    case "queued":
      return waitMessage(result.reason, { retryAt: result.retryAt });
    case "failed":
      return { tone: "error", text: failText(result.reason) };
    case "invalid":
      if (result.code === "bad_url") return { tone: "error", text: TEXT.cantSave };
      if (result.code === "too_long") {
        if (result.field === "title") return { tone: "error", text: TEXT.titleTooLong };
        if (result.field === "note") return { tone: "error", text: TEXT.noteTooLong };
        return { tone: "error", text: TEXT.linkTooLong };
      }
      return { tone: "error", text: TEXT.invalid };
    case "queue_full":
      return { tone: "error", text: TEXT.queueFull };
    case "disconnected":
      return { tone: "error", text: TEXT.disconnected, reconnect: true };
  }
}

/** What the popup says after sending the queue when it opened, or null for nothing to say. */
export function flushMessage(result: FlushResult): Message | null {
  if (result.stoppedBy === "disconnected") {
    return { tone: "error", text: TEXT.disconnected, reconnect: true };
  }
  // offline and a server's hiccup clear up by themselves: the waiting count says enough
  if (
    result.stoppedBy !== null &&
    result.stoppedBy !== "offline" &&
    result.stoppedBy !== "server_error"
  ) {
    return waitMessage(result.stoppedBy, { retryAt: result.retryAt, count: result.waiting });
  }
  if (result.dropped > 0) {
    const text =
      result.dropped === 1
        ? "Knowtarium refused 1 waiting clip, so it was removed"
        : `Knowtarium refused ${String(result.dropped)} waiting clips, so they were removed`;
    return { tone: "error", text };
  }
  return null;
}

const clips = (count: number) => (count === 1 ? "1 clip" : `${String(count)} clips`);

/** Before pairing, when clips wait: what connecting to another workspace does to them. */
export function discardWarning(count: number, workspaceName: string): string | null {
  if (count <= 0) return null;
  return `${clips(count)} waiting for ${workspaceName} will be discarded if you connect to a different workspace.`;
}

/** After pairing with another workspace: what happened to the clips that waited. */
export function discardedText(count: number, workspaceName: string | null): string | null {
  if (count <= 0) return null;
  const verb = count === 1 ? "was" : "were";
  const from = workspaceName === null ? "" : ` for ${workspaceName}`;
  return `${clips(count)} waiting${from} ${verb} discarded, since this is a different workspace.`;
}

/** After pairing again with the same workspace, when clips wait. */
export function keptText(count: number): string | null {
  if (count <= 0) return null;
  return `${clips(count)} waiting from before will be sent the next time you open the popup.`;
}

/** "1 clip waiting to be sent", or null when none waits. */
export function waitingText(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? "1 clip waiting to be sent" : `${String(count)} clips waiting to be sent`;
}

/** What the pairing page says when pairing stops. */
export function pairingFailureText(reason: PairingFailure): string {
  switch (reason) {
    case "offline":
      return "Knowtarium can't be reached. Check your connection, then start again.";
    case "not_updated":
      return TEXT.notUpdated;
    case "rate_limited":
      return "Too many tries to connect. Wait a few minutes, then start again.";
    case "server_error":
      return "Knowtarium had a problem. Start again in a moment.";
    case "expired":
      return "This request expired. Start again to get a new code.";
    case "denied":
      return "The request was declined in Knowtarium.";
    case "used":
      return "This request was already used. Start again.";
    case "bad_payload":
    case "wrong_key":
    case "bad_signature":
      return "Knowtarium's answer didn't check out, so this extension didn't connect. Start again, and revoke this extension in Knowtarium under Settings > Agents if it's listed there.";
    case "cancelled":
      return "Connecting was stopped.";
  }
}
