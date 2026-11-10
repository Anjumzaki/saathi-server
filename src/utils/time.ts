export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const addMs = (d: Date, ms: number): Date => new Date(d.getTime() + ms);

/** "HH:MM" -> minutes since midnight, or null when malformed. */
export function parseHHMM(t: string | undefined | null): number | null {
  if (!t) return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(t);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function formatHHMM(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export const utcDayKey = (d: Date): string => d.toISOString().slice(0, 10);
