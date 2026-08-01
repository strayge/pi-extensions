/**
 * Compact durations for a countdown that shares a row with everything else.
 *
 * The smaller unit is dropped once the larger one makes it noise: minutes stop
 * mattering six hours out, hours stop mattering two days out. At most two units
 * are ever shown.
 */

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 1_440;
/** Above this, minutes are noise next to the hours. */
const DROP_MINUTES_ABOVE = 6 * MINUTES_PER_HOUR;
/** Above this, hours are noise next to the days. */
const DROP_HOURS_ABOVE = 2 * MINUTES_PER_DAY;

export function formatDuration(minutes: number, spaced: boolean): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "";
  if (minutes < 1) return "<1m";

  const gap = spaced ? " " : "";
  const total = Math.round(minutes);
  if (total < MINUTES_PER_HOUR) return `${total}m`;

  const hours = Math.floor(total / MINUTES_PER_HOUR);
  const restMinutes = total % MINUTES_PER_HOUR;
  if (total < DROP_MINUTES_ABOVE) {
    return restMinutes ? `${hours}h${gap}${restMinutes}m` : `${hours}h`;
  }
  if (total < MINUTES_PER_DAY) return `${hours}h`;

  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  if (total < DROP_HOURS_ABOVE) return restHours ? `${days}d${gap}${restHours}h` : `${days}d`;
  return `${days}d`;
}
