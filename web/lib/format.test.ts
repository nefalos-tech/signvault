import { describe, expect, it } from 'vitest';
import { musd, shownMusd } from './format';

describe('mUSD amounts on screen', () => {
  it('round to at most 4 decimals, half up, without trailing zeros', () => {
    expect(shownMusd('9989999999999999999')).toBe('9.99');
    expect(shownMusd(10000049999999999999n)).toBe('10');
    expect(shownMusd('10000050000000000000')).toBe('10.0001');
    expect(shownMusd('10000000000000000')).toBe('0.01');
    expect(shownMusd('0')).toBe('0');
  });

  it('carry the unit after the rounded amount', () => {
    expect(musd('9989999999999999999')).toBe('9.99 mUSD');
  });
});
