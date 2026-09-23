import {
  countAnalyticsBuckets,
  getAdminAnalyticsQuerySchema,
  resolveAnalyticsQueryDefaults,
  toAnalyticsRange,
} from './get-admin-analytics-query.dto';

describe('admin analytics query', () => {
  const now = new Date('2026-09-24T15:30:00Z');

  it.each([
    ['hour', '2026-09-24'],
    ['day', '2026-09-01'],
    ['month', '2026-01-01'],
    ['year', '2022-01-01'],
  ] as const)('defaults %s to a window ending today', (interval, from) => {
    expect(resolveAnalyticsQueryDefaults({ interval }, now)).toEqual({
      interval,
      from,
      to: '2026-09-24',
    });
  });

  it('keeps explicit bounds', () => {
    expect(
      resolveAnalyticsQueryDefaults(
        { interval: 'month', from: '2025-03-01', to: '2025-06-30' },
        now,
      ),
    ).toEqual({ interval: 'month', from: '2025-03-01', to: '2025-06-30' });
  });

  it('counts buckets inclusively', () => {
    expect(countAnalyticsBuckets('hour', '2026-09-01', '2026-09-01')).toBe(24);
    expect(countAnalyticsBuckets('day', '2026-09-01', '2026-09-30')).toBe(30);
    expect(countAnalyticsBuckets('month', '2025-11-15', '2026-02-01')).toBe(4);
    expect(countAnalyticsBuckets('year', '2022-06-01', '2026-01-01')).toBe(5);
  });

  it('includes the whole last day in the half-open range', () => {
    expect(
      toAnalyticsRange({
        interval: 'day',
        from: '2026-09-01',
        to: '2026-09-30',
      }),
    ).toEqual({
      interval: 'day',
      from: new Date('2026-09-01T00:00:00Z'),
      toExclusive: new Date('2026-10-01T00:00:00Z'),
    });
  });

  it('rejects inverted ranges, over-wide ranges, and unknown keys', () => {
    expect(
      getAdminAnalyticsQuerySchema.safeParse({
        from: '2026-09-10',
        to: '2026-09-01',
      }).success,
    ).toBe(false);
    expect(
      getAdminAnalyticsQuerySchema.safeParse({
        interval: 'hour',
        from: '2020-01-01',
        to: '2026-01-01',
      }).success,
    ).toBe(false);
    expect(
      getAdminAnalyticsQuerySchema.safeParse({ interval: 'day', extra: '1' })
        .success,
    ).toBe(false);
    // 41 days x 24 = 984 hourly buckets is still inside the cap.
    expect(
      getAdminAnalyticsQuerySchema.safeParse({
        interval: 'hour',
        from: '2026-08-01',
        to: '2026-09-10',
      }).success,
    ).toBe(true);
  });

  it('rejects malformed dates and intervals', () => {
    expect(
      getAdminAnalyticsQuerySchema.safeParse({ from: '2026-13-01' }).success,
    ).toBe(false);
    expect(
      getAdminAnalyticsQuerySchema.safeParse({ interval: 'week' }).success,
    ).toBe(false);
  });
});
