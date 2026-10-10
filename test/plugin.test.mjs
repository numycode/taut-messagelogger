import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, start, edit } from "./fixture.mjs";
test("captures generic message subtype edit, self, bot, DM and thread events without exclusions", async () => {
  const f = await start();
  for (const c of ["C", "D"]) f.events.get("*")(edit("1", c));
  await f.plugin.flush();
  assert.equal(f.plugin.entries.size, 2);
  assert.equal(f.plugin.entries.get("C:1").edits[0].oldText, "old");
  f.controller.abort();
  await f.plugin.stop();
});
test("repeat transitions preserve exact chronological edit history across flushes", async () => {
  const f = await start();
  for (const [a, b] of [
    ["a", "b"],
    ["b", "a"],
    ["a", "b"],
  ]) {
    f.events.get("*")(edit("1", "C", a, b));
    await f.plugin.flush();
  }
  assert.equal(f.plugin.entries.get("C:1").edits.length, 3);
  f.controller.abort();
  await f.plugin.stop();
});
test("editing without previous payload uses latest observed text", async () => {
  const f = await start();
  f.events.get("*")({ type: "message", channel: "C", ts: "1", text: "a" });
  for (const text of ["b", "c"]) {
    f.events.get("*")({
      type: "message_changed",
      channel: "C",
      message: { ts: "1", text },
    });
  }
  assert.equal(f.plugin.entries.get("C:1").edits.at(-1).oldText, "b");
  f.controller.abort();
  await f.plugin.stop();
});
test("locked latest-value merge keeps concurrent tab edits and deduplicates replay", async (t) => {
  const shared = new Map();
  const a = await start(fixture(shared)),
    b = await start(fixture(shared));
  t.after(async () => {
    a.controller.abort();
    b.controller.abort();
    await a.plugin.stop();
    await b.plugin.stop();
  });
  a.events.get("*")(edit("1"));
  b.events.get("*")(edit("2"));
  await Promise.all([a.plugin.flush(), b.plugin.flush()]);
  assert.equal(a.plugin.entries.size, 2);
  assert.equal(b.plugin.entries.size, 2);
  b.events.get("*")(edit("1"));
  await b.plugin.flush();
  assert.equal(a.plugin.entries.get("C:1").edits.length, 1);
});
test("delete injects original payload, inline history is strikethrough, dismiss actions persist", async (t) => {
  const f = await start();
  t.after(async () => {
    f.controller.abort();
    await f.plugin.stop();
  });
  f.events.get("*")(edit());
  f.events.get("*")({
    type: "message_deleted",
    channel: "C",
    deleted_ts: "1",
    previous_message: { ts: "1", text: "new", thread_ts: "root" },
  });
  await f.plugin.flush();
  assert.equal(f.api.inject()[0].text, "new");
  assert.equal(f.api.inject()[0].thread_ts, "root");
  const history = f.plugin.editHistory(f.plugin.entries.get("C:1").edits);
  assert.equal(history.children[0][0].children[0].type, "s");
  assert.equal(history.children[0][0].children[1].children[0], "(edited)");
  assert.match(f.plugin.css(), /#e01e5a/);
  f.plugin.config.deletedStyle = "opacity";
  assert.match(f.plugin.css(), /0.5/);
  f.plugin.hideEdits(f.plugin.entries.get("C:1"));
  await f.plugin.flush();
  assert.equal(f.plugin.entries.get("C:1").edits, undefined);
  f.plugin.acceptDelete(f.plugin.entries.get("C:1"));
  await f.plugin.flush();
  assert.equal(f.api.inject().length, 0);
  const restarted = await start(fixture(f.shared));
  restarted.controller.abort();
  await restarted.plugin.stop();
  assert.equal(restarted.plugin.entries.size, 0);
});
test("workspace storage is isolated and switch disables old capture/injection", async (t) => {
  const shared = new Map(),
    f = await start(fixture(shared, "TONE"));
  t.after(async () => {
    f.controller.abort();
    await f.plugin.stop();
  });
  f.events.get("*")(edit());
  await f.plugin.flush();
  const g = await start(fixture(shared, "TTWO"));
  t.after(async () => {
    g.controller.abort();
    await g.plugin.stop();
  });
  assert.equal(g.plugin.entries.size, 0);
  f.api.redux.getRawState = () => ({ selfTeamIds: { teamId: "TTWO" } });
  f.events.get("*")(edit("2"));
  assert.equal(f.plugin.entries.size, 1);
  assert.equal(f.api.inject().length, 0);
});
test("count, edit count, edit text and recent payload bounds hold under burst", async (t) => {
  const f = await start();
  t.after(async () => {
    f.controller.abort();
    await f.plugin.stop();
  });
  for (let n = 0; n < 1100; n++) f.events.get("*")(edit(String(n)));
  for (let n = 0; n < 30; n++)
    f.events.get("*")(
      edit(
        "1099",
        "C",
        String(n) + "x".repeat(5000),
        String(n + 1) + "x".repeat(5000),
      ),
    );
  await f.plugin.flush();
  assert.equal(f.plugin.entries.size, 1000);
  const e = f.plugin.entries.get("C:1099");
  assert.equal(e.edits.length, 20);
  assert.equal(e.edits[0].oldText.length, 4000);
  assert.ok(f.plugin.recent.size <= 400);
  assert.ok(f.stats().writes < 10);
});
test("image sources reject private network, arbitrary hosts, ports, userinfo and preserve concurrency", async (t) => {
  const f = await start();
  t.after(async () => {
    f.controller.abort();
    await f.plugin.stop();
  });
  f.plugin.config.saveImages = true;
  let calls = 0;
  let release;
  const wait = new Promise((r) => (release = r));
  f.plugin.images.download = async () => {
    calls++;
    await wait;
    return "data:image/png;base64,aGVsbG8=";
  };
  for (let i = 0; i < 20; i++) {
    const msg = {
      type: "message",
      channel: "C",
      ts: String(i),
      files: [
        {
          id: "F",
          mimetype: "image/png",
          thumb_480: "https://files.slack.com/a",
        },
      ],
    };
    f.events.get("*")(msg);
  }
  assert.equal(calls, 8);
  assert.equal(f.plugin.images.pending.size, 8);
  f.controller.abort();
  release();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(f.plugin.images.recent.size, 0);
});
test("retention purges cold restore and archived images survive deletion/restart", async (t) => {
  const shared = new Map([
    [
      "workspace:TTEST:entries",
      {
        "C:old": {
          channel: "C",
          ts: "old",
          at: 0,
          deleted: true,
          message: { channel: "C", ts: "old", text: "old" },
        },
      },
    ],
  ]);
  const f = await start(fixture(shared));
  t.after(async () => {
    f.controller.abort();
    await f.plugin.stop();
  });
  await f.plugin.flush();
  assert.equal(f.plugin.entries.size, 0);
  f.plugin.config.saveImages = true;
  f.plugin.images.download = async () => "data:image/png;base64,aGVsbG8=";
  f.events.get("*")({
    type: "message",
    channel: "C",
    ts: "1",
    files: [
      {
        id: "F1",
        mimetype: "image/png",
        thumb_480: "https://files.slack.com/a",
      },
    ],
  });
  await new Promise((r) => setTimeout(r, 0));
  f.events.get("*")({ type: "message_deleted", channel: "C", deleted_ts: "1" });
  await f.plugin.flush();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(f.plugin.images.get("C:1").length, 1);
  await f.plugin.images.settled();
  await f.plugin.flushImages();
  const g = await start(fixture(shared));
  t.after(async () => {
    g.controller.abort();
    await g.plugin.stop();
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(g.plugin.images.get("C:1")[0].fileId, "F1");
});
test("host allowlist never requests private or arbitrary URLs and fetch omits auth with redirects blocked", async (t) => {
  const f = fixture();
  const requests = [];
  f.context.fetch = async (url, options) => {
    requests.push({ url, options });
    return { ok: false, headers: new Headers(), body: null };
  };
  await start(f);
  t.after(async () => {
    f.controller.abort();
    await f.plugin.stop();
  });
  f.plugin.config.saveImages = true;
  for (const [i, url] of [
    "https://127.0.0.1/a",
    "https://[::1]/a",
    "https://10.0.0.1/a",
    "https://attacker.invalid/a",
    "https://files.slack.com.attacker.invalid/a",
    "https://user:pass@files.slack.com/a",
    "https://files.slack.com:444/a",
    "http://files.slack.com/a",
    "https://files.slack.com/a",
  ].entries()) {
    f.events.get("*")({
      type: "message",
      channel: "C",
      ts: String(i),
      files: [{ mimetype: "image/png", thumb_480: url }],
    });
  }
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.credentials, "omit");
  assert.equal(requests[0].options.redirect, "error");
  assert.equal(requests[0].options.referrerPolicy, "no-referrer");
});
test("corrupt restore cannot crash and unknown oversized message fields remain bounded", async (t) => {
  const shared = new Map([
    [
      "workspace:TTEST:entries",
      {
        "C:1": {
          channel: "C",
          ts: "1",
          at: Date.now(),
          edits: { bad: "shape" },
        },
      },
    ],
  ]);
  const f = await start(fixture(shared));
  t.after(async () => {
    f.controller.abort();
    await f.plugin.stop();
  });
  await new Promise((r) => setTimeout(r, 0));
  f.events.get("*")({
    type: "message",
    channel: "C",
    ts: "2",
    text: "a",
    unknown: "x".repeat(100000),
    user: "U",
  });
  assert.ok(
    Buffer.byteLength(JSON.stringify(f.plugin.recent.get("C:2"))) <= 32768,
  );
  assert.equal(f.plugin.entries.get("C:1").edits, undefined);
});
test("cross-tab archived preview synchronization and image persistence batching", async (t) => {
  const shared = new Map(),
    a = await start(fixture(shared)),
    b = await start(fixture(shared));
  t.after(async () => {
    a.controller.abort();
    b.controller.abort();
    await a.plugin.stop();
    await b.plugin.stop();
  });
  a.plugin.config.saveImages = true;
  a.plugin.images.download = async () => "data:image/png;base64,aGVsbG8=";
  for (let i = 0; i < 8; i++)
    a.events.get("*")({
      type: "message",
      channel: "C",
      ts: String(i),
      files: [
        { mimetype: "image/png", thumb_480: "https://files.slack.com/a" },
      ],
    });
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 8; i++)
    a.events.get("*")({
      type: "message_deleted",
      channel: "C",
      deleted_ts: String(i),
    });
  await a.plugin.flush();
  await a.plugin.flushImages();
  assert.equal(b.plugin.images.get("C:0").length, 1);
  assert.ok(a.stats().writes <= 4);
});
test("UTF-8 message bound and long edit replay deduplication", async (t) => {
  const f = await start();
  t.after(async () => {
    f.controller.abort();
    await f.plugin.stop();
  });
  f.events.get("*")({
    type: "message",
    channel: "C",
    ts: "1",
    text: "界".repeat(20000),
  });
  assert.ok(
    Buffer.byteLength(JSON.stringify(f.plugin.recent.get("C:1"))) <= 32768,
  );
  const e = edit("2", "C", "a".repeat(5000), "b".repeat(5000));
  f.events.get("*")(e);
  f.events.get("*")(e);
  assert.equal(f.plugin.entries.get("C:2").edits.length, 1);
});
test("bots, threaded DM deletes, tombstones and configurable sender exclusions", async (t) => {
  const f = await start();
  t.after(async () => {
    f.controller.abort();
    await f.plugin.stop();
  });
  const bot = {
    type: "message",
    subtype: "bot_message",
    channel: "D",
    ts: "10",
    bot_id: "BOT",
    app_id: "APP",
    text: "bot",
    thread_ts: "9",
  };
  f.events.get("*")(bot);
  f.events.get("*")({
    type: "message",
    subtype: "message_changed",
    channel: "D",
    previous_message: bot,
    message: { ...bot, text: "edited" },
  });
  assert.equal(f.plugin.entries.get("D:10").edits.length, 1);
  f.events.get("*")({
    type: "message_changed",
    channel: "D",
    message: { ts: "10", subtype: "tombstone" },
  });
  assert.equal(f.plugin.entries.get("D:10").deleted, true);
  assert.equal(f.api.inject()[0].thread_ts, "9");
  f.plugin.config.ignoreSelf = true;
  f.events.get("*")(edit("self"));
  assert.equal(f.plugin.entries.has("C:self"), false);
  f.plugin.config.ignoreSelf = false;
  f.plugin.config.ignoreEditsFrom = " BOT, APP ";
  f.events.get("*")({
    type: "message_changed",
    channel: "D",
    previous_message: { ...bot, ts: "11" },
    message: { ...bot, ts: "11", text: "skip" },
  });
  assert.equal(f.plugin.entries.has("D:11"), false);
  f.plugin.config.ignoreAnchors = "lax";
  f.events.get("*")({
    type: "message_deleted",
    channel: "D",
    deleted_ts: "12",
    previous_message: { ...bot, ts: "12" },
  });
  assert.equal(f.plugin.entries.has("D:12"), false);
});
test("failed persistence keeps dirty state for subsequent retry without dropping received edits", async (t) => {
  const f = await start();
  t.after(async () => {
    f.controller.abort();
    await f.plugin.stop();
  });
  f.events.get("*")(edit());
  const update = f.plugin.saved.update;
  f.plugin.saved.update = async () => {
    throw Error("offline fixture disk failure");
  };
  const logs = [];
  f.context.console = { ...console, error: (...args) => logs.push(args) };
  await f.plugin.flush();
  assert.equal(f.plugin.dirty.size, 1);
  f.plugin.saved.update = update;
  await f.plugin.flush();
  assert.equal(f.plugin.dirty.size, 0);
  assert.equal(f.plugin.saved.get()["C:1"].edits.length, 1);
  assert.equal(logs.length, 1);
});
test("concurrent same-message branches retain new edits without replaying common baseline", async (t) => {
  const shared = new Map(),
    a = await start(fixture(shared)),
    b = await start(fixture(shared));
  t.after(async () => {
    a.controller.abort();
    b.controller.abort();
    await a.plugin.stop();
    await b.plugin.stop();
  });
  a.events.get("*")(edit("1", "C", "a", "b"));
  await a.plugin.flush();
  a.events.get("*")(edit("1", "C", "b", "c"));
  b.events.get("*")(edit("1", "C", "b", "d"));
  await Promise.all([a.plugin.flush(), b.plugin.flush()]);
  assert.equal(a.plugin.entries.get("C:1").edits.length, 3);
});
test("image retained-key cache remains bounded even when another tab evicts old entries", async (t) => {
  const f = await start();
  t.after(async () => {
    f.controller.abort();
    await f.plugin.stop();
  });
  for (let i = 0; i < 1100; i++) f.plugin.images.retain("C:" + i);
  assert.ok(f.plugin.images.retained.size <= 1000);
});
test("accepting deletion in another tab prevents an in-flight preview from resurrecting archived bytes", async (t) => {
  const shared = new Map(),
    a = await start(fixture(shared)),
    b = await start(fixture(shared));
  t.after(async () => {
    a.controller.abort();
    b.controller.abort();
    await a.plugin.stop();
    await b.plugin.stop();
  });
  a.plugin.config.saveImages = true;
  let resolve;
  a.plugin.images.download = () => new Promise((r) => (resolve = r));
  a.events.get("*")({
    type: "message",
    channel: "C",
    ts: "1",
    files: [{ mimetype: "image/png", thumb_480: "https://files.slack.com/a" }],
  });
  a.events.get("*")({ type: "message_deleted", channel: "C", deleted_ts: "1" });
  await a.plugin.flush();
  b.plugin.acceptDelete(b.plugin.entries.get("C:1"));
  await b.plugin.flush();
  resolve("data:image/png;base64,aGVsbG8=");
  await new Promise((r) => setTimeout(r, 0));
  await a.plugin.flushImages();
  assert.equal(a.plugin.images.get("C:1").length, 0);
  assert.equal(shared.get("workspace:TTEST:images")["C:1"], undefined);
});
test("oversized identity fields cannot bypass message payload bound", async (t) => {
  const f = await start();
  t.after(async () => {
    f.controller.abort();
    await f.plugin.stop();
  });
  f.events.get("*")({
    type: "message",
    channel: "C",
    ts: "1",
    text: "a",
    user: "U".repeat(100000),
    thread_ts: "1".repeat(100000),
  });
  assert.ok(
    Buffer.byteLength(JSON.stringify(f.plugin.recent.get("C:1"))) <= 32768,
  );
});
test("router message category without a type field still captures the original", async (t) => {
  const f = await start();
  t.after(async () => {
    f.controller.abort();
    await f.plugin.stop();
  });
  f.events.get("message")?.({
    channel: "D",
    ts: "1",
    text: "category payload",
  });
  f.events.get("*")({ type: "message_deleted", channel: "D", deleted_ts: "1" });
  assert.equal(f.plugin.entries.get("D:1").message?.text, "category payload");
});
test("router edit/delete categories without payload type or subtype are recognized", async (t) => {
  const f = await start();
  t.after(async () => {
    f.controller.abort();
    await f.plugin.stop();
  });
  f.events.get("message_changed")?.({
    channel: "C",
    previous_message: { ts: "1", text: "old" },
    message: { ts: "1", text: "new" },
  });
  assert.equal(f.plugin.entries.get("C:1")?.edits.length, 1);
  f.events.get("message_deleted")?.({
    channel: "C",
    deleted_ts: "1",
    previous_message: { ts: "1", text: "new" },
  });
  assert.equal(f.plugin.entries.get("C:1").deleted, true);
});
