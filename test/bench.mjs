// Explicit offline benchmark: actual Taut store locking/JSON, no network, no Slack credentials.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { fixture, start, edit } from "./fixture.mjs";
import { ScopedStorage, blobFixture } from "./taut-storage.mjs";
const results = [];
const eventCount = Number(process.env.BENCH_EVENTS ?? 2000);
assert.ok(Number.isSafeInteger(eventCount) && eventCount > 0);
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
    await f.plugin.flush();
    await f.plugin.images.settled();
    await f.plugin.flushImages();
    const restoreMs = performance.now() - restoreStart;
    global.gc?.();
    const sparseBefore = blob.stats();
    const sparseHeap = process.memoryUsage().heapUsed;
    let sparsePeakHeap = sparseHeap;
    const write = blob.write;
    blob.write = async (key, raw) => {
      sparsePeakHeap = Math.max(sparsePeakHeap, process.memoryUsage().heapUsed);
      return write(key, raw);
    };
    const sparseDelayStart = performance.now();
    const sparseDelayed = new Promise((r) =>
      setTimeout(() => r(performance.now() - sparseDelayStart), 0),
    );
    const sparseStart = performance.now();
    f.events.get("*")(edit("1", "C", "sparse old", "sparse new"));
    const sparseCaptureMs = performance.now() - sparseStart;
    const sparseFlushStart = performance.now();
    await f.plugin.flush();
    const sparseFlushMs = performance.now() - sparseFlushStart;
    sparsePeakHeap = Math.max(sparsePeakHeap, process.memoryUsage().heapUsed);
    const sparseEventLoopDelayMs = await sparseDelayed;
    blob.write = write;
    const sparseBytesWritten =
      blob.stats().writtenBytes - sparseBefore.writtenBytes;
    const sparseWrites = blob.stats().writes - sparseBefore.writes;
    const sparseExtraHeapMiB = (sparsePeakHeap - sparseHeap) / 1048576;
    assert.equal(sparseWrites, 3);
    assert.ok(sparseBytesWritten < 8 * 1024 * 1024);
    global.gc?.();
    const flushHeap = process.memoryUsage().heapUsed;
    const before = blob.stats();
    const delayStart = performance.now();
    const delayed = new Promise((r) =>
      setTimeout(() => r(performance.now() - delayStart), 0),
    );
    const samples = [];
    const startBurst = performance.now();
    for (let i = 0; i < eventCount; i++) {
      const ts = String(i % 1000),
        s = performance.now();
      f.events.get("*")(edit(ts, "C", "burst " + i, "next " + i));
      samples.push(performance.now() - s);
    }
    const captureMs = performance.now() - startBurst;
    const flushStart = performance.now();
    await f.plugin.flush();
    const flushMs = performance.now() - flushStart;
    const heapAfterFlush = process.memoryUsage().heapUsed;
    const eventLoopDelayMs = await delayed;
    await new Promise((r) => setTimeout(r, 60));
    samples.sort((a, b) => a - b);
    const after = blob.stats();
    assert.equal(f.plugin.entries.size, 1000);
    assert.equal(f.plugin.images.archived.size, 128);
    assert.ok(f.plugin.recent.size <= 400);
    assert.ok(after.writes - before.writes <= 66);
    const imageBefore = blob.stats();
    const imageHeap = process.memoryUsage().heapUsed;
    f.plugin.stageImages("C:0", [
      { name: "updated offline", data, fileId: "F0" },
    ]);
    const imageDelayStart = performance.now();
    const imageDelayed = new Promise((r) =>
      setTimeout(() => r(performance.now() - imageDelayStart), 0),
    );
    const imageStart = performance.now();
    await f.plugin.flushImages();
    const imageFlushMs = performance.now() - imageStart;
    const imageExtraHeapMiB =
      (process.memoryUsage().heapUsed - imageHeap) / 1048576;
    const imageEventLoopDelayMs = await imageDelayed;
    const imageBytesWritten =
      blob.stats().writtenBytes - imageBefore.writtenBytes;
    f.controller.abort();
    await f.plugin.stop();
    global.gc?.();
    const restartHeap = process.memoryUsage().heapUsed;
    const restarted = fixture();
    restarted.api.storage = new ScopedStorage(
      blob,
      "offline-bench-" + mode + "-" + run,
      restarted.controller.signal,
    );
    const restartStart = performance.now();
    await start(restarted);
    await restarted.plugin.saved.ready;
    await new Promise((r) => setTimeout(r, 0));
    await restarted.plugin.images.settled();
    await restarted.plugin.flushImages();
    const partitionRestoreMs = performance.now() - restartStart;
    const partitionRestoreExtraHeapMiB =
      (process.memoryUsage().heapUsed - restartHeap) / 1048576;
    assert.equal(restarted.plugin.entries.size, 1000);
    assert.equal(restarted.plugin.images.archived.size, 128);
    restarted.controller.abort();
    await restarted.plugin.stop();
    results.push({
      sparseCaptureMs: +sparseCaptureMs.toFixed(2),
      sparseFlushMs: +sparseFlushMs.toFixed(2),
      sparseBytesWritten,
      sparseWrites,
      sparseExtraHeapMiB: +sparseExtraHeapMiB.toFixed(2),
      sparseEventLoopDelayMs: +sparseEventLoopDelayMs.toFixed(2),
      partitionRestoreMs: +partitionRestoreMs.toFixed(2),
      partitionRestoreExtraHeapMiB: +partitionRestoreExtraHeapMiB.toFixed(2),
      imageFlushMs: +imageFlushMs.toFixed(2),
      imageBytesWritten,
      imageExtraHeapMiB: +imageExtraHeapMiB.toFixed(2),
      imageEventLoopDelayMs: +imageEventLoopDelayMs.toFixed(2),
      mode,
      run,
      events: eventCount,
      beforeStoredBytes: before.bytes,
      entries: 1000,
      images: 384,
      storedBytes: after.bytes,
      restoreMs: +restoreMs.toFixed(2),
      captureMs: +captureMs.toFixed(2),
      eventP95Ms: +samples[Math.floor(samples.length * 0.95)].toFixed(3),
      flushMs: +flushMs.toFixed(2),
      writes: after.writes - before.writes,
      bytesWritten: after.writtenBytes - before.writtenBytes,
      eventLoopDelayMs: +eventLoopDelayMs.toFixed(2),
      burstExtraHeapMiB: +((heapAfterFlush - flushHeap) / 1048576).toFixed(2),
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
