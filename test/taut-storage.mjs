// Offline integration against the actual Taut ScopedStorage, with an in-memory BlobStore and Web Locks fixture.
import { build } from "esbuild";
const compiled = await build({
  entryPoints: [
    new URL("../../taut/app/api/pluginStorage.ts", import.meta.url).pathname,
  ],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
});
export const { ScopedStorage } = await import(
  "data:text/javascript;base64," +
    Buffer.from(compiled.outputFiles[0].text).toString("base64")
);
const locks = new Map();
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    locks: {
      request(name, run) {
        const before = locks.get(name) ?? Promise.resolve();
        const next = before.catch(() => {}).then(run);
        locks.set(name, next);
        next.then(
          () => {
            if (locks.get(name) === next) locks.delete(name);
          },
          () => {
            if (locks.get(name) === next) locks.delete(name);
          },
        );
        return next;
      },
    },
  },
});
export function blobFixture(initial = new Map()) {
  let writes = 0;
  const values = new Map([...initial].map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    values,
    stats: () => ({
      writes,
      bytes: [...values.values()].reduce((s, v) => s + Buffer.byteLength(v), 0),
    }),
    async read(k) {
      return values.get(k) ?? null;
    },
    async write(k, v) {
      writes++;
      values.set(k, v);
      return true;
    },
    async delete(k) {
      return values.delete(k);
    },
    async list() {
      return [...values.keys()];
    },
    async clear() {
      values.clear();
      return true;
    },
  };
}
