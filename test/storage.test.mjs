import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, start, edit } from "./fixture.mjs";
import { ScopedStorage, blobFixture, readEntries } from "./taut-storage.mjs";
test("actual Taut locked stores preserve concurrent plugin updates and broadcast dismissal", async (t) => {
  const blob = blobFixture();
  const a = fixture(),
    b = fixture();
  a.api.storage = new ScopedStorage(
    blob,
    "offline-integration",
    a.controller.signal,
  );
  b.api.storage = new ScopedStorage(
    blob,
    "offline-integration",
    b.controller.signal,
  );
  await start(a);
  await start(b);
  await a.plugin.saved.ready;
  await b.plugin.saved.ready;
  t.after(async () => {
    a.controller.abort();
    b.controller.abort();
    await a.plugin.stop();
    await b.plugin.stop();
  });
  a.events.get("*")(edit("1"));
  b.events.get("*")(edit("2"));
  await Promise.all([a.plugin.flush(), b.plugin.flush()]);
  await a.plugin.saved.refresh();
  await b.plugin.saved.refresh();
  assert.equal(a.plugin.entries.size, 2);
  assert.equal(b.plugin.entries.size, 2);
  b.plugin.hideEdits(b.plugin.entries.get("C:1"));
  await b.plugin.flush();
  await a.plugin.saved.refresh();
  assert.equal(a.plugin.entries.has("C:1"), false);
  const disk = await readEntries(blob);
  assert.equal(
    Object.keys(disk).filter((key) => key !== "__dismissals").length,
    1,
  );
  assert.equal(disk.__dismissals.clock, 1);
  assert.equal(disk["C:2"].edits[0].oldText, "old");
});
