import { describe, expect, it } from 'vitest';
import type { RunEvent } from '@signvault/shared';
import scripted from './scripted-runs.json';
import { replayLength, visibleEvents } from './player';

// The scripted runs, not web/fixtures/, which card D3 refreshes from live runs.
const baseline = scripted.baseline as RunEvent[];
const signvault = scripted.signvault as RunEvent[];
const runs = [baseline, signvault];

describe('visibleEvents', () => {
  it('starts both runs at once, each from its own first event', () => {
    const shown = visibleEvents(runs, 0);
    expect(shown.map((e) => e.kind)).toEqual(['run_started', 'run_started']);
    expect(new Set(shown.map((e) => e.wallet))).toEqual(new Set(['baseline', 'signvault']));
  });

  it('shows the refusals once their time has come, and not before', () => {
    const refusedBefore = visibleEvents(runs, 16_499).filter((e) => e.kind === 'tx_refused');
    const refusedAt = visibleEvents(runs, 16_500).filter((e) => e.kind === 'tx_refused');
    expect(refusedBefore).toEqual([]);
    expect(refusedAt.map((e) => e.error).sort()).toEqual(['DailyCapExceeded', 'NotOnTheList']);
  });

  it('shows every event in recorded order once the replay is over', () => {
    const shown = visibleEvents(runs, replayLength(runs));
    expect(shown.filter((e) => e.wallet === 'baseline')).toEqual(baseline);
    expect(shown.filter((e) => e.wallet === 'signvault')).toEqual(signvault);
  });

  it('shows nothing before the replay starts', () => {
    expect(visibleEvents(runs, -1)).toEqual([]);
  });
});

describe('replayLength', () => {
  it('is the length of the longest run', () => {
    expect(replayLength(runs)).toBe(46_500);
  });
});
