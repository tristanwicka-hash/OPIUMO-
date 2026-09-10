/**
 * Active-window scheduler tests. Offline, pure, no clock and no network -
 * every instant is constructed explicitly so a boundary can be asserted to the
 * minute rather than approximately.
 *
 * The load-bearing sections are:
 *   - MIDNIGHT CROSSING: 12:00-02:00 is fourteen hours, and its early-morning
 *     tail belongs to the day the window STARTED on
 *   - INDEPENDENCE: the scheduler decides whether to look, never what passes
 */
import {
  ScheduleConfig,
  ScheduleWindow,
  DEFAULT_SCHEDULE,
  evaluateSchedule,
  isWindowOpenAt,
  windowDurationMinutes,
  validateSchedule,
  parseDays,
  parseHhMm,
  weeklyOpenHours,
  nextOpenTime,
} from "../src/schedule/scheduler";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  PASS: ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? " -- " + detail : ""}`);
    console.log(`  FAIL: ${name}${detail ? " -- " + detail : ""}`);
  }
}
function section(t: string): void {
  console.log(`\n=== ${t} ===\n`);
}
function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

/** A UTC instant. 2026-09-07 is a Monday, so day offsets below are readable. */
const utc = (day: number, hh: number, mm = 0) => new Date(Date.UTC(2026, 8, day, hh, mm, 0));
const MON = 7, TUE = 8, WED = 9, THU = 10, FRI = 11, SAT = 12, SUN = 13;

const sched = (windows: ScheduleWindow[], enabled = true): ScheduleConfig => ({
  ...DEFAULT_SCHEDULE,
  enabled,
  activeWindows: windows,
});

section("day-of-week is what it says it is (guards every test below)");

check("2026-09-07 is a Monday", utc(MON, 0).getUTCDay() === 1);
check("2026-09-12 is a Saturday", utc(SAT, 0).getUTCDay() === 6);
check("2026-09-13 is a Sunday", utc(SUN, 0).getUTCDay() === 0);

section("parsing");

check("parses 00:00", parseHhMm("00:00", "t") === 0);
check("parses 13:45", parseHhMm("13:45", "t") === 13 * 60 + 45);
check("parses 23:59", parseHhMm("23:59", "t") === 1439);
check("rejects 24:00", throws(() => parseHhMm("24:00", "t")));
check("rejects 12:60", throws(() => parseHhMm("12:60", "t")));
check("rejects '9:00' - two digits required", throws(() => parseHhMm("9:00", "t")));
check("rejects nonsense", throws(() => parseHhMm("noon", "t")));

check("mon-fri is five days", parseDays("mon-fri").size === 5);
check("sat-sun is two days", parseDays("sat-sun").size === 2);
check("all is seven days", parseDays("all").size === 7);
check("a list works", parseDays("mon,wed,fri").size === 3);
check(
  "a wrapping day range works: fri-mon is four days",
  parseDays("fri-mon").size === 4,
  `got ${parseDays("fri-mon").size}`
);
check("rejects an unknown day", throws(() => parseDays("moonday")));

section("MIDNIGHT CROSSING: 12:00-02:00 is FOURTEEN hours, not minus ten");

const crossing: ScheduleWindow = { days: "mon-fri", start: "12:00", end: "02:00" };
check(
  "duration is 840 minutes = 14 hours",
  windowDurationMinutes(crossing) === 840,
  `got ${windowDurationMinutes(crossing)}`
);
check("a same-day window is still simple: 13:00-16:00 is 3h",
  windowDurationMinutes({ days: "all", start: "13:00", end: "16:00" }) === 180);
check("a window ending at midnight: 14:00-00:00 is 10h",
  windowDurationMinutes({ days: "all", start: "14:00", end: "00:00" }) === 600,
  `got ${windowDurationMinutes({ days: "all", start: "14:00", end: "00:00" })}`);

check("open at 12:00 Monday (the boundary is inclusive)", isWindowOpenAt(crossing, utc(MON, 12, 0)));
check("open at 18:00 Monday", isWindowOpenAt(crossing, utc(MON, 18)));
check("open at 23:59 Monday", isWindowOpenAt(crossing, utc(MON, 23, 59)));
check("open at 00:00 Tuesday - the wrap actually happens", isWindowOpenAt(crossing, utc(TUE, 0, 0)));
check("open at 01:59 Tuesday", isWindowOpenAt(crossing, utc(TUE, 1, 59)));
check("CLOSED at 02:00 Tuesday (the end boundary is exclusive)", !isWindowOpenAt(crossing, utc(TUE, 2, 0)));
check("closed at 06:00 Tuesday", !isWindowOpenAt(crossing, utc(TUE, 6)));
check("closed at 11:59 Tuesday", !isWindowOpenAt(crossing, utc(TUE, 11, 59)));

section("THE TAIL BELONGS TO THE DAY THE WINDOW STARTED ON");

// This is the case most hand-written schedulers get wrong: a mon-fri window
// crossing midnight is open in the small hours of SATURDAY (Friday's tail) and
// closed in the small hours of MONDAY (Sunday has no window to spill from).
check("open at 01:00 Saturday - this is Friday's tail", isWindowOpenAt(crossing, utc(SAT, 1)));
check("CLOSED at 12:00 Saturday - Saturday itself is not a mon-fri day", !isWindowOpenAt(crossing, utc(SAT, 12)));
check(
  "CLOSED at 01:00 Monday - Sunday is not in mon-fri, so nothing spills into Monday morning",
  !isWindowOpenAt(crossing, utc(MON, 1)),
  "if this fails, the tail is being attributed to today instead of yesterday"
);
check("open at 01:00 Friday - Thursday's tail", isWindowOpenAt(crossing, utc(FRI, 1)));
check("closed at 01:00 Sunday - Saturday is not in mon-fri", !isWindowOpenAt(crossing, utc(SUN, 1)));

section("a weekend window, crossing midnight, from the research doc");

const weekend: ScheduleWindow = { days: "sat-sun", start: "14:00", end: "00:00" };
check("open 14:00 Saturday", isWindowOpenAt(weekend, utc(SAT, 14)));
check("open 23:59 Saturday", isWindowOpenAt(weekend, utc(SAT, 23, 59)));
check("closed 00:00 Sunday - end is exclusive and 00:00 is this window's end", !isWindowOpenAt(weekend, utc(SUN, 0)));
check("open 14:00 Sunday", isWindowOpenAt(weekend, utc(SUN, 14)));
check("closed 13:59 Sunday", !isWindowOpenAt(weekend, utc(SUN, 13, 59)));
check("closed on a Wednesday", !isWindowOpenAt(weekend, utc(WED, 20)));

section("weekly hours - the number the credit arithmetic uses");

check(
  "mon-fri 12:00-02:00 is 5 x 14 = 70 hours a week",
  weeklyOpenHours(sched([crossing])) === 70,
  `got ${weeklyOpenHours(sched([crossing]))}`
);
check(
  "the research doc's 12:00-02:00 daily = 14h/day = 98h/week",
  weeklyOpenHours(sched([{ days: "all", start: "12:00", end: "02:00" }])) === 98,
  `got ${weeklyOpenHours(sched([{ days: "all", start: "12:00", end: "02:00" }]))}`
);
check(
  "13:00-22:00 daily is 9h/day = 63h/week",
  weeklyOpenHours(sched([{ days: "all", start: "13:00", end: "22:00" }])) === 63
);
check(
  "two windows that do not overlap add up",
  weeklyOpenHours(sched([crossing, weekend])) === 70 + 20,
  `got ${weeklyOpenHours(sched([crossing, weekend]))}`
);
check(
  "overlapping windows are counted once, not twice",
  weeklyOpenHours(sched([
    { days: "all", start: "10:00", end: "14:00" },
    { days: "all", start: "12:00", end: "16:00" },
  ])) === 6 * 7,
  "10:00-16:00 is 6h/day"
);

section("DEFAULT IS OFF, and off means unchanged behaviour");

check("the shipped default is disabled", DEFAULT_SCHEDULE.enabled === false);
check("the shipped default is UTC", DEFAULT_SCHEDULE.timezone === "UTC");
check("the shipped default configures no windows", DEFAULT_SCHEDULE.activeWindows.length === 0);

const off = evaluateSchedule(sched([crossing], false), utc(SUN, 5));
check("disabled means active, at an hour every window is closed", off.active === true);
check("and the reason says so explicitly", off.reason === "scheduler-disabled");
check(
  "the reason distinguishes 'off' from 'outside a window'",
  off.reason !== "outside-window"
);

section("the skip reason is never ambiguous - 'quiet night' vs 'scheduler off'");

const closed = evaluateSchedule(sched([crossing]), utc(SUN, 5));
check("closed outside every window", closed.active === false);
check("reason is outside-window", closed.reason === "outside-window");
check("detail names the configured windows", closed.detail.includes("12:00-02:00"));
check("and reports when it next opens", closed.nextOpenUtc !== null);
check(
  "next open from 05:00 Sunday is 12:00 Monday",
  closed.nextOpenUtc === "2026-09-14T12:00:00Z",
  `got ${closed.nextOpenUtc}`
);

const open = evaluateSchedule(sched([crossing]), utc(WED, 15));
check("inside a window is active", open.active === true);
check("reason is inside-window", open.reason === "inside-window");
check("the matched window is reported, not just a boolean", open.window?.start === "12:00");
check(
  "an open verdict carries no nextOpenUtc - it is already open",
  open.nextOpenUtc === null
);
check(
  "the four reasons are all distinct strings",
  new Set(["scheduler-disabled", "inside-window", "outside-window", "no-windows-configured"]).size === 4
);

section("nextOpenTime");

check(
  "from inside a window, the next open minute is the very next minute",
  nextOpenTime(sched([crossing]), utc(WED, 15)) === "2026-09-09T15:01:00Z",
  `got ${nextOpenTime(sched([crossing]), utc(WED, 15))}`
);
check(
  "a schedule that can never open returns null rather than a wrong time",
  nextOpenTime(sched([]), utc(WED, 15)) === null
);

section("validation fails closed and says exactly what is wrong");

check("a valid schedule passes", !throws(() => validateSchedule(sched([crossing]))));
check(
  "start === end is REFUSED as ambiguous (zero hours, or twenty-four?)",
  throws(() => validateSchedule(sched([{ days: "all", start: "12:00", end: "12:00" }])))
);
check(
  "a non-UTC timezone is refused rather than silently ignored",
  throws(() => validateSchedule({ ...sched([crossing]), timezone: "America/New_York" }))
);
check("UTC is accepted", !throws(() => validateSchedule({ ...sched([crossing]), timezone: "utc" })));
check(
  "enabled with no windows is refused - it would idle forever",
  throws(() => validateSchedule(sched([])))
);
check(
  "DISABLED with no windows is fine - that is the shipped default",
  !throws(() => validateSchedule(sched([], false)))
);
check(
  "an unknown outsideWindow mode is refused",
  throws(() => validateSchedule({ ...sched([crossing]), outsideWindow: "trade-anyway" as never }))
);
check("a malformed time is refused", throws(() => validateSchedule(sched([{ days: "all", start: "9am", end: "17:00" }]))));

section("fails OPEN if an empty schedule somehow gets past validation");

const emptyButEnabled = evaluateSchedule(sched([]), utc(WED, 15));
check("runs rather than idling forever", emptyButEnabled.active === true);
check("and names that state precisely", emptyButEnabled.reason === "no-windows-configured");

section("INDEPENDENCE: the schedule decides WHETHER to look, never WHAT passes");

// Enforced structurally, not by convention: if src/schedule/ ever imports from
// src/filters/, a schedule change could move a PASS/SKIP and the outcome study
// stops being interpretable. Grep the source rather than trust the comment.
const fs = require("fs") as typeof import("fs");
const schedulerSource = fs.readFileSync("src/schedule/scheduler.ts", "utf-8");
check(
  "src/schedule/ imports nothing from src/filters/",
  !/from\s+["'][^"']*filters/.test(schedulerSource)
);
check(
  "src/schedule/ imports nothing from src/trading/",
  !/from\s+["'][^"']*trading/.test(schedulerSource)
);
check(
  "the scheduler never mentions a filter threshold or a decision verdict",
  !/PASS|SKIP|liquidity|holder|threshold/i.test(
    schedulerSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
  ),
  "found filter vocabulary in scheduler code (comments excluded)"
);
const filtersSource = fs.readFileSync("src/filters/engine.ts", "utf-8");
check(
  "and src/filters/engine.ts does not import the scheduler either",
  !/from\s+["'][^"']*schedule/.test(filtersSource)
);
check(
  "evaluateSchedule returns only scheduling fields - no verdict, no score",
  Object.keys(open).sort().join(",") === "active,detail,nextOpenUtc,reason,window"
);

console.log(`\nTotal: ${pass} passed, ${fail} failed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail > 0 ? 1 : 0);
