// Sokoban solver for make.fun — room-decomposed push-optimal search.
//
// Idea: a generated level is one hallway row plus 1-4 rooms, each room
// opening onto the hallway through a single door. A box pushed out of a
// room into the hallway can never come back, so every box stays in its
// room and the level optimum is the sum of the rooms' optima. This
// program therefore splits the level into rooms and solves each room
// independently with a push-only breadth-first search (fewest pushes
// first, so the first solution found is push-optimal for that room),
// then stitches the rooms together with plain walks through the
// hallway. Everything is deterministic: fixed direction order, fixed
// budgets counted in states, no clock, no randomness.
//
// Written from scratch in this session for this competition.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Directions in fixed order: up, down, left, right. This order is used
// everywhere (walks, push generation) so ties always break the same way.
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const LETTER = ['u', 'd', 'l', 'r'];

type Board = {
  w: number;
  h: number;
  wall: Uint8Array; // 1 = wall (includes the padded outer frame)
  goals: number[];
  boxes: number[]; // sorted
  player: number;
};

const idx = (b: Board, x: number, y: number): number => y * b.w + x;
const inBounds = (b: Board, i: number): boolean => i >= 0 && i < b.w * b.h;
const isWall = (b: Board, i: number): boolean => !inBounds(b, i) || b.wall[i] === 1;

/** Parse XSB text into a board. Short rows and the outer frame count as wall. */
function parseLevel(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(1, ...rows.map((r) => r.length));
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
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * Live cells: cells from which a box can still be pushed onto some goal,
 * found by pulling boxes backwards from the goals. A box standing on a
 * non-live cell is dead, and pushing a box onto one is a wasted move.
 */
function liveCells(b: Board): Uint8Array {
  const live = new Uint8Array(b.w * b.h);
  const queue: number[] = [];
  for (const g of b.goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const cell = queue[qi];
    for (let d = 0; d < 4; d++) {
      const step = DY[d] * b.w + DX[d];
      const from = cell - step; // the cell the box is pulled back to
      const stand = from - step; // where the player must stand to pull it
      if (!isWall(b, from) && !isWall(b, stand) && !live[from]) {
        live[from] = 1;
        queue.push(from);
      }
    }
  }
  return live;
}

/** All cells the player can reach from `from` without crossing walls/boxes. */
function reachable(b: Board, occupied: Uint8Array, from: number): Uint8Array {
  const seen = new Uint8Array(b.w * b.h);
  const stack: number[] = [from];
  seen[from] = 1;
  while (stack.length > 0) {
    const p = stack.pop() as number;
    for (let d = 0; d < 4; d++) {
      const q = p + DY[d] * b.w + DX[d];
      if (!isWall(b, q) && !occupied[q] && !seen[q]) {
        seen[q] = 1;
        stack.push(q);
      }
    }
  }
  return seen;
}

/** Lowest cell index of a reachable set (names the player's region). */
function lowestOf(seen: Uint8Array): number {
  for (let i = 0; i < seen.length; i++) if (seen[i]) return i;
  return -1;
}

/**
 * Frozen 2x2 block: four cells of wall/box forming a square that contains
 * a box off its goal. Such a box can never move again, so the state is dead.
 */
function inFrozenBlock(b: Board, occupied: Uint8Array, isGoal: Uint8Array, t: number): boolean {
  const corners = [t, t - 1, t - b.w, t - b.w - 1];
  for (const a of corners) {
    const cells = [a, a + 1, a + b.w, a + b.w + 1];
    let solid = true;
    for (const c of cells) {
      if (!isWall(b, c) && !occupied[c]) {
        solid = false;
        break;
      }
    }
    if (!solid) continue;
    for (const c of cells) {
      if (occupied[c] && !isGoal[c]) return true;
    }
  }
  return false;
}

/** Shortest walk from `from` to `to` around walls and boxes (lowercase moves). */
function walkTo(b: Board, occupied: Uint8Array, from: number, to: number): string {
  if (from === to) return '';
  const prev = new Int32Array(b.w * b.h).fill(-1);
  const how = new Int8Array(b.w * b.h).fill(-1);
  const queue: number[] = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (let d = 0; d < 4; d++) {
      const q = p + DY[d] * b.w + DX[d];
      if (isWall(b, q) || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = d;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: target unreachable');
  let out = '';
  for (let p = to; p !== from; p = prev[p]) out = LETTER[how[p]] + out;
  return out;
}

type PushSolution = { pushes: number; moves: string };

/**
 * Push-optimal solve of one board by breadth-first search over pushes.
 * States are (sorted box cells, player region). Expanding in push order
 * makes the first solved state found push-optimal. Dead states are
 * pruned by live cells and frozen 2x2 blocks. When `requireExit` is set,
 * a solved state also needs the player's region to reach `exitCell`, so
 * the player can walk on to the next room. Returns null on cap exhaustion
 * or when no solution exists within the budget.
 */
function solvePush(
  b: Board,
  maxStates: number,
  requireExit: boolean,
  exitCell: number,
): PushSolution | null {
  const size = b.w * b.h;
  const isGoal = new Uint8Array(size);
  for (const g of b.goals) isGoal[g] = 1;
  const live = liveCells(b);
  for (const box of b.boxes) if (!live[box]) return null;
  const solved = (boxes: number[]): boolean => boxes.every((x) => isGoal[x]);

  const boxesList: number[][] = [b.boxes.slice()];
  const playerList: number[] = [b.player];
  const parent: number[] = [-1];
  const pushFrom: number[] = [-1];
  const pushTo: number[] = [-1];
  const pushDir: number[] = [-1];
  const seenKeys = new Map<string, number>();

  const occupied0 = new Uint8Array(size);
  for (const x of b.boxes) occupied0[x] = 1;
  const startRegion = reachable(b, occupied0, b.player);
  seenKeys.set(`${b.boxes.join(',')}|${lowestOf(startRegion)}`, 0);

  let found = -1;
  if (solved(b.boxes) && (!requireExit || startRegion[exitCell])) found = 0;

  for (let head = 0; found < 0 && head < boxesList.length; head++) {
    const boxes = boxesList[head];
    const occupied = new Uint8Array(size);
    for (const x of boxes) occupied[x] = 1;
    const region = reachable(b, occupied, playerList[head]);
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const box = boxes[bi];
      for (let d = 0; d < 4; d++) {
        const step = DY[d] * b.w + DX[d];
        const dest = box + step;
        const behind = box - step;
        if (!region[behind]) continue;
        if (isWall(b, dest) || occupied[dest] || !live[dest]) continue;
        occupied[box] = 0;
        occupied[dest] = 1;
        const frozen = inFrozenBlock(b, occupied, isGoal, dest);
        let nextBoxes: number[] | null = null;
        let key = '';
        if (!frozen) {
          nextBoxes = boxes.slice();
          nextBoxes[bi] = dest;
          nextBoxes.sort((x, y) => x - y);
          const nextRegion = reachable(b, occupied, box);
          key = `${nextBoxes.join(',')}|${lowestOf(nextRegion)}`;
        }
        occupied[dest] = 0;
        occupied[box] = 1;
        if (frozen || nextBoxes === null || seenKeys.has(key)) continue;
        if (boxesList.length >= maxStates) return null;
        const stateId = boxesList.length;
        seenKeys.set(key, stateId);
        boxesList.push(nextBoxes);
        playerList.push(box); // after the push the player stands where the box was
        parent.push(head);
        pushFrom.push(box);
        pushTo.push(dest);
        pushDir.push(d);
        if (solved(nextBoxes)) {
          if (!requireExit) {
            found = stateId;
            break;
          }
          const after = new Uint8Array(size);
          for (const x of nextBoxes) after[x] = 1;
          if (reachable(b, after, box)[exitCell]) {
            found = stateId;
            break;
          }
        }
      }
    }
  }
  if (found < 0) return null;

  // Rebuild the move string: walk to each push square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = b.player;
  let boxes = b.boxes.slice();
  for (const s of path) {
    const fromBox = pushFrom[s];
    const d = pushDir[s];
    const step = DY[d] * b.w + DX[d];
    const occupied = new Uint8Array(size);
    for (const x of boxes) occupied[x] = 1;
    moves += walkTo(b, occupied, player, fromBox - step);
    moves += LETTER[d];
    player = fromBox;
    const next = boxesList[s];
    boxes = next.slice();
  }
  return { pushes: path.length, moves };
}

type Room = {
  boxes: number[];
  goals: number[];
  door: number; // the room cell adjacent to the hallway row (-1 if unknown)
};

/**
 * Split a level into rooms: cut the hallway row's dead cells (floor cells
 * of the player's row from which no goal is pull-reachable) out of the
 * floor; each remaining connected component holding boxes is a room.
 * Returns null when the level does not split cleanly.
 */
function roomsOf(b: Board): Room[] | null {
  const live = liveCells(b);
  const hallRow = Math.floor(b.player / b.w);
  const cut = new Uint8Array(b.w * b.h);
  for (let x = 0; x < b.w; x++) {
    const i = hallRow * b.w + x;
    if (!b.wall[i] && !live[i]) cut[i] = 1;
  }
  for (const box of b.boxes) if (cut[box]) return null;

  const label = new Int32Array(b.w * b.h).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < b.w * b.h; s++) {
    if (b.wall[s] || cut[s] || label[s] >= 0) continue;
    const comp: number[] = [s];
    label[s] = rooms.length;
    for (let i = 0; i < comp.length; i++) {
      for (let d = 0; d < 4; d++) {
        const q = comp[i] + DY[d] * b.w + DX[d];
        if (!isWall(b, q) && !cut[q] && label[q] < 0) {
          label[q] = rooms.length;
          comp.push(q);
        }
      }
    }
    // Door: the component cell touching the hallway row.
    let door = -1;
    for (const cell of comp) {
      const up = cell - b.w;
      const down = cell + b.w;
      if (Math.floor(up / b.w) === hallRow && !b.wall[up]) {
        door = cell;
        break;
      }
      if (Math.floor(down / b.w) === hallRow && !b.wall[down]) {
        door = cell;
        break;
      }
    }
    rooms.push({ boxes: [], goals: [], door });
  }
  for (const box of b.boxes) {
    if (label[box] < 0) return null;
    rooms[label[box]].boxes.push(box);
  }
  for (const g of b.goals) {
    if (label[g] < 0) return null;
    rooms[label[g]].goals.push(g);
  }
  for (const r of rooms) {
    if (r.boxes.length !== r.goals.length) return null;
    r.boxes.sort((x, y) => x - y);
    r.goals.sort((x, y) => x - y);
  }
  return rooms.filter((r) => r.boxes.length > 0);
}

/** Player cell after playing `moves` (case-insensitive) from `from`. */
function endOf(b: Board, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) {
    const d = LETTER.indexOf(ch);
    if (d >= 0) p += DY[d] * b.w + DX[d];
  }
  return p;
}

/** Replay `moves` on `text`; true only when every step is legal and all boxes end on goals. */
function replaySolves(text: string, moves: string): boolean {
  const b = parseLevel(text);
  const occupied = new Uint8Array(b.w * b.h);
  for (const x of b.boxes) occupied[x] = 1;
  const isGoal = new Uint8Array(b.w * b.h);
  for (const g of b.goals) isGoal[g] = 1;
  let player = b.player;
  for (const ch of moves.toLowerCase()) {
    const d = LETTER.indexOf(ch);
    if (d < 0) return false;
    const step = DY[d] * b.w + DX[d];
    const next = player + step;
    if (isWall(b, next)) return false;
    if (occupied[next]) {
      const beyond = next + step;
      if (isWall(b, beyond) || occupied[beyond]) return false;
      occupied[next] = 0;
      occupied[beyond] = 1;
    }
    player = next;
  }
  for (let i = 0; i < occupied.length; i++) if (occupied[i] && !isGoal[i]) return false;
  return true;
}

/** Solve one level following the rooms in the given index order. */
function solveInOrder(board: Board, rooms: Room[], order: number[]): string {
  const settled: number[][] = rooms.map((r) => r.boxes.slice());
  let player = board.player;
  let moves = '';
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    const room = rooms[i];
    // Other rooms' boxes stand as walls while this room is solved.
    const subWall = board.wall.slice();
    for (let j = 0; j < rooms.length; j++) {
      if (j === i) continue;
      for (const x of settled[j]) subWall[x] = 1;
    }
    const sub: Board = {
      w: board.w,
      h: board.h,
      wall: subWall,
      goals: room.goals.slice(),
      boxes: room.boxes.slice(),
      player,
    };
    const last = k === order.length - 1;
    let result: PushSolution | null = null;
    if (!last && room.door >= 0) {
      // Prefer a solution that lets the player walk out to the next room.
      result = solvePush(sub, 200_000, true, room.door);
    }
    if (result === null) result = solvePush(sub, 200_000, false, -1);
    if (result === null) result = solvePush(sub, 1_000_000, false, -1);
    if (result === null) break; // leave the valid prefix; instance scores 0
    moves += result.moves;
    player = endOf(board, player, result.moves);
    settled[i] = room.goals.slice(); // this room's boxes now rest on its goals
  }
  return moves;
}

/** Solve one level: room by room, stitching with hallway walks. */
function solveLevel(text: string): string {
  const board = parseLevel(text);
  const rooms = roomsOf(board);
  if (rooms === null) {
    // No clean split: fall back to a global push search.
    const whole = solvePush(board, 1_000_000, false, -1);
    return whole === null ? '' : whole.moves;
  }
  const scanOrder = rooms.map((_, i) => i);
  const first = solveInOrder(board, rooms, scanOrder);
  if (replaySolves(text, first)) return first;
  // Scan order did not leave a solved level (e.g. the player ended
  // trapped after an early room): retry visiting the rooms in reverse.
  if (rooms.length > 1) {
    const reversed = solveInOrder(board, rooms, scanOrder.slice().reverse());
    if (replaySolves(text, reversed)) return reversed;
  }
  return first;
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  let moves = '';
  try {
    moves = solveLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
  } catch {
    moves = '';
  }
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
