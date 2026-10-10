// Explicit offline benchmark: actual Taut store locking/JSON, no network, no Slack credentials.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { fixture, start, edit } from "./fixture.mjs";
import { ScopedStorage, blobFixture } from "./taut-storage.mjs";
const results = [];
for (const mode of [process.env.BENCH_MODE ?? "representative"])
  for (let run = 1; run <= Number(process.env.BENCH_RUNS ?? 3); run++) {
    const chars = mode === "max-text" ? 3990 : 120;
    const entries = {},
      images = {};
    const now = Date.now();
    for (let i = 0; i < 1000; i++)
      entries["C:" + i] = {
        channel: "C",
        ts: String(i),
        at: now,
        deleted: true,
        message: {
          channel: "C",
          ts: String(i),
          text: "x".repeat(mode === "max-text" ? 32000 : 500),
        },
        edits: Array.from({ length: 20 }, (_, j) => ({
          oldText: String(j) + "a".repeat(chars),
          newText: String(j + 1) + "a".repeat(chars),
        })),
      };
    // Exactly 128 archived messages, each with 3 max-size encoded fixture previews; these are test bytes, not claimed live images.
    const data = "data:image/png;base64," + "A".repeat(65536);
    for (let i = 0; i < 128; i++)
      images["C:" + i] = Array.from({ length: 3 }, (_, j) => ({
        name: "offline " + j,
        data,
        fileId: "F" + j,
      }));
    const blob = blobFixture(
      new Map([
        ["workspace:TTEST:entries", entries],
        ["workspace:TTEST:images", images],
      ]),
    );
    const f = fixture();
    f.api.storage = new ScopedStorage(
      blob,
      "offline-bench-" + mode + "-" + run,
      f.controller.signal,
    );
    const beforeHeap = process.memoryUsage().heapUsed;
    const restoreStart = performance.now();
    await start(f);
    await f.plugin.saved.ready;
    await new Promise((r) => setTimeout(r, 0));
    const restoreMs = performance.now() - restoreStart;
    const before = blob.stats();
    const samples = [];
    const startBurst = performance.now();
    for (let i = 0; i < 2000; i++) {
      const ts = String(i % 1000),
        s = performance.now();
      f.events.get("*")(edit(ts, "C", "burst " + i, "next " + i));
      samples.push(performance.now() - s);
    }
    const captureMs = performance.now() - startBurst;
    const flushStart = performance.now();
    await f.plugin.flush();
    const flushMs = performance.now() - flushStart;
    await new Promise((r) => setTimeout(r, 60));
    samples.sort((a, b) => a - b);
    const after = blob.stats();
    assert.equal(f.plugin.entries.size, 1000);
    assert.equal(f.plugin.images.archived.size, 128);
    assert.ok(f.plugin.recent.size <= 400);
    assert.equal(after.writes - before.writes, 1);
    results.push({
      mode,
      run,
      events: 2000,
      entries: 1000,
      images: 384,
      storedBytes: after.bytes,
      restoreMs: +restoreMs.toFixed(2),
      captureMs: +captureMs.toFixed(2),
      eventP95Ms: +samples[Math.floor(samples.length * 0.95)].toFixed(3),
      flushMs: +flushMs.toFixed(2),
      writes: after.writes - before.writes,
      repaints: f.stats().paints,
      heapDeltaMiB: +(
        (process.memoryUsage().heapUsed - beforeHeap) /
        1048576
      ).toFixed(2),
    });
    f.controller.abort();
    await f.plugin.stop();
  }
console.log(
  JSON.stringify(
    {
      node: process.version,
      fixture:
        "explicit offline, actual Taut ScopedStorage + in-memory BlobStore/Web Locks fixture; no browser/IPC/disk/network",
      results,
    },
    null,
    2,
  ),
);
