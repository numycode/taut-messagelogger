import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, start, edit } from "./fixture.mjs";

test("hide edits from U08FP1HKKFZ defaults off", async (t) => {
  const f = await start();
  t.after(async () => {
    f.controller.abort();
    await f.plugin.stop();
  });
  assert.equal(f.plugin.config.hideEditsFromU08FP1HKKFZ, false);
});

test("target edit display is reversible without changing capture, storage or deletion", async (t) => {
  const f = await start();
  const instances = [f];
  t.after(async () => {
    for (const instance of instances) {
      instance.controller.abort();
      await instance.plugin.stop();
    }
  });
  const target = "U08FP1HKKFZ";
  for (const [ts, user] of [
    ["target", target],
    ["other", "ME"],
  ]) {
    const event = edit(ts);
    event.previous_message.user = event.message.user = user;
    f.events.get("*")(event);
  }
  await f.plugin.flush();

  const nodes = (tree) =>
    !tree || typeof tree !== "object"
      ? []
      : [tree, ...(tree.children ?? []).flat(Infinity).flatMap(nodes)];
  const render = (
    instance,
    ts,
    user,
    name = "MessageWrapper",
    blocks = false,
  ) => {
    const msg = {
      channel: "C",
      ts,
      user,
      text: "new",
      ...(blocks ? { blocks: [{}] } : {}),
    };
    const Original = () => null;
    const row = instance.patches.get(name)(Original)({ msg });
    const context = nodes(row).find((node) => node.props?.value?.edits)?.props
      .value;
    instance.api.react.useContext = (value) =>
      value === instance.plugin.EditContext ? context : [];
    const body = instance.patches.get(blocks ? "Blocks" : "MessageText")(
      Original,
    )({ msg });
    return {
      history: nodes(body).some(
        (node) =>
          node.props?.className === "taut-message-logger-edited-original",
      ),
      edited: nodes(row).some((node) =>
        node.props?.className?.includes("taut-message-logger-edited"),
      ),
      deleted: nodes(row).some((node) =>
        node.props?.className?.includes("taut-message-logger-deleted"),
      ),
    };
  };
  assert.equal(render(f, "target", target).history, true);
  f.plugin.config.hideEditsFromU08FP1HKKFZ = true;
  for (const name of [
    "MessageWrapper",
    "ThreadRootGeneric",
    "ThreadReplyGeneric",
  ])
    for (const blocks of [false, true]) {
      assert.equal(render(f, "target", target, name, blocks).history, false);
      assert.equal(render(f, "target", target, name, blocks).edited, false);
      assert.equal(render(f, "other", "ME", name, blocks).history, true);
    }
  assert.equal(render(f, "target", undefined).history, false); // Archived entry.user.
  const event = edit("target", "C", "new", "newer");
  event.previous_message.user = event.message.user = target;
  f.events.get("*")(event);
  f.events.get("*")({
    type: "message_deleted",
    channel: "C",
    deleted_ts: "target",
    previous_message: {
      channel: "C",
      ts: "target",
      user: target,
      text: "newer",
    },
  });
  await f.plugin.flush();
  const before = JSON.stringify([...f.shared]);
  assert.equal(f.api.inject()[0].text, "newer");
  assert.equal(render(f, "target", target).deleted, true);
  assert.equal(render(f, "target", target).history, false);
  const entry = f.plugin.entries.get("C:target");
  assert.equal(entry.edits.length, 2);
  f.plugin.entries.set("C:target", { ...entry, user: undefined });
  assert.equal(render(f, "target", undefined).history, false); // Archived message.user.
  f.plugin.entries.set("C:target", entry);
  f.plugin.config.hideEditsFromU08FP1HKKFZ = false;
  assert.equal(render(f, "target", target).history, true);
  assert.equal(render(f, "target", target).edited, true);
  assert.equal(render(f, "target", target).deleted, true);
  assert.equal(JSON.stringify([...f.shared]), before);
  const restored = await start(fixture(f.shared));
  instances.push(restored);
  assert.equal(restored.plugin.entries.get("C:target").edits.length, 2);
  assert.equal(render(restored, "target", undefined).history, true);
  restored.plugin.config.hideEditsFromU08FP1HKKFZ = true;
  assert.equal(render(restored, "target", undefined).history, false);
  assert.equal(restored.api.inject()[0].text, "newer");
});
