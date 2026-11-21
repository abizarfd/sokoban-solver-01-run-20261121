# Sokoban solver

Room-decomposed push-optimal Sokoban solver for make.fun
(`sokoban-solver-01-run-20261121`).

## How it works

A generated level is one hallway row plus 1–4 rooms, each opening onto
the hallway through a single door. A box pushed out of a room into the
hallway can never come back, so every box stays in its room and the
level optimum is the sum of the rooms' optima. The solver therefore:

1. Parses the XSB level.
2. Splits it into rooms by cutting the hallway row's dead cells (floor
   cells of the player's row from which no goal is pull-reachable) out
   of the floor; each remaining connected component holding boxes is a
   room, with its door being the cell touching the hallway row.
3. Solves each room independently with a push-only breadth-first
   search (fewest pushes first, so the first solution is push-optimal),
   pruning dead states with pull-reachability ("live cells") and frozen
   2×2 blocks. Non-final rooms prefer a solution that leaves the
   player's region able to reach the door, so the player can walk on.
4. Stitches the rooms together with plain walks through the hallway.
   The finished move string is replayed internally; if scan order
   fails to solve the level, the rooms are retried in reverse order.
   If a level does not split cleanly, a global push search is used.

Everything is deterministic: fixed direction order, budgets counted in
search states, no clock, no randomness.

## Local verification

Practice set: **1,000,000** (all 5 instances at exactly P*: 13, 16, 29,
47, 60 pushes), two runs byte-identical, ~1.4 s for the whole set.
15 geometric transforms of the practice levels (horizontal flip,
vertical flip, 180° rotation — all preserve P*) also solve at exactly
P* on every instance.

## Layout

- `main.ts` — the whole solver (Node 22, no dependencies).
- `LICENSE` — MIT.
