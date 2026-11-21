# sokoban-solver — a push-optimal Sokoban solver

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/zamrdzhu/sokoban-solver/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/zamrdzhu/sokoban-solver/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver in one file (`main.ts`, Node 22, no dependencies).
It answers a whole set of 5 levels in one run — about 0.7 s a set on this machine —
and scores **1,000,000 on the practice set** (every instance solved in exactly P*
pushes), against 200,000 for the house baseline plain-astar 1.0.0.

Entry for the make.fun contest **sokoban-solver-01-run-20261121** ("Build the best
Sokoban solver, 21 November 2026"): https://make.fun/bounty/sokoban-solver-01-run-20261121

## How it works

Generated levels are a 1-wide hallway with 1–4 rooms off it, and a box pushed out
of a room through its door can never come back — so every box stays in its room
and the rooms are independent problems joined only by the player's walk.

1. **Rooms.** The hallway row's dead squares (squares from which no push, ignoring
   the other boxes, can ever reach a goal) are cut out of the floor; each remaining
   component holding boxes is one room.
2. **Push-optimal search per room.** Breadth-first search over pushes, where a
   state is the boxes' squares plus the player's reachable region (named by its
   lowest square). The first solved state found is push-optimal for that room, and
   the rooms' optima add up to the level's P*. Two deadlocks are pruned — a box
   pushed onto a dead square, and a box pushed into a frozen 2×2 block of walls
   and boxes holding a box off its goal — and neither prunes a solvable state.
   States live in typed arrays (boxes packed into one base-size number), so a room
   costs a few dozen bytes a state.
3. **Fallbacks.** If a room's breadth-first search runs past its state cap, a
   best-first search with the same machinery tries for a merely good solution
   instead of none. If a level is no set of rooms at all, the same searches run
   over the whole level. A level that still has no answer gets an empty solution
   file — a valid answer worth no points — so the entry always answers every
   instance.

Every budget is a count of states, never the clock, and iteration orders are
fixed, so two executions on one set write byte-identical outputs.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Verify it with the kit's own grader (from the unpacked kit directory):

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repository> --driver process
```

The grader runs the entry twice and checks the two executions write the same bytes.

## Results

| Set | Score | Notes |
| --- | --- | --- |
| Practice (kit) | 1,000,000 | all 5 instances at exactly P* pushes |
| 10 generated sets (kit generator, fresh seeds) | 1,000,000 each | all 50 instances at exactly P* pushes |
| House baseline plain-astar 1.0.0, practice | 200,000 | solves only i001 |

## License

MIT — see [LICENSE](LICENSE).
