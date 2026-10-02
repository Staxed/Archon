import { describe, it, expect } from 'bun:test';
import { formatUsd } from './format-usd';

describe('formatUsd', () => {
  it('shows cents for a cent or more', () => {
    expect(formatUsd(2.5)).toBe('2.50');
    expect(formatUsd(0.01)).toBe('0.01');
    expect(formatUsd(12)).toBe('12.00');
  });

  it('keeps sub-cent amounts visible instead of rounding to 0.00', () => {
    expect(formatUsd(0.001)).toBe('0.001');
    expect(formatUsd(0.0067)).toBe('0.0067');
    expect(formatUsd(0.004567)).toBe('0.0046');
  });

  it('shows zero as 0.00', () => {
    expect(formatUsd(0)).toBe('0.00');
  });
});
