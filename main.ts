// sokoban-solver: a push-optimal Sokoban solver for make.fun's sokoban-solver-01.
// One run answers a set of 5 levels (each /input/<id>/level.txt) with /output/<id>/solution.txt.
//
// How it works, in three layers:
//
//  1. Rooms. A generated level is a 1-wide hallway with 1-4 rooms off it, and a box
//     pushed out of a room through its door can never come back (the player would
//     have to stand on the hallway's far side, which is wall). So every box stays in
//     its room and the rooms are independent problems joined only by the player's
//     walk. The rooms are found by cutting the hallway row's dead squares (squares
//     from which no push, ignoring the other boxes, can ever reach a goal) out of
//     the floor: each remaining component holding boxes is one room.
//
//  2. Push-optimal search per room. A state is the boxes' squares plus the region
//     the player can reach around them (named by its lowest square). The search is
//     breadth-first over pushes, so the first solved state it meets is
//     push-optimal for that room, and the rooms' optima add up to the level's.
//     Two deadlocks are pruned, and neither prunes a solvable state: a box pushed
//     onto a dead square, and a box pushed into a frozen 2 x 2 block of walls and
//     boxes holding a box off its goal. States live in typed arrays (boxes packed
//     into one base-size number), so a room of 4 boxes costs a few dozen bytes a
//     state.
//
//  3. Fallbacks. If a room's breadth-first search runs past its state cap, a
//     best-first search with the same state machinery (pushes + a distance
//     estimate) tries for a merely good solution instead of none. If the level
//     is no set of rooms at all, the same searches run over the whole level.
//     A level that still has no answer gets an empty solution file, which is a
//     valid answer worth no points, so the entry always answers every instance.
//
// Determinism: every budget is a count of states, never the clock. The program
// reads no clock, no environment variable as a source of variation, and no file
// outside /input and /bot. Iteration orders are fixed (directions u, d, l, r;
// boxes in square order; states in the order found), so two executions on one
// set write the same bytes.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Work budgets, counted in states, never in seconds: the run must finish well
// inside its 60-second wall budget on one CPU, and identical work on both
// executions is what makes the outputs byte-identical.
const ROOM_STATE_CAP = 800_000; // per room; the generator keeps rooms solvable inside 250,000
const LEVEL_STATE_CAP = 400_000; // whole-level fallback search
const RUN_STATE_CAP = 5_000_000; // every search in the run, all five levels together

/** The four directions: [dx, dy, walk letter, push letter]. */
const DIRS: [number, number, string, string][] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** A level in XSB text (# wall, space floor, . goal, $ box, * box on a goal, @ player, + player on a goal). */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/** The squares from which a box alone can be pushed onto some goal (pulled back from the goals over open floor). */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway: a box
 * there reaches no goal) out of the floor, and each part left that holds a box is
 * a room. Null when some part holds more or fewer boxes than goals, or a box
 * starts in the hallway: then the level is no set of rooms.
 */
function roomsOf(level: Level): { squares: number[]; boxes: number[]; goals: number[] }[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: { squares: number[]; boxes: number[]; goals: number[] }[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) if (part[g]! >= 0) rooms[part[g]!]!.goals.push(g);
  if (goals.some((g) => part[g]! < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** Whether the box just pushed to `t` sits in a frozen 2 x 2 block of walls and boxes with a box off its goal. */
function frozenBlock(wall: Uint8Array, occupied: Uint8Array, goal: Uint8Array, w: number, t: number): boolean {
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** Shared scratch for the searches below: region stamps and a flood-fill stack, sized per level. */
class SearchScratch {
  readonly seen: Int32Array;
  readonly mark: Int32Array;
  readonly stack: Int32Array;
  readonly occupied: Uint8Array;
  stamp = 0;
  constructor(size: number) {
    this.seen = new Int32Array(size);
    this.mark = new Int32Array(size);
    this.stack = new Int32Array(size);
    this.occupied = new Uint8Array(size);
  }
  /**
   * The squares the player reaches from `from` around walls and the boxes in
   * `occupied`, marked in `seen` with a fresh stamp; returns the lowest.
   */
  reach(level: Level, from: number, seen: Int32Array): number {
    const { w, wall } = level;
    const { occupied, stack } = this;
    const stamp = ++this.stamp;
    let low = from;
    let n = 0;
    stack[n++] = from;
    seen[from] = stamp;
    while (n > 0) {
      const p = stack[--n]!;
      if (p < low) low = p;
      for (let k = 0; k < 4; k++) {
        const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
        if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
          seen[q] = stamp;
          stack[n++] = q;
        }
      }
    }
    return low;
  }
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters (first direction first on ties). */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The square the player stands on after `moves` (LURD, the case aside) from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

interface SearchResult {
  pushes: number;
  moves: string;
}

/**
 * A push search over one sub-level: states are the boxes (packed into one
 * base-size number, boxes in square order) and the player's reachable region
 * (its lowest square). `bestFirst` picks the queue: false is breadth-first,
 * which is push-optimal; true is best-first on pushes plus a distance estimate,
 * which is not optimal but still finds a solution when breadth-first runs out
 * of budget. Returns null when the search gives up (state cap, or the run's
 * state budget).
 */
function pushSearch(
  sub: Level,
  cap: number,
  budget: { used: number },
  bestFirst: boolean,
  scratch: SearchScratch,
): SearchResult | null {
  const { w, wall, goals } = sub;
  const size = wall.length;
  const nBoxes = sub.boxes.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(sub);
  if (sub.boxes.some((b) => !live[b])) return null;
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);
  // Each square's distance to its nearest goal over open floor (the best-first estimate's table).
  const dist = new Int32Array(size).fill(-1);
  {
    const queue = [...goals];
    for (const g of goals) dist[g] = 0;
    for (let qi = 0; qi < queue.length; qi++) {
      const p = queue[qi]!;
      for (const [dx, dy] of DIRS) {
        const q = p + dy * w + dx;
        if (!wall[q] && dist[q] < 0) {
          dist[q] = dist[p]! + 1;
          queue.push(q);
        }
      }
    }
  }
  const estimate = (boxes: number[]): number => {
    let e = 0;
    for (const b of boxes) e += dist[b] < 0 ? 0 : dist[b]!;
    return e;
  };
  const pack = (boxes: number[]): number => {
    let k = 0;
    for (const b of boxes) k = k * size + b;
    return k;
  };
  const unpack = (packed: number, out: number[]): void => {
    for (let i = nBoxes - 1; i >= 0; i--) {
      out[i] = packed % size;
      packed = Math.floor(packed / size);
    }
  };
  const keyOf = (boxes: number[], low: number): number => {
    let k = low;
    for (const b of boxes) k = k * size + b;
    return k;
  };

  // The states, in the order found: packed boxes, parent, and the push that made them.
  let capacity = 4096;
  let packed = new Float64Array(capacity);
  let parent = new Int32Array(capacity);
  let pushFrom = new Int32Array(capacity);
  let pushTo = new Int32Array(capacity);
  let playerAt = new Int32Array(capacity);
  let depth = new Int32Array(capacity);
  let heur = new Int32Array(capacity);
  let count = 0;
  const grow = (): void => {
    capacity *= 2;
    const np = new Float64Array(capacity);
    np.set(packed);
    packed = np;
    const npar = new Int32Array(capacity);
    npar.set(parent);
    parent = npar;
    const nf = new Int32Array(capacity);
    nf.set(pushFrom);
    pushFrom = nf;
    const nt = new Int32Array(capacity);
    nt.set(pushTo);
    pushTo = nt;
    const npl = new Int32Array(capacity);
    npl.set(playerAt);
    playerAt = npl;
    const nd = new Int32Array(capacity);
    nd.set(depth);
    depth = nd;
    const nh = new Int32Array(capacity);
    nh.set(heur);
    heur = nh;
  };
  const add = (pk: number, par: number, from: number, to: number, pl: number, h: number): number => {
    if (count === capacity) grow();
    packed[count] = pk;
    parent[count] = par;
    pushFrom[count] = from;
    pushTo[count] = to;
    playerAt[count] = pl;
    depth[count] = par < 0 ? 0 : depth[par]! + 1;
    heur[count] = h;
    return count++;
  };

  const { occupied } = scratch;
  for (const b of sub.boxes) occupied[b] = 1;
  const startLow = scratch.reach(sub, sub.player, scratch.seen);
  const startKey = keyOf(sub.boxes, startLow);
  const visited = new Map<number, number>();
  visited.set(startKey, add(pack(sub.boxes), -1, -1, -1, sub.player, estimate(sub.boxes)));
  for (const b of sub.boxes) occupied[b] = 0;
  if (solved(sub.boxes)) return { pushes: 0, moves: '' };

  // The open list: breadth-first walks the states in the order found; best-first
  // keeps a heap on pushes + estimate (ties: fewer pushes, then earlier found).
  const heap: number[] = [];
  const less = (a: number, b: number): boolean => {
    const fa = depth[a]! + heur[a]!;
    const fb = depth[b]! + heur[b]!;
    return fa < fb || (fa === fb && (depth[a]! < depth[b]! || (depth[a]! === depth[b]! && a < b)));
  };
  const heapPush = (s: number): void => {
    let i = heap.length;
    heap.push(s);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): number => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };
  if (bestFirst) heapPush(0);

  let found = -1;
  let head = 0;
  const boxes: number[] = new Array(nBoxes);
  while ((bestFirst ? heap.length > 0 : head < count) && found < 0) {
    const s = bestFirst ? heapPop() : head++;
    unpack(packed[s]!, boxes);
    for (const b of boxes) occupied[b] = 1;
    scratch.reach(sub, playerAt[s]!, scratch.seen);
    // reach() stamped the player's region with the stamp it used; that stamp is
    // the value scratch.stamp holds now, and it names the region below.
    const regionStamp = scratch.stamp;
    for (let bi = 0; bi < nBoxes && found < 0; bi++) {
      const b = boxes[bi]!;
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const t = b + d;
        if (scratch.seen[b - d] !== regionStamp || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(wall, occupied, goal, w, t);
        let key = -1;
        let next: number[] | null = null;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          key = keyOf(next, scratch.reach(sub, b, scratch.mark));
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || visited.has(key)) continue;
        if (count >= cap || budget.used >= RUN_STATE_CAP) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        budget.used++;
        const ns = add(pack(next!), s, b, t, b, estimate(next!));
        visited.set(key, ns);
        if (bestFirst) heapPush(ns);
        if (solved(next!)) {
          found = ns;
          break;
        }
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;
  // The path of states, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = sub.player;
  let cur: number[] = sub.boxes.slice();
  for (const s of path) {
    const from = pushFrom[s]!;
    const to = pushTo[s]!;
    const d = to - from;
    const dir = DIRS.find(([dx, dy]) => dy * w + dx === d)!;
    for (const b of cur) occupied[b] = 1;
    moves += walkTo(sub, occupied, player, from - d);
    for (const b of cur) occupied[b] = 0;
    moves += dir[3];
    player = from;
    cur = cur.slice();
    cur[cur.indexOf(from)] = to;
    cur.sort((a, b) => a - b);
  }
  return { pushes: path.length, moves };
}

/** One room solved push-optimally, falling back to best-first when breadth-first runs out of budget. */
function solveRoom(sub: Level, budget: { used: number }, scratch: SearchScratch): SearchResult | null {
  return pushSearch(sub, ROOM_STATE_CAP, budget, false, scratch) ?? pushSearch(sub, ROOM_STATE_CAP, budget, true, scratch);
}

/**
 * The level solved room by room: each room's push-optimal solution in turn, the
 * other rooms' boxes standing as walls (on their goals once their room is done),
 * the player walking on from where the last room left it. Falls back to a
 * whole-level search when the level is no set of rooms, and to an empty answer
 * when nothing solves it.
 */
function solveLevel(level: Level, budget: { used: number }): string {
  const scratch = new SearchScratch(level.w * level.h);
  const rooms = roomsOf(level);
  if (rooms !== null) {
    let player = level.player;
    let moves = '';
    for (const room of rooms) {
      const wall = level.wall.slice();
      for (const other of rooms) {
        if (other === room) continue;
        for (const b of other.boxes) wall[b] = 1;
      }
      const sub: Level = {
        w: level.w,
        h: level.h,
        wall,
        goals: room.goals.slice().sort((a, b) => a - b),
        boxes: room.boxes.slice().sort((a, b) => a - b),
        player,
      };
      const solved = solveRoom(sub, budget, scratch);
      if (solved === null) return '';
      moves += solved.moves;
      player = endOf(level.w, player, solved.moves);
      // The room just solved: its boxes now stand on its goals, as walls for the next room.
      room.boxes = room.goals.slice();
    }
    return moves;
  }
  const whole = pushSearch(level, LEVEL_STATE_CAP, budget, false, scratch) ?? pushSearch(level, LEVEL_STATE_CAP, budget, true, scratch);
  return whole === null ? '' : whole.moves;
}

/** The moves for a level in XSB: a string of u, d, l and r (an upper letter marks a push; case is not checked). */
function solve(text: string, budget: { used: number }): string {
  try {
    return solveLevel(parseLevel(text), budget);
  } catch {
    return '';
  }
}

const budget = { used: 0 };
for (const id of readdirSync(I).sort()) {
  let moves = '';
  try {
    moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'), budget);
  } catch {
    moves = '';
  }
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
