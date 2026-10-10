import { describe, expect, it } from "vitest";

import type { ApiResult } from "../src/lib/api";
import { classifyPost, type WaitReason } from "../src/lib/clipper";
import {
  discardedText,
  discardWarning,
  flushMessage,
  formatTime,
  keptText,
  pairingFailureText,
  saveMessage,
  TEXT,
  waitingText,
  waitText,
} from "../src/lib/messages";
import type { PairingFailure } from "../src/lib/pairing";

const error = (
  status: number,
  code: string | null = null,
  retryAfterSeconds: number | null = null,
): ApiResult<unknown> => ({
  kind: "error",
  status,
  code,
  error: code === null ? null : { code },
  retryAfterSeconds,
});

const wait = (reason: WaitReason) => ({ kind: "wait", reason });

describe("each answer to a posted clip", () => {
  it("is sent, or waits, or is dropped only when the API can never take it", () => {
    expect(classifyPost({ kind: "ok", status: 201, body: { status: "queued" } })).toEqual({
      kind: "sent",
      duplicate: false,
    });
    expect(classifyPost({ kind: "ok", status: 200, body: { status: "duplicate" } })).toEqual({
      kind: "sent",
      duplicate: true,
    });
    expect(classifyPost({ kind: "network" })).toEqual(wait("offline"));
    for (const status of [500, 502, 503, 504]) {
      expect(classifyPost(error(status, "unavailable"))).toEqual(wait("server_error"));
    }
    expect(classifyPost(error(404, "not_found"))).toEqual(wait("not_updated"));
    expect(classifyPost(error(404))).toEqual(wait("not_updated"));
    expect(classifyPost(error(400, "unsupported_protocol"))).toEqual(wait("not_updated"));
    expect(classifyPost(error(429, "rate_limited"))).toEqual(wait("rate_limited"));
    expect(classifyPost(error(429, "rate_limited", 30))).toEqual({
      ...wait("rate_limited"),
      retryAfterSeconds: 30,
    });
    expect(classifyPost(error(429, "inbox_full"))).toEqual(wait("inbox_full"));
    expect(classifyPost(error(402, "quota_exceeded"))).toEqual(wait("quota_exceeded"));
    expect(classifyPost(error(403, "forbidden"))).toEqual(wait("reconnect"));
    expect(classifyPost(error(409, "inbox_not_set"))).toEqual(wait("reconnect"));
    expect(classifyPost(error(409, "stale_inbox_key"))).toEqual(wait("server_error"));
    expect(classifyPost(error(418, "teapot"))).toEqual(wait("server_error"));
    expect(classifyPost(error(401, "token_revoked"))).toEqual({ kind: "disconnected" });
    expect(classifyPost(error(401, "unauthenticated"))).toEqual({ kind: "disconnected" });
    expect(classifyPost(error(409, "already_exists"))).toEqual({ kind: "sent", duplicate: true });
    // only these are dropped
    expect(classifyPost(error(413, "payload_too_large"))).toEqual({
      kind: "refused",
      reason: "too_long",
    });
    expect(classifyPost(error(400, "invalid_request"))).toEqual({
      kind: "refused",
      reason: "refused",
    });
  });
});

describe("the popup's texts", () => {
  it("follow the design's table, each wait saying the clip waits here", () => {
    expect(saveMessage({ kind: "saved", category: "", duplicate: false }).text).toBe(
      "Saved to Inbox",
    );
    expect(saveMessage({ kind: "saved", category: "Reading", duplicate: true }).text).toBe(
      "Saved to Inbox/Reading",
    );
    expect(saveMessage({ kind: "disconnected" })).toEqual({
      tone: "error",
      text: "Disconnected from Knowtarium",
      reconnect: true,
    });
    expect(saveMessage({ kind: "failed", reason: "too_long" }).text).toBe("This clip is too long");
    expect(saveMessage({ kind: "invalid", field: "url", code: "bad_url" }).text).toBe(
      "This page can't be saved",
    );
    const texts: Record<WaitReason, string> = {
      offline: "Knowtarium can't be reached right now. This clip waits here.",
      server_error: "Knowtarium had a problem. This clip waits here.",
      not_updated: "Knowtarium's server isn't updated yet. This clip waits here.",
      rate_limited: "Too many saves. This clip waits here.",
      inbox_full:
        "Your inbox has 1,000 clips waiting. Open Knowtarium to file them. This clip waits here.",
      quota_exceeded: "Your Knowtarium storage is full. This clip waits here.",
      unverified_key:
        "Knowtarium sent an inbox key this extension couldn't verify. This clip waits here.",
      reconnect: "Knowtarium needs this extension connected again. This clip waits here.",
    };
    for (const [reason, text] of Object.entries(texts) as [WaitReason, string][]) {
      expect(saveMessage({ kind: "queued", reason, category: "", waiting: 1 }).text).toBe(text);
    }
  });

  it("offer Connect again where only connecting again helps", () => {
    for (const reason of ["unverified_key", "reconnect"] as const) {
      expect(saveMessage({ kind: "queued", reason, category: "", waiting: 1 })).toMatchObject({
        tone: "error",
        reconnect: true,
      });
    }
    for (const reason of ["offline", "rate_limited", "quota_exceeded", "inbox_full"] as const) {
      expect(saveMessage({ kind: "queued", reason, category: "", waiting: 1 })).not.toHaveProperty(
        "reconnect",
      );
    }
  });

  it("say when a rate-limited clip is sent", () => {
    const at = Date.parse("2026-10-10T14:05:00.000Z");
    expect(
      saveMessage({ kind: "queued", reason: "rate_limited", category: "", waiting: 1, retryAt: at })
        .text,
    ).toBe(`Too many saves. This clip waits here and is sent after ${formatTime(at)}.`);
    expect(waitText("rate_limited", { retryAt: at, count: 3 })).toBe(
      `Too many saves. These clips wait here and are sent after ${formatTime(at)}.`,
    );
  });

  it("warn before connecting elsewhere and say what happened to waiting clips", () => {
    expect(discardWarning(0, "Research")).toBeNull();
    expect(discardWarning(1, "Research")).toBe(
      "1 clip waiting for Research will be discarded if you connect to a different workspace.",
    );
    expect(discardWarning(3, "Research")).toBe(
      "3 clips waiting for Research will be discarded if you connect to a different workspace.",
    );
    expect(discardedText(0, "Research")).toBeNull();
    expect(discardedText(1, "Research")).toBe(
      "1 clip waiting for Research was discarded, since this is a different workspace.",
    );
    expect(discardedText(2, null)).toBe(
      "2 clips waiting were discarded, since this is a different workspace.",
    );
    expect(keptText(0)).toBeNull();
    expect(keptText(2)).toBe(
      "2 clips waiting from before will be sent the next time you open the popup.",
    );
  });

  it("cover every other outcome", () => {
    expect(saveMessage({ kind: "failed", reason: "refused" }).text).toBe(TEXT.refused);
    expect(saveMessage({ kind: "invalid", field: "title", code: "too_long" }).text).toBe(
      TEXT.titleTooLong,
    );
    expect(saveMessage({ kind: "invalid", field: "note", code: "too_long" }).text).toBe(
      TEXT.noteTooLong,
    );
    expect(saveMessage({ kind: "invalid", field: "url", code: "too_long" }).text).toBe(
      TEXT.linkTooLong,
    );
    expect(saveMessage({ kind: "invalid", field: null, code: "invalid" }).text).toBe(TEXT.invalid);
    expect(saveMessage({ kind: "queue_full" }).text).toBe(TEXT.queueFull);
  });

  it("say what sending the queue ran into", () => {
    const base = { sent: 0, dropped: 0, waiting: 1 };
    expect(flushMessage({ ...base, stoppedBy: null })).toBeNull();
    expect(flushMessage({ ...base, stoppedBy: "offline" })).toBeNull();
    expect(flushMessage({ ...base, stoppedBy: "server_error" })).toBeNull();
    expect(flushMessage({ ...base, stoppedBy: "disconnected" })?.reconnect).toBe(true);
    expect(flushMessage({ ...base, stoppedBy: "quota_exceeded" })?.text).toBe(
      waitText("quota_exceeded"),
    );
    expect(flushMessage({ ...base, waiting: 2, stoppedBy: "inbox_full" })?.text).toBe(
      "Your inbox has 1,000 clips waiting. Open Knowtarium to file them. These clips wait here.",
    );
    expect(flushMessage({ ...base, stoppedBy: "not_updated" })?.text).toBe(waitText("not_updated"));
    expect(flushMessage({ ...base, stoppedBy: "reconnect" })?.reconnect).toBe(true);
    const at = Date.parse("2026-10-10T14:05:00.000Z");
    expect(flushMessage({ ...base, stoppedBy: "rate_limited", retryAt: at })?.text).toBe(
      waitText("rate_limited", { retryAt: at }),
    );
    expect(flushMessage({ ...base, dropped: 1, stoppedBy: null })?.text).toBe(
      "Knowtarium refused 1 waiting clip, so it was removed",
    );
    expect(flushMessage({ ...base, dropped: 3, stoppedBy: null })?.text).toBe(
      "Knowtarium refused 3 waiting clips, so they were removed",
    );
    expect(waitingText(0)).toBeNull();
    expect(waitingText(1)).toBe("1 clip waiting to be sent");
    expect(waitingText(7)).toBe("7 clips waiting to be sent");
  });

  it("have a pairing text for every way pairing stops", () => {
    const reasons: PairingFailure[] = [
      "offline",
      "not_updated",
      "rate_limited",
      "server_error",
      "expired",
      "denied",
      "used",
      "bad_payload",
      "wrong_key",
      "bad_signature",
      "cancelled",
    ];
    for (const reason of reasons) expect(pairingFailureText(reason).length).toBeGreaterThan(10);
    expect(pairingFailureText("not_updated")).toBe(TEXT.notUpdated);
  });

  it("use no em dashes", () => {
    const all = [
      ...Object.values(TEXT),
      ...(
        [
          "offline",
          "server_error",
          "not_updated",
          "rate_limited",
          "inbox_full",
          "quota_exceeded",
          "unverified_key",
          "reconnect",
        ] as const
      ).map((reason) => waitText(reason, { retryAt: 0 })),
    ];
    for (const text of all) expect(text).not.toContain(String.fromCharCode(0x2014));
  });
});
