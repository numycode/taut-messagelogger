/*! MessageLogger — modified Slick port, 2026-10-10. GPL-3.0-only.
 * Original: Slick contributors https://github.com/3kh0/slick
 * No warranty. See LICENSE and PROVENANCE.md. */
// Listens at the RTM router, puts deleted messages back through
// injectMessages (messages + channelHistory), and styles rows via a component
// patch.

import {
  TautPlugin,
  opt,
  type ComponentType,
  type RtmEvent,
  type SlackMessage,
} from "$taut";

type StoredEdit = { oldText: string; newText: string };
function mergeEdits(stored: StoredEdit[], live: StoredEdit[]): StoredEdit[] {
  const same = (a: StoredEdit, b: StoredEdit) =>
    a.oldText === b.oldText && a.newText === b.newText;
  let prefix = 0;
  while (
    prefix < Math.min(stored.length, live.length) &&
    same(stored[prefix], live[prefix])
  )
    prefix++;
  if (prefix) return [...stored, ...live.slice(prefix)].slice(-20);
  let overlap = Math.min(stored.length, live.length);
  while (overlap && !stored.slice(-overlap).every((e, i) => same(e, live[i])))
    overlap--;
  return [...stored, ...live.slice(overlap)].slice(-20);
}

type LogEntry = {
  channel: string;
  ts: string;
  user?: string;
  deleted?: boolean;
  message?: SlackMessage;
  edits?: StoredEdit[];
  at: number;
  generation?: number;
};

// Dismissal barriers share the entry lock; compaction fences older pending captures.
const DISMISSALS = "__dismissals";
type Dismissals = {
  clock: number;
  floor: number;
  hideFloor: number;
  keys: Record<string, { accept?: number; hide?: number }>;
};
function dismissalState(values: any): Dismissals {
  const value = values?.[DISMISSALS];
  if (
    !value ||
    !Number.isSafeInteger(value.clock) ||
    !Number.isSafeInteger(value.floor) ||
    !value.keys ||
    typeof value.keys !== "object"
  )
    return { clock: 0, floor: -1, hideFloor: -1, keys: {} };
  return {
    ...value,
    hideFloor: Number.isSafeInteger(value.hideFloor) ? value.hideFloor : -1,
  };
}
function afterDismissal(
  entry: LogEntry,
  key: string,
  state: Dismissals,
): LogEntry | undefined {
  const generation = entry.generation ?? 0;
  const barrier = state.keys[key];
  if (generation <= state.floor || generation < (barrier?.accept ?? 0))
    return undefined;
  if (generation <= state.hideFloor || generation < (barrier?.hide ?? 0)) {
    if (!entry.deleted) return undefined;
    return { ...entry, edits: undefined };
  }
  return entry;
}

type RowProps = {
  msg?: SlackMessage;
  message?: SlackMessage;
  channelId?: string;
  className?: string;
};

type ActionsMenuProps = {
  channelId?: string;
  ts?: string;
  onTriggerClose?: (event?: unknown) => void;
};

type MenuProps = { children?: React.ReactNode };

type ApiRequest = { method?: string; args?: { channel?: string; ts?: string } };
type ApiThunk = (...args: unknown[]) => unknown;

const RECENT_CAP = 400;
const ROW_COMPONENTS = [
  "MessageWrapper",
  "ThreadRootGeneric",
  "ThreadReplyGeneric",
] as const;

function decode(value: string): string {
  return value
    .replace(/<([^>|]+)\|([^>]+)>/g, "$2")
    .replace(/<([^>]+)>/g, "$1")
    .replace(
      /&(amp|lt|gt);/g,
      (_, entity: string) => ({ amp: "&", lt: "<", gt: ">" })[entity]!,
    )
    .trim();
}

function messageText(msg: SlackMessage | undefined): string {
  if (!msg) return "";
  return typeof msg.text === "string" ? decode(msg.text) : "";
}

function channelOf(event: RtmEvent, msg?: SlackMessage): string {
  if (typeof msg?.channel === "string" && msg.channel) return msg.channel;
  if (typeof event.channel === "string" && event.channel) return event.channel;
  if (typeof event.channel_id === "string" && event.channel_id)
    return event.channel_id;
  return "";
}

function tsOf(event: RtmEvent, msg?: SlackMessage): string {
  if (typeof event.deleted_ts === "string" && event.deleted_ts)
    return event.deleted_ts;
  if (typeof msg?.ts === "string" && msg.ts) return msg.ts;
  if (typeof event.ts === "string" && event.ts) return event.ts;
  return "";
}

function userOf(msg?: SlackMessage, event?: RtmEvent): string {
  if (typeof msg?.user === "string" && msg.user) return msg.user;
  if (typeof event?.user === "string" && event.user) return event.user;
  return "";
}

function isDeleteEvent(event: RtmEvent): boolean {
  const message = event.message as SlackMessage | undefined;
  return (
    event.type === "message_deleted" ||
    event.subtype === "message_deleted" ||
    message?.subtype === "tombstone" ||
    message?.subtype === "thread_hidden"
  );
}

function isChangeEvent(event: RtmEvent): boolean {
  return (
    event.type === "message_changed" || event.subtype === "message_changed"
  );
}

function asInjected(
  previous: SlackMessage,
  channel: string,
  ts: string,
): SlackMessage {
  const message: SlackMessage = { ...previous, channel, ts };
  if (
    message.subtype === "tombstone" ||
    message.subtype === "message_deleted" ||
    message.subtype === "thread_hidden"
  )
    delete message.subtype;
  delete message.hidden;
  return trim(message);
}

// Fixed buckets limit cached stores without serializing the archive on every change.
// shortcut: hash collisions can concentrate payloads; revisit partitioning if measured sparse writes miss the budget.
const ENTRY_BUCKETS = 64;
function bucketOf(key: string) {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++)
    hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
  return (hash >>> 0) % ENTRY_BUCKETS;
}
class EntryStorage {
  private buckets: any[];
  private index: any;
  private listeners = new Set<(bucket?: number) => void>();
  private cleanups: (() => void)[] = [];
  private loaded = false;
  readonly ready: Promise<void>;
  constructor(
    private storage: any,
    private team: string,
    private days: () => number,
  ) {
    this.index = storage.store(`workspace:${team}:entry-index:v2`, {});
    this.buckets = Array.from({ length: ENTRY_BUCKETS }, (_, i) =>
      storage.store(`workspace:${team}:entries:v2:${i}`, {}),
    );
    this.cleanups = this.buckets.map((store, i) =>
      store.subscribe(() => {
        if (this.loaded) for (const listener of this.listeners) listener(i);
      }),
    );
    this.ready = this.lock(async () => {
      await this.prepare(true);
      this.loaded = true;
    });
  }
  private async lock<T>(run: () => Promise<T>): Promise<T> {
    return navigator.locks.request(
      `taut:MessageLogger:workspace:${this.team}:entries:v2`,
      run,
    );
  }
  subscribe = (listener: (bucket?: number) => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  close() {
    for (const cleanup of this.cleanups) cleanup();
  }
  get(bucket?: number): Record<string, any> {
    const values = Object.assign(
      {},
      ...(bucket === undefined ? this.buckets : [this.buckets[bucket]]).map(
        (s) => s.get(),
      ),
    );
    let state = dismissalState({ [DISMISSALS]: this.index.get().dismissals });
    for (const store of this.buckets) {
      const candidate = dismissalState(store.get());
      if (candidate.clock > state.clock) state = candidate;
    }
    if (state.clock) values[DISMISSALS] = state;
    return values;
  }
  async refresh() {
    await this.ready;
    await this.index.refresh();
    await Promise.all(this.buckets.map((s) => s.refresh()));
    return this.get();
  }
  async withCurrent<T>(
    keys: string[],
    run: (values: Record<string, any>) => Promise<T>,
  ) {
    await this.ready.catch(() => {});
    return this.lock(async () => {
      await this.prepare();
      await Promise.all(
        [...new Set(keys.map(bucketOf))].map((i) => this.buckets[i].refresh()),
      );
      return run(this.get());
    });
  }
  private metadata(values: Record<string, any>) {
    return Object.fromEntries(
      Object.entries(values)
        .filter(
          ([key, e]) =>
            key !== DISMISSALS &&
            e &&
            typeof e.channel === "string" &&
            typeof e.ts === "string" &&
            key === `${e.channel}:${e.ts}` &&
            Number.isFinite(e.at),
        )
        .map(([key, e]) => [key, { at: e.at }]),
    );
  }
  private async prepare(all = false) {
    const index = await this.index.refresh();
    if (all || index.schema !== 2 || index.pending)
      await Promise.all(this.buckets.map((s) => s.refresh()));
    if (index.schema !== 2) {
      const key = `workspace:${this.team}:entries`;
      const legacy = this.storage.store(key, {});
      const old = await legacy.refresh();
      // Migration is replayed only before the durable marker; old writers must be closed.
      const values = { ...old, ...this.get() };
      if (dismissalState(old).clock > dismissalState(values).clock)
        values[DISMISSALS] = old[DISMISSALS];
      for (let i = 0; i < ENTRY_BUCKETS; i++) {
        const part = Object.fromEntries(
          Object.entries(values).filter(
            ([k]) => k !== DISMISSALS && bucketOf(k) === i,
          ),
        );
        if (values[DISMISSALS]) part[DISMISSALS] = values[DISMISSALS];
        if (Object.keys(part).length) {
          await this.buckets[i].update(() => part);
          const saved = await this.buckets[i].refresh();
          if (JSON.stringify(saved) !== JSON.stringify(part))
            throw new Error("Entry migration verification failed");
        }
      }
      await this.index.update(() => ({ schema: 2, pending: true }));
      await this.recover();
    } else if (index.pending) await this.recover();
    // Retry cleanup after recovery too; a durable marker may outlive interrupted migration.
    if (all || index.schema !== 2 || index.pending)
      await this.storage.delete(`workspace:${this.team}:entries`);
  }
  private async recover() {
    const values = this.get();
    const state = dismissalState(values);
    const metadata = this.metadata(values);
    const removed = new Set(evictable(Object.entries(metadata), this.days()));
    for (const [key, entry] of Object.entries(values)) {
      if (key === DISMISSALS) continue;
      const live = metadata[key] && afterDismissal(entry, key, state);
      if (!live) removed.add(key);
      else values[key] = live;
    }
    for (let i = 0; i < ENTRY_BUCKETS; i++) {
      const current = this.buckets[i].get() ?? {};
      const keys = Object.keys(current).filter((k) => k !== DISMISSALS);
      if (!keys.some((k) => removed.has(k) || values[k] !== current[k]))
        continue;
      await this.buckets[i].update((current: Record<string, any>) => {
        const next: Record<string, any> = { ...current, [DISMISSALS]: state };
        for (const key of keys)
          if (removed.has(key)) delete next[key];
          else next[key] = values[key];
        return next;
      });
    }
    for (const key of removed) delete values[key];
    await this.index.update(() => ({
      schema: 2,
      entries: this.metadata(values),
      dismissals: state,
    }));
  }
  update = async (
    change: (values: Record<string, any>) => Record<string, any>,
    keys: string[] = [],
  ) => {
    // Initialization failure may be transient; retry conversion before admitting writes.
    await this.ready.catch(() => {});
    return this.lock(async () => {
      await this.prepare();
      const touched = new Set(keys.map(bucketOf));
      const loaded = this.loaded;
      this.loaded = false;
      try {
        await Promise.all([...touched].map((i) => this.buckets[i].refresh()));
        // The small index supplies global retention; untouched cached payloads may be stale.
        const current = this.get();
        const next = change(current);
        const metadata = { ...this.index.get().entries };
        for (const key of keys)
          if (next[key]) metadata[key] = { at: next[key].at };
          else delete metadata[key];
        const gone = evictable(Object.entries(metadata), this.days());
        for (const key of gone) {
          delete next[key];
          delete metadata[key];
          touched.add(bucketOf(key));
        }
        const state = dismissalState(next);
        await this.index.update((index: any) => ({ ...index, pending: true }));
        // Evict before inserting, so even an interrupted multi-key write never exceeds the cap.
        for (const i of new Set(
          gone.filter((key) => this.index.get().entries[key]).map(bucketOf),
        ))
          await this.buckets[i].update((value: Record<string, any>) => {
            const next = { ...value };
            for (const key of gone) if (bucketOf(key) === i) delete next[key];
            return next;
          });
        for (const i of touched) {
          const changes = new Set(
            [...keys, ...gone].filter((k) => bucketOf(k) === i),
          );
          await this.buckets[i].update((value: Record<string, any>) => {
            const updated: Record<string, any> = {
              ...value,
              [DISMISSALS]: state,
            };
            for (const key of changes)
              if (next[key]) updated[key] = next[key];
              else delete updated[key];
            return updated;
          });
        }
        await this.index.update(() => ({
          schema: 2,
          entries: metadata,
          dismissals: state,
        }));
        this.loaded = true;
        for (const i of touched)
          for (const listener of this.listeners) listener(i);
        return next;
      } finally {
        this.loaded = loaded || this.loaded;
      }
    });
  };
}

// Image bytes have their own smaller buckets; the index preserves global insertion order.
const IMAGE_BUCKETS = 16;
class ImageStorage {
  private buckets: any[];
  private index: any;
  private listeners = new Set<(bucket: number) => void>();
  private cleanups: (() => void)[];
  private loaded = false;
  readonly ready: Promise<void>;
  constructor(
    private storage: any,
    private team: string,
  ) {
    this.index = storage.store(`workspace:${team}:image-index:v2`, {});
    this.buckets = Array.from({ length: IMAGE_BUCKETS }, (_, i) =>
      storage.store(`workspace:${team}:images:v2:${i}`, {}),
    );
    this.cleanups = this.buckets.map((store, i) =>
      store.subscribe(() => {
        if (this.loaded) for (const listener of this.listeners) listener(i);
      }),
    );
    this.ready = this.lock(async () => {
      await this.prepare(true);
      this.loaded = true;
    });
  }
  private async lock<T>(run: () => Promise<T>): Promise<T> {
    return navigator.locks.request(
      `taut:MessageLogger:workspace:${this.team}:images:v2`,
      run,
    );
  }
  subscribe(listener: (bucket: number) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  close() {
    for (const cleanup of this.cleanups) cleanup();
  }
  get(bucket?: number) {
    const values = Object.assign(
      {},
      ...(bucket === undefined ? this.buckets : [this.buckets[bucket]]).map(
        (s) => s.get(),
      ),
    );
    return Object.fromEntries(
      [...new Set([...(this.index.get().keys ?? []), ...Object.keys(values)])]
        .filter((key) => values[key])
        .map((key) => [key, values[key]]),
    );
  }
  private async prepare(all = false) {
    const index = await this.index.refresh();
    if (all || index.schema !== 2 || index.pending)
      await Promise.all(this.buckets.map((s) => s.refresh()));
    if (index.schema !== 2) {
      const key = `workspace:${this.team}:images`;
      const legacy = this.storage.store(key, {});
      const old = await legacy.refresh();
      const values = { ...old, ...this.get() };
      for (let i = 0; i < IMAGE_BUCKETS; i++) {
        const part = Object.fromEntries(
          Object.entries(values).filter(
            ([key]) => bucketOf(key) % IMAGE_BUCKETS === i,
          ),
        );
        if (!Object.keys(part).length) continue;
        await this.buckets[i].update(() => part);
        if (
          JSON.stringify(await this.buckets[i].refresh()) !==
          JSON.stringify(part)
        )
          throw new Error("Image migration verification failed");
      }
      await this.index.update(() => ({
        schema: 2,
        pending: true,
        keys: Object.keys(values),
      }));
      await this.recover();
    } else if (index.pending) await this.recover();
    if (all || index.schema !== 2 || index.pending)
      await this.storage.delete(`workspace:${this.team}:images`);
  }
  private async recover() {
    const values = this.get();
    const keys = [
      ...new Set([...(this.index.get().keys ?? []), ...Object.keys(values)]),
    ].filter((k) => values[k]);
    const gone = keys.slice(0, -128);
    for (const i of new Set(gone.map((k) => bucketOf(k) % IMAGE_BUCKETS)))
      await this.buckets[i].update((value: Record<string, any>) => {
        const next = { ...value };
        for (const key of gone) delete next[key];
        return next;
      });
    await this.index.update(() => ({ schema: 2, keys: keys.slice(-128) }));
  }
  update = async (
    change: (values: Record<string, any>) => Record<string, any>,
    keys: string[],
  ) => {
    await this.ready.catch(() => {});
    return this.lock(async () => {
      const loaded = this.loaded;
      this.loaded = false;
      try {
        await this.prepare();
        const touched = new Set(keys.map((k) => bucketOf(k) % IMAGE_BUCKETS));
        await Promise.all([...touched].map((i) => this.buckets[i].refresh()));
        const next = change(this.get());
        const order = new Set<string>(this.index.get().keys);
        for (const key of keys)
          if (next[key]) order.add(key);
          else order.delete(key);
        const pendingKeys = [...order];
        const gone = pendingKeys.slice(0, -128);
        for (const key of gone) {
          delete next[key];
          order.delete(key);
          touched.add(bucketOf(key) % IMAGE_BUCKETS);
        }
        await this.index.update((index: any) => ({
          ...index,
          pending: true,
          keys: pendingKeys,
        }));
        for (const i of new Set(gone.map((k) => bucketOf(k) % IMAGE_BUCKETS)))
          await this.buckets[i].update((value: Record<string, any>) => {
            const next = { ...value };
            for (const key of gone) delete next[key];
            return next;
          });
        for (const i of touched) {
          const changes = [...keys, ...gone].filter(
            (k) => bucketOf(k) % IMAGE_BUCKETS === i,
          );
          await this.buckets[i].update((value: Record<string, any>) => {
            const updated = { ...value };
            for (const key of changes)
              if (next[key]) updated[key] = next[key];
              else delete updated[key];
            return updated;
          });
        }
        await this.index.update(() => ({ schema: 2, keys: [...order] }));
        this.loaded = true;
        for (const i of touched)
          for (const listener of this.listeners) listener(i);
        return next;
      } finally {
        this.loaded = loaded || this.loaded;
      }
    });
  };
}

export default class MessageLogger extends TautPlugin<typeof MessageLogger> {
  static readonly id = "MessageLogger";
  static readonly pluginName = "Message Logger";
  static readonly description = "Keep deleted and edited messages visible";
  static readonly authors = [
    { name: "Slick contributors", url: "https://github.com/3kh0/slick" },
  ];
  static readonly category = "messages";
  static readonly defaultConfig = {
    enabled: false,
    saveImages: opt(
      true,
      "Save accessible Slack image previews (3 per message, 128 archived messages)",
    ),
    retentionDays: opt.number(
      30,
      "Retention in days; 0 disables age eviction",
      {
        min: 0,
        max: 3650,
        check: (v) =>
          Number.isFinite(v) && v >= 0 && v <= 3650 ? null : "Use 0–3650 days",
      },
    ),
    deletedStyle: opt.select(
      ["red", "opacity"],
      "red",
      "Deleted message appearance",
    ),
    hideEditsFromU08FP1HKKFZ: opt(
      false,
      "Hide edits from meta anon vote (display only; history stays stored)",
      { label: "Hide edits from meta anon vote" },
    ),
    ignoreSelf: opt(false, "Skip your edits and deletions"),
    ignoreEditsFrom: opt("", "Comma-separated app, user or bot IDs"),
    ignoreAnchors: opt.select(
      ["off", "lax", "strict"],
      "off",
      "Skip anchored bot deletions",
    ),
  };
  private team = "";
  private saved: any;
  private dismiss = new Map<string, "hide" | "accept">();
  private stopped = false;
  private imageController = new AbortController();
  private imageSaved: any;
  private imagePending = new Map<string, SavedImage[] | null>();
  private imageTimer: ReturnType<typeof setTimeout> | null = null;
  private imageWrites: Promise<void> = Promise.resolve();
  private unsubscribeImages: (() => void) | undefined;
  private stageImages(key: string, value: SavedImage[] | null) {
    this.imagePending.set(key, value);
    if (!this.imageTimer)
      this.imageTimer = setTimeout(() => {
        this.imageTimer = null;
        void this.flushImages();
      }, 200);
  }
  private flushImages(): Promise<void> {
    if (this.imageTimer) {
      clearTimeout(this.imageTimer);
      this.imageTimer = null;
    }
    const batch = [...this.imagePending];
    this.imagePending.clear();
    if (!batch.length) return this.imageWrites;
    this.imageWrites = this.imageWrites
      .then(async () => {
        // Lock order is entries then images, so acceptance cannot race preview persistence.
        await this.saved.withCurrent(
          batch.map(([key]) => key),
          (entries: Record<string, LogEntry>) =>
            this.imageSaved.update(
              (current: Record<string, SavedImage[]>) => {
                const next = { ...current };
                const state = dismissalState(entries);
                for (const [key, value] of batch)
                  if (
                    value &&
                    entries[key] &&
                    afterDismissal(entries[key], key, state)?.deleted
                  )
                    next[key] = value;
                  else delete next[key];
                return next;
              },
              batch.map(([key]) => key),
            ),
        );
      })
      .catch((error) => {
        console.error("[Taut] MessageLogger image storage failed", error);
        for (const [key, value] of batch)
          if (!this.imagePending.has(key)) this.imagePending.set(key, value);
      });
    return this.imageWrites;
  }
  private unsubscribe: (() => void) | undefined;
  private repaintTimer: ReturnType<typeof setTimeout> | null = null;
  private workspaceId() {
    return (
      this.api.redux.getRawState()?.selfTeamIds?.teamId ??
      /^\/client\/([TE][A-Z0-9]+)/.exec(location.pathname)?.[1] ??
      ""
    );
  }
  private active() {
    return (
      !this.stopped &&
      !this.api.signal.aborted &&
      this.team === this.workspaceId()
    );
  }
  private repaint() {
    if (!this.active() || this.repaintTimer) return;
    this.repaintTimer = setTimeout(() => {
      this.repaintTimer = null;
      if (this.active()) this.api.redux.refresh();
    }, 50);
  }
  private readonly entries = new Map<string, LogEntry>();
  private readonly recent = new Map<string, SlackMessage>();
  private readonly dirty = new Map<string, LogEntry | undefined>();
  private writes: Promise<void> = Promise.resolve();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private rowTimer: ReturnType<typeof setTimeout> | null = null;
  private seenRow = false;
  private images: ImageArchive | null = null;

  private readonly EditContext = React.createContext<{
    ts: string;
    edits: StoredEdit[];
    blocks: boolean;
  } | null>(null);

  private readonly ImageContext = React.createContext<SavedImage[]>([]);

  /** `MessageActionsMenu` knows the message; the generic `Menu` that renders rows does not. */
  private readonly MenuRowsContext = React.createContext<React.ReactNode[]>([]);

  start() {
    this.team = this.workspaceId();
    if (!/^[TE][A-Z0-9]+$/.test(this.team)) {
      this.log("No unambiguous workspace ID; capture disabled");
      return;
    }
    this.saved = new EntryStorage(
      this.api.storage,
      this.team,
      () => this.config.retentionDays,
    );
    const imageStore = new ImageStorage(this.api.storage, this.team);
    this.imageSaved = imageStore;
    const imageStorage = {
      entries: async <T>(prefix: string) => {
        await imageStore.ready;
        return new Map(
          Object.entries(imageStore.get()).map(([k, v]) => [
            prefix + k,
            v as T,
          ]),
        );
      },
      set: async (key: string, value: unknown) => {
        this.stageImages(key.slice(7), value as SavedImage[]);
        return true;
      },
      delete: async (key: string) => {
        this.stageImages(key.slice(7), null);
        return true;
      },
    };
    this.images = new ImageArchive(
      imageStorage,
      this.imageController.signal,
      () => this.repaint(),
    );
    this.api.signal.addEventListener(
      "abort",
      () => this.imageController.abort(),
      { once: true },
    );
    this.unsubscribeImages = imageStore.subscribe((bucket) => {
      if (!this.active() || !this.images) return;
      this.images.sync(
        imageStore.get(bucket),
        this.imagePending,
        bucket,
        Object.keys(imageStore.get()),
      );
      this.repaint();
    });
    this.unsubscribe = this.saved.subscribe((bucket: number) => {
      if (this.active()) this.sync(bucket);
    });
    this.api.rtm.on("message", (event) => {
      if (this.active() && !isDeleteEvent(event) && !isChangeEvent(event))
        this.remember(event);
    });
    for (const type of ["message_changed", "message_deleted"])
      this.api.rtm.on(type, (event) => {
        if (this.active() && !isChangeEvent(event) && !isDeleteEvent(event))
          this.record({ ...event, type });
      });
    this.api.rtm.on("*", (event) => {
      if (!this.active()) return;
      if (isDeleteEvent(event) || isChangeEvent(event)) this.record(event);
      else if (event.type === "message" || event.subtype === "bot_message")
        this.remember(event);
    });
    this.api.messages.injectMessages(() =>
      this.active() ? this.injectable() : [],
    );
    this.api.setStyle(this.css(), "deleted");
    this.patchRows();
    this.patchMenu();
    this.patchReplies();
    void this.saved.ready
      .then(async () => {
        if (!this.active()) return;
        this.sync();
        this.cap();
        await this.flush();
        await this.images?.restore(() =>
          [...this.entries].filter(([, e]) => e.deleted).map(([k]) => k),
        );
      })
      .catch((e: unknown) =>
        console.error("[Taut] MessageLogger restore failed", e),
      );
  }
  private sync(bucket?: number) {
    const pending = new Map(
      [...this.dirty.keys()]
        .filter((k) => bucket === undefined || bucketOf(k) === bucket)
        .map((k) => [k, this.dirty.get(k)]),
    );
    for (const key of this.entries.keys())
      if (bucket === undefined || bucketOf(key) === bucket)
        this.entries.delete(key);
    const values = this.saved.get(bucket);
    if (values && typeof values === "object")
      for (const [k, e] of Object.entries(values)) {
        const raw = e as LogEntry;
        if (!raw || typeof raw !== "object") continue;
        const entry = {
          ...raw,
          message:
            raw.message && typeof raw.message === "object"
              ? { ...raw.message }
              : undefined,
          edits: Array.isArray(raw.edits)
            ? raw.edits.map((edit) => ({ ...edit }))
            : raw.edits,
        };
        if (
          !entry ||
          typeof entry.channel !== "string" ||
          typeof entry.ts !== "string" ||
          !Number.isFinite(entry.at) ||
          k !== this.key(entry.channel, entry.ts)
        )
          continue;
        if (normalize(entry)) this.dirty.set(k, entry);
        this.entries.set(k, entry);
      }
    for (const [k, e] of pending) {
      const live =
        e && !this.dismiss.has(k)
          ? afterDismissal(e, k, dismissalState(values))
          : e;
      if (live) this.entries.set(k, live);
      else if (!e) this.entries.delete(k);
      else this.dirty.delete(k);
    }
    this.images?.reconcile(
      new Set(
        [
          ...new Map<string, LogEntry | undefined>([
            ...Object.entries(this.saved.get() as Record<string, LogEntry>),
            ...this.dirty,
          ]),
        ]
          .filter(([, entry]) => entry?.deleted)
          .map(([key]) => key),
      ),
    );
    this.cap();
    this.repaint();
  }
  async stop() {
    this.stopped = true;
    this.imageController.abort();
    this.unsubscribe?.();
    this.saved?.close();
    this.unsubscribeImages?.();
    this.imageSaved?.close();
    if (this.rowTimer) clearTimeout(this.rowTimer);
    if (this.repaintTimer) clearTimeout(this.repaintTimer);
    await this.flush();
    await this.images?.settled();
    await this.flushImages();
  }
  private key(channel: string, ts: string) {
    return `${channel}:${ts}`;
  }

  private remember(event: RtmEvent) {
    const channel = channelOf(event, event as SlackMessage);
    const ts = tsOf(event, event as SlackMessage);
    if (!channel || !ts) return;
    this.recent.set(
      this.key(channel, ts),
      trim({ ...(event as SlackMessage), channel, ts }),
    );
    this.captureImages(this.key(channel, ts), event as SlackMessage);
    while (this.recent.size > RECENT_CAP) {
      const first = this.recent.keys().next().value;
      if (first === undefined) break;
      this.recent.delete(first);
    }
  }

  private record(event: RtmEvent) {
    if (isDeleteEvent(event)) this.recordDelete(event);
    else if (isChangeEvent(event)) this.recordEdit(event);
  }

  private captureImages(key: string, message: SlackMessage, deletion = false) {
    if (
      !this.active() ||
      !this.config.saveImages ||
      this.skipSelf(userOf(message)) ||
      this.skipAnchor(message)
    )
      return;
    // Slack normalizes history files to IDs; RTM messages can carry full objects.
    const files = this.api.redux.getRawState()?.files;
    this.images?.capture(
      key,
      {
        ...message,
        files: Array.isArray(message.files)
          ? message.files
              .map((file) => (typeof file === "string" ? files?.[file] : file))
              .filter(Boolean)
          : message.files,
      },
      deletion,
    );
  }

  private previousOf(event: RtmEvent): SlackMessage | undefined {
    const previous = (event.previous_message ?? event.previous) as
      SlackMessage | undefined;
    if (previous && typeof previous === "object") return previous;
    return undefined;
  }

  private original(
    event: RtmEvent,
    channel: string,
    ts: string,
  ): SlackMessage | undefined {
    return (
      this.previousOf(event) ??
      this.recent.get(this.key(channel, ts)) ??
      this.api.messages.getRawMessage(channel, ts)
    );
  }

  private currentUserId(): string | undefined {
    const id = this.api.redux.getRawState()?.bootData?.user_id;
    return typeof id === "string" ? id : undefined;
  }

  private skipSelf(user: string | undefined): boolean {
    if (!this.config.ignoreSelf || !user) return false;
    const me = this.currentUserId();
    return !!me && me === user;
  }

  private skipAnchor(msg: SlackMessage | undefined): boolean {
    if (!msg) return false;
    switch (this.config.ignoreAnchors) {
      case "lax":
        return !!msg.app_id;
      case "strict":
        return (
          (msg.metadata as { event_type?: string } | undefined)?.event_type ===
            "anchor" && !!msg.app_id
        );
      default:
        return false;
    }
  }

  private skipEditsFrom(...messages: (SlackMessage | undefined)[]): boolean {
    const ignored = new Set(
      (this.config.ignoreEditsFrom ?? "")
        .split(",")
        .map((id: string) => id.trim())
        .filter(Boolean),
    );
    if (!ignored.size) return false;
    return messages.some((msg) =>
      [
        msg?.user,
        msg?.app_id,
        msg?.bot_id,
        msg?.bot_profile?.app_id,
        msg?.bot_profile?.user_id,
        msg?.bot_profile?.id,
      ].some((id) => !!id && ignored.has(id)),
    );
  }

  private recordDelete(event: RtmEvent) {
    const previous = this.previousOf(event);
    const next = event.message as SlackMessage | undefined;
    const channel = channelOf(event, next ?? previous);
    const ts = tsOf(event, next ?? previous);
    if (!channel || !ts) return;
    const original = this.original(event, channel, ts);
    const user = userOf(original ?? previous, event);
    if (this.skipAnchor(original ?? previous)) return;
    if (this.skipSelf(user)) return;

    const key = this.key(channel, ts);
    const state = dismissalState(this.saved.get());
    const inherited = this.entries.get(key);
    const existing = inherited && afterDismissal(inherited, key, state);
    if (existing?.deleted) return;

    const message = original ? asInjected(original, channel, ts) : undefined;
    const entry: LogEntry = {
      ...(existing ?? { channel, ts, at: Date.now() }),
      channel,
      ts,
      user: existing?.user || user,
      deleted: true,
      generation: state.clock,
      message: message ?? existing?.message,
      at: Date.now(),
    };
    this.entries.set(key, entry);
    if (original) this.captureImages(key, original, true);
    this.images?.retain(key);
    this.dirty.set(key, this.entries.get(key));
    this.cap();
    this.persist();
    this.repaint();
  }

  private recordEdit(event: RtmEvent) {
    if (isDeleteEvent(event)) {
      this.recordDelete(event);
      return;
    }
    const previous = this.previousOf(event);
    const next = event.message as SlackMessage | undefined;
    const channel = channelOf(event, next ?? previous);
    const ts = tsOf(event, next ?? previous);
    if (!channel || !ts) return;
    const original = this.original(event, channel, ts);
    const user = userOf(next ?? original ?? previous, event);
    if (this.skipSelf(user)) return;
    if (this.skipEditsFrom(next, previous, original, event as SlackMessage))
      return;
    if (next) this.captureImages(this.key(channel, ts), next);

    if (next)
      this.recent.set(this.key(channel, ts), trim({ ...next, channel, ts }));
    while (this.recent.size > RECENT_CAP)
      this.recent.delete(this.recent.keys().next().value!);
    const oldText = (messageText(previous) || messageText(original)).slice(
      0,
      MAX_EDIT_TEXT,
    );
    const newText = messageText(next).slice(0, MAX_EDIT_TEXT);
    if (!oldText || oldText === newText) return;

    const key = this.key(channel, ts);
    const state = dismissalState(this.saved.get());
    const inherited = this.entries.get(key);
    const existing = inherited && afterDismissal(inherited, key, state);
    const edits = existing?.edits ? [...existing.edits] : [];
    const last = edits[edits.length - 1];
    if (last && last.oldText === oldText && last.newText === newText) return;
    edits.push({
      oldText: oldText.slice(0, MAX_EDIT_TEXT),
      newText: newText.slice(0, MAX_EDIT_TEXT),
    });
    if (edits.length > MAX_EDITS_PER_MESSAGE)
      edits.splice(0, edits.length - MAX_EDITS_PER_MESSAGE);

    this.entries.set(key, {
      ...(existing ?? { channel, ts, at: Date.now() }),
      channel,
      ts,
      user: existing?.user || user,
      edits,
      generation: state.clock,
      at: existing?.at ?? Date.now(),
    });
    this.dirty.set(key, this.entries.get(key));
    this.cap();
    this.persist();
    this.repaint();
  }

  private forget(key: string) {
    this.entries.delete(key);
    this.images?.forget(key);
    this.dirty.set(key, this.entries.get(key));
  }

  /** Returns whether anything was evicted. */
  private cap(): boolean {
    const gone = evictable(this.entries, this.config.retentionDays);
    // Local view eviction is not permission to delete newer durable captures.
    for (const key of gone) this.entries.delete(key);
    return gone.length > 0;
  }

  private persist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.flush();
    }, 200);
  }

  private flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (!this.saved || !this.dirty.size) return this.writes;
    const batch = [...this.dirty].map(([k, entry]) => ({
      key: k,
      entry,
      dismiss: this.dismiss.get(k),
    }));
    this.dirty.clear();
    this.dismiss.clear();
    this.writes = this.writes
      .then(async () => {
        await this.saved.update(
          (current: Record<string, any>) => {
            const next = { ...current };
            const previous = dismissalState(current);
            const state: Dismissals = {
              ...previous,
              keys: { ...previous.keys },
            };
            for (const { key, entry: captured, dismiss } of batch) {
              if (dismiss) {
                state.clock++;
                state.keys[key] = {
                  ...state.keys[key],
                  [dismiss]: state.clock,
                };
              }
              const entry = captured && afterDismissal(captured, key, previous);
              if (captured && !entry && dismiss !== "accept") continue;
              if (dismiss === "accept" || !entry) {
                delete next[key];
                continue;
              }
              if (dismiss === "hide") {
                const latest = next[key] ? mergeEntry(next[key], entry) : entry;
                if (latest.deleted) next[key] = { ...latest, edits: undefined };
                else delete next[key];
                continue;
              }
              const oldEdits = Array.isArray(next[key]?.edits)
                ? next[key].edits!
                : [];
              const merged = next[key]
                ? mergeEntry({ ...next[key], edits: oldEdits }, entry)
                : entry;
              // The same RTM edit may arrive in multiple tabs.
              if (merged.edits)
                merged.edits = mergeEdits(oldEdits, entry.edits ?? []);
              next[key] = merged;
            }

            const barriers = Object.entries(state.keys).sort(
              (a, b) =>
                Math.max(a[1].accept ?? 0, a[1].hide ?? 0) -
                Math.max(b[1].accept ?? 0, b[1].hide ?? 0),
            );
            for (const [key, barrier] of barriers.slice(0, -MAX_ENTRIES)) {
              state.floor = Math.max(state.floor, barrier.accept ?? -1);
              state.hideFloor = Math.max(state.hideFloor, barrier.hide ?? -1);
              delete state.keys[key];
            }
            if (state.clock) next[DISMISSALS] = state;
            return next;
          },
          batch.map((item) => item.key),
        );
        if (!this.stopped)
          for (const bucket of new Set(batch.map((item) => bucketOf(item.key))))
            this.sync(bucket);
      })
      .catch((error) => {
        console.error("[Taut] MessageLogger persistence failed", error);
        for (const item of batch) {
          if (!this.dirty.has(item.key)) {
            if (item.entry) this.entries.set(item.key, item.entry);
            this.dirty.set(item.key, item.entry);
            if (item.dismiss) this.dismiss.set(item.key, item.dismiss);
          }
        }
      });
    return this.writes;
  }

  private injectable(): SlackMessage[] {
    const out: SlackMessage[] = [];
    for (const entry of this.entries.values()) {
      if (!entry.deleted || !entry.message) continue;
      if (
        typeof entry.message.channel !== "string" ||
        typeof entry.message.ts !== "string"
      )
        continue;
      out.push(entry.message);
    }
    return out;
  }

  private loggedThread(channel?: string, threadTs?: string): SlackMessage[] {
    if (!this.active() || !channel || !threadTs) return [];
    const parent = this.entries.get(this.key(channel, threadTs));
    if (!parent?.deleted || !parent.message) return [];
    const replies: SlackMessage[] = [];
    for (const entry of this.entries.values()) {
      if (
        !entry.deleted ||
        !entry.message ||
        entry.channel !== channel ||
        entry.ts === threadTs
      )
        continue;
      if (entry.message.thread_ts === threadTs) replies.push(entry.message);
    }
    return [
      parent.message,
      ...replies.toSorted((a, b) => String(a.ts).localeCompare(String(b.ts))),
    ];
  }

  private patchReplies() {
    this.api.redux.patchThunk("apiCall", (untypedOriginal) => {
      const original = untypedOriginal as (
        request: ApiRequest,
        ...rest: unknown[]
      ) => unknown;
      return (request: ApiRequest, ...rest: unknown[]) => {
        const thunk = original(request, ...rest);
        if (
          request?.method !== "conversations.replies" ||
          typeof thunk !== "function"
        )
          return thunk;
        return (...args: unknown[]) =>
          Promise.resolve((thunk as ApiThunk)(...args)).catch(
            (error: { name?: string }) => {
              const messages =
                error?.name === "thread_not_found"
                  ? this.loggedThread(request.args?.channel, request.args?.ts)
                  : [];
              if (!messages.length) throw error;
              return {
                ok: true,
                method: request.method,
                messages,
                has_more: false,
                unchanged_messages: [],
              };
            },
          );
      };
    });
  }

  private entryFor(
    msg?: SlackMessage,
    channelId?: string,
  ): LogEntry | undefined {
    if (!this.active()) return;
    const ts = typeof msg?.ts === "string" ? msg.ts : undefined;
    if (!ts) return;
    const channel =
      (typeof msg?.channel === "string" && msg.channel) || channelId;
    if (channel) {
      const hit = this.entries.get(this.key(channel, ts));
      if (hit) return hit;
    }
    let found: LogEntry | undefined;
    for (const entry of this.entries.values()) {
      if (entry.ts !== ts) continue;
      if (channel && entry.channel && entry.channel !== channel) continue;
      if (found) return;
      found = entry;
    }
    return found;
  }

  private css(): string {
    const deleted =
      this.config.deletedStyle === "opacity"
        ? `.taut-message-logger-deleted { opacity: 0.5 !important; }`
        : `.taut-message-logger-deleted, .taut-message-logger-deleted * { color: #e01e5a !important; }`;
    return `
      ${deleted}
      .taut-message-logger-edited-original { display: block; padding: 4px 20px 0 0; opacity: .62; white-space: pre-wrap; word-break: break-word; }
      .taut-message-logger-edited-original-line { display: block; }
      .taut-message-logger-edited-original s { text-decoration: line-through; }
      .taut-message-logger-edited-marker { margin-left: 4px; font-size: .85em; opacity: .72; }
      .taut-message-logger-images { display: flex; flex-wrap: wrap; gap: 8px; padding: 4px 0; }
      .taut-message-logger-image { display: block; max-width: 100%; width: fit-content; }
      .taut-message-logger-image img { display: block; max-width: min(360px, 100%); max-height: 300px; object-fit: contain; filter: grayscale(1); }
      .taut-message-logger-image:hover img, .taut-message-logger-image:focus img { filter: grayscale(0); }
    `;
  }

  private savedImage(image: SavedImage, className?: string) {
    const React = globalThis.React;
    return React.createElement(
      "div",
      {
        className: [className, "taut-message-logger-image"]
          .filter(Boolean)
          .join(" "),
        tabIndex: 0,
        "aria-label": `${image.name} (saved deleted image)`,
      },
      React.createElement("img", {
        src: image.data,
        alt: image.name,
        title: image.name,
      }),
    );
  }

  private patchRows() {
    // Replace the deleted-file card inside Slack's gallery, rather than adding
    // a second preview outside the message body (and its avatar gutter).
    this.api.patchComponent<{ file?: { id?: string }; className?: string }>(
      "MessageFile",
      (Original) => (props) => {
        const React = globalThis.React;
        const images = React.useContext(this.ImageContext);
        const image = images.find(
          (saved) => saved.fileId && saved.fileId === props.file?.id,
        );
        return image
          ? this.savedImage(image, props.className)
          : React.createElement(Original, props);
      },
    );
    this.api.patchComponent<{ msg?: SlackMessage }>(
      "MessageFiles",
      (Original) => (props) => {
        const React = globalThis.React;
        const images = React.useContext(this.ImageContext);
        const ids = new Set(
          (Array.isArray(props.msg?.files) ? props.msg.files : []).map(
            (file: any) => (typeof file === "string" ? file : file?.id),
          ),
        );
        const extra = images.filter(
          (image) => !image.fileId || !ids.has(image.fileId),
        );
        return React.createElement(
          React.Fragment,
          null,
          React.createElement(Original, props),
          extra.length
            ? React.createElement(
                "div",
                {
                  className: "taut-message-logger-images",
                  "aria-label": "Saved image previews",
                },
                extra.map((image, index) =>
                  React.createElement(
                    React.Fragment,
                    { key: image.fileId ?? index },
                    this.savedImage(image),
                  ),
                ),
              )
            : null,
        );
      },
    );
    for (const name of ROW_COMPONENTS) {
      this.api.patchComponent<RowProps>(
        name,
        (Original) => (props) => this.renderRow(Original, props),
      );
    }
    for (const name of ["Blocks", "MessageText"] as const) {
      this.api.patchComponent<{ msg?: SlackMessage }>(
        name,
        (Original) => (props) => {
          const React = globalThis.React;
          const edit = React.useContext(this.EditContext);
          if (
            !edit ||
            props.msg?.ts !== edit.ts ||
            (name === "Blocks") !== edit.blocks
          )
            return React.createElement(Original, props);
          return React.createElement(
            React.Fragment,
            null,
            this.editHistory(edit.edits),
            React.createElement(Original, props),
          );
        },
      );
    }
    this.rowTimer = setTimeout(() => {
      if (this.api.signal.aborted || this.seenRow) return;
      this.log(
        `${ROW_COMPONENTS.join(" / ")} never rendered; deleted/edited styling may be inert. Inspect TautAPI.getRenderedComponent(name)`,
      );
    }, 20_000);
  }

  private renderRow(Original: ComponentType<RowProps>, props: RowProps) {
    const React = globalThis.React;
    const version = this.api.redux.usePatchVersion();
    const msg = props.msg ?? props.message;
    const entry = React.useMemo(
      () => this.entryFor(msg, props.channelId),
      [msg, props.channelId, version],
    );
    React.useEffect(() => {
      const channel =
        (typeof msg?.channel === "string" && msg.channel) || props.channelId;
      if (msg?.ts && channel && !entry?.deleted)
        this.captureImages(this.key(channel, msg.ts), msg);
    }, [msg, props.channelId, entry?.deleted]);
    this.seenRow = true;
    const edits =
      this.config.hideEditsFromU08FP1HKKFZ &&
      (msg?.user || entry?.message?.user || entry?.user) === "U08FP1HKKFZ"
        ? undefined
        : entry?.edits;
    if (!entry || (!entry.deleted && !edits?.length))
      return React.createElement(Original, props);

    const classes = [
      props.className,
      entry.deleted && "taut-message-logger-deleted",
      edits?.length && "taut-message-logger-edited",
    ]
      .filter(Boolean)
      .join(" ");

    // Dismiss actions live in the overflow menu; inline they read as message body.
    const images = entry.deleted
      ? (this.images?.get(this.key(entry.channel, entry.ts)) ?? [])
      : [];
    // Older archives predate file IDs. Match them to the stored file order
    // when every file has a preview; leave known non-images alone.
    const files = Array.isArray(msg?.files)
      ? msg.files
      : Array.isArray(entry.message?.files)
        ? entry.message.files
        : [];
    const mapped = images.map((image, index) => {
      if (image.fileId || files.length !== images.length) return image;
      const file = files[index];
      const fileId = typeof file === "string" ? file : file?.id;
      const info =
        typeof file === "string"
          ? this.api.redux.getRawState()?.files?.[file]
          : file;
      if (
        typeof info?.mimetype === "string" &&
        !/^image\/(png|jpeg|gif|webp)$/i.test(info.mimetype)
      )
        return image;
      return typeof fileId === "string" ? { ...image, fileId } : image;
    });
    // Archived RTM payloads contain file objects; Slack's row expects IDs.
    // Passing the objects through makes the gallery look up '[object Object]'.
    const restored =
      entry.deleted && msg && files.length
        ? {
            ...msg,
            files: files
              .map((file) => (typeof file === "string" ? file : file?.id))
              .filter(Boolean),
          }
        : msg;
    const rowProps =
      restored !== msg
        ? {
            ...props,
            ...(props.msg ? { msg: restored } : { message: restored }),
          }
        : props;
    const row = React.createElement(
      this.ImageContext.Provider,
      { value: mapped },
      React.createElement(
        "div",
        { className: classes || undefined },
        React.createElement(Original, rowProps),
      ),
    );
    if (!edits?.length || !msg?.ts) return row;
    return React.createElement(
      this.EditContext.Provider,
      {
        value: {
          ts: msg.ts,
          edits,
          blocks: Array.isArray(msg.blocks) && msg.blocks.length > 0,
        },
      },
      row,
    );
  }

  /**
   * Slack builds the message menu from redux selectors, not a template prop, so
   * the rows are appended as extra children of the menu body.
   */
  private patchMenu() {
    const React = globalThis.React;

    this.api.patchComponent<ActionsMenuProps>(
      "MessageActionsMenu",
      (Original) => (props) => {
        const version = this.api.redux.usePatchVersion();
        const { channelId, ts, onTriggerClose } = props;
        const rows = React.useMemo(() => {
          const entry =
            this.active() && channelId && ts
              ? this.entries.get(this.key(channelId, ts))
              : undefined;
          if (!entry) return [];
          return [
            entry.edits?.length
              ? this.menuRow(
                  "taut_message_logger_hide_edits",
                  "Hide edit history",
                  () => this.hideEdits(entry),
                  onTriggerClose,
                )
              : null,
            entry.deleted
              ? this.menuRow(
                  "taut_message_logger_accept_delete",
                  "Accept deletion",
                  () => this.acceptDelete(entry),
                  onTriggerClose,
                )
              : null,
          ].filter((row) => row !== null);
        }, [channelId, ts, onTriggerClose, version]);

        return React.createElement(
          this.MenuRowsContext.Provider,
          { value: rows },
          React.createElement(Original, props),
        );
      },
    );

    this.api.patchComponent<MenuProps>("Menu", (Original) => (props) => {
      const rows = React.useContext(this.MenuRowsContext);
      if (!rows.length) return React.createElement(Original, props);
      // Empty the context below so submenus (each its own `Menu`) don't get the rows.
      return React.createElement(
        this.MenuRowsContext.Provider,
        { value: [] },
        React.createElement(Original, props, props.children, rows),
      );
    });
  }

  /** Slack's `MenuItem` isn't addressable by name, so this mimics its markup; the classes are the contract. */
  private menuRow(
    key: string,
    label: string,
    click: () => void,
    close?: (event?: unknown) => void,
  ) {
    const React = globalThis.React;
    return React.createElement(
      "div",
      { key, className: "c-menu_item__li", role: "presentation" },
      React.createElement(
        "button",
        {
          type: "button",
          role: "menuitem",
          className: "c-menu_item__button",
          "data-qa": key,
          onClick: () => {
            click();
            close?.();
          },
        },
        React.createElement("div", { className: "c-menu_item__label" }, label),
      ),
    );
  }

  private hideEdits(entry: LogEntry) {
    const key = this.key(entry.channel, entry.ts);
    this.dismiss.set(key, "hide");
    const current = this.entries.get(key);
    if (!current) return;
    if (current.deleted)
      this.entries.set(key, { ...current, edits: undefined });
    else this.entries.delete(key);
    this.dirty.set(key, this.entries.get(key));
    this.persist();
    this.repaint();
  }

  private acceptDelete(entry: LogEntry) {
    this.dismiss.set(this.key(entry.channel, entry.ts), "accept");
    this.forget(this.key(entry.channel, entry.ts));
    this.persist();
    this.repaint();
  }

  private editHistory(edits: StoredEdit[]) {
    const React = globalThis.React;
    return React.createElement(
      "span",
      { className: "taut-message-logger-edited-original" },
      edits.map((edit, index) =>
        React.createElement(
          "span",
          { className: "taut-message-logger-edited-original-line", key: index },
          React.createElement("s", null, edit.oldText || "(empty message)"),
          React.createElement(
            "span",
            { className: "taut-message-logger-edited-marker" },
            "(edited)",
          ),
        ),
      ),
    );
  }
}
// Retention is bounded by age, count and per-entry size: a busy workspace
// produced ~1000 entries/day, and single entries reached 127 KB.

const MAX_ENTRIES = 1000;
const MAX_EDITS_PER_MESSAGE = 20;
const MAX_EDIT_TEXT = 4000;
/** Messages are stored whole (to be injected back), so blocks can make them large. */
const MAX_MESSAGE_BYTES = 32 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

const HEAVY_FIELDS = ["blocks", "attachments", "files", "metadata"] as const;

function weigh(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value) ?? "").byteLength;
  } catch {
    return Infinity;
  }
}

/**
 * Drop heavy fields until it fits, then truncate `text` (never dropped). A row
 * without blocks still renders: Slack falls back to `text`.
 */
function trim(message: SlackMessage): SlackMessage {
  if (weigh(message) <= MAX_MESSAGE_BYTES) return message;
  for (const field of HEAVY_FIELDS) {
    if (!(field in message)) continue;
    delete (message as Record<string, unknown>)[field];
    if (weigh(message) <= MAX_MESSAGE_BYTES) return message;
  }
  if (typeof message.text === "string") {
    const over = weigh(message) - MAX_MESSAGE_BYTES;
    if (over > 0)
      message.text = `${message.text.slice(0, Math.max(0, message.text.length - over - 1))}…`;
  }
  if (weigh(message) > MAX_MESSAGE_BYTES) {
    const bounded: SlackMessage = {
      channel:
        typeof message.channel === "string"
          ? message.channel.slice(0, 200)
          : undefined,
      ts: typeof message.ts === "string" ? message.ts.slice(0, 200) : undefined,
      user:
        typeof message.user === "string"
          ? message.user.slice(0, 200)
          : undefined,
      thread_ts:
        typeof message.thread_ts === "string"
          ? message.thread_ts.slice(0, 200)
          : undefined,
      text: typeof message.text === "string" ? message.text.slice(0, 4000) : "",
    };
    return bounded;
  }
  return message;
}

/** Too old first, then oldest-first until the count fits. `retentionDays` 0 ignores age. */
function evictable(
  entries: Iterable<[string, { at?: number }]>,
  retentionDays: number,
  now = Date.now(),
) {
  const live = new Map(entries);
  const out: string[] = [];

  if (retentionDays > 0) {
    const cutoff = now - retentionDays * DAY_MS;
    for (const [key, entry] of live) {
      if ((entry.at ?? 0) >= cutoff) continue;
      out.push(key);
      live.delete(key);
    }
  }

  if (live.size > MAX_ENTRIES) {
    const ordered = [...live].toSorted(
      (a, b) => (a[1].at ?? 0) - (b[1].at ?? 0),
    );
    for (const [key] of ordered) {
      if (live.size <= MAX_ENTRIES) break;
      out.push(key);
      live.delete(key);
    }
  }

  return out;
}

/**
 * Apply current caps to an entry stored under looser ones; caps enforced only
 * on write would leave oversized entries until the message was edited again.
 * Returns whether it changed, so the caller persists it.
 */
function normalize(entry: {
  message?: SlackMessage;
  edits?: { oldText: string; newText: string }[];
}): boolean {
  let changed = false;
  if (entry.edits && !Array.isArray(entry.edits)) {
    entry.edits = undefined;
    changed = true;
  }

  if (entry.edits && entry.edits.length > MAX_EDITS_PER_MESSAGE) {
    entry.edits = entry.edits.slice(-MAX_EDITS_PER_MESSAGE);
    changed = true;
  }
  if (entry.edits)
    entry.edits = entry.edits.filter(
      (e) =>
        e && typeof e.oldText === "string" && typeof e.newText === "string",
    );
  for (const edit of entry.edits ?? []) {
    for (const field of ["oldText", "newText"] as const) {
      if (
        typeof edit[field] !== "string" ||
        edit[field].length <= MAX_EDIT_TEXT
      )
        continue;
      edit[field] = edit[field].slice(0, MAX_EDIT_TEXT);
      changed = true;
    }
  }

  if (entry.message && weigh(entry.message) > MAX_MESSAGE_BYTES) {
    entry.message = trim(entry.message);
    changed = true;
  }

  return changed;
}

type Mergeable = {
  at: number;
  user?: string;
  deleted?: boolean;
  message?: SlackMessage;
  edits?: { oldText: string; newText: string }[];
};

function mergeEntry<T extends Mergeable>(stored: T, live: T): T {
  const edits = [...(stored.edits ?? []), ...(live.edits ?? [])].slice(
    -MAX_EDITS_PER_MESSAGE,
  );
  return {
    ...stored,
    ...live,
    user: live.user || stored.user,
    deleted: live.deleted || stored.deleted,
    message: live.message ?? stored.message,
    edits: edits.length ? edits : undefined,
    at:
      live.deleted && !stored.deleted
        ? live.at
        : stored.deleted && !live.deleted
          ? stored.at
          : Math.min(stored.at, live.at),
  };
}
function safeImageURL(value: string): boolean {
  try {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      (!u.port || u.port === "443") &&
      ["files.slack.com", "slack-files.com", "a.slack-edge.com"].includes(
        u.hostname,
      )
    );
  } catch {
    return false;
  }
}

type SavedImage = { name: string; data: string; fileId?: string };
type ImageSource = { name: string; urls: string[]; fileId?: string };
type Store = {
  entries<T>(prefix: string): Promise<Map<string, T>>;
  set(key: string, value: unknown): Promise<boolean>;
  delete(key: string): Promise<boolean>;
};

const PREFIX = "images:";
const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 48 * 1024;
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;
const MAX_ARCHIVED = 128;
const MAX_RECENT = 64;
const RASTER = /^image\/(png|jpeg|gif|webp)$/i;

function urls(values: unknown[]): string[] {
  return [
    ...new Set(
      values.filter((value): value is string => {
        if (typeof value !== "string") return false;
        try {
          return safeImageURL(value);
        } catch {
          return false;
        }
      }),
    ),
  ];
}

/** Prefer a Slack preview: originals can be huge, and private URLs need session cookies. */
function imageSources(message: SlackMessage): ImageSource[] {
  const sources: ImageSource[] = [];
  for (const file of Array.isArray(message.files) ? message.files : []) {
    if (
      !file ||
      typeof file !== "object" ||
      typeof file.mimetype !== "string" ||
      !RASTER.test(file.mimetype)
    )
      continue;
    sources.push({
      ...(typeof file.id === "string" ? { fileId: file.id } : {}),
      name: String(file.title || file.name || "Deleted image").slice(0, 200),
      urls: urls([
        file.thumb_720,
        file.thumb_480,
        file.thumb_360,
        file.url_private,
        file.url_private_download,
      ]),
    });
  }
  for (const attachment of message.attachments ?? []) {
    sources.push({
      name: String(attachment.title || "Deleted image").slice(0, 200),
      urls: urls([attachment.image_url, attachment.thumb_url]),
    });
  }
  for (const block of Array.isArray(message.blocks) ? message.blocks : []) {
    if (block?.type === "image")
      sources.push({
        name: String(block.alt_text || "Deleted image").slice(0, 200),
        urls: urls([block.image_url]),
      });
  }
  const seen = new Set<string>();
  return sources
    .filter((source) => {
      if (!source.urls.length || seen.has(source.urls[0])) return false;
      seen.add(source.urls[0]);
      return true;
    })
    .slice(0, MAX_IMAGES);
}

function dataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)), {
      once: true,
    });
    reader.addEventListener("error", () => reject(reader.error), {
      once: true,
    });
    reader.readAsDataURL(blob);
  });
}

async function downloadImage(
  url: string,
  signal: AbortSignal,
): Promise<string | null> {
  if (!safeImageURL(url)) return null;
  const response = await fetch(url, {
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  const type = response.headers.get("content-type")?.split(";")[0].trim() ?? "";
  if (
    !response.ok ||
    !RASTER.test(type) ||
    Number(response.headers.get("content-length")) > MAX_DOWNLOAD_BYTES ||
    !response.body
  ) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body.getReader();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_DOWNLOAD_BYTES) return null;
      parts.push(new Uint8Array(value));
    }
  } finally {
    await reader.cancel();
  }
  const blob = new Blob(parts, { type });
  if (blob.size <= MAX_IMAGE_BYTES) return dataURL(blob);
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, 800 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.8, 0.5, 0.3]) {
      const data = canvas.toDataURL("image/webp", quality);
      if (data.length <= (MAX_IMAGE_BYTES * 4) / 3 + 64) return data;
    }
    return null;
  } finally {
    bitmap.close();
  }
}

function validImages(value: unknown): value is SavedImage[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_IMAGES &&
    value.every(
      (image) =>
        (image?.fileId === undefined ||
          (typeof image.fileId === "string" && image.fileId.length <= 200)) &&
        typeof image?.name === "string" &&
        image.name.length <= 200 &&
        typeof image.data === "string" &&
        /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(
          image.data,
        ) &&
        image.data.length <= (MAX_IMAGE_BYTES * 4) / 3 + 64,
    )
  );
}

/** Image bytes stay separate from the 32 KB message cap and fit extension storage quotas. */
class ImageArchive {
  private recent = new Map<string, SavedImage[]>();
  private archived = new Map<string, SavedImage[]>();
  private retained = new Set<string>();
  private attempted = new Map<string, string>();
  private pending = new Map<string, object>();
  private queued = new Map<string, () => void>();
  private running = 0;
  private writes: Promise<unknown> = Promise.resolve();
  private store: Store;
  private signal: AbortSignal;
  private changed: () => void;
  private download: typeof downloadImage;

  constructor(
    store: Store,
    signal: AbortSignal,
    changed: () => void,
    download = downloadImage,
  ) {
    this.store = store;
    this.signal = signal;
    this.changed = changed;
    this.download = download;
  }

  async restore(keys: () => Iterable<string>) {
    const stored = await this.store.entries<unknown>(PREFIX);
    if (this.signal.aborted) return;
    this.retained = new Set(keys());
    for (const [key, images] of stored) {
      const id = key.slice(PREFIX.length);
      if (!this.retained.has(id) || !validImages(images)) this.remove(id);
      else if (!this.archived.has(id)) this.archived.set(id, images);
    }
    this.cap();
    this.changed();
  }

  reconcile(keys: Set<string>) {
    for (const key of new Set([...this.retained, ...this.archived.keys()]))
      if (!keys.has(key)) this.forget(key);
  }
  settled() {
    return this.writes;
  }
  sync(
    saved: Record<string, unknown>,
    pending: Map<string, SavedImage[] | null>,
    bucket?: number,
    order = Object.keys(saved),
  ) {
    const merged = { ...saved };
    for (const [key, value] of pending)
      if (value) merged[key] = value;
      else delete merged[key];
    for (const key of this.archived.keys())
      if (bucket === undefined || bucketOf(key) % IMAGE_BUCKETS === bucket)
        this.archived.delete(key);
    for (const [key, value] of Object.entries(merged))
      if (
        (bucket === undefined || bucketOf(key) % IMAGE_BUCKETS === bucket) &&
        validImages(value)
      )
        this.archived.set(key, value);
    for (const key of this.archived.keys())
      if (!order.includes(key) && !pending.has(key)) this.archived.delete(key);
    this.archived = new Map([
      ...order
        .filter((key) => this.archived.has(key))
        .map((key) => [key, this.archived.get(key)!] as const),
      ...this.archived,
    ]);
    while (this.archived.size > MAX_ARCHIVED)
      this.archived.delete(this.archived.keys().next().value!);
  }
  get(key: string): SavedImage[] {
    return this.archived.get(key) ?? [];
  }

  capture(key: string, message: SlackMessage, deletion = false) {
    if (this.signal.aborted || this.archived.has(key)) return;
    const sources = imageSources(message);
    // Missing deletion metadata is not evidence that the last observed image changed.
    if (deletion && !sources.length) return;
    const signature = JSON.stringify(sources);
    if (this.attempted.get(key) === signature) return;
    this.pending.delete(key);
    this.queued.delete(key);
    // Source invalidation must not depend on download capacity.
    this.recent.delete(key);
    if (sources.length && this.running >= 8 && this.queued.size >= 8) {
      this.attempted.delete(key);
      return;
    }
    this.attempted.set(key, signature);
    while (this.attempted.size > 400)
      this.attempted.delete(this.attempted.keys().next().value!);
    if (!sources.length) return;
    const token = {};
    this.pending.set(key, token);
    const run = () => {
      this.running++;
      void (async () => {
        const images: SavedImage[] = [];
        for (const source of sources) {
          for (const url of source.urls) {
            if (this.signal.aborted || this.pending.get(key) !== token) return;
            try {
              const data = await this.download(url, this.signal);
              if (!data) continue;
              images.push({
                name: source.name,
                data,
                ...(source.fileId ? { fileId: source.fileId } : {}),
              });
              break;
            } catch {
              // Deleted, inaccessible or offline images must not interrupt logging.
            }
          }
        }
        if (
          this.signal.aborted ||
          this.pending.get(key) !== token ||
          !images.length
        )
          return;
        this.recent.set(key, images);
        while (this.recent.size > MAX_RECENT)
          this.recent.delete(this.recent.keys().next().value!);
        if (this.retained.has(key)) this.retain(key);
      })().finally(() => {
        if (this.pending.get(key) === token) this.pending.delete(key);
        this.running--;
        if (this.signal.aborted) this.queued.clear();
        const next = this.queued.entries().next().value;
        if (next) {
          this.queued.delete(next[0]);
          next[1]();
        }
      });
    };
    if (this.running < 8) run();
    else this.queued.set(key, run);
  }

  retain(key: string) {
    this.retained.add(key);
    while (this.retained.size > MAX_ENTRIES)
      this.retained.delete(this.retained.values().next().value!);
    const images = this.recent.get(key);
    if (!images) return;
    this.recent.delete(key);
    this.archived.set(key, images);
    this.enqueue(() => this.store.set(`${PREFIX}${key}`, images));
    this.cap();
    this.changed();
  }

  forget(key: string) {
    this.retained.delete(key);
    this.recent.delete(key);
    this.attempted.delete(key);
    this.pending.delete(key);
    this.queued.delete(key);
    this.archived.delete(key);
    this.remove(key);
  }

  private cap() {
    // At most ~24 MB encoded; backend storage quotas remain platform-dependent.
    while (this.archived.size > MAX_ARCHIVED) {
      const key = this.archived.keys().next().value!;
      this.archived.delete(key);
      // Durable eviction belongs to the locked image index, not this cached view.
    }
  }

  private remove(key: string) {
    this.enqueue(() => this.store.delete(`${PREFIX}${key}`));
  }

  private enqueue(write: () => Promise<boolean>) {
    this.writes = this.writes
      .then(write)
      .catch((error) =>
        console.error("[Taut] MessageLogger image storage failed:", error),
      );
  }
}
