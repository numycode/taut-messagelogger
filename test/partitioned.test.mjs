import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, start, edit } from "./fixture.mjs";
import { ScopedStorage, blobFixture } from "./taut-storage.mjs";

async function tab(t, blob, namespace = "partitioned") {
  const f = fixture();
  f.api.storage = new ScopedStorage(blob, namespace, f.controller.signal);
  t.after(async () => {
    f.controller.abort();
    await f.plugin?.stop();
  });
  await start(f);
  await f.plugin.saved.ready;
  await new Promise((r) => setTimeout(r, 0));
  return f;
}
test("sparse persistence does not rewrite unrelated maximum-size legacy entries", async (t) => {
  const entries = {};
  for (let i = 0; i < 1000; i++)
    entries["C:" + i] = {
      channel: "C",
      ts: String(i),
      at: Date.now(),
      edits: Array.from({ length: 20 }, (_, j) => ({
        oldText: j + "a".repeat(3990),
        newText: j + "b".repeat(3990),
      })),
    };
  const blob = blobFixture(new Map([["workspace:TTEST:entries", entries]]));
  const f = await tab(t, blob);
  assert.equal(f.plugin.entries.size, 1000);
  const before = new Map(blob.values);
  f.events.get("*")(edit("1", "C", "new", "fresh"));
  await f.plugin.flush();
  const changed = [...blob.values].filter(
    ([key, value]) => before.get(key) !== value,
  );
  const bytes = changed.reduce(
    (n, [, value]) => n + Buffer.byteLength(value),
    0,
  );
  assert.ok(bytes < 8 * 1024 * 1024, `sparse write serialized ${bytes} bytes`);
  const restarted = await tab(t, blob);
  assert.equal(restarted.plugin.entries.size, 1000);
  assert.equal(
    restarted.plugin.entries.get("C:1").edits.at(-1).newText,
    "fresh",
  );
});

test("sparse preview persistence does not rewrite the entire maximum image archive", async (t) => {
  const entries = {},
    images = {};
  const data = "data:image/png;base64," + "A".repeat(65536);
  for (let i = 0; i < 128; i++) {
    entries["C:" + i] = {
      channel: "C",
      ts: String(i),
      at: Date.now(),
      deleted: true,
    };
    images["C:" + i] = Array.from({ length: 3 }, () => ({
      name: "offline",
      data,
    }));
  }
  const blob = blobFixture(
    new Map([
      ["workspace:TTEST:entries", entries],
      ["workspace:TTEST:images", images],
    ]),
  );
  const f = await tab(t, blob);
  assert.equal(f.plugin.images.archived.size, 128);
  const before = blob.stats().writtenBytes;
  f.plugin.stageImages("C:0", [{ name: "replacement", data }]);
  await f.plugin.flushImages();
  const bytes = blob.stats().writtenBytes - before;
  assert.ok(
    bytes < 4 * 1024 * 1024,
    `sparse preview serialized ${bytes} bytes`,
  );
  const restarted = await tab(t, blob);
  assert.equal(restarted.plugin.images.archived.size, 128);
  assert.equal(restarted.plugin.images.get("C:0")[0].name, "replacement");
});

const legacyEntry = (ts, extra = {}) => ({
  channel: "C",
  ts,
  at: Date.now(),
  ...extra,
});
const preview = [{ name: "legacy", data: "data:image/png;base64,QQ==" }];

test("stale local retention cannot evict a recently refreshed durable deletion", async (t) => {
  const entries = {};
  for (let i = 0; i < 1000; i++)
    entries["C:" + i] = legacyEntry(String(i), {
      at: Date.now() - 100000 + i,
      edits: [{ oldText: "old", newText: "new" }],
    });
  const blob = blobFixture(new Map([["workspace:TTEST:entries", entries]]));
  const a = await tab(t, blob, "stale-retention"),
    b = await tab(t, blob, "stale-retention");
  a.plugin.unsubscribe();
  a.plugin.saved.close();
  b.events.get("*")({
    type: "message_deleted",
    channel: "C",
    deleted_ts: "0",
    previous_message: { ts: "0", text: "recent deletion" },
  });
  await b.plugin.flush();
  b.plugin.stageImages("C:0", preview);
  await b.plugin.flushImages();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(a.plugin.images.get("C:0").length, 1);
  a.events.get("*")(edit("new"));
  assert.equal(a.plugin.entries.size, 1000);
  await a.plugin.flush();
  await a.plugin.images.settled();
  await a.plugin.flushImages();
  const restarted = await tab(t, blob, "stale-retention");
  assert.equal(restarted.plugin.images.get("C:0").length, 1);
  assert.equal(restarted.plugin.entries.get("C:0")?.deleted, true);
  assert.equal(restarted.plugin.entries.has("C:1"), false);
  assert.equal(restarted.plugin.entries.has("C:new"), true);
  assert.equal(restarted.plugin.entries.size, 1000);
});

test("local cap preserves an evicted pending capture for locked retention", async (t) => {
  const entries = {};
  for (let i = 0; i < 1000; i++)
    entries["C:" + i] = legacyEntry(String(i), {
      at: Date.now() - 100000 + i,
      edits: [{ oldText: "old", newText: "new" }],
    });
  const blob = blobFixture(new Map([["workspace:TTEST:entries", entries]]));
  const a = await tab(t, blob, "pending-cap"),
    b = await tab(t, blob, "pending-cap");
  a.plugin.unsubscribe();
  a.plugin.saved.close();
  a.events.get("*")(edit("0", "C", "new", "pending"));
  b.events.get("*")({
    type: "message_deleted",
    channel: "C",
    deleted_ts: "0",
    previous_message: { ts: "0", text: "recent deletion" },
  });
  await b.plugin.flush();
  a.events.get("*")(edit("new"));
  assert.equal(a.plugin.entries.has("C:0"), false);
  await a.plugin.flush();
  const restarted = await tab(t, blob, "pending-cap");
  assert.equal(restarted.plugin.entries.get("C:0")?.deleted, true);
  assert.equal(
    restarted.plugin.entries.get("C:0").edits.at(-1).newText,
    "pending",
  );
  assert.equal(restarted.plugin.entries.has("C:1"), false);
  assert.equal(restarted.plugin.entries.size, 1000);
});

test("fresh deletion cannot restamp inherited hidden edits", async (t) => {
  const blob = blobFixture();
  const a = await tab(t, blob, "hidden-delete"),
    b = await tab(t, blob, "hidden-delete");
  a.plugin.unsubscribe();
  for (const f of [a, b]) f.events.get("*")(edit());
  await b.plugin.flush();
  b.plugin.hideEdits(b.plugin.entries.get("C:1"));
  await b.plugin.flush();
  await a.plugin.saved.refresh();
  a.events.get("*")({
    type: "message_deleted",
    channel: "C",
    deleted_ts: "1",
    previous_message: { ts: "1", text: "fresh deletion" },
  });
  await a.plugin.flush();
  const restarted = await tab(t, blob, "hidden-delete");
  const entry = restarted.plugin.entries.get("C:1");
  assert.equal(entry?.deleted, true);
  assert.equal(entry.message.text, "fresh deletion");
  assert.equal(entry.edits, undefined);
});

test("normal preview retention evicts durable oldest after restore and bucket sync", async (t) => {
  const entries = {},
    images = {};
  for (let i = 0; i < 128; i++) {
    entries["C:" + i] = legacyEntry(String(i), { deleted: true });
    images["C:" + i] = preview;
  }
  const blob = blobFixture(
    new Map([
      ["workspace:TTEST:entries", entries],
      ["workspace:TTEST:images", images],
    ]),
  );
  const f = await tab(t, blob, "normal-image-order");
  f.plugin.config.saveImages = true;
  f.plugin.images.download = async () => "data:image/png;base64,Qg==";
  for (let i = 0; i < 2; i++) {
    const ts = "new" + i;
    const file = {
      id: ts,
      mimetype: "image/png",
      thumb_480: "https://files.slack.com/" + ts,
    };
    f.events.get("*")({ type: "message", channel: "C", ts, files: [file] });
    await new Promise((r) => setTimeout(r, 0));
    f.events.get("*")({
      type: "message_deleted",
      channel: "C",
      deleted_ts: ts,
      previous_message: { ts, text: "new", files: [file] },
    });
    await f.plugin.flush();
    await f.plugin.images.settled();
    await f.plugin.flushImages();
    const order = JSON.parse(
      await blob.read("workspace:TTEST:image-index:v2"),
    ).keys;
    assert.equal(order.length, 128);
    assert.equal(order.includes("C:" + i), false);
    assert.equal(order.includes("C:" + (i + 1)), true);
    assert.equal(order.at(-1), "C:" + ts);
  }
  const restarted = await tab(t, blob, "normal-image-order");
  assert.equal(restarted.plugin.images.archived.size, 128);
  assert.equal(restarted.plugin.images.get("C:0").length, 0);
  assert.equal(restarted.plugin.images.get("C:1").length, 0);
  assert.equal(restarted.plugin.images.get("C:2").length, 1);
  assert.equal(restarted.plugin.images.get("C:new1").length, 1);
});

for (const kind of ["entries", "images"]) {
  test(`partially converted legacy ${kind} replay without losing or duplicating payloads`, async (t) => {
    const entries = {
      "C:1": legacyEntry("1", {
        deleted: true,
        edits: [{ oldText: "old", newText: "new" }],
      }),
      "C:2": legacyEntry("2", { deleted: true }),
    };
    const images = { "C:1": preview, "C:2": preview };
    const blob = blobFixture(
      new Map([
        ["workspace:TTEST:entries", entries],
        ["workspace:TTEST:images", images],
      ]),
    );
    const legacyKey = "workspace:TTEST:" + kind;
    const original = blob.values.get(legacyKey);
    const write = blob.write;
    let buckets = 0,
      failed = false;
    blob.write = async (key, raw) => {
      if (key.startsWith(legacyKey + ":v2:") && ++buckets === 2) {
        failed = true;
        return false;
      }
      return write(key, raw);
    };
    const f = fixture();
    f.context.console = { ...console, error() {} };
    f.api.storage = new ScopedStorage(
      blob,
      "partial-migration-" + kind,
      f.controller.signal,
    );
    if (kind === "entries") await assert.rejects(start(f), /Couldn't save/);
    else {
      await start(f);
      await assert.rejects(f.plugin.imageSaved.ready, /Couldn't save/);
    }
    assert.equal(failed, true);
    assert.equal(blob.values.get(legacyKey), original);
    f.controller.abort();
    await f.plugin.stop();
    const restarted = await tab(t, blob, "partial-migration-" + kind);
    assert.equal(restarted.plugin.entries.size, 2);
    assert.equal(restarted.plugin.entries.get("C:1").edits.length, 1);
    for (const key of ["C:1", "C:2"])
      assert.equal(restarted.plugin.images.get(key)[0].data, preview[0].data);
    assert.equal(blob.values.has(legacyKey), false);
  });
}

test("pending recovery tolerates a malformed empty bucket", async (t) => {
  const blob = blobFixture(
    new Map([
      ["workspace:TTEST:entry-index:v2", { schema: 2, pending: true }],
      ["workspace:TTEST:entries:v2:0", null],
    ]),
  );
  const f = await tab(t, blob, "null-bucket");
  assert.equal(f.plugin.entries.size, 0);
  assert.equal(
    JSON.parse(blob.values.get("workspace:TTEST:entry-index:v2")).pending,
    undefined,
  );
});

test("legacy migration ignores malformed entries without losing valid payloads or barriers", async (t) => {
  const blob = blobFixture(
    new Map([
      [
        "workspace:TTEST:entries",
        {
          "C:1": legacyEntry("1", { deleted: true }),
          "C:null": null,
          "C:bad": { at: 1 },
          __dismissals: {
            clock: 2,
            floor: -1,
            hideFloor: -1,
            keys: { "C:missing": { accept: 2 } },
          },
        },
      ],
    ]),
  );
  const f = await tab(t, blob);
  assert.equal(f.plugin.entries.size, 1);
  assert.equal(f.plugin.saved.get().__dismissals.keys["C:missing"].accept, 2);
  assert.equal(f.plugin.saved.get()["C:null"], undefined);
  assert.equal(f.plugin.saved.get()["C:bad"], undefined);
});

test("stale unsubscribed preview writer cannot persist bytes after durable acceptance", async (t) => {
  const blob = blobFixture();
  const a = await tab(t, blob, "stale-preview"),
    b = await tab(t, blob, "stale-preview");
  a.events.get("*")({
    type: "message_deleted",
    channel: "C",
    deleted_ts: "1",
    previous_message: { ts: "1", text: "deleted" },
  });
  await a.plugin.flush();
  await b.plugin.saved.refresh();
  b.plugin.sync();
  a.controller.abort();
  a.plugin.unsubscribe();
  a.plugin.saved.close();
  // This is a completed preview already waiting in the persistence batch, not a live fetch.
  a.plugin.stageImages("C:1", preview);
  b.plugin.acceptDelete(b.plugin.entries.get("C:1"));
  await b.plugin.flush();
  await b.plugin.images.settled();
  await b.plugin.flushImages();
  await a.plugin.flushImages();
  const stored = Object.assign(
    {},
    ...[...blob.values]
      .filter(([key]) => key.startsWith("workspace:TTEST:images:v2:"))
      .map(([, raw]) => JSON.parse(raw)),
  );
  assert.equal(stored["C:1"], undefined);
});

test("interrupted migration retains legacy until recovery commits, then removes it", async (t) => {
  const old = {
    "C:1": legacyEntry("1", { deleted: true }),
    "C:2": legacyEntry("2", { edits: [{ oldText: "old", newText: "new" }] }),
    __dismissals: {
      clock: 1,
      floor: -1,
      hideFloor: -1,
      keys: { "C:1": { accept: 1 } },
    },
  };
  const blob = blobFixture(new Map([["workspace:TTEST:entries", old]]));
  const write = blob.write;
  let failed = false;
  blob.write = async (key, raw) => {
    if (
      !failed &&
      key === "workspace:TTEST:entry-index:v2" &&
      !JSON.parse(raw).pending
    ) {
      failed = true;
      return false;
    }
    return write(key, raw);
  };
  const f = fixture();
  f.context.console = { ...console, error() {} };
  f.api.storage = new ScopedStorage(
    blob,
    "migration-failure",
    f.controller.signal,
  );
  await assert.rejects(start(f), /Couldn't save/);
  assert.ok(blob.values.has("workspace:TTEST:entries"));
  f.controller.abort();
  await f.plugin.stop();
  const restarted = await tab(t, blob, "migration-failure");
  assert.equal(restarted.plugin.entries.has("C:1"), false);
  assert.equal(restarted.plugin.entries.get("C:2").edits[0].oldText, "old");
  assert.equal(restarted.plugin.saved.get().__dismissals.clock, 1);
  assert.equal(blob.values.has("workspace:TTEST:entries"), false);
});

test("interrupted image batch recovers insertion order rather than bucket order", async (t) => {
  const blob = blobFixture();
  const f = await tab(t, blob, "image-order");
  for (const ts of ["new1", "new0"])
    f.events.get("*")({
      type: "message_deleted",
      channel: "C",
      deleted_ts: ts,
      previous_message: { ts, text: "deleted" },
    });
  await f.plugin.flush();
  const write = blob.write;
  let failed = false;
  blob.write = async (key, raw) => {
    if (
      !failed &&
      key === "workspace:TTEST:image-index:v2" &&
      !JSON.parse(raw).pending
    ) {
      failed = true;
      return false;
    }
    return write(key, raw);
  };
  f.context.console = { ...console, error() {} };
  f.plugin.stageImages("C:new1", preview);
  f.plugin.stageImages("C:new0", preview);
  await f.plugin.flushImages();
  assert.equal(failed, true);
  // Discard uncommitted local retries to model process loss, not graceful shutdown.
  f.plugin.imagePending.clear();
  f.controller.abort();
  f.plugin.saved.close();
  f.plugin.imageSaved.close();
  const restarted = await tab(t, blob, "image-order");
  assert.equal(restarted.plugin.images.get("C:new1")[0].data, preview[0].data);
  assert.equal(restarted.plugin.images.get("C:new0")[0].data, preview[0].data);
  assert.deepEqual(
    JSON.parse(blob.values.get("workspace:TTEST:image-index:v2")).keys,
    ["C:new1", "C:new0"],
  );
});

test("failed image eviction does not promote the oldest preview during recovery", async (t) => {
  const entries = {},
    images = {};
  for (let i = 0; i < 128; i++) {
    entries["C:" + i] = legacyEntry(String(i), { deleted: true });
    images["C:" + i] = preview;
  }
  const blob = blobFixture(
    new Map([
      ["workspace:TTEST:entries", entries],
      ["workspace:TTEST:images", images],
    ]),
  );
  const f = await tab(t, blob, "failed-image-eviction");
  f.events.get("*")({
    type: "message_deleted",
    channel: "C",
    deleted_ts: "new",
    previous_message: { ts: "new", text: "new" },
  });
  await f.plugin.flush();
  const write = blob.write;
  let failed = false;
  blob.write = async (key, raw) => {
    if (!failed && key.startsWith("workspace:TTEST:images:v2:")) {
      failed = true;
      return false;
    }
    return write(key, raw);
  };
  f.context.console = { ...console, error() {} };
  f.plugin.stageImages("C:new", preview);
  await f.plugin.flushImages();
  assert.equal(failed, true);
  crash(f);
  const restarted = await tab(t, blob, "failed-image-eviction");
  assert.equal(restarted.plugin.images.archived.size, 128);
  restarted.plugin.stageImages("C:new", preview);
  await restarted.plugin.flushImages();
  assert.equal(restarted.plugin.images.get("C:0").length, 0);
  assert.equal(restarted.plugin.images.get("C:1").length, 1);
  assert.equal(restarted.plugin.images.get("C:new").length, 1);
});

test("interrupted image migration replays durably and cleans up legacy bytes", async (t) => {
  const blob = blobFixture(
    new Map([
      [
        "workspace:TTEST:entries",
        { "C:1": legacyEntry("1", { deleted: true }) },
      ],
      ["workspace:TTEST:images", { "C:1": preview }],
    ]),
  );
  const write = blob.write;
  let failed = false;
  blob.write = async (key, raw) => {
    if (
      !failed &&
      key === "workspace:TTEST:image-index:v2" &&
      !JSON.parse(raw).pending
    ) {
      failed = true;
      return false;
    }
    return write(key, raw);
  };
  const f = fixture();
  f.context.console = { ...console, error() {} };
  f.api.storage = new ScopedStorage(
    blob,
    "image-migration-failure",
    f.controller.signal,
  );
  await start(f);
  await assert.rejects(f.plugin.imageSaved.ready, /Couldn't save/);
  assert.ok(blob.values.has("workspace:TTEST:images"));
  f.controller.abort();
  await f.plugin.stop();
  const restarted = await tab(t, blob, "image-migration-failure");
  assert.equal(restarted.plugin.images.get("C:1")[0].data, preview[0].data);
  assert.equal(blob.values.has("workspace:TTEST:images"), false);
  const again = await tab(t, blob, "image-migration-failure");
  assert.equal(again.plugin.images.get("C:1")[0].data, preview[0].data);
});

// A crash has no graceful flush: discard retry queues, abort broadcasts, and close subscriptions.
function crash(f) {
  f.plugin.dirty.clear();
  f.plugin.dismiss.clear();
  f.plugin.imagePending.clear();
  f.controller.abort();
  f.plugin.saved.close();
  f.plugin.imageSaved.close();
}
for (const failure of ["second-bucket", "final-index"])
  for (const action of ["accept", "hide"]) {
    test(`entry recovery preserves durable buckets and dismissal barriers (${failure}, ${action})`, async (t) => {
      const blob = blobFixture(
        new Map([
          [
            "workspace:TTEST:entries",
            {
              "C:1": legacyEntry("1", {
                deleted: true,
                message: { channel: "C", ts: "1", text: "deleted original" },
                edits: [{ oldText: "old", newText: "new" }],
              }),
              "C:keep": legacyEntry("keep", { deleted: true }),
            },
          ],
        ]),
      );
      const f = await tab(t, blob, "entry-crash-" + failure + action);
      const stale = await tab(t, blob, "entry-crash-" + failure + action);
      stale.events.get("*")(edit("1"));
      stale.controller.abort();
      stale.plugin.unsubscribe();
      stale.plugin.saved.close();
      const write = blob.write;
      let buckets = 0,
        failed = false;
      blob.write = async (key, raw) => {
        const bucket = key.startsWith("workspace:TTEST:entries:v2:");
        if (bucket) buckets++;
        if (
          !failed &&
          (failure === "second-bucket"
            ? bucket && buckets === 2
            : key === "workspace:TTEST:entry-index:v2" &&
              !JSON.parse(raw).pending)
        ) {
          failed = true;
          return false;
        }
        return write(key, raw);
      };
      f.context.console = { ...console, error() {} };
      // The dismissal is in the first bucket; unrelated captures follow it.
      f.plugin[action === "accept" ? "acceptDelete" : "hideEdits"](
        f.plugin.entries.get("C:1"),
      );
      f.events.get("*")(edit("2"));
      f.events.get("*")(edit("3"));
      await f.plugin.flush();
      assert.equal(failed, true);
      const durable = Object.assign(
        {},
        ...[...blob.values]
          .filter(([key]) => key.startsWith("workspace:TTEST:entries:v2:"))
          .map(([, raw]) => JSON.parse(raw)),
      );
      const savedNewKeys = ["C:2", "C:3"].filter((k) => durable[k]);
      if (action === "accept") assert.equal(durable["C:1"], undefined);
      else assert.equal(durable["C:1"].edits, undefined);
      crash(f);
      const restarted = await tab(t, blob, "entry-crash-" + failure + action);
      assert.equal(restarted.plugin.entries.has("C:1"), action === "hide");
      if (action === "hide") {
        assert.equal(restarted.plugin.entries.get("C:1").edits, undefined);
        assert.equal(
          restarted.plugin.entries.get("C:1").message.text,
          "deleted original",
        );
      }
      assert.equal(restarted.plugin.entries.has("C:keep"), true);
      for (const key of savedNewKeys)
        assert.equal(restarted.plugin.entries.get(key).edits[0].newText, "new");
      assert.equal(
        restarted.plugin.saved.get().__dismissals.keys["C:1"][action],
        1,
      );
      assert.equal(
        JSON.parse(blob.values.get("workspace:TTEST:entry-index:v2")).pending,
        undefined,
      );
      // A real generation-zero capture that missed broadcasts cannot undo recovered acceptance.
      await stale.plugin.flush();
      await restarted.plugin.saved.refresh();
      if (action === "accept")
        assert.equal(restarted.plugin.saved.get()["C:1"], undefined);
      else assert.equal(restarted.plugin.saved.get()["C:1"].edits, undefined);
    });
  }

test("simultaneous startup and eviction keep a single global entry and preview cap", async (t) => {
  const entries = {},
    images = {};
  for (let i = 0; i < 1000; i++)
    entries["C:" + i] = legacyEntry(String(i), {
      at: Date.now() - 100000 + i,
      deleted: true,
    });
  for (let i = 0; i < 128; i++) images["C:" + i] = preview;
  const blob = blobFixture(
    new Map([
      ["workspace:TTEST:entries", entries],
      ["workspace:TTEST:images", images],
    ]),
  );
  const [a, b] = await Promise.all([
    tab(t, blob, "global-caps"),
    tab(t, blob, "global-caps"),
  ]);
  // Neither writer can rely on broadcast freshness for global eviction.
  for (const [f, ts] of [
    [a, "a"],
    [b, "b"],
  ])
    f.events.get("*")({
      type: "message_deleted",
      channel: "C",
      deleted_ts: ts,
      previous_message: { ts, text: "new deletion" },
    });
  a.controller.abort();
  b.controller.abort();
  a.plugin.saved.close();
  b.plugin.saved.close();
  await Promise.all([a.plugin.flush(), b.plugin.flush()]);
  a.plugin.stageImages("C:a", preview);
  b.plugin.stageImages("C:b", preview);
  await Promise.all([a.plugin.flushImages(), b.plugin.flushImages()]);
  const restarted = await tab(t, blob, "global-caps");
  assert.equal(restarted.plugin.entries.size, 1000);
  assert.equal(restarted.plugin.entries.has("C:0"), false);
  assert.equal(restarted.plugin.entries.has("C:1"), false);
  assert.equal(restarted.plugin.entries.has("C:a"), true);
  assert.equal(restarted.plugin.entries.has("C:b"), true);
  assert.equal(restarted.plugin.images.archived.size, 128);
  assert.equal(restarted.plugin.images.get("C:a").length, 1);
  assert.equal(restarted.plugin.images.get("C:b").length, 1);
});
