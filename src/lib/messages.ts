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
  notUpdated: "Knowtarium's server isn't updated yet",
  tooLong: "This clip is too long",
  rateLimited: "Too many saves, it will be sent later",
  inboxFull: "Your inbox has 1,000 clips waiting. Open Knowtarium to file them.",
  /** The design's texts for a clip that stays queued, with where the clip is. */
  notUpdatedQueued: "Knowtarium's server isn't updated yet. This clip waits here.",
  inboxFullQueued:
    "Your inbox has 1,000 clips waiting. Open Knowtarium to file them. This clip waits here.",
  quotaExceeded: "Your Knowtarium storage is full",
  cantSave: "This page can't be saved",
  offline: "Knowtarium can't be reached right now, it will be sent later",
  serverError: "Knowtarium had a problem, it will be sent later",
  unverifiedKey:
    "Knowtarium sent an inbox key this extension couldn't verify, so the clip waits here. Connect again if this keeps happening.",
  refused: "Knowtarium refused this clip",
  queueFull:
    "100 clips are already waiting to be sent. Open this popup again when Knowtarium can be reached.",
  titleTooLong: "The title is too long (at most 300 characters)",
  noteTooLong: "The note is too long (at most 4,000 characters)",
  linkTooLong: "This page's link is too long to save",
  invalid: "This clip couldn't be made. Try again.",
} as const;

/** "Inbox" or "Inbox/<category>", as the clip lands. */
export function destination(category: string): string {
  return category === "" ? "Inbox" : `Inbox/${category}`;
}

export function waitText(reason: WaitReason): string {
  switch (reason) {
    case "offline":
      return TEXT.offline;
    case "server_error":
      return TEXT.serverError;
    case "not_updated":
      return TEXT.notUpdatedQueued;
    case "rate_limited":
      return TEXT.rateLimited;
    case "inbox_full":
      return TEXT.inboxFullQueued;
    case "unverified_key":
      return TEXT.unverifiedKey;
  }
}

export function failText(reason: FailReason): string {
  switch (reason) {
    case "too_long":
      return TEXT.tooLong;
    case "quota_exceeded":
      return TEXT.quotaExceeded;
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
      // inbox_full is no promise to send it later; the others are
      return {
        tone:
          result.reason === "inbox_full" || result.reason === "unverified_key" ? "error" : "info",
        text: waitText(result.reason),
        ...(result.reason === "unverified_key" ? { reconnect: true } : {}),
      };
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
  if (result.stoppedBy === "quota_exceeded") return { tone: "error", text: TEXT.quotaExceeded };
  if (result.stoppedBy === "inbox_full") return { tone: "error", text: TEXT.inboxFullQueued };
  if (result.stoppedBy === "not_updated") return { tone: "info", text: TEXT.notUpdatedQueued };
  if (result.stoppedBy === "unverified_key") {
    return { tone: "error", text: TEXT.unverifiedKey, reconnect: true };
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
