import { describe, expect, it } from "vitest";

import type { ApiResult } from "../src/lib/api";
import { classifyPost } from "../src/lib/clipper";
import {
  flushMessage,
  pairingFailureText,
  saveMessage,
  TEXT,
  waitingText,
} from "../src/lib/messages";
import type { PairingFailure } from "../src/lib/pairing";

const error = (status: number, code: string | null = null): ApiResult<unknown> => ({
  kind: "error",
  status,
  code,
  error: code === null ? null : { code },
  retryAfterSeconds: null,
});

describe("each answer to a posted clip", () => {
  it("maps to what the popup does", () => {
    expect(classifyPost({ kind: "ok", status: 201, body: { status: "queued" } })).toEqual({
      kind: "sent",
      duplicate: false,
    });
    expect(classifyPost({ kind: "ok", status: 200, body: { status: "duplicate" } })).toEqual({
      kind: "sent",
      duplicate: true,
    });
    expect(classifyPost({ kind: "network" })).toEqual({ kind: "wait", reason: "offline" });
    for (const status of [500, 502, 503, 504]) {
      expect(classifyPost(error(status, "unavailable"))).toEqual({
        kind: "wait",
        reason: "server_error",
      });
    }
    expect(classifyPost(error(404, "not_found"))).toEqual({ kind: "wait", reason: "not_updated" });
    expect(classifyPost(error(404))).toEqual({ kind: "wait", reason: "not_updated" });
    expect(classifyPost(error(429, "rate_limited"))).toEqual({
      kind: "wait",
      reason: "rate_limited",
    });
    expect(classifyPost(error(429, "inbox_full"))).toEqual({ kind: "wait", reason: "inbox_full" });
    expect(classifyPost(error(401, "token_revoked"))).toEqual({ kind: "disconnected" });
    expect(classifyPost(error(401, "unauthenticated"))).toEqual({ kind: "disconnected" });
    expect(classifyPost(error(402, "quota_exceeded"))).toEqual({ kind: "full" });
    expect(classifyPost(error(413, "payload_too_large"))).toEqual({
      kind: "refused",
      reason: "too_long",
    });
    expect(classifyPost(error(409, "already_exists"))).toEqual({ kind: "sent", duplicate: true });
    expect(classifyPost(error(409, "stale_inbox_key"))).toEqual({
      kind: "wait",
      reason: "server_error",
    });
    expect(classifyPost(error(400, "invalid_request"))).toEqual({
      kind: "refused",
      reason: "refused",
    });
    expect(classifyPost(error(403, "forbidden"))).toEqual({ kind: "refused", reason: "refused" });
  });
});

describe("the popup's texts", () => {
  it("are the design's, word for word", () => {
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
    expect(
      saveMessage({ kind: "queued", reason: "not_updated", category: "", waiting: 1 }).text,
    ).toBe("Knowtarium's server isn't updated yet");
    expect(saveMessage({ kind: "failed", reason: "too_long" }).text).toBe("This clip is too long");
    expect(
      saveMessage({ kind: "queued", reason: "rate_limited", category: "", waiting: 1 }).text,
    ).toBe("Too many saves, it will be sent later");
    expect(saveMessage({ kind: "queued", reason: "inbox_full", category: "", waiting: 1 })).toEqual(
      {
        tone: "error",
        text: "Your inbox has 1,000 clips waiting. Open Knowtarium to file them.",
      },
    );
    expect(saveMessage({ kind: "failed", reason: "quota_exceeded" }).text).toBe(
      "Your Knowtarium storage is full",
    );
    expect(saveMessage({ kind: "invalid", field: "url", code: "bad_url" }).text).toBe(
      "This page can't be saved",
    );
  });

  it("cover every other outcome", () => {
    expect(saveMessage({ kind: "queued", reason: "offline", category: "", waiting: 2 })).toEqual({
      tone: "info",
      text: TEXT.offline,
    });
    expect(
      saveMessage({ kind: "queued", reason: "server_error", category: "", waiting: 1 }).text,
    ).toBe(TEXT.serverError);
    expect(
      saveMessage({ kind: "queued", reason: "unverified_key", category: "", waiting: 1 }).text,
    ).toBe(TEXT.unverifiedKey);
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
    expect(flushMessage({ ...base, stoppedBy: "rate_limited" })).toBeNull();
    expect(flushMessage({ ...base, stoppedBy: "disconnected" })?.reconnect).toBe(true);
    expect(flushMessage({ ...base, stoppedBy: "quota_exceeded" })?.text).toBe(TEXT.quotaExceeded);
    expect(flushMessage({ ...base, stoppedBy: "inbox_full" })?.text).toBe(TEXT.inboxFull);
    expect(flushMessage({ ...base, stoppedBy: "not_updated" })?.text).toBe(TEXT.notUpdated);
    expect(flushMessage({ ...base, stoppedBy: "unverified_key" })?.text).toBe(TEXT.unverifiedKey);
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
    for (const text of Object.values(TEXT)) expect(text).not.toContain(String.fromCharCode(0x2014));
  });
});
