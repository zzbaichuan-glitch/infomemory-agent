import { describe, expect, it } from 'vitest';

import { extractMeetingReminder } from '../src/services/meeting-time-extractor.js';

const now = new Date('2026-08-19T02:00:00.000Z'); // 2026-08-19 10:00 in Asia/Shanghai

describe('extractMeetingReminder', () => {
  it('uses Asia/Shanghai by default independently of the process time zone', () => {
    const result = extractMeetingReminder('请注意，明天 14:30 开会讨论上线方案。', now);

    expect(result).toMatchObject({
      precision: 'exact',
      needsConfirmation: false,
      startsAt: new Date('2026-08-20T06:30:00.000Z'),
      remindAt: new Date('2026-08-20T06:00:00.000Z'),
    });
  });

  it('honors an explicit IANA time zone', () => {
    const result = extractMeetingReminder('明天 14:30 开会。', now, {
      timeZone: 'UTC',
    });

    expect(result?.startsAt.toISOString()).toBe('2026-08-20T14:30:00.000Z');
    expect(() => extractMeetingReminder('明天 14:30 开会。', now, {
      timeZone: 'not/a-time-zone',
    })).toThrow(/Invalid IANA time zone/u);
  });

  it('handles daylight-saving transitions for explicit IANA time zones', () => {
    const beforeSpringForward = new Date('2026-03-07T12:00:00.000Z');
    const valid = extractMeetingReminder('明天 09:00 开会。', beforeSpringForward, {
      timeZone: 'America/New_York',
    });
    const skipped = extractMeetingReminder('2026年3月8日 02:30 开会。', beforeSpringForward, {
      timeZone: 'America/New_York',
    });

    expect(valid?.startsAt.toISOString()).toBe('2026-03-08T13:00:00.000Z');
    expect(skipped).toBeNull();
  });

  it.each([
    '2026年2月31日 14点开会。',
    '2026年13月1日 14点开会。',
    '2026年4月31日 14点开会。',
  ])('rejects an invalid calendar date: %s', (text) => {
    expect(extractMeetingReminder(text, now)).toBeNull();
  });

  it.each([
    '2026年8月18日 14:30 开会。',
    '2026年8月19日 09:30 开会。',
    '今天 09:30 开会。',
  ])('rejects an explicitly dated time that is not in the future: %s', (text) => {
    expect(extractMeetingReminder(text, now)).toBeNull();
  });

  it('rolls an undated elapsed clock time to the next local day', () => {
    const result = extractMeetingReminder('09:30 开会。', now);

    expect(result).toMatchObject({
      precision: 'inferred',
      needsConfirmation: true,
      startsAt: new Date('2026-08-20T01:30:00.000Z'),
    });
  });

  it('handles tomorrow and the end of a month using the target calendar', () => {
    const monthEnd = new Date('2026-01-31T15:30:00.000Z'); // Jan 31 23:30 in Shanghai
    const result = extractMeetingReminder('明天 09:00 开会。', monthEnd);

    expect(result?.startsAt.toISOString()).toBe('2026-02-01T01:00:00.000Z');
  });

  it('handles the day after tomorrow across the end of a year', () => {
    const yearEnd = new Date('2026-12-31T15:30:00.000Z'); // Dec 31 23:30 in Shanghai
    const result = extractMeetingReminder('后天 09:00 开会。', yearEnd);

    expect(result?.startsAt.toISOString()).toBe('2027-01-02T01:00:00.000Z');
  });

  it('marks broad periods as needing confirmation', () => {
    const result = extractMeetingReminder('下午要开会，大家别忘了参加。', now);

    expect(result).toMatchObject({
      precision: 'period',
      needsConfirmation: true,
      startsAt: new Date('2026-08-19T07:00:00.000Z'),
    });
  });

  it('ignores ordinary messages without meeting time signals', () => {
    expect(extractMeetingReminder('今天请查收项目周报。', now)).toBeNull();
  });
});
