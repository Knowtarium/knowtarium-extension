import { fromBase64Url } from "knowtarium/clip";
import { createAccountKeys, createWorkspaceKey, deriveInboxKeyPair } from "knowtarium/crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { INBOX_KEY_CHECK_MS, QUEUE_LIMIT } from "../src/lib/clipper";
import type { QueuedClip } from "../src/lib/storage";
import { connected, PAGE } from "./helpers/connected";
import { apiError, json } from "./helpers/fake-api";
import { readyAll } from "./helpers/owner";

beforeAll(readyAll);

const form = (overrides: Partial<typeof PAGE & { note: string; category: string }> = {}) => ({
  ...PAGE,
  note: "",
  category: "",
  ...overrides,
});

function posts(state: ReturnType<typeof connected>) {
  return state.api.requests.filter((r) => r.path === "/extensions/current/clips");
}

describe("saving a clip", () => {
  it("cleans, signs and seals it to the inbox key, and the owner's side can open it", async () => {
    const state = connected();
    const result = await state.clipper.save(
      form({
        title: "  How we‮ sped up  ",
        note: "Read before\r\nthe meeting",
        category: "reading",
      }),
    );
    expect(result).toEqual({ kind: "saved", category: "reading", duplicate: false });
    expect(state.store.snapshot().queue).toEqual([]);

    const [post] = posts(state);
    expect(post?.headers["authorization"]).toBe(`Bearer ${state.connection.token}`);
    expect(post?.headers["knowtarium-protocol-version"]).toBe("2");
    expect(post?.headers["knowtarium-request"]).toBe("1");
    const { clipId, blob } = post?.body as { clipId: string; blob: string };
    const bytes = fromBase64Url(blob);
    expect(bytes[0]).toBe(1);
    expect(bytes.length % 1024).toBe((5 + 48) % 1024);
    const opened = state.owner.openClip(bytes, state.signPublicKey);
    expect(opened?.signed).toBe(true);
    expect(opened?.payload).toEqual({
      v: 1,
      clipId,
      workspaceId: state.connection.workspaceId,
      extensionId: state.connection.extensionId,
      url: PAGE.url,
      title: "How we sped up",
      note: "Read before\nthe meeting",
      category: "reading",
      savedAt: new Date(state.clock).toISOString(),
    });
  });

  it("counts a duplicate as saved", async () => {
    const state = connected();
    state.api.override = (r) =>
      r.path === "/extensions/current/clips" ? json(200, { status: "duplicate" }) : undefined;
    expect(await state.clipper.save(form())).toEqual({
      kind: "saved",
      category: "",
      duplicate: true,
    });
    expect(state.store.snapshot().queue).toEqual([]);
  });

  it("queues it offline and sends the same sealed bytes later", async () => {
    const state = connected();
    state.api.offline = true;
    expect(await state.clipper.save(form())).toEqual({
      kind: "queued",
      reason: "offline",
      category: "",
      waiting: 1,
    });
    const [queued] = state.store.snapshot().queue ?? [];
    expect(queued?.blob).toBeTypeOf("string");

    state.api.offline = false;
    expect(await state.clipper.flush()).toEqual({
      sent: 1,
      dropped: 0,
      waiting: 0,
      stoppedBy: null,
    });
    const [post] = posts(state);
    expect(post?.body).toEqual({ clipId: queued?.clipId, blob: queued?.blob });
    expect(state.api.clips.get(queued?.clipId ?? "")).toBe(queued?.blob);
  });

  it("queues on a 5xx, a 404 and a 429, retrying with the same bytes each time", async () => {
    const state = connected();
    const answers = [
      apiError(503, "unavailable"),
      apiError(404, "not_found"),
      apiError(429, "rate_limited", { retryAfterSeconds: 30 }, { "Retry-After": "30" }),
      apiError(429, "inbox_full"),
    ];
    const reasons: string[] = [];
    state.api.override = (r) =>
      r.path === "/extensions/current/clips" ? answers.shift() : undefined;
    const first = await state.clipper.save(form());
    if (first.kind === "queued") reasons.push(first.reason);
    for (let i = 0; i < 3; i++) {
      const flushed = await state.clipper.flush();
      reasons.push(String(flushed.stoppedBy));
      expect(flushed.waiting).toBe(1);
    }
    expect(reasons).toEqual(["server_error", "not_updated", "rate_limited", "inbox_full"]);
    const blobs = new Set(posts(state).map((r) => (r.body as { blob: string }).blob));
    expect(blobs.size).toBe(1);
    expect(await state.clipper.flush()).toMatchObject({ sent: 1, waiting: 0 });
    expect(new Set(posts(state).map((r) => (r.body as { blob: string }).blob)).size).toBe(1);
  });

  it("on stale_inbox_key verifies the new key, seals again and sends once more", async () => {
    const state = connected();
    state.owner.rotate();
    state.api.inboxKey = state.owner.inboxKey(2);
    expect(await state.clipper.save(form())).toMatchObject({ kind: "saved" });
    const sent = posts(state);
    expect(sent).toHaveLength(2);
    const second = sent[1]?.body as { clipId: string; blob: string };
    expect(second.clipId).toBe((sent[0]?.body as { clipId: string }).clipId);
    expect(second.blob).not.toBe((sent[0]?.body as { blob: string }).blob);
    expect(new DataView(fromBase64Url(second.blob).buffer).getUint32(1)).toBe(2);
    expect(state.owner.openClip(fromBase64Url(second.blob), state.signPublicKey)?.signed).toBe(
      true,
    );
    const { connection } = state.store.snapshot();
    expect(connection?.inboxKey.envelope.revision).toBe(2);
    expect(connection?.inboxKey.envelope.generation).toBe(2);
  });

  it("keeps a queued clip's new bytes after sealing again, for its next retry", async () => {
    const state = connected();
    state.api.offline = true;
    await state.clipper.save(form());
    state.api.offline = false;
    state.owner.rotate();
    state.api.inboxKey = state.owner.inboxKey(2);
    let calls = 0;
    state.api.override = (r) => {
      if (r.path !== "/extensions/current/clips") return undefined;
      calls += 1;
      return calls === 2 ? apiError(503, "unavailable") : undefined;
    };
    expect(await state.clipper.flush()).toMatchObject({ stoppedBy: "server_error", waiting: 1 });
    const [queued] = state.store.snapshot().queue ?? [];
    expect(queued?.generation).toBe(2);
    expect(await state.clipper.flush()).toMatchObject({ sent: 1, waiting: 0 });
    const last = posts(state).at(-1)?.body as { blob: string };
    expect(last.blob).toBe(queued?.blob);
  });

  it("refuses a swapped inbox key in a stale_inbox_key answer and keeps the clip", async () => {
    const state = connected();
    const attacker = createAccountKeys();
    const swapped = deriveInboxKeyPair(createWorkspaceKey());
    state.api.inboxKey = {
      ...state.owner.inboxKey(2, { signer: attacker.signing, publicKey: swapped.publicKey }),
    };
    state.api.override = (r) =>
      r.path === "/extensions/current/clips"
        ? apiError(409, "stale_inbox_key", { inboxKey: state.api.inboxKey })
        : undefined;
    expect(await state.clipper.save(form())).toMatchObject({
      kind: "queued",
      reason: "unverified_key",
    });
    expect(posts(state)).toHaveLength(1);
    expect(state.store.snapshot().connection?.inboxKey).toEqual(state.connection.inboxKey);
  });

  it("refuses an older revision or generation in a stale_inbox_key answer", async () => {
    const state = connected();
    state.owner.rotate();
    const newer = state.owner.inboxKey(5);
    await state.store.set({ connection: { ...state.connection, inboxKey: newer } });
    // the server tries to move it back to revision 3 of generation 1
    const older = state.owner.inboxKey(3, { key: createWorkspaceKey() });
    state.api.override = (r) =>
      r.path === "/extensions/current/clips"
        ? apiError(409, "stale_inbox_key", { inboxKey: older })
        : undefined;
    expect(await state.clipper.save(form())).toMatchObject({ reason: "unverified_key" });
    expect(state.store.snapshot().connection?.inboxKey).toEqual(newer);
  });

  it("sends once more only: a second stale_inbox_key leaves the clip queued", async () => {
    const state = connected();
    state.owner.rotate();
    const latest = state.owner.inboxKey(2);
    state.api.override = (r) =>
      r.path === "/extensions/current/clips"
        ? apiError(409, "stale_inbox_key", { inboxKey: latest })
        : undefined;
    expect(await state.clipper.save(form())).toMatchObject({ kind: "queued" });
    expect(posts(state)).toHaveLength(2);
  });

  it("counts 409 already_exists as saved (an earlier post of this clip got through)", async () => {
    const state = connected();
    state.api.override = (r) =>
      r.path === "/extensions/current/clips" ? apiError(409, "already_exists") : undefined;
    expect(await state.clipper.save(form())).toMatchObject({ kind: "saved", duplicate: true });
  });

  it("keeps nothing on 402, 413 or another refusal", async () => {
    for (const [answer, reason] of [
      [apiError(402, "quota_exceeded"), "quota_exceeded"],
      [apiError(413, "payload_too_large"), "too_long"],
      [apiError(400, "invalid_request"), "refused"],
      [apiError(403, "forbidden"), "refused"],
    ] as const) {
      const state = connected();
      state.api.override = (r) => (r.path === "/extensions/current/clips" ? answer : undefined);
      expect(await state.clipper.save(form())).toEqual({ kind: "failed", reason });
      expect(state.store.snapshot().queue).toEqual([]);
    }
  });

  it("forgets everything on 401 and leaves a notice", async () => {
    for (const code of ["token_revoked", "unauthenticated"]) {
      const state = connected();
      state.api.override = (r) =>
        r.path === "/extensions/current/clips" ? apiError(401, code) : undefined;
      expect(await state.clipper.save(form())).toEqual({ kind: "disconnected" });
      expect(state.store.snapshot()).toEqual({ notice: "disconnected" });
    }
  });

  it("refuses fields over their limits and pages that aren't http or https", async () => {
    const state = connected();
    expect(await state.clipper.save(form({ title: "x".repeat(301) }))).toEqual({
      kind: "invalid",
      field: "title",
      code: "too_long",
    });
    expect(await state.clipper.save(form({ note: "\u{1f600}".repeat(4001) }))).toEqual({
      kind: "invalid",
      field: "note",
      code: "too_long",
    });
    expect(
      await state.clipper.save(form({ url: `https://example.com/${"a".repeat(2100)}` })),
    ).toEqual({ kind: "invalid", field: "url", code: "too_long" });
    expect(await state.clipper.save(form({ url: "chrome://settings" }))).toEqual({
      kind: "invalid",
      field: "url",
      code: "bad_url",
    });
    expect(await state.clipper.save(form({ url: "file:///etc/hosts" }))).toMatchObject({
      code: "bad_url",
    });
    expect(posts(state)).toHaveLength(0);
    expect(state.store.snapshot().queue).toEqual([]);
  });

  it("accepts a 4,000-character note in 4-byte characters", async () => {
    const state = connected();
    const result = await state.clipper.save(form({ note: "\u{1f600}".repeat(4000) }));
    expect(result).toMatchObject({ kind: "saved" });
  });

  it("holds at most 100 clips", async () => {
    const state = connected();
    state.api.offline = true;
    for (let i = 0; i < QUEUE_LIMIT; i++) {
      expect(await state.clipper.save(form())).toMatchObject({ kind: "queued", waiting: i + 1 });
    }
    expect(await state.clipper.save(form())).toEqual({ kind: "queue_full" });
    expect(await state.clipper.waiting()).toBe(QUEUE_LIMIT);
  });

  it("says disconnected when there is no connection, or one for another API", async () => {
    const state = connected();
    await state.store.set({ connection: { ...state.connection, apiOrigin: "https://other.test" } });
    expect(await state.clipper.save(form())).toEqual({ kind: "disconnected" });
    expect(await state.clipper.flush()).toMatchObject({ sent: 0 });
  });
});

describe("the queue", () => {
  async function queueOf(count: number) {
    const state = connected();
    state.api.offline = true;
    for (let i = 0; i < count; i++) await state.clipper.save(form({ title: `Page ${String(i)}` }));
    state.api.offline = false;
    state.api.requests.length = 0;
    return state;
  }

  it("sends oldest first and stops at the first clip that has to wait", async () => {
    const state = await queueOf(3);
    const queue = state.store.snapshot().queue ?? [];
    let calls = 0;
    state.api.override = (r) => {
      if (r.path !== "/extensions/current/clips") return undefined;
      calls += 1;
      return calls === 2 ? apiError(503, "unavailable") : undefined;
    };
    expect(await state.clipper.flush()).toEqual({
      sent: 1,
      dropped: 0,
      waiting: 2,
      stoppedBy: "server_error",
    });
    expect(posts(state).map((r) => (r.body as { clipId: string }).clipId)).toEqual([
      queue[0]?.clipId,
      queue[1]?.clipId,
    ]);
    expect(await state.clipper.flush()).toMatchObject({ sent: 2, waiting: 0, stoppedBy: null });
  });

  it("drops clips the API refuses for good and keeps going", async () => {
    const state = await queueOf(2);
    let calls = 0;
    state.api.override = (r) => {
      if (r.path !== "/extensions/current/clips") return undefined;
      calls += 1;
      return calls === 1 ? apiError(400, "invalid_request") : undefined;
    };
    expect(await state.clipper.flush()).toEqual({
      sent: 1,
      dropped: 1,
      waiting: 0,
      stoppedBy: null,
    });
  });

  it("keeps clips on 402 while sending the queue", async () => {
    const state = await queueOf(1);
    state.api.override = (r) =>
      r.path === "/extensions/current/clips" ? apiError(402, "quota_exceeded") : undefined;
    expect(await state.clipper.flush()).toMatchObject({ stoppedBy: "quota_exceeded", waiting: 1 });
  });

  it("forgets everything when the token was revoked", async () => {
    const state = await queueOf(2);
    state.api.revoked.add(state.connection.token);
    expect(await state.clipper.flush()).toMatchObject({ stoppedBy: "disconnected" });
    expect(state.store.snapshot()).toEqual({ notice: "disconnected" });
  });

  it("does nothing for an empty queue", async () => {
    const state = connected();
    expect(await state.clipper.flush()).toEqual({
      sent: 0,
      dropped: 0,
      waiting: 0,
      stoppedBy: null,
    });
    expect(state.api.requests).toHaveLength(0);
  });

  it("serializes a save and a flush running at once", async () => {
    const state = await queueOf(1);
    const [a, b] = await Promise.all([state.clipper.flush(), state.clipper.save(form())]);
    expect(a.sent + (b.kind === "saved" ? 1 : 0)).toBe(2);
    expect(state.store.snapshot().queue).toEqual([] as QueuedClip[]);
  });
});

describe("reading the inbox key once a day", () => {
  it("skips it within a day", async () => {
    const state = connected();
    state.clock = state.connection.inboxKeyCheckedAt + INBOX_KEY_CHECK_MS - 1;
    expect(await state.clipper.refreshInboxKey()).toBe("skipped");
    expect(state.api.requests).toHaveLength(0);
  });

  it("takes a newer key signed by the pinned owner key", async () => {
    const state = connected();
    state.owner.rotate();
    state.api.inboxKey = state.owner.inboxKey(2);
    expect(await state.clipper.refreshInboxKey()).toBe("updated");
    const { connection } = state.store.snapshot();
    expect(connection?.inboxKey.envelope.revision).toBe(2);
    expect(connection?.inboxKeyCheckedAt).toBe(state.clock);
    expect(state.api.requests[0]?.headers["knowtarium-request"]).toBeUndefined();
  });

  it("notes the same key and refuses a swapped one", async () => {
    const same = connected();
    expect(await same.clipper.refreshInboxKey()).toBe("same");

    const swapped = connected();
    const attacker = createAccountKeys();
    swapped.api.inboxKey = swapped.owner.inboxKey(2, { signer: attacker.signing });
    expect(await swapped.clipper.refreshInboxKey()).toBe("refused");
    expect(swapped.store.snapshot().connection?.inboxKey).toEqual(swapped.connection.inboxKey);
  });

  it("forgets everything on 401 and waits on other failures", async () => {
    const state = connected();
    state.api.offline = true;
    expect(await state.clipper.refreshInboxKey()).toBe("unavailable");
    state.api.offline = false;
    state.api.revoked.add(state.connection.token);
    expect(await state.clipper.refreshInboxKey()).toBe("disconnected");
    expect(state.store.snapshot()).toEqual({ notice: "disconnected" });
  });
});

describe("disconnecting", () => {
  it("revokes the token and clears everything local", async () => {
    const state = connected();
    expect(await state.clipper.disconnect()).toEqual({ revoked: true });
    const [request] = state.api.requests;
    expect(request?.method).toBe("DELETE");
    expect(request?.path).toBe("/extensions/current");
    expect(request?.headers["authorization"]).toBe(`Bearer ${state.connection.token}`);
    expect(state.api.revoked.has(state.connection.token)).toBe(true);
    expect(state.store.snapshot()).toEqual({});
  });

  it("clears everything local even when the API can't be reached", async () => {
    const state = connected();
    state.api.offline = true;
    expect(await state.clipper.disconnect()).toEqual({ revoked: false });
    expect(state.store.snapshot()).toEqual({});
  });
});
