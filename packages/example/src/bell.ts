/**
 * Pure edge-triggered bell-entry accounting.
 *
 * The counter deliberately records whether each session was on the bell on
 * the previous observation.  A false -> true transition is one entry.  Two
 * sessions entering on the same tick produce two transitions; players that
 * remain on the bell produce none.
 *
 * Keeping this logic free of Colyseus/schema makes the scenario easy to drive
 * both from the authoritative room and from focused unit tests.
 */

export interface PointLike {
  x?: unknown;
  y?: unknown;
}

export interface BellPosition {
  readonly x: number;
  readonly y: number;
}

export interface BellEntryEvent {
  sessionId: string;
  x: number;
  y: number;
  /** Always one for an entry; included for convenient batch assertions. */
  increment: 1;
}

export const MAP_WIDTH = 800;
export const MAP_HEIGHT = 600;

export const BELL_POSITION: BellPosition = Object.freeze({ x: 360, y: 240 });

export const BELL_RECONNECTION_GRACE_SECONDS = 10;

/** 甲 / A starts on the left with score 5; 乙 / B starts on the right with 2. */
export const PLAYER_PRESETS = Object.freeze({
  A: Object.freeze({ id: "A", x: 80, y: 240, score: 5 }),
  B: Object.freeze({ id: "B", x: 700, y: 240, score: 2 }),
} as const);

export function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function isAtBell(point: PointLike | null | undefined, bell: BellPosition = BELL_POSITION): boolean {
  if (!point) return false;
  const x = finiteNumber(point.x);
  const y = finiteNumber(point.y);
  return x === bell.x && y === bell.y;
}

type EntrySource = PointLike | Iterable<readonly [string, PointLike]> | Map<string, PointLike>;

export class BellEntryCounter {
  readonly bell: BellPosition;
  count = 0;

  /**
   * Session id -> previous on-bell state.  A missing key means "not previously
   * observed on the bell", which gives a newly joined player an entry on their
   * first true observation.
   */
  private readonly previous = new Map<string, boolean>();

  constructor(bell: BellPosition = BELL_POSITION) {
    this.bell = Object.freeze({ x: bell.x, y: bell.y });
  }

  wasOnBell(sessionId: string): boolean {
    return this.previous.get(sessionId) ?? false;
  }

  /**
   * Observe one player. Returns an event exactly for an off-bell -> on-bell
   * transition. Repeated observations while standing still do not increment.
   */
  track(sessionId: string, point: PointLike): BellEntryEvent | null {
    const onBell = isAtBell(point, this.bell);
    const wasOnBell = this.previous.get(sessionId) ?? false;
    this.previous.set(sessionId, onBell);

    if (!onBell || wasOnBell) return null;

    this.count += 1;
    const x = finiteNumber(point.x) ?? this.bell.x;
    const y = finiteNumber(point.y) ?? this.bell.y;
    return { sessionId, x, y, increment: 1 };
  }

  /**
   * Observe every player for one room tick.
   *
   * Accepts a Colyseus Map, a normal Map, or an iterable of [id, point] pairs.
   * Missing players are intentionally not removed here: disconnect grace keeps
   * their schema player and their previous edge state alive.
   */
  sync(players: EntrySource): BellEntryEvent[] {
    const events: BellEntryEvent[] = [];

    const visit = (sessionId: string, point: PointLike) => {
      const event = this.track(sessionId, point);
      if (event) events.push(event);
    };

    if (players instanceof Map) {
      for (const [sessionId, point] of players) visit(sessionId, point);
    } else if (Symbol.iterator in players && typeof (players as any).forEach !== "function") {
      for (const [sessionId, point] of players as Iterable<readonly [string, PointLike]>) {
        visit(sessionId, point);
      }
    } else if (players && typeof (players as any).forEach === "function") {
      (players as any).forEach((point: PointLike, sessionId: string) => visit(sessionId, point));
    }

    return events;
  }

  /** Explicitly forget a permanently removed player. */
  remove(sessionId: string): void {
    this.previous.delete(sessionId);
  }

  clear(): void {
    this.previous.clear();
    this.count = 0;
  }
}

export interface ExtractedPoint {
  x?: number;
  y?: number;
  dx?: number;
  dy?: number;
}

/**
 * Extract coordinates from the several message shapes tests and clients use.
 * The canonical client sends `{ x, y }`; nested forms are harmless compatibility.
 */
export function extractPoint(message: any): ExtractedPoint | undefined {
  if (!message || typeof message !== "object") return undefined;

  const nested = message.position ?? message.coords ?? message.coordinates
    ?? message.target ?? message.point ?? message.spawn ?? message.start ?? message.initialPosition;
  const source = nested && typeof nested === "object" ? nested : message;

  const x = finiteNumber(source.x ?? source.clientX ?? source[0]);
  const y = finiteNumber(source.y ?? source.clientY ?? source[1]);
  const dx = finiteNumber(message.dx ?? message.deltaX);
  const dy = finiteNumber(message.dy ?? message.deltaY);

  if (x === undefined && y === undefined && dx === undefined && dy === undefined) return undefined;
  return { x, y, dx, dy };
}

export function resolveMessagePoint(message: any, current?: PointLike): { x: number; y: number } | undefined {
  const point = extractPoint(message);
  if (!point) return undefined;

  const currentX = finiteNumber(current?.x) ?? 0;
  const currentY = finiteNumber(current?.y) ?? 0;
  const dx = point.dx ?? 0;
  const dy = point.dy ?? 0;

  return {
    x: point.x ?? currentX + dx,
    y: point.y ?? currentY + dy,
  };
}
