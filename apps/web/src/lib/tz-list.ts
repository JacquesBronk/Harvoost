// Short list of common IANA timezones for v1 pickers. Per the dispatch:
// "timezone is an IANA picker — use a hardcoded short list of common ones;
// full picker is v1.0.1". Free-text fallback is offered alongside the
// dropdown so admins can paste a non-listed IANA name when needed.
//
// Order: regional grouping (Africa first since Harvoost is SA-headquartered),
// then Europe, Americas, Asia/Pacific. Each entry uses the canonical IANA
// identifier; the display label is just the IANA name (admins recognise
// these unambiguously).

export const COMMON_IANA_TIMEZONES: ReadonlyArray<{ value: string; label: string }> = [
  // Africa
  { value: 'Africa/Johannesburg', label: 'Africa/Johannesburg (SAST)' },
  { value: 'Africa/Cairo', label: 'Africa/Cairo' },
  { value: 'Africa/Lagos', label: 'Africa/Lagos' },
  { value: 'Africa/Nairobi', label: 'Africa/Nairobi' },
  // Europe
  { value: 'Europe/London', label: 'Europe/London' },
  { value: 'Europe/Lisbon', label: 'Europe/Lisbon' },
  { value: 'Europe/Paris', label: 'Europe/Paris' },
  { value: 'Europe/Berlin', label: 'Europe/Berlin' },
  { value: 'Europe/Madrid', label: 'Europe/Madrid' },
  { value: 'Europe/Amsterdam', label: 'Europe/Amsterdam' },
  // Americas
  { value: 'America/New_York', label: 'America/New_York' },
  { value: 'America/Chicago', label: 'America/Chicago' },
  { value: 'America/Denver', label: 'America/Denver' },
  { value: 'America/Los_Angeles', label: 'America/Los_Angeles' },
  { value: 'America/Sao_Paulo', label: 'America/Sao_Paulo' },
  // Asia/Pacific
  { value: 'Asia/Dubai', label: 'Asia/Dubai' },
  { value: 'Asia/Kolkata', label: 'Asia/Kolkata' },
  { value: 'Asia/Singapore', label: 'Asia/Singapore' },
  { value: 'Asia/Tokyo', label: 'Asia/Tokyo' },
  { value: 'Australia/Sydney', label: 'Australia/Sydney' },
  { value: 'Pacific/Auckland', label: 'Pacific/Auckland' },
  // UTC fallback
  { value: 'UTC', label: 'UTC' },
];

export function isKnownTimezone(tz: string): boolean {
  return COMMON_IANA_TIMEZONES.some((option) => option.value === tz);
}
