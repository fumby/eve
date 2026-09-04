// Local wall-clock formatting. Reminders are stored as local ISO minutes
// ("2026-08-15T09:00") because that is how Umberto says them; comparing them
// against Date#toISOString (always UTC) made them fire late by the offset —
// two hours in Italian summer, and a different amount on a UTC server. Wall
// clock is whatever TZ the process runs under (TZ=Europe/Rome on a VPS).
const pad = (n: number): string => String(n).padStart(2, "0");

/** "YYYY-MM-DD" in local time. */
export function localDate(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "YYYY-MM-DDTHH:MM" in local time — the same shape reminders are stored in. */
export function localMinute(d = new Date()): string {
  return `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
