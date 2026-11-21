// Room-by-room push-optimal Sokoban solver.
//
// Strategy: every level in this competition is a 1-wide hallway with 1-4
// independent rooms off it (3-4 boxes each, one door each). A box pushed out
// of a room through its door can never come back, so each room is solved on
// its own and the rooms' push counts add up to the level optimum. Per room
// this runs A* over pushes (not moves): a state is the sorted box squares
// plus the player's reachable region (named by its lowest square), the cost
// is pushes, and the estimate is the cheapest assignment of boxes to goals
// under single-box push distances (admissible: one push moves one box one
// square). Dead states are pruned with live squares (a square from which no
// single-box push ever reaches a goal) and frozen 2x2 blocks. The search
// budget is a count of states, never the clock, so two runs agree byte for
// byte. If A* gives up on a room, a greedy best-first search tries to find
// any (non-optimal) solution for partial points instead of none.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Work budgets: state counts, never wall time, so runs stay deterministic.
const ASTAR_STATES = 250_000;
const GREEDY_STATES = 150_000;

const DIRS: [number, number, string, string][] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

interface Board {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
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

/** Squares from which a lone box can be pushed onto some goal (reverse pulls from the goals). */
function liveSquares(b: Board): Uint8Array {
  const live = new Uint8Array(b.wall.length);
  const queue = [...b.goals];
  for (const g of b.goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * b.w + dx;
      const y = x - d;
      if (!b.wall[y] && !b.wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * The level's rooms: cut the hallway row's dead floor (squares of the
 * player's row from which no box reaches a goal) out of the floor; each
 * remaining connected part holding boxes is a room.
 */
function roomsOf(b: Board): { squares: number[]; boxes: number[]; goals: number[] }[] | null {
  const live = liveSquares(b);
  const row = Math.floor(b.player / b.w);
  const cut = new Uint8Array(b.wall.length);
  for (let i = row * b.w; i < (row + 1) * b.w; i++) {
    if (!b.wall[i] && !live[i]) cut[i] = 1;
  }
  if (b.boxes.some((x) => cut[x])) return null;
  const part = new Int32Array(b.wall.length).fill(-1);
  const rooms: { squares: number[]; boxes: number[]; goals: number[] }[] = [];
  for (let s = 0; s < b.wall.length; s++) {
    if (b.wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * b.w + dx;
        if (!b.wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const x of b.boxes) rooms[part[x]!]!.boxes.push(x);
  for (const g of b.goals) if (part[g] >= 0) rooms[part[g]!]!.goals.push(g);
  if (b.goals.some((g) => part[g] < 0)) return null;
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** Single-box push distances: dist[cell * nGoals + gi] = fewest pushes for one box alone to reach goal gi, -1 if never. */
function pushDistances(b: Board): Int32Array {
  const n = b.goals.length;
  const dist = new Int32Array(b.wall.length * n).fill(-1);
  for (let gi = 0; gi < n; gi++) {
    const g = b.goals[gi]!;
    dist[g * n + gi] = 0;
    const queue = [g];
    for (let qi = 0; qi < queue.length; qi++) {
      const x = queue[qi]!;
      const d0 = dist[x * n + gi]!;
      for (const [dx, dy] of DIRS) {
        const d = dy * b.w + dx;
        const y = x - d; // the box stood at y and was pushed to x; the player stood at y - d.
        if (b.wall[y] || b.wall[y - d] || dist[y * n + gi] >= 0) continue;
        dist[y * n + gi] = d0 + 1;
        queue.push(y);
      }
    }
  }
  return dist;
}

/** All permutations of 0..n-1, for the assignment heuristic. */
function permutations(n: number): number[][] {
  const out: number[][] = [];
  const a = [...Array(n).keys()];
  const gen = (k: number): void => {
    if (k === 1) {
      out.push(a.slice());
      return;
    }
    for (let i = 0; i < k; i++) {
      gen(k - 1);
      const j = k % 2 === 0 ? i : 0;
      [a[j], a[k - 1]] = [a[k - 1]!, a[j]!];
    }
  };
  gen(n);
  return out;
}

interface SearchResult {
  moves: string;
  pushes: number;
}

/**
 * Push-optimal (A*) or greedy (best-first on the estimate alone) search of one
 * board: returns the move string or null when the state budget runs out.
 * `astar` false means greedy: faster, not optimal, a fallback for partial points.
 */
function searchPushes(b: Board, maxStates: number, astar: boolean): SearchResult | null {
  const size = b.wall.length;
  const n = b.boxes.length;
  const goal = new Uint8Array(size);
  for (const g of b.goals) goal[g] = 1;
  const live = liveSquares(b);
  if (b.boxes.some((x) => !live[x])) return null;
  const dist = pushDistances(b);
  const perms = permutations(n);
  const isGoal = (boxes: number[]): boolean => boxes.every((x) => goal[x]);

  // Cheapest assignment of boxes to goals under single-box push distances.
  // Infinity when some box can reach no goal at all: the state is dead.
  const estimate = (boxes: number[]): number => {
    let best = Infinity;
    for (const p of perms) {
      let s = 0;
      for (let i = 0; i < n; i++) {
        const d = dist[boxes[i]! * n + p[i]!]!;
        if (d < 0) {
          s = Infinity;
          break;
        }
        s += d;
      }
      if (s < best) best = s;
    }
    return best;
  };

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const seen2 = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  let stamp2 = 0;
  // Flood the player's reachable region from `from` (boxes in `occupied` block),
  // marking it in `arr` with `mark`; returns the region's lowest square.
  // Two stamp arrays exist so a successor's flood never clobbers the region
  // the current state's push checks read: the expansion flood uses `seen`,
  // every other flood (a successor's region, a stale check) uses `seen2`.
  const reachLow = (from: number, arr: Int32Array, mark: number): number => {
    let low = from;
    let sp = 0;
    stack[sp++] = from;
    arr[from] = mark;
    while (sp > 0) {
      const p = stack[--sp]!;
      if (p < low) low = p;
      for (const [dx, dy] of DIRS) {
        const q = p + dy * b.w + dx;
        if (!b.wall[q] && !occupied[q] && arr[q] !== mark) {
          arr[q] = mark;
          stack[sp++] = q;
        }
      }
    }
    return low;
  };

  // Whether the box just pushed to `t` sits in a frozen 2x2 block of walls
  // and boxes with a box off its goal: no box in such a block can ever move.
  const frozenBlock = (t: number): boolean => {
    for (const a of [t, t - 1, t - b.w, t - b.w - 1]) {
      const c2 = a + 1;
      const c3 = a + b.w;
      const c4 = c3 + 1;
      if (!(b.wall[a] || occupied[a]) || !(b.wall[c2] || occupied[c2]) || !(b.wall[c3] || occupied[c3]) || !(b.wall[c4] || occupied[c4])) continue;
      if ((occupied[a] && !goal[a]) || (occupied[c2] && !goal[c2]) || (occupied[c3] && !goal[c3]) || (occupied[c4] && !goal[c4])) return true;
    }
    return false;
  };

  const keyOf = (boxes: number[], low: number): number => {
    let k = low;
    for (const x of boxes) k = k * size + x;
    return k;
  };

  const boxesArr: number[][] = [b.boxes.slice()];
  const playerArr: number[] = [b.player];
  const gArr: number[] = [0];
  const parentArr: number[] = [-1];
  const pushFromArr: number[] = [-1];
  const pushToArr: number[] = [-1];
  const best = new Map<number, number>();
  for (const x of b.boxes) occupied[x] = 1;
  const low0 = reachLow(b.player, seen2, ++stamp2);
  for (const x of b.boxes) occupied[x] = 0;
  best.set(keyOf(b.boxes, low0), 0);

  // Binary heap on [priority, -g, h, seq, state]: A* priority is g + h,
  // greedy priority is h alone. The sequence number breaks every tie in
  // insertion order, so the search is fully deterministic.
  type HeapEntry = [number, number, number, number, number];
  const heap: HeapEntry[] = [];
  let seq = 0;
  const h0 = estimate(b.boxes);
  if (h0 === Infinity) return null;
  if (isGoal(b.boxes)) return { moves: '', pushes: 0 };
  heap.push([astar ? h0 : h0, 0, h0, seq++, 0]);
  const less = (x: HeapEntry, y: HeapEntry): boolean =>
    x[0] < y[0] || (x[0] === y[0] && (x[1] < y[1] || (x[1] === y[1] && (x[2] < y[2] || (x[2] === y[2] && x[3] < y[3])))));
  const heapPush = (e: HeapEntry): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): HeapEntry => {
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

  let found = -1;
  while (heap.length > 0) {
    const [, , , , s] = heapPop();
    const boxes = boxesArr[s]!;
    if (best.get(keyOf(boxes, reachLowFrom(s))) !== s) continue;
    if (isGoal(boxes)) {
      found = s;
      break;
    }
    const g = gArr[s]!;
    for (const x of boxes) occupied[x] = 1;
    reachLow(playerArr[s]!, seen, ++stamp);
    const regionStamp = stamp;
    for (let bi = 0; bi < n; bi++) {
      const box = boxes[bi]!;
      for (const [dx, dy] of DIRS) {
        const d = dy * b.w + dx;
        const t = box + d;
        // The player must stand on the pushing square, the box must land on
        // open floor that can still reach a goal.
        if (seen[box - d] !== regionStamp || b.wall[t] || occupied[t] || !live[t]) continue;
        occupied[box] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(t);
        let key = -1;
        let next: number[] | null = null;
        let low = -1;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((a, z) => a - z);
          low = reachLow(box, seen2, ++stamp2);
          key = keyOf(next, low);
        }
        occupied[t] = 0;
        occupied[box] = 1;
        if (frozen || next === null) continue;
        const seenIdx = best.get(key);
        if (seenIdx !== undefined && gArr[seenIdx]! <= g + 1) continue;
        if (boxesArr.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        const h = estimate(next);
        if (h === Infinity) continue;
        const ns = boxesArr.length;
        boxesArr.push(next);
        playerArr.push(box);
        gArr.push(g + 1);
        parentArr.push(s);
        pushFromArr.push(box);
        pushToArr.push(t);
        best.set(key, ns);
        heapPush([astar ? g + 1 + h : h, -(g + 1), h, seq++, ns]);
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;

  // The path of states, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parentArr[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = b.player;
  let boxes = b.boxes.slice();
  for (const s of path) {
    const nextBoxes = boxesArr[s]!;
    const from = pushFromArr[s]!;
    const to = pushToArr[s]!;
    const d = to - from;
    for (const x of boxes) occupied[x] = 1;
    moves += walkTo(b, occupied, player, from - d);
    for (const x of boxes) occupied[x] = 0;
    const dir = DIRS.find(([dx, dy]) => dy * b.w + dx === d);
    moves += dir![3];
    player = from;
    boxes = nextBoxes;
  }
  return { moves, pushes: path.length };

  // The region's lowest square for state s, recomputed from its player cell.
  function reachLowFrom(s: number): number {
    const bs = boxesArr[s]!;
    for (const x of bs) occupied[x] = 1;
    const low = reachLow(playerArr[s]!, seen2, ++stamp2);
    for (const x of bs) occupied[x] = 0;
    return low;
  }
}

/** Shortest walk from `from` to `to` around walls and the boxes in `occupied` (lower LURD letters). */
function walkTo(b: Board, occupied: Uint8Array, from: number, to: number): string {
  if (from === to) return '';
  const prev = new Int32Array(b.wall.length).fill(-1);
  const how = new Array<string>(b.wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * b.w + dx;
      if (b.wall[q] || occupied[q] || prev[q] !== -1) continue;
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

/** The square the player stands on after `moves` (case aside) from `from`. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

/** Solve one level: room by room, the other rooms' boxes standing as walls. */
function solveLevel(text: string): string {
  const level = parseLevel(text);
  if (level.boxes.length === 0) return '';
  const rooms = roomsOf(level);
  if (rooms === null) {
    // No room structure: fall back to a search over the whole level.
    const r = searchPushes(level, ASTAR_STATES, true) ?? searchPushes(level, GREEDY_STATES, false);
    return r === null ? '' : r.moves;
  }
  let player = level.player;
  let moves = '';
  const done = new Set<{ squares: number[]; boxes: number[]; goals: number[] }>();
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      // A room already solved has its boxes on its goals; one still to come
      // has them where they started. Walls must follow the boxes, or the
      // player walks through a box that is no longer where the board says.
      for (const x of done.has(other) ? other.goals : other.boxes) wall[x] = 1;
    }
    const sub: Board = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, z) => a - z),
      boxes: room.boxes.slice().sort((a, z) => a - z),
      player,
    };
    const solved = searchPushes(sub, ASTAR_STATES, true) ?? searchPushes(sub, GREEDY_STATES, false);
    if (solved === null) return '';
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    done.add(room);
  }
  return moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
