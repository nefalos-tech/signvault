import type { RunEvent } from '@signvault/shared';

/** How long a run lasts, from its first event to its last, in ms. */
function runLength(run: RunEvent[]) {
  return run.length === 0 ? 0 : run[run.length - 1].ts - run[0].ts;
}

export function replayLength(runs: RunEvent[][]) {
  return Math.max(0, ...runs.map(runLength));
}

/**
 * The events a replay shows `elapsedMs` after it starts. Every run starts at 0, each timed from
 * its own first event, so recorded runs play side by side even when they were recorded apart.
 */
export function visibleEvents(runs: RunEvent[][], elapsedMs: number): RunEvent[] {
  return runs
    .flatMap((run) => run.map((e) => ({ e, at: e.ts - run[0].ts })))
    .filter(({ at }) => at <= elapsedMs)
    .sort((a, b) => a.at - b.at)
    .map(({ e }) => e);
}
