export type MeetingReminderPrecision = 'exact' | 'period' | 'inferred';

export interface MeetingReminderCandidate {
  title: string;
  startsAt: Date;
  remindAt: Date;
  precision: MeetingReminderPrecision;
  needsConfirmation: boolean;
  matchedText: string;
}

export interface MeetingReminderExtractionOptions {
  timeZone?: string;
}

export const DEFAULT_MEETING_TIME_ZONE = 'Asia/Shanghai';

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

interface ClockTime {
  hour: number;
  minute: number;
  hasExplicitHour: boolean;
}

interface ZonedDateTimeParts extends CalendarDate {
  hour: number;
  minute: number;
  second: number;
}

const MEETING_PATTERN = /(?:开会|会议|例会|评审|评审会|讨论会|碰头会|同步会|站会|meeting|meet)/iu;
const DATE_PATTERN = /(?:(今天|明天|后天)|((20\d{2})[-年](\d{1,2})[-月](\d{1,2})日?)|(下?周)([一二三四五六日天1-7]))/u;
const CLOCK_PATTERN = /(?:(上午|早上|下午|晚上|今晚|中午)\s*)?(\d{1,2})(?:(?:[:：](\d{1,2}))|(?:[点时](\d{1,2})?分?))/u;
const PERIOD_PATTERN = /(上午|早上|下午|晚上|今晚|中午)/u;

const PERIOD_DEFAULTS: Record<string, number> = {
  上午: 9,
  早上: 9,
  下午: 15,
  晚上: 19,
  今晚: 19,
  中午: 12,
};

const ONE_DAY_MS = 24 * 60 * 60 * 1_000;
const OFFSET_PROBE_DAYS = [-2, -1, 0, 1, 2];

export function extractMeetingReminder(
  text: string,
  now = new Date(),
  options: MeetingReminderExtractionOptions = {},
): MeetingReminderCandidate | null {
  if (!Number.isFinite(now.getTime())) throw new RangeError('now must be a valid Date');
  const timeZone = options.timeZone?.trim() || DEFAULT_MEETING_TIME_ZONE;
  const formatter = createZonedFormatter(timeZone);
  const meeting = text.match(MEETING_PATTERN);
  if (!meeting || meeting.index === undefined) return null;

  const dateMatch = text.match(DATE_PATTERN);
  const timeMatch = text.match(CLOCK_PATTERN);
  const periodMatch = text.match(PERIOD_PATTERN);
  if (!dateMatch && !timeMatch && !periodMatch) return null;

  const nowParts = getZonedParts(now, formatter);
  let date = resolveDate(dateMatch, nowParts);
  const time = resolveTime(timeMatch, periodMatch);
  if (!date || !time) return null;

  let startsAt = zonedDateTimeToDate(date, time, formatter);
  if (!startsAt) return null;

  if (startsAt.getTime() <= now.getTime()) {
    if (dateMatch) return null;
    date = addCalendarDays(date, 1);
    startsAt = zonedDateTimeToDate(date, time, formatter);
    if (!startsAt || startsAt.getTime() <= now.getTime()) return null;
  }

  const precision: MeetingReminderPrecision = dateMatch && time.hasExplicitHour
    ? 'exact'
    : periodMatch ? 'period' : 'inferred';
  const needsConfirmation = precision !== 'exact';
  const remindAt = new Date(startsAt.getTime() - (needsConfirmation ? 60 : 30) * 60_000);
  const contextStart = Math.max(
    0,
    (dateMatch?.index ?? periodMatch?.index ?? timeMatch?.index ?? meeting.index) - 32,
  );
  const contextEnd = Math.min(text.length, contextStart + 140);

  return {
    title: buildTitle(text, meeting.index),
    startsAt,
    remindAt,
    precision,
    needsConfirmation,
    matchedText: text.slice(contextStart, contextEnd).replace(/\s+/g, ' ').trim(),
  };
}

function resolveDate(
  match: RegExpMatchArray | null,
  today: CalendarDate,
): CalendarDate | null {
  if (!match) return today;
  const relative = match[1];
  if (relative) {
    const delta = relative === '明天' ? 1 : relative === '后天' ? 2 : 0;
    return addCalendarDays(today, delta);
  }
  if (match[2] && match[3] && match[4] && match[5]) {
    const date = {
      year: Number(match[3]),
      month: Number(match[4]),
      day: Number(match[5]),
    };
    return isValidCalendarDate(date) ? date : null;
  }
  const weekPrefix = match[6];
  const dayValue = match[7];
  if (!weekPrefix || !dayValue) return null;
  const target = chineseWeekday(dayValue);
  if (target === null) return null;
  const current = calendarWeekday(today);
  let delta = (target - current + 7) % 7;
  if (weekPrefix === '下周' || delta === 0) delta += 7;
  return addCalendarDays(today, delta);
}

function resolveTime(
  clock: RegExpMatchArray | null,
  period: RegExpMatchArray | null,
): ClockTime | null {
  if (!clock && !period) return null;
  const periodName = clock?.[1] ?? period?.[1];
  const rawHour = clock?.[2];
  const rawMinute = clock?.[3] ?? clock?.[4];
  const hour = rawHour ? Number(rawHour) : periodName ? PERIOD_DEFAULTS[periodName] : null;
  if (hour === null || hour === undefined || hour < 0 || hour > 23) return null;
  let normalizedHour = hour;
  if (periodName && ['下午', '晚上', '今晚'].includes(periodName) && hour < 12 && rawHour) {
    normalizedHour += 12;
  }
  if (periodName === '中午' && hour < 11 && rawHour) normalizedHour += 12;
  const minute = rawMinute ? Number(rawMinute) : 0;
  if (minute < 0 || minute > 59) return null;
  return { hour: normalizedHour, minute, hasExplicitHour: Boolean(rawHour) };
}

function createZonedFormatter(timeZone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat('en-CA-u-ca-iso8601-nu-latn', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    throw new RangeError(`Invalid IANA time zone: ${timeZone}`);
  }
}

function getZonedParts(date: Date, formatter: Intl.DateTimeFormat): ZonedDateTimeParts {
  const values = new Map(
    formatter.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
  const year = values.get('year');
  const month = values.get('month');
  const day = values.get('day');
  const hour = values.get('hour');
  const minute = values.get('minute');
  const second = values.get('second');
  if ([year, month, day, hour, minute, second].some((value) => value === undefined)) {
    throw new RangeError('The selected time zone could not be formatted');
  }
  return {
    year: year ?? 0,
    month: month ?? 0,
    day: day ?? 0,
    hour: hour ?? 0,
    minute: minute ?? 0,
    second: second ?? 0,
  };
}

function zonedDateTimeToDate(
  date: CalendarDate,
  time: ClockTime,
  formatter: Intl.DateTimeFormat,
): Date | null {
  if (!isValidCalendarDate(date)) return null;
  const localEpoch = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute, 0, 0);
  const offsets = new Set<number>();
  for (const days of OFFSET_PROBE_DAYS) {
    const probe = localEpoch + days * ONE_DAY_MS;
    offsets.add(partsAsUtcEpoch(getZonedParts(new Date(probe), formatter)) - probe);
  }

  const candidates = Array.from(offsets, (offset) => new Date(localEpoch - offset))
    .filter((candidate) => sameWallTime(getZonedParts(candidate, formatter), date, time))
    .sort((left, right) => left.getTime() - right.getTime());
  return candidates[0] ?? null;
}

function partsAsUtcEpoch(parts: ZonedDateTimeParts): number {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    0,
  );
}

function sameWallTime(
  parts: ZonedDateTimeParts,
  date: CalendarDate,
  time: ClockTime,
): boolean {
  return parts.year === date.year
    && parts.month === date.month
    && parts.day === date.day
    && parts.hour === time.hour
    && parts.minute === time.minute
    && parts.second === 0;
}

function isValidCalendarDate(date: CalendarDate): boolean {
  if (!Number.isInteger(date.year) || !Number.isInteger(date.month) || !Number.isInteger(date.day)) {
    return false;
  }
  if (date.month < 1 || date.month > 12 || date.day < 1 || date.day > 31) return false;
  const candidate = new Date(Date.UTC(date.year, date.month - 1, date.day));
  return candidate.getUTCFullYear() === date.year
    && candidate.getUTCMonth() === date.month - 1
    && candidate.getUTCDate() === date.day;
}

function addCalendarDays(date: CalendarDate, days: number): CalendarDate {
  const candidate = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: candidate.getUTCFullYear(),
    month: candidate.getUTCMonth() + 1,
    day: candidate.getUTCDate(),
  };
}

function calendarWeekday(date: CalendarDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

function chineseWeekday(value: string): number | null {
  const map: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
  if (/^[1-7]$/.test(value)) return Number(value) % 7;
  return map[value] ?? null;
}

function buildTitle(text: string, meetingIndex: number): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  const compactMeetingIndex = compact.search(MEETING_PATTERN);
  const anchor = compactMeetingIndex >= 0 ? compactMeetingIndex : meetingIndex;
  let start = Math.max(0, anchor - 28);
  const openRedaction = compact.lastIndexOf('[', start);
  const closedRedaction = compact.lastIndexOf(']', start);
  if (openRedaction > closedRedaction) start = openRedaction;
  const prefix = compact.slice(
    start,
    Math.min(compact.length, anchor + 52),
  );
  return prefix || '飞书会议提醒';
}
