/**
 * Active-window scheduler: decides WHETHER the bot looks, never WHAT passes.
 *
 * ## Why this is a separate module with no imports from filters/
 *
 * The schedule is a COST control. It exists to stop spending Helius credits
 * during hours the logs show nothing worth seeing. It must never influence a
 * PASS/SKIP, because the outcome study compares what the filters rejected
 * against what those tokens went on to do - and if the schedule could also
 * change a verdict, "this token was skipped" would mean two different things
 * and the study could not be read at all. So this file imports nothing from
 * src/filters/ and returns only "look" or "don't look".
 *
 * ## UTC, always
 *
 * Windows are evaluated in UTC and nothing here reads a local timezone. A
 * local-time window silently shifts by an hour twice a year and nobody notices
 * until months of logs look strange - and the hour it shifts by is exactly the
 * boundary the window was tuned to.
 *
 * ## Crossing midnight
 *
 * `12:00`-`02:00` is fourteen hours, not minus ten. A window whose end is
 * numerically before its start wraps into the next day, and its early-morning
 * tail belongs to the day the window STARTED on: a mon-fri 12:00-02:00 window
 * is open at 01:00 on a Saturday, because that hour is the tail of Friday's
 * window, and is NOT open at 01:00 on a Monday. Getting that backwards is the
 * classic scheduler off-by-one and it is tested explicitly.
 */

export const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type DayName = (typeof DAY_NAMES)[number];

export const MINUTES_PER_DAY = 1440;

export interface ScheduleWindow {
  /** "mon-fri", "sat-sun", "all", "mon", or a list like "mon,wed,fri". */
  days: string;
  /** "HH:MM", 24-hour, UTC. */
  start: string;
  /** "HH:MM", 24-hour, UTC. May be numerically before `start` - that wraps past midnight. */
  end: string;
}

export interface ScheduleConfig {
  enabled: boolean;
  /** Only "UTC" is accepted. Present so a config claiming otherwise fails loudly instead of being ignored. */
  timezone: string;
  activeWindows: ScheduleWindow[];
  /** What to do outside every window. "idle" = detect nothing, spend nothing. */
  outsideWindow: "idle";
}

export const DEFAULT_SCHEDULE: ScheduleConfig = {
  // Off until an hourly histogram of real detections justifies a window.
  // Turning this on is a decision made against measured data, never a default
  // someone inherits - see scripts/hourly-histogram.ts.
  enabled: false,
  timezone: "UTC",
  activeWindows: [],
  outsideWindow: "idle",
};

/** Why the scheduler allowed or refused a cycle. Logged verbatim so the two are never confused. */
export type ScheduleReason =
  | "scheduler-disabled"
  | "inside-window"
  | "outside-window"
  | "no-windows-configured";

export interface ScheduleDecision {
  /** True when the bot should look. */
  active: boolean;
  reason: ScheduleReason;
  /** The window that matched, when one did. */
  window: ScheduleWindow | null;
  /** Human-readable, written into every skip record. */
  detail: string;
  /** UTC "HH:MM" the next window opens, when computable and currently closed. */
  nextOpenUtc: string | null;
}

// --- parsing -------------------------------------------------------------

/** Parses "HH:MM" into minutes past UTC midnight. Throws on anything else. */
export function parseHhMm(value: string, label: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) throw new Error(`schedule: ${label} must be "HH:MM" (24-hour, UTC), got ${JSON.stringify(value)}`);
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23) throw new Error(`schedule: ${label} hour must be 00-23, got ${hours}`);
  if (minutes > 59) throw new Error(`schedule: ${label} minute must be 00-59, got ${minutes}`);
  return hours * 60 + minutes;
}

/**
 * Expands a day spec into the set of weekday indices it covers.
 *
 * Ranges wrap: "fri-mon" is fri, sat, sun, mon. That is the same wrapping rule
 * the time windows use, applied to days, so the two behave consistently rather
 * than one wrapping and the other silently producing nothing.
 */
export function parseDays(spec: string): Set<number> {
  const text = spec.trim().toLowerCase();
  if (text === "all" || text === "daily" || text === "*") {
    return new Set(DAY_NAMES.map((_, i) => i));
  }

  const out = new Set<number>();
  for (const part of text.split(",")) {
    const piece = part.trim();
    if (piece === "") continue;

    const range = /^([a-z]{3})-([a-z]{3})$/.exec(piece);
    if (range) {
      const from = dayIndex(range[1]);
      const to = dayIndex(range[2]);
      // Inclusive, wrapping. fri-mon => fri, sat, sun, mon.
      let i = from;
      out.add(i);
      while (i !== to) {
        i = (i + 1) % 7;
        out.add(i);
      }
      continue;
    }
    out.add(dayIndex(piece));
  }

  if (out.size === 0) throw new Error(`schedule: days spec ${JSON.stringify(spec)} matched no days`);
  return out;
}

function dayIndex(name: string): number {
  const i = DAY_NAMES.indexOf(name as DayName);
  if (i === -1) {
    throw new Error(`schedule: unknown day ${JSON.stringify(name)} - use ${DAY_NAMES.join(", ")}, a range like "mon-fri", or "all"`);
  }
  return i;
}

/**
 * How long a window lasts, in minutes, wrapping past midnight when needed.
 *
 * This is the function that makes 12:00-02:00 fourteen hours rather than a
 * negative number, and it is the one to read if a window ever behaves oddly.
 */
export function windowDurationMinutes(window: ScheduleWindow): number {
  const start = parseHhMm(window.start, "start");
  const end = parseHhMm(window.end, "end");
  if (end > start) return end - start;
  // Wraps: run to midnight, then on to the end time.
  return MINUTES_PER_DAY - start + end;
}

/**
 * Validates a schedule and throws with a specific message on anything wrong.
 *
 * Fails closed on the one genuinely ambiguous case: start === end. That could
 * mean a zero-length window or a 24-hour one, and silently picking either would
 * eventually surprise someone by a factor of infinity. Say so instead.
 */
export function validateSchedule(schedule: ScheduleConfig): void {
  if (schedule.timezone.toUpperCase() !== "UTC") {
    throw new Error(
      `schedule.timezone must be "UTC" - got ${JSON.stringify(schedule.timezone)}. Local time silently ` +
        `shifts every window by an hour twice a year; convert your hours to UTC instead.`
    );
  }
  if (schedule.outsideWindow !== "idle") {
    throw new Error(`schedule.outsideWindow must be "idle" - got ${JSON.stringify(schedule.outsideWindow)}`);
  }
  for (const w of schedule.activeWindows) {
    const start = parseHhMm(w.start, "start");
    const end = parseHhMm(w.end, "end");
    parseDays(w.days);
    if (start === end) {
      throw new Error(
        `schedule: window ${w.days} ${w.start}-${w.end} has the same start and end. That is ambiguous ` +
          `(zero hours, or twenty-four?). Use "00:00"-"23:59" for a full day, or remove the window.`
      );
    }
  }
  if (schedule.enabled && schedule.activeWindows.length === 0) {
    throw new Error(
      `schedule.enabled is true but activeWindows is empty - that would idle the bot forever. ` +
        `Add a window, or set enabled: false.`
    );
  }
}

// --- evaluation ----------------------------------------------------------

/** Whether one window is open at a given UTC instant. */
export function isWindowOpenAt(window: ScheduleWindow, at: Date): boolean {
  const days = parseDays(window.days);
  const start = parseHhMm(window.start, "start");
  const end = parseHhMm(window.end, "end");

  const day = at.getUTCDay();
  const minutes = at.getUTCHours() * 60 + at.getUTCMinutes();

  if (end > start) {
    // Same-day window.
    return days.has(day) && minutes >= start && minutes < end;
  }

  // Wraps past midnight. Two disjoint pieces:
  //   - the evening piece, on a matching day, from start to midnight
  //   - the early-morning TAIL, which belongs to the PREVIOUS day's window, so
  //     the day that must match is yesterday, not today. This is the case that
  //     is wrong in most hand-written schedulers.
  const yesterday = (day + 6) % 7;
  if (days.has(day) && minutes >= start) return true;
  if (days.has(yesterday) && minutes < end) return true;
  return false;
}

/**
 * The scheduler's verdict for one instant.
 *
 * `at` is passed in rather than read from the clock so the whole thing is a
 * pure function of its inputs and every case below can be asserted exactly.
 */
export function evaluateSchedule(schedule: ScheduleConfig, at: Date): ScheduleDecision {
  if (!schedule.enabled) {
    return {
      active: true,
      reason: "scheduler-disabled",
      window: null,
      detail: "scheduler is off - the bot runs continuously, as it did before the scheduler existed",
      nextOpenUtc: null,
    };
  }

  if (schedule.activeWindows.length === 0) {
    // validateSchedule refuses this at load. Fail OPEN here rather than idling
    // forever on a config that somehow got past validation: a bot that quietly
    // stops looking is worse than one that spends credits it meant to save.
    return {
      active: true,
      reason: "no-windows-configured",
      window: null,
      detail: "scheduler is enabled but no activeWindows are configured - running anyway rather than idling forever",
      nextOpenUtc: null,
    };
  }

  for (const window of schedule.activeWindows) {
    if (isWindowOpenAt(window, at)) {
      return {
        active: true,
        reason: "inside-window",
        window,
        detail: `inside window ${window.days} ${window.start}-${window.end} UTC`,
        nextOpenUtc: null,
      };
    }
  }

  const nextOpenUtc = nextOpenTime(schedule, at);
  return {
    active: false,
    reason: "outside-window",
    window: null,
    detail:
      `outside every configured window (${schedule.activeWindows
        .map((w) => `${w.days} ${w.start}-${w.end}`)
        .join("; ")} UTC)` + (nextOpenUtc ? `; next opens ${nextOpenUtc} UTC` : ""),
    nextOpenUtc,
  };
}

/**
 * When the next window opens, as an ISO instant, searching forward minute by
 * minute for up to eight days.
 *
 * Eight rather than seven so a weekly-repeating schedule is always found even
 * when the search starts mid-window-day. Returns null if nothing opens in that
 * span, which means the schedule can never open - worth seeing in a log line.
 */
export function nextOpenTime(schedule: ScheduleConfig, at: Date): string | null {
  const cursor = new Date(at.getTime());
  cursor.setUTCSeconds(0, 0);
  for (let i = 0; i < MINUTES_PER_DAY * 8; i++) {
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
    if (schedule.activeWindows.some((w) => isWindowOpenAt(w, cursor))) {
      return cursor.toISOString().replace(".000Z", "Z");
    }
  }
  return null;
}

/** Total hours a schedule is open in a week - the figure the credit arithmetic needs. */
export function weeklyOpenHours(schedule: ScheduleConfig): number {
  let openMinutes = 0;
  const cursor = new Date(Date.UTC(2026, 0, 4, 0, 0, 0)); // a Sunday, so a full week starts here
  for (let i = 0; i < MINUTES_PER_DAY * 7; i++) {
    if (schedule.activeWindows.some((w) => isWindowOpenAt(w, cursor))) openMinutes++;
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return openMinutes / 60;
}
