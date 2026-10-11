const backendListeners = new WeakMap();
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import "./taut-storage.mjs";
export function fixture(shared = new Map(), team = "TTEST") {
  const React = {
    createContext: () => ({ Provider: "provider" }),
    createElement: (type, props, ...children) => ({ type, props, children }),
    useMemo: (f) => f(),
    useEffect: (f) => f(),
    useContext: () => [],
  };
  const Base = class {
    constructor(api, config) {
      this.api = api;
      this.config = config;
    }
    log() {}
  };
  const events = new Map(),
    patches = new Map(),
    controller = new AbortController();
  let paints = 0,
    writes = 0;
  let subscribers = backendListeners.get(shared);
  if (!subscribers) {
    subscribers = new Map();
    backendListeners.set(shared, subscribers);
  }
  const storage = {
    async delete(key) {
      shared.delete(key);
      for (const cb of subscribers.get(key) ?? []) cb();
      return true;
    },
    store(key, fallback) {
      if (!shared.has(key)) shared.set(key, fallback);
      const listeners = subscribers.get(key) ?? new Set();
      subscribers.set(key, listeners);
      return {
        get: () => shared.get(key),
        ready: Promise.resolve(),
        async refresh() {
          for (const cb of listeners) cb();
          return shared.get(key) ?? fallback;
        },
        subscribe: (f) => (listeners.add(f), () => listeners.delete(f)),
        async update(f) {
          shared.set(key, f(shared.get(key)));
          writes++;
          for (const cb of listeners) cb();
          return shared.get(key);
        },
      };
    },
  };
  const api = {
    storage,
    react: React,
    signal: controller.signal,
    rtm: { on: (k, f) => events.set(k, f) },
    setStyle() {},
    patchComponent: (k, f) => patches.set(k, f),
    messages: { getRawMessage() {}, injectMessages: (f) => (api.inject = f) },
    redux: {
      getRawState: () => ({
        selfTeamIds: { teamId: team },
        bootData: { user_id: "ME" },
      }),
      refresh: () => paints++,
      usePatchVersion: () => 0,
      patchThunk() {},
      subscribe: () => () => {},
    },
  };
  return {
    api,
    events,
    patches,
    controller,
    shared,
    stats: () => ({ paints, writes }),
    context: {
      globalThis: {
        React,
        TautPlugin: Base,
        TautOpt: Object.assign((v) => v, {
          select: (_, v) => v,
          number: (v) => v,
        }),
      },
      React,
      console,
      Map,
      Set,
      Date,
      performance,
      setTimeout,
      clearTimeout,
      AbortController,
      AbortSignal,
      URL,
      TextEncoder,
      navigator,
      location: { pathname: "/client/" + team + "/channel" },
    },
  };
}
export async function start(f = fixture()) {
  const code = await readFile(
    new URL("../dist/MessageLogger.js", import.meta.url),
    "utf8",
  );
  const Plugin = vm.runInNewContext(code, f.context);
  f.plugin = new Plugin(f.api, {
    ...Plugin.defaultConfig,
    enabled: true,
    saveImages: false,
  });
  f.plugin.start();
  await f.plugin.saved?.ready;
  await Promise.resolve();
  await Promise.resolve();
  return f;
}
export const edit = (
  ts = "1",
  channel = "C",
  oldText = "old",
  newText = "new",
) => ({
  type: "message",
  subtype: "message_changed",
  channel,
  previous_message: { ts, user: "ME", text: oldText },
  message: { ts, user: "ME", text: newText },
});
