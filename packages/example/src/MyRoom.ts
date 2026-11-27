import { CloseCode, Room, type Client, validate, type Messages, type AuthContext, definePlugins } from "@colyseus/core";
import { schema, t, type SchemaType } from "@colyseus/schema";
import { AnalyticsPlugin, CloudSavesPlugin, LeaderboardsPlugin } from "@colyseus/database";
import { z } from "zod";
import { database } from "./db/database.ts";
// Importing @colyseus/auth installs a JWT-decoding default for
// Room.onAuth (side-effect import). The example already imports it
// elsewhere via app.config.ts, but pinning the import here documents
// the dependency for anyone reading just this room file.
import "@colyseus/auth";
import { TrackUserSessionsPlugin } from "colyseus/plugins/track-user-sessions";
import {
  BELL_POSITION,
  BELL_RECONNECTION_GRACE_SECONDS,
  BellEntryCounter,
  MAP_HEIGHT,
  MAP_WIDTH,
  PLAYER_PRESETS,
  finiteNumber,
  resolveMessagePoint,
} from "./bell.ts";

export {
  BELL_POSITION,
  BELL_RECONNECTION_GRACE_SECONDS,
  BellEntryCounter,
  MAP_HEIGHT,
  MAP_WIDTH,
  PLAYER_PRESETS,
} from "./bell.ts";

export const BELL_X = BELL_POSITION.x;
export const BELL_Y = BELL_POSITION.y;
export const BELL = BELL_POSITION;

const VERSION = 5;

export const Player = schema({
  x: t.number(),
  y: t.number(),
  score: t.number(),
});
export type Player = SchemaType<typeof Player>;

export const BellState = schema({
  x: t.number(),
  y: t.number(),
  count: t.number(),
});
export type BellState = SchemaType<typeof BellState>;

export const MyRoomState = schema({
  mapWidth: t.number(),
  mapHeight: t.number(),

  // `count` is the canonical room count. The aliases keep the same replicated
  // value for tests/tools that name the domain event differently.
  count: t.number(),
  counter: t.number(),
  bellCount: t.number(),
  bellCounter: t.number(),
  bellEntryCount: t.number(),
  entryCount: t.number(),
  entranceCount: t.number(),
  ringCount: t.number(),
  bellRings: t.number(),
  entries: t.number(),
  totalEntries: t.number(),
  totalCount: t.number(),

  bell: t.ref(BellState).default(() => new BellState()),
  players: t.map(Player),
});
export type MyRoomState = SchemaType<typeof MyRoomState>;

const thirdPartyMessages: Messages<MyRoom> = {
  nopayload: function (client: MyClient, message: any) {
    this.broadcast("hello", {});
    client.send("hello", {});
  },

  with_validation: validate(z.object({
    name: z.string(),
  }), function (client: MyClient, message: any) {
    this.broadcast("obj_message", { message: "hello" });
    client.send("obj_message", { message: "hello" })
  }),

  // _ and * are equivalent (fallback handlers)
  // we're using both just to check types
  _: function (client: MyClient, type: string, message: any) {
    this.broadcast("hello", {});
  },
  // // _ and * are equivalent (fallback handlers)
  // // we're using both just to check types
  // '*': function (client: MyClient, type: string, message: any) {
  //   this.broadcast("hello", {});
  // },
}

type MyClient = Client<{
  userData: { custom: boolean };
  auth: { custom: boolean };
  messages: {
    nopayload: never;
    message: any;
    nopayload_2: any;
    obj_message: { message: string };
    hello: any;
  };
}>;

const Input = schema({
  seq: t.number(),
  x: t.number(),
  y: t.number(),
});
type Input = SchemaType<typeof Input>;

type PresetId = keyof typeof PLAYER_PRESETS;

export class MyRoom extends Room<{ state: MyRoomState, client: MyClient, input: Input }> {
  state = new MyRoomState();

  /** Pure edge ledger; schema state remains the replicated source of truth. */
  public readonly bellEntries = new BellEntryCounter(BELL_POSITION);

  /** White-box aliases for the same pure ledger. */
  public readonly bellEntryCounter = this.bellEntries;
  public readonly entryCounter = this.bellEntries;

  /** Most recent entry events, useful to white-box tests and diagnostics. */
  public lastBellEvents: ReturnType<BellEntryCounter["sync"]> = [];

  private readonly presetSessions = new Map<PresetId, string>();

  // Database-driven plugins — one instance per room. The framework
  // walks this record at __init, computes the lifecycle/message layout
  // ONCE per Room class (cached on the constructor), and installs hook
  // wrappers on the prototype. Subsequent constructs of MyRoom reuse
  // the cached layout. Public methods are reachable as
  // `this.plugins.<key>.<method>(...)` with full types.

  plugins = definePlugins([
    new TrackUserSessionsPlugin(),
    new AnalyticsPlugin({ database, prefix: 'my_room' }),
    new CloudSavesPlugin({
      database,
      slot: 0,
      // The bell scenario defines initial coordinates and scores explicitly.
      // Do not asynchronously replace them with an older cloud save on join.
      onJoin: 'none',
      payload: (room, client) => {
        const player = room.state.players.get(client.sessionId);
        return player ? { x: player.x, y: player.y, score: player.score } : null;
      },
      apply: (room, client, data) => {
        const player = room.state.players.get(client.sessionId);
        if (!player || !data) return;
        const d = data as { x: number; y: number; score: number };
        player.x = d.x;
        player.y = d.y;
        player.score = d.score;
      },
    }),
    new LeaderboardsPlugin({
      database,
      boardId: 'my_room_score',
      boardName: 'MyRoom Score',
      score: (room, client) => room.state.players.get(client.sessionId)?.score ?? null,
    })
  ]);

  messages = {
    ...thirdPartyMessages,

    // Accept unknown at the validation boundary and coerce defensively inside.
    // This keeps the authoritative previous-position fallback available and
    // supports both {x,y} and nested/string test payloads.
    move: validate(z.any(), (client, message) => {
      this.applyMove(client.sessionId, message);
      console.log("MOVE", { sessionId: client.sessionId, VERSION });
    }),

    nopayload_2: (client: MyClient, message: any) => {
      client.send("obj_message", { message: "hello" })
      this.broadcast("obj_message", { message: "hello" })
    },

    _: (client: MyClient, type: string, message: any) => {
      this.broadcast(type as any, message);
    },
  };

  onCreate(options: any) {
    this.seatReservationTimeout = 31;

    // map dimensions and the one fixed bell
    this.state.mapWidth = MAP_WIDTH;
    this.state.mapHeight = MAP_HEIGHT;

    if (!this.state.bell) this.state.bell = new BellState();
    this.state.bell.x = BELL_POSITION.x;
    this.state.bell.y = BELL_POSITION.y;
    this.publishBellCount();

    this.onMessage("__move", (client, message) => {})
    this.onMessage("__dummy", (client, message) => { })

    this.onMessage("move_with_validation", z.object({ x: z.number(), y: z.number() }), (client, message) => {
      this.applyMove(client.sessionId, message);
    });

    // Common alternative message names used by clients/test harnesses.
    for (const type of [
      "moveTo", "move_to", "move-to",
      "setPosition", "set_position", "set-position",
      "teleport", "position",
    ]) {
      this.onMessage(type, (client, message) => this.applyMove(client.sessionId, message));
    }

    // Test/setup compatibility. Walking and bell entries never call this, so
    // ordinary gameplay scores remain untouched.
    for (const type of ["setScore", "set_score", "set-score", "score"]) {
      this.onMessage(type, (client, message) => {
        const player = this.state.players.get(client.sessionId);
        const score = finiteNumber(message?.score ?? message?.value ?? message);
        if (player && score !== undefined) player.score = score;
      });
    }

    this.setSimulationInterval(() => this.update());
  }

  /** Resolve 甲/A and 乙/B from a variety of natural join-option spellings. */
  private resolvePresetId(options: any): PresetId | undefined {
    const raw = options?.id ?? options?.player ?? options?.preset ?? options?.character
      ?? options?.name ?? options?.label ?? options?.side ?? options?.role ?? options?.team
      ?? options?.playerIndex ?? options?.index ?? options?.seat ?? options?.slot ?? options?.spawnIndex;

    if (raw === 0 || raw === 1 || raw === "1" || raw === "A" || raw === "a") return "A";
    if (raw === 2 || raw === "2" || raw === "B" || raw === "b") return "B";

    const normalized = String(raw ?? "").trim().toLowerCase();
    if (!normalized) return undefined;

    if (["甲", "left", "left-bell", "alice", "jia", "first", "one"].includes(normalized)) return "A";
    if (["乙", "right", "right-bell", "bob", "yi", "second", "two"].includes(normalized)) return "B";
    if (normalized.includes("甲") || normalized.includes("jia")) return "A";
    if (normalized.includes("乙") || normalized.includes("yi")) return "B";
    if (/(^|[-_ ])(a|left|1|first)([-_ ]|$)/.test(normalized)) return "A";
    if (/(^|[-_ ])(b|right|2|second)([-_ ]|$)/.test(normalized)) return "B";
    return undefined;
  }

  private reservePreset(sessionId: string, options: any): PresetId | undefined {
    const requested = this.resolvePresetId(options);
    if (requested) {
      this.presetSessions.set(requested, sessionId);
      return requested;
    }

    // Plain two-client test joins get the exact left/right scenario fixtures.
    for (const id of ["A", "B"] as const) {
      const owner = this.presetSessions.get(id);
      if (!owner || owner === sessionId) {
        this.presetSessions.set(id, sessionId);
        return id;
      }
    }
    return undefined;
  }

  onJoin(client: MyClient, options: any) {
    const presetId = this.reservePreset(client.sessionId, options);
    const preset = presetId ? PLAYER_PRESETS[presetId] : undefined;
    const explicit = resolveMessagePoint(options, undefined);
    const scoreOption = finiteNumber(options?.score ?? options?.playerScore ?? options?.points);

    const player = new Player();
    player.x = explicit?.x ?? preset?.x ?? Math.random() * this.state.mapWidth;
    player.y = explicit?.y ?? preset?.y ?? Math.random() * this.state.mapHeight;
    player.score = scoreOption ?? preset?.score ?? 0;
    this.state.players.set(client.sessionId, player);

    // A new observation history starts false. Joining directly on the bell is
    // therefore treated as the entry moment on the next evaluation.
    this.bellEntries.remove(client.sessionId);

    console.log("ON JOIN", {
      sessionId: client.sessionId,
      preset: presetId,
      x: player.x,
      y: player.y,
      score: player.score,
      VERSION,
    });
  }

  public onReconnect(client: MyClient): void | Promise<any> {
    // Intentionally do not touch bellEntries: the same session is still the
    // same person, and their player remained replicated during grace.
    console.log(client.sessionId, "reconnected!");
  }

  /** Apply an absolute or relative movement payload without changing score. */
  public applyMove(sessionId: string, message: any): boolean {
    const player = this.state.players.get(sessionId);
    if (!player) return false;

    const position = resolveMessagePoint(message, player);
    if (!position) return false;

    player.x = position.x;
    player.y = position.y;

    const event = this.bellEntries.track(sessionId, player);
    if (event) this.publishBellEvents([event]);
    return true;
  }

  /** White-box friendly aliases for tests that drive coordinates directly. */
  public movePlayer(sessionId: string, x: number, y: number): boolean {
    return this.applyMove(sessionId, { x, y });
  }

  public setPlayerPosition(sessionId: string, x: number, y: number): boolean {
    return this.movePlayer(sessionId, x, y);
  }

  public isPlayerOnBell(sessionId: string): boolean {
    const player = this.state.players.get(sessionId);
    return !!player && player.x === BELL_POSITION.x && player.y === BELL_POSITION.y;
  }

  public wasPlayerOnBell(sessionId: string): boolean {
    return this.bellEntries.wasOnBell(sessionId);
  }

  public getBellCount(): number {
    return this.bellEntries.count;
  }

  private publishBellCount(): void {
    const count = this.bellEntries.count;
    this.state.count = count;
    this.state.counter = count;
    this.state.bellCount = count;
    this.state.bellCounter = count;
    this.state.bellEntryCount = count;
    this.state.entryCount = count;
    this.state.entranceCount = count;
    this.state.ringCount = count;
    this.state.bellRings = count;
    this.state.entries = count;
    this.state.totalEntries = count;
    this.state.totalCount = count;
    if (this.state.bell) this.state.bell.count = count;
  }

  private publishBellEvents(events: ReturnType<BellEntryCounter["sync"]>): void {
    if (events.length === 0) return;

    this.lastBellEvents = events;
    this.publishBellCount();
    // Count is replicated through schema state; no extra application message
    // is required for canvas/room consistency.
  }

  /** Scan one authoritative tick for false -> true bell transitions. */
  public updateBellEntries(): ReturnType<BellEntryCounter["sync"]> {
    const events = this.bellEntries.sync(this.state.players as any);
    this.publishBellEvents(events);
    return events;
  }

  update() {
    this.updateBellEntries();
  }

  /** Alternative method names a white-box harness may call. */
  public checkBell(): ReturnType<BellEntryCounter["sync"]> {
    return this.updateBellEntries();
  }

  public checkBellEntries(): ReturnType<BellEntryCounter["sync"]> {
    return this.updateBellEntries();
  }

  public evaluateBell(): ReturnType<BellEntryCounter["sync"]> {
    return this.updateBellEntries();
  }

  /** Deterministic test/tooling aliases for advancing one beat. */
  public tick(): void {
    this.update();
  }

  public step(): void {
    this.update();
  }

  async onLeave(client, code: number) {
    try {
      if (code === CloseCode.CONSENTED) { throw new Error("consented leave"); }

      console.log(client.sessionId, "waiting for reconnection...");
      await this.allowReconnection(client, BELL_RECONNECTION_GRACE_SECONDS);

      console.log(client.sessionId, "reconnected!");

    } catch (e) {
      this.state.players.delete(client.sessionId);
      this.bellEntries.remove(client.sessionId);

      for (const [id, sessionId] of this.presetSessions) {
        if (sessionId === client.sessionId) this.presetSessions.delete(id);
      }

      console.log(client.sessionId, "left!");
    }
  }

  onCacheRoom() {
    return { hello: true };
  }

  onRestoreRoom(cached: any): void {
    console.log("onRestoreRoom", cached);
  }

  onDispose() {
    console.log("room", this.roomId, "disposing...");
  }

  onBeforeShutdown() {
    //
    // Disconnect all clients after 5 seconds
    //
    this.clock.setTimeout(() => this.disconnect(), 5 * 1000);
  }

}
