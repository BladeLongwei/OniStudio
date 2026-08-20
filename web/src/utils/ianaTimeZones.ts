const FALLBACK_TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix',
  'America/Toronto',
  'America/Vancouver',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Kolkata',
  'Australia/Sydney',
  'Pacific/Auckland',
];

function listTimeZones(): string[] {
  try {
    const supported = (
      Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
    ).supportedValuesOf?.('timeZone');
    if (supported && supported.length > 0) return supported;
  } catch {
    /* fall through */
  }
  return FALLBACK_TIMEZONES;
}

const TIMEZONE_OPTIONS = listTimeZones();

/** IANA zones for selects, ensuring any current value remains selectable. */
export function ianaTimeZoneSelectOptions(current: string): string[] {
  const trimmed = current.trim();
  if (trimmed && !TIMEZONE_OPTIONS.includes(trimmed)) {
    return [trimmed, ...TIMEZONE_OPTIONS];
  }
  return TIMEZONE_OPTIONS;
}

/**
 * Filter IANA zones by typed query. Matches full id, underscored city, or
 * spaced city (e.g. "new york" → America/New_York).
 */
export function filterIanaTimeZones(query: string, options: string[]): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  const qCompact = q.replace(/\s+/g, '_');

  const scored: { tz: string; score: number }[] = [];
  for (const tz of options) {
    const lower = tz.toLowerCase();
    const spaced = lower.replace(/_/g, ' ');
    const city = lower.split('/').pop() || '';
    const citySpaced = city.replace(/_/g, ' ');

    let score = -1;
    if (lower === qCompact || spaced === q || city === qCompact || citySpaced === q) {
      score = 0;
    } else if (
      lower.startsWith(qCompact) ||
      spaced.startsWith(q) ||
      city.startsWith(qCompact) ||
      citySpaced.startsWith(q)
    ) {
      score = 1;
    } else if (
      lower.includes(qCompact) ||
      spaced.includes(q) ||
      city.includes(qCompact) ||
      citySpaced.includes(q)
    ) {
      score = 2;
    }
    if (score >= 0) scored.push({ tz, score });
  }

  scored.sort((a, b) => a.score - b.score || a.tz.localeCompare(b.tz));
  return scored.map((x) => x.tz);
}
