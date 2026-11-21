# Roomwise Push-Optimal Sokoban Solver

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/icandoitone/makefun-sokoban-solver-01-run-20261121-01/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/icandoitone/makefun-sokoban-solver-01-run-20261121-01/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A Sokoban solver built for the
[make.fun bounty "Build the best Sokoban solver, 21 November 2026"](https://make.fun/bounty/sokoban-solver-01-run-20261121).
It answers a set of 5 levels in one run, in as few pushes as possible.

## How it works

Every level in this competition is a one-square-wide hallway with one to
four rooms off it (3–4 boxes each, one door each). A box pushed out of a
room through its door can never come back, so each room is an independent
problem and the level's push-optimal count is the sum of its rooms' optima.
The solver exploits that structure:

1. **Split into rooms.** The hallway row's dead floor (squares from which
   no box can ever reach a goal) is cut out of the floor; each remaining
   connected part holding boxes is a room.
2. **Solve each room push-optimally with A\* over pushes.** A state is the
   sorted box squares plus the player's reachable region (named by its
   lowest square). The cost is pushes; the estimate is the cheapest
   assignment of boxes to goals under single-box push distances, which is
   admissible because one push moves one box one square. Dead states are
   pruned with live squares (a square from which no lone-box push ever
   reaches a goal) and frozen 2×2 blocks of walls and boxes. The other
   rooms' boxes stand as walls while a room is solved — a room already
   solved contributes its goals as walls, since its boxes now sit on them.
3. **Stitch the rooms together.** Between rooms the player walks the
   shortest path (BFS) out of the finished room, along the hallway, and
   into the next room; inside a room each push is preceded by the shortest
   walk to its pushing square.

The search budget is a count of states, never the wall clock, so two runs
write byte-identical outputs. If A\* gives up on a room, a greedy
best-first search tries to find any (non-optimal) solution for partial
points instead of none. The program uses only the Node standard library.

## Practice score

On the kit's practice set the solver reaches the push optimum on every
instance — 1,000 points each, **1,000,000 total**:

| instance | boxes | P\* | pushes | points |
|----------|-------|-----|--------|--------|
| i001 | 3 | 13 | 13 | 1,000 |
| i002 | 4 | 16 | 16 | 1,000 |
| i003 | 8 | 29 | 29 | 1,000 |
| i004 | 12 | 47 | 47 | 1,000 |
| i005 | 16 | 60 | 60 | 1,000 |

The whole set solves in about 0.3 seconds on this machine (limit: 60 s),
and two runs produce byte-identical `solution.txt` files. The house
baseline (plain-astar 1.0.0) scores far below this on the same practice
set — see the submission report for the exact figure.

## Run it

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` is TypeScript in erasable syntax only (Node 22 runs it as-is).
It reads `/input/<id>/level.txt` and writes `/output/<id>/solution.txt`
per instance.
