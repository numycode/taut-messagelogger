import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, start, edit } from "./fixture.mjs";
import { ScopedStorage, blobFixture, readEntries } from "./taut-storage.mjs";

const deletion = {
  type: "message_deleted",
  channel: "C",
  deleted_ts: "1",
  previous_message: { ts: "1", text: "new" },
};
async function tab(t, blob, namespace = "release-fixes") {
  const f = fixture();
  f.api.storage = new ScopedStorage(blob, namespace, f.controller.signal);
  await start(f);
  await f.plugin.saved.ready;
  await new Promise((r) => setTimeout(r, 0));
  t.after(async () => {
    f.controller.abort();
    await f.plugin.stop();
  });
  return f;
}
for (const replacement of [
  "B-first",
  "A-first",
  "removed",
  "omitted-delete",
  "tombstoned-delete",
]) {
  test(`pending preview follows latest source (${replacement})`, async (t) => {
    const blob = blobFixture();
    const f = await tab(t, blob);
    f.plugin.config.saveImages = true;
    const resolve = new Map();
    f.plugin.images.download = (url) => new Promise((r) => resolve.set(url, r));
    const file = (id) => ({
      id,
      mimetype: "image/png",
      thumb_480: "https://files.slack.com/" + id,
    });
    f.events.get("*")({
      type: "message",
      channel: "C",
      ts: "1",
      text: "old",
      files: [file("A")],
    });
    if (!replacement.endsWith("delete")) {
      f.events.get("*")({
        ...edit(),
        message: {
          ts: "1",
          text: "new",
          files: replacement === "removed" ? [] : [file("B")],
        },
      });
    }
    // The deletion may omit file metadata even though the previous message had it.
    f.events.get("*")({
      ...deletion,
      previous_message: {
        ...deletion.previous_message,
        ...(replacement === "tombstoned-delete" ? { files: ["MISSING"] } : {}),
      },
    });
    await f.plugin.flush();
    if (replacement.endsWith("first")) {
      assert.equal(resolve.has("https://files.slack.com/B"), true);
      for (const id of replacement === "B-first" ? ["B", "A"] : ["A", "B"]) {
        resolve.get("https://files.slack.com/" + id)(
          "data:image/png;base64,aGVsbG8=",
        );
        await new Promise((r) => setTimeout(r, 0));
      }
    } else {
      resolve.get("https://files.slack.com/A")(
        "data:image/png;base64,aGVsbG8=",
      );
      await new Promise((r) => setTimeout(r, 0));
    }
    await f.plugin.images.settled();
    await f.plugin.flushImages();
    const expected =
      replacement === "removed"
        ? []
        : [replacement.endsWith("delete") ? "A" : "B"];
    assert.deepEqual(
      Array.from(f.plugin.images.get("C:1"), (image) => image.fileId),
      expected,
    );
    const restart = await tab(t, blob);
    assert.deepEqual(
      Array.from(restart.plugin.images.get("C:1"), (image) => image.fileId),
      expected,
    );
  });
}

for (const metadata of ["replacement", "omitted", "unresolved"]) {
  test(`completed preview reconciles deletion metadata (${metadata})`, async (t) => {
    const blob = blobFixture();
    const f = await tab(t, blob);
    f.plugin.config.saveImages = true;
    const releases = new Map();
    f.plugin.images.download = (url) =>
      new Promise((r) => releases.set(url, r));
    const file = (id) => ({
      id,
      mimetype: "image/png",
      thumb_480: "https://files.slack.com/" + id,
    });
    f.events.get("*")({
      type: "message",
      channel: "C",
      ts: "1",
      text: "old",
      files: [file("A")],
    });
    releases.get("https://files.slack.com/A")("data:image/png;base64,QQ==");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(f.plugin.images.recent.get("C:1")[0].fileId, "A");
    f.events.get("*")({
      ...deletion,
      previous_message: {
        ...deletion.previous_message,
        ...(metadata === "replacement"
          ? { files: [file("B")] }
          : metadata === "unresolved"
            ? { files: ["MISSING"] }
            : {}),
      },
    });
    if (metadata === "replacement") {
      assert.equal(releases.has("https://files.slack.com/B"), true);
      assert.equal(f.plugin.images.get("C:1").length, 0);
      releases.get("https://files.slack.com/B")("data:image/png;base64,Qg==");
      await new Promise((r) => setTimeout(r, 0));
    }
    await f.plugin.flush();
    await f.plugin.images.settled();
    await f.plugin.flushImages();
    const expected = metadata === "replacement" ? "B" : "A";
    assert.equal(f.plugin.images.get("C:1")[0]?.fileId, expected);
    const restart = await tab(t, blob);
    assert.equal(restart.plugin.images.get("C:1")[0]?.fileId, expected);
    assert.equal(
      restart.plugin.images.get("C:1")[0]?.data,
      metadata === "replacement"
        ? "data:image/png;base64,Qg=="
        : "data:image/png;base64,QQ==",
    );
  });
}

test("completed preview replacement queues behind saturated downloads", async (t) => {
  const blob = blobFixture();
  const f = await tab(t, blob);
  f.plugin.config.saveImages = true;
  const releases = new Map();
  let active = 0;
  let peak = 0;
  f.plugin.images.download = (url) => {
    active++;
    peak = Math.max(peak, active);
    return new Promise((resolve) =>
      releases.set(url, (data) => {
        active--;
        resolve(data);
      }),
    );
  };
  const file = (id) => ({
    id,
    mimetype: "image/png",
    thumb_480: "https://files.slack.com/" + id,
  });
  const send = (ts, id) =>
    f.events.get("*")({
      type: "message",
      channel: "C",
      ts,
      files: [file(id)],
    });
  send("1", "A");
  releases.get("https://files.slack.com/A")("data:image/png;base64,QQ==");
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 8; i++) send("busy" + i, "busy" + i);
  assert.equal(active, 8);
  f.events.get("*")({
    ...deletion,
    previous_message: { ...deletion.previous_message, files: [file("B")] },
  });
  assert.equal(f.plugin.images.get("C:1").length, 0);
  assert.equal(releases.has("https://files.slack.com/B"), false);
  await f.plugin.flush();
  await f.plugin.flushImages();
  const before = await tab(t, blob);
  assert.equal(before.plugin.images.get("C:1").length, 0);
  releases.get("https://files.slack.com/busy0")(null);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(releases.has("https://files.slack.com/B"), true);
  assert.equal(active, 8);
  releases.get("https://files.slack.com/B")("data:image/png;base64,Qg==");
  for (let i = 1; i < 8; i++)
    releases.get("https://files.slack.com/busy" + i)(null);
  await new Promise((r) => setTimeout(r, 0));
  await f.plugin.images.settled();
  await f.plugin.flushImages();
  assert.equal(peak, 8);
  assert.equal(f.plugin.images.pending.size, 0);
  const restart = await tab(t, blob);
  assert.equal(restart.plugin.images.get("C:1")[0]?.fileId, "B");
  assert.equal(
    restart.plugin.images.get("C:1")[0]?.data,
    "data:image/png;base64,Qg==",
  );
});

for (const metadata of ["replacement", "omitted", "unresolved", "removed"]) {
  test(`full image queue still reconciles cached source (${metadata})`, async (t) => {
    const blob = blobFixture();
    const f = await tab(t, blob);
    f.plugin.config.saveImages = true;
    const releases = new Map();
    f.plugin.images.download = (url) =>
      new Promise((r) => releases.set(url, r));
    const file = (id) => ({
      id,
      mimetype: "image/png",
      thumb_480: "https://files.slack.com/" + id,
    });
    const send = (ts, id) =>
      f.events.get("*")({
        type: "message",
        channel: "C",
        ts,
        files: [file(id)],
      });
    send("1", "A");
    releases.get("https://files.slack.com/A")("data:image/png;base64,QQ==");
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 16; i++) send("busy" + i, "busy" + i);
    assert.equal(f.plugin.images.running, 8);
    assert.equal(f.plugin.images.queued.size, 8);
    if (metadata === "removed")
      f.events.get("*")({
        ...edit(),
        message: { ts: "1", text: "new", files: [] },
      });
    const event = {
      ...deletion,
      previous_message: {
        ...deletion.previous_message,
        ...(metadata === "replacement"
          ? { files: [file("B")] }
          : metadata === "unresolved"
            ? { files: ["MISSING"] }
            : {}),
      },
    };
    f.events.get("*")(event);
    const expected =
      metadata === "omitted" || metadata === "unresolved" ? ["A"] : [];
    assert.deepEqual(
      Array.from(f.plugin.images.get("C:1"), (i) => i.fileId),
      expected,
    );
    assert.equal(f.plugin.images.queued.size, 8);
    await f.plugin.flush();
    await f.plugin.images.settled();
    await f.plugin.flushImages();
    const restart = await tab(t, blob);
    assert.deepEqual(
      Array.from(restart.plugin.images.get("C:1"), (i) => i.fileId),
      expected,
    );
    // Saturated admission must not mark B as attempted: a later event can retry it.
    releases.get("https://files.slack.com/busy0")(null);
    await new Promise((r) => setTimeout(r, 0));
    if (metadata === "replacement") {
      send("1", "B");
      assert.equal(f.plugin.images.queued.has("C:1"), true);
    }
    for (let i = 1; i < 16; i++) {
      releases.get("https://files.slack.com/busy" + i)(null);
      await new Promise((r) => setTimeout(r, 0));
    }
    if (metadata === "replacement") {
      releases.get("https://files.slack.com/B")("data:image/png;base64,Qg==");
      await new Promise((r) => setTimeout(r, 0));
    }
    await f.plugin.images.settled();
    await f.plugin.flushImages();
    const final = await tab(t, blob);
    assert.deepEqual(
      Array.from(final.plugin.images.get("C:1"), (i) => i.fileId),
      metadata === "replacement" ? ["B"] : expected,
    );
    assert.equal(f.plugin.images.pending.size, 0);
  });
}

test("saturated queue keeps only latest sources and cancels removal", async (t) => {
  const f = await tab(t, blobFixture());
  f.plugin.config.saveImages = true;
  const releases = new Map();
  f.plugin.images.download = (url) => new Promise((r) => releases.set(url, r));
  const send = (ts, id) =>
    f.events.get("*")({
      type: "message",
      channel: "C",
      ts,
      files: id
        ? [
            {
              id,
              mimetype: "image/png",
              thumb_480: "https://files.slack.com/" + id,
            },
          ]
        : [],
    });
  for (let i = 0; i < 16; i++) send(String(i), "A" + i);
  for (let i = 0; i < 20; i++) send("8", "B" + i);
  send("9", null);
  assert.equal(f.plugin.images.running, 8);
  assert.equal(f.plugin.images.queued.size, 7);
  for (let i = 0; i < 8; i++)
    releases.get("https://files.slack.com/A" + i)(null);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(f.plugin.images.running, 7);
  assert.equal(releases.has("https://files.slack.com/B19"), true);
  assert.equal(releases.has("https://files.slack.com/A8"), false);
  assert.equal(releases.has("https://files.slack.com/A9"), false);
  for (let i = 0; i < 19; i++)
    assert.equal(releases.has("https://files.slack.com/B" + i), false);
  releases.get("https://files.slack.com/B19")(null);
  for (let i = 10; i < 16; i++)
    releases.get("https://files.slack.com/A" + i)(null);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(f.plugin.images.pending.size, 0);
  assert.equal(f.plugin.images.queued.size, 0);
  assert.equal(f.plugin.images.running, 0);
});

test("source replacements keep actual download concurrency bounded", async (t) => {
  const f = await tab(t, blobFixture());
  f.plugin.config.saveImages = true;
  const releases = [];
  f.plugin.images.download = () => new Promise((r) => releases.push(r));
  for (let i = 0; i < 20; i++)
    f.events.get("*")({
      type: "message",
      channel: "C",
      ts: "1",
      files: [
        { mimetype: "image/png", thumb_480: "https://files.slack.com/" + i },
      ],
    });
  assert.equal(releases.length, 8);
  for (const release of releases) release(null);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(releases.length, 9);
  releases[8]("data:image/png;base64,aGVsbG8=");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(f.plugin.images.pending.size, 0);
});

for (const action of ["accept", "hide"]) {
  test(`cross-tab pending deletion cannot undo ${action}`, async (t) => {
    const blob = blobFixture();
    const a = await tab(t, blob),
      b = await tab(t, blob);
    a.plugin.config.saveImages = true;
    let release;
    a.plugin.images.download = () =>
      new Promise((r) => {
        release = r;
      });
    a.events.get("*")({
      type: "message",
      channel: "C",
      ts: "1",
      text: "old",
      files: [
        {
          id: "FA",
          mimetype: "image/png",
          thumb_480: "https://files.slack.com/a",
        },
      ],
    });
    for (const f of [a, b]) {
      f.events.get("*")({
        ...edit(),
        message: {
          ...edit().message,
          files: [
            {
              id: "FA",
              mimetype: "image/png",
              thumb_480: "https://files.slack.com/a",
            },
          ],
        },
      });
      f.events.get("*")(deletion);
    }
    assert.equal(a.plugin.images.pending.size, 1);
    await b.plugin.flush();
    if (action === "accept") b.plugin.acceptDelete(b.plugin.entries.get("C:1"));
    else b.plugin.hideEdits(b.plugin.entries.get("C:1"));
    await b.plugin.flush();
    await a.plugin.saved.refresh();
    assert.equal(a.api.inject().length, action === "accept" ? 0 : 1);
    assert.equal(a.plugin.entries.get("C:1")?.edits, undefined);
    await a.plugin.flush();
    release("data:image/png;base64,aGVsbG8=");
    await new Promise((r) => setTimeout(r, 0));
    await a.plugin.flushImages();
    await b.plugin.saved.refresh();
    const disk = await readEntries(blob);
    assert.equal(disk["C:1"]?.deleted, action === "accept" ? undefined : true);
    assert.equal(disk["C:1"]?.edits, undefined);
    if (action === "accept") {
      assert.equal(a.plugin.images.get("C:1").length, 0);
      assert.equal(
        JSON.parse((await blob.read("workspace:TTEST:images")) ?? "{}")["C:1"],
        undefined,
      );
    } else {
      assert.equal(a.plugin.images.get("C:1")[0]?.fileId, "FA");
    }
    const restart = await tab(t, blob);
    assert.equal(restart.api.inject().length, action === "accept" ? 0 : 1);
    assert.equal(
      restart.plugin.images.get("C:1").length,
      action === "accept" ? 0 : 1,
    );
    restart.events.get("*")(edit("1", "C", "new", "legitimate"));
    await restart.plugin.flush();
    assert.equal(restart.plugin.entries.get("C:1").edits.length, 1);
    assert.equal(
      restart.plugin.entries.get("C:1").edits[0].newText,
      "legitimate",
    );
  });
}

for (const action of ["accept", "hide"]) {
  test(`locked reducer rejects stale capture without subscription sync (${action})`, async (t) => {
    const blob = blobFixture();
    const a = await tab(t, blob),
      b = await tab(t, blob);
    a.plugin.unsubscribe();
    for (const f of [a, b]) {
      f.events.get("*")(edit());
      f.events.get("*")(deletion);
    }
    await b.plugin.flush();
    if (action === "accept") b.plugin.acceptDelete(b.plugin.entries.get("C:1"));
    else b.plugin.hideEdits(b.plugin.entries.get("C:1"));
    await b.plugin.flush();
    assert.equal(a.plugin.entries.get("C:1").edits.length, 1);
    a.events.get("*")(edit("unrelated"));
    await a.plugin.flush();
    const disk = await readEntries(blob);
    assert.equal(disk["C:1"]?.deleted, action === "accept" ? undefined : true);
    assert.equal(disk["C:1"]?.edits, undefined);
    assert.equal(disk["C:unrelated"].edits.length, 1);
  });
}

for (const action of ["hide", "accept"]) {
  test(`fresh edit does not restamp dismissed inherited history (${action})`, async (t) => {
    const blob = blobFixture();
    const a = await tab(t, blob),
      b = await tab(t, blob);
    a.plugin.unsubscribe();
    for (const f of [a, b]) {
      f.events.get("*")(edit());
      f.events.get("*")(deletion);
    }
    await b.plugin.flush();
    if (action === "hide") b.plugin.hideEdits(b.plugin.entries.get("C:1"));
    else b.plugin.acceptDelete(b.plugin.entries.get("C:1"));
    await b.plugin.flush();
    await a.plugin.saved.refresh();
    assert.equal(a.plugin.entries.get("C:1").edits.length, 1);
    a.events.get("*")(edit("1", "C", "new", "fresh"));
    await a.plugin.flush();
    const disk = await readEntries(blob);
    assert.deepEqual(disk["C:1"].edits, [{ oldText: "new", newText: "fresh" }]);
    assert.equal(disk["C:1"].deleted, action === "hide" ? true : undefined);
    const restart = await tab(t, blob);
    assert.equal(restart.plugin.entries.get("C:1").edits.length, 1);
    assert.equal(restart.api.inject().length, action === "hide" ? 1 : 0);
  });
}

test("subscribed stale hide cannot undo another tab's accept", async (t) => {
  const blob = blobFixture();
  const a = await tab(t, blob),
    b = await tab(t, blob);
  for (const f of [a, b]) {
    f.events.get("*")(edit());
    f.events.get("*")(deletion);
  }
  await b.plugin.flush();
  b.plugin.acceptDelete(b.plugin.entries.get("C:1"));
  await b.plugin.flush();
  // Broadcast delivery has not run yet; A still exposes its unflushed deletion.
  assert.equal(a.plugin.entries.get("C:1")?.deleted, true);
  a.plugin.hideEdits(a.plugin.entries.get("C:1"));
  await a.plugin.flush();
  const disk = await readEntries(blob);
  assert.equal(disk["C:1"], undefined);
  assert.equal(disk.__dismissals.keys["C:1"].accept, 1);
  assert.equal(disk.__dismissals.keys["C:1"].hide, 2);
  const restart = await tab(t, blob);
  assert.equal(restart.api.inject().length, 0);
});

test("dismissal compaction bounds metadata and fences retired captures", async (t) => {
  const blob = blobFixture();
  const a = await tab(t, blob),
    b = await tab(t, blob);
  a.plugin.unsubscribe();
  a.events.get("*")(edit("0"));
  for (let i = 0; i < 1001; i++) {
    b.events.get("*")(edit(String(i)));
    b.plugin.hideEdits(b.plugin.entries.get("C:" + i));
  }
  await b.plugin.flush();
  const state = (await readEntries(blob)).__dismissals;
  assert.equal(Object.keys(state.keys).length, 1000);
  assert.equal(state.floor, -1);
  assert.equal(state.hideFloor, 1);
  await a.plugin.flush();
  assert.equal((await readEntries(blob))["C:0"], undefined);
  const restart = await tab(t, blob);
  restart.events.get("*")(edit("0", "C", "new", "fresh"));
  await restart.plugin.flush();
  assert.equal(restart.plugin.entries.get("C:0").edits.length, 1);
});

test("hide barrier compaction preserves a delayed deletion", async (t) => {
  const blob = blobFixture();
  const a = await tab(t, blob),
    b = await tab(t, blob);
  a.plugin.unsubscribe();
  a.events.get("*")(edit("0"));
  a.events.get("*")({
    ...deletion,
    deleted_ts: "0",
    previous_message: { ts: "0", text: "keep" },
  });
  for (let i = 0; i < 1001; i++) {
    b.events.get("*")(edit(String(i)));
    b.plugin.hideEdits(b.plugin.entries.get("C:" + i));
  }
  await b.plugin.flush();
  await a.plugin.flush();
  const disk = await readEntries(blob);
  assert.equal(disk["C:0"]?.deleted, true);
  assert.equal(disk["C:0"].edits, undefined);
});

for (const persistedEdit of [false, true]) {
  test(`hide preserves unflushed deletion (${persistedEdit ? "edit-only" : "empty"} disk)`, async (t) => {
    const blob = blobFixture();
    const a = await tab(t, blob);
    a.events.get("*")(edit());
    if (persistedEdit) await a.plugin.flush();
    a.events.get("*")(deletion);
    a.plugin.hideEdits(a.plugin.entries.get("C:1"));
    await a.plugin.flush();
    const disk = await readEntries(blob);
    assert.equal(disk["C:1"]?.deleted, true);
    assert.equal(disk["C:1"].edits, undefined);
    assert.equal(a.api.inject()[0]?.text, "new");
    const restart = await tab(t, blob);
    assert.equal(restart.api.inject()[0]?.text, "new");
    assert.equal(restart.plugin.entries.get("C:1").edits, undefined);
  });
}
