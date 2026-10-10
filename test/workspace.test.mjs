import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, start, edit } from "./fixture.mjs";

// Offline lifecycle regressions load the built plugin, with no Slack/network calls.
for (const id of ["T0AT86SDAM8", "E09V59WQY1E"]) {
  for (const source of ["redux", "url"]) {
    test(`workspace startup captures self edits/deletes for ${id} from ${source}`, async (t) => {
      const f = fixture(new Map(), id);
      if (source === "url") f.api.redux.getRawState = () => ({});
      else f.context.location.pathname = "/client/TOTHER/channel";
      await start(f);
      t.after(async () => {
        f.controller.abort();
        await f.plugin.stop();
      });
      assert.equal(
        typeof f.events.get("*"),
        "function",
        "startup registers capture",
      );
      f.events.get("*")(edit());
      assert.equal(f.plugin.entries.get("C:1").edits[0].oldText, "old");
      f.events.get("*")({
        type: "message",
        subtype: "message_deleted",
        channel: "C",
        deleted_ts: "1",
        previous_message: { ts: "1", user: "ME", text: "new" },
      });
      await f.plugin.flush();
      assert.equal(
        f.shared.get(`workspace:${id}:entries`)["C:1"].deleted,
        true,
      );
      assert.equal(f.shared.has("workspace:TOTHER:entries"), false);
      assert.equal(f.api.inject()[0].text, "new");
    });
  }
}

for (const id of ["", "E", "T", "U09V59WQY1E", "e09V59WQY1E", "E09V59WQY1E!"]) {
  test(`invalid Redux workspace ${JSON.stringify(id)} fails closed`, async () => {
    const f = fixture(new Map(), id);
    // A malformed present Redux ID must not be repaired via a valid URL.
    f.context.location.pathname = "/client/TVALID/channel";
    await start(f);
    assert.equal(f.events.size, 0);
    assert.equal(f.shared.size, 0);
    assert.equal(f.api.inject, undefined);
    f.controller.abort();
    await f.plugin.stop();
  });
}

test("missing Redux workspace and unrecognized URL fail closed", async () => {
  const f = fixture();
  f.api.redux.getRawState = () => ({});
  f.context.location.pathname = "/client/UINVALID/channel";
  await start(f);
  assert.equal(f.events.size, 0);
  assert.equal(f.shared.size, 0);
  f.controller.abort();
  await f.plugin.stop();
});

test("Enterprise and team archives remain isolated and switching disables old capture/injection", async (t) => {
  const shared = new Map();
  const a = await start(fixture(shared, "E09V59WQY1E"));
  const b = await start(fixture(shared, "T0AT86SDAM8"));
  t.after(async () => {
    for (const f of [a, b]) {
      f.controller.abort();
      await f.plugin.stop();
    }
  });
  assert.equal(typeof a.events.get("*"), "function");
  a.events.get("*")(edit("1", "C", "enterprise old", "enterprise new"));
  b.events.get("*")(edit("1", "C", "team old", "team new"));
  await Promise.all([a.plugin.flush(), b.plugin.flush()]);
  assert.equal(a.plugin.entries.get("C:1").edits[0].oldText, "enterprise old");
  assert.equal(b.plugin.entries.get("C:1").edits[0].oldText, "team old");
  assert.equal(
    shared.get("workspace:E09V59WQY1E:entries")["C:1"].edits[0].oldText,
    "enterprise old",
  );
  assert.equal(
    shared.get("workspace:T0AT86SDAM8:entries")["C:1"].edits[0].oldText,
    "team old",
  );
  a.api.redux.getRawState = () => ({ selfTeamIds: { teamId: "T0AT86SDAM8" } });
  a.events.get("*")(edit("2"));
  assert.equal(a.plugin.entries.size, 1);
  assert.equal(a.api.inject().length, 0);
});
