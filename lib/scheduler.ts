import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const REGIME_SCHEDULE = Object.freeze([
  {
    session: "open",
    label: "Open",
    hour: 9,
    minute: 30,
    time: "09:30",
    purpose: "Pre-open rebalance check",
  },
  {
    session: "close",
    label: "Close",
    hour: 16,
    minute: 0,
    time: "16:00",
    purpose: "End-of-day drift check",
  },
] as const);

const DEFAULT_TIMEZONE = "America/New_York";
const DEFAULT_TICK_MS = 15_000;
const DEFAULT_RETRY_MS = 5 * 60_000;
const MAX_OUTPUT_LENGTH = 32_000;

export interface SchedulerRun {
  session: string;
  date: string;
  startedAt: string;
  completedAt: string;
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error: string | null;
}

interface SchedulerState {
  running: boolean;
  lastAttemptAt: number;
  lastAttemptDate: string | null;
  lastRun: SchedulerRun | null;
}

interface StreamLike {
  on(event: string, listener: (...args: any[]) => void): unknown;
}

interface SpawnedChild {
  stdout: StreamLike | null;
  stderr: StreamLike | null;
  once(event: string, listener: (...args: any[]) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

type SpawnJob = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ["ignore", "pipe", "pipe"] },
) => SpawnedChild;

export interface SchedulerStatus {
  enabled: boolean;
  timezone: string;
  tickMs: number;
  retryMs: number;
  startedAt: string | null;
  lastCheckAt: string | null;
  activeSession: string | null;
  jobs: Array<{
    session: string;
    time: string;
    purpose: string;
    due: boolean;
    completedToday: boolean;
    running: boolean;
    nextRun: string | null;
    lastRun: SchedulerRun | null;
  }>;
}

function envNumber(name: string, fallback: number, minimum: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}

function localParts(date: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  dateKey: string;
  weekday: number;
} {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(
    formatted
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<string, number>;
  const dateKey = [values.year, values.month, values.day]
    .map((value, index) => String(value).padStart(index === 0 ? 4 : 2, "0"))
    .join("-");
  const weekday = new Date(Date.UTC(values.year, values.month - 1, values.day)).getUTCDay();
  return { ...values, dateKey, weekday } as {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
    dateKey: string;
    weekday: number;
  };
}

function addDays(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function isWeekday(weekday: number): boolean {
  return weekday >= 1 && weekday <= 5;
}

function minutesSinceMidnight(parts: { hour: number; minute: number; second: number }): number {
  return parts.hour * 60 + parts.minute + parts.second / 60;
}

function isDue(
  parts: { weekday: number; hour: number; minute: number; second: number },
  job: (typeof REGIME_SCHEDULE)[number],
): boolean {
  return isWeekday(parts.weekday) && minutesSinceMidnight(parts) >= job.hour * 60 + job.minute;
}

function nextOccurrence(
  parts: { dateKey: string; hour: number; minute: number; second: number },
  job: (typeof REGIME_SCHEDULE)[number],
  timeZone: string,
): string | null {
  const currentMinutes = minutesSinceMidnight(parts);
  for (let offset = 0; offset < 8; offset += 1) {
    const dateKey = addDays(parts.dateKey, offset);
    const weekday = new Date(`${dateKey}T12:00:00Z`).getUTCDay();
    if (!isWeekday(weekday)) continue;
    if (offset === 0 && job.hour * 60 + job.minute <= currentMinutes) continue;
    return `${dateKey} ${job.time} ${timeZone}`;
  }
  return null;
}

function appendOutput(current: string, chunk: unknown): string {
  const next = current + String(chunk);
  return next.length > MAX_OUTPUT_LENGTH ? next.slice(-MAX_OUTPUT_LENGTH) : next;
}

function loadXaiApiKey(rootDir: string): string {
  const configured = String(process.env.XAI_API_KEY || "").trim();
  if (configured) return configured;

  try {
    return fs.readFileSync(path.join(rootDir, "data", "xai_api_key.txt"), "utf8").trim();
  } catch {
    return "";
  }
}

export interface SchedulerOptions {
  rootDir: string;
  isSessionComplete: (dateKey: string, session: string) => boolean;
  claimSession?: (dateKey: string, session: string, owner: string) => boolean;
  releaseSession?: (dateKey: string, session: string, owner: string) => void;
  ownerId?: string;
  timeZone?: string;
  pythonBin?: string;
  now?: () => Date;
  spawnJob?: SpawnJob;
  tickMs?: number;
  retryMs?: number;
}

export function createScheduler({
  rootDir,
  isSessionComplete,
  claimSession,
  releaseSession,
  ownerId = `${process.pid}:${randomUUID()}`,
  timeZone = process.env.SCHEDULE_TIMEZONE || DEFAULT_TIMEZONE,
  pythonBin = process.env.PYTHON_BIN || "python3",
  now = () => new Date(),
  spawnJob = nodeSpawn as unknown as SpawnJob,
  tickMs = envNumber("SCHEDULER_TICK_MS", DEFAULT_TICK_MS, 1000),
  retryMs = envNumber("SCHEDULER_RETRY_MS", DEFAULT_RETRY_MS, 1000),
}: SchedulerOptions): {
  start: () => void;
  stop: () => void;
  getStatus: () => SchedulerStatus;
} {
  if (!rootDir) throw new Error("Scheduler rootDir is required");
  if (typeof isSessionComplete !== "function") {
    throw new Error("Scheduler isSessionComplete callback is required");
  }

  const states = new Map<string, SchedulerState>(
    REGIME_SCHEDULE.map((job) => [
      job.session,
      { running: false, lastAttemptAt: 0, lastAttemptDate: null, lastRun: null },
    ]),
  );

  let timer: NodeJS.Timeout | null = null;
  let active: { session: string; child: SpawnedChild } | null = null;
  let checkInProgress = false;
  let startedAt: string | null = null;
  let lastCheckAt: string | null = null;
  let stopped = true;

  function completeFor(dateKey: string, session: string): boolean {
    try {
      return Boolean(isSessionComplete(dateKey, session));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[scheduler] Could not inspect strategy log: ${message}`);
      return false;
    }
  }

  function runJob(
    job: (typeof REGIME_SCHEDULE)[number],
    dateKey: string,
  ): Promise<{ ok: boolean; exitCode?: number | null; signal?: NodeJS.Signals | null; error?: string } | null> {
    const state = states.get(job.session);
    if (stopped || active || !state || state.running) return Promise.resolve(null);

    state.running = true;
    state.lastAttemptAt = now().getTime();
    state.lastAttemptDate = dateKey;
    const started = now().toISOString();
    let stdout = "";
    let stderr = "";

    console.log(`[scheduler] Starting ${job.label.toLowerCase()} job for ${dateKey}`);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: {
        ok: boolean;
        exitCode?: number | null;
        signal?: NodeJS.Signals | null;
        error?: string;
      }) => {
        if (settled) return;
        settled = true;
        state.running = false;
        state.lastRun = {
          session: job.label,
          date: dateKey,
          startedAt: started,
          completedAt: now().toISOString(),
          ok: result.ok,
          exitCode: result.exitCode ?? null,
          signal: result.signal ?? null,
          error: result.error ?? null,
        };
        active = null;

        if (stdout.trim()) console.log(`[scheduler] ${job.session} job output:\n${stdout.trim()}`);
        if (stderr.trim()) console.error(`[scheduler] ${job.session} job error output:\n${stderr.trim()}`);
        if (result.ok) {
          console.log(`[scheduler] Completed ${job.label.toLowerCase()} job for ${dateKey}`);
        } else {
          console.error(
            `[scheduler] ${job.label} job failed for ${dateKey}${result.error ? `: ${result.error}` : ""}`,
          );
        }
        resolve(result);
      };

      try {
        const env: NodeJS.ProcessEnv = { ...process.env, TZ: timeZone, PYTHONUNBUFFERED: "1" };
        const xaiApiKey = loadXaiApiKey(rootDir);
        if (xaiApiKey) env.XAI_API_KEY = xaiApiKey;

        const child = spawnJob(/* turbopackIgnore: true */ pythonBin, ["scripts/daily_regime_job.py", "--session", job.session], {
          cwd: rootDir,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        active = { session: job.session, child };
        child.stdout?.on("data", (chunk) => {
          stdout = appendOutput(stdout, chunk);
        });
        child.stderr?.on("data", (chunk) => {
          stderr = appendOutput(stderr, chunk);
        });
        child.once("error", (error: Error) => finish({ ok: false, error: error.message }));
        child.once("close", (exitCode: number | null, signal: NodeJS.Signals | null) => {
          finish({ ok: exitCode === 0, exitCode, signal });
        });
      } catch (error) {
        finish({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  async function check(): Promise<void> {
    if (stopped || checkInProgress) return;
    checkInProgress = true;
    try {
      const current = now();
      const parts = localParts(current, timeZone);
      lastCheckAt = current.toISOString();
      if (!isWeekday(parts.weekday)) return;

      for (const job of REGIME_SCHEDULE) {
        if (active) break;
        if (!isDue(parts, job)) continue;
        if (completeFor(parts.dateKey, job.session)) continue;

        const state = states.get(job.session);
        const recentlyAttempted = Boolean(
          state &&
            state.lastAttemptDate === parts.dateKey &&
            now().getTime() - state.lastAttemptAt < retryMs,
        );
        if (recentlyAttempted) continue;

        if (claimSession && !claimSession(parts.dateKey, job.session, ownerId)) continue;

        const result = await runJob(job, parts.dateKey);
        if (result && !result.ok) {
          releaseSession?.(parts.dateKey, job.session, ownerId);
          break;
        }
      }
    } finally {
      checkInProgress = false;
    }
  }

  function tick(): void {
    check().catch((error: unknown) => {
      const message = error instanceof Error ? error.stack || error.message : String(error);
      console.error(`[scheduler] Tick failed: ${message}`);
    });
  }

  function jobStatus(
    job: (typeof REGIME_SCHEDULE)[number],
    parts: ReturnType<typeof localParts>,
  ): SchedulerStatus["jobs"][number] {
    const state = states.get(job.session);
    const completedToday = completeFor(parts.dateKey, job.session);
    const due = isDue(parts, job) && !completedToday;
    return {
      session: job.label,
      time: job.time,
      purpose: job.purpose,
      due,
      completedToday,
      running: state?.running ?? false,
      nextRun: due ? "Due" : nextOccurrence(parts, job, timeZone),
      lastRun: state?.lastRun ?? null,
    };
  }

  return {
    start() {
      if (timer) return;
      stopped = false;
      startedAt = now().toISOString();
      console.log(`[scheduler] In-app scheduler started (${timeZone})`);
      timer = setInterval(tick, tickMs);
      timer.unref?.();
      tick();
    },

    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      active?.child.kill?.("SIGTERM");
      for (const state of states.values()) state.running = false;
      active = null;
      console.log("[scheduler] In-app scheduler stopped");
    },

    getStatus() {
      const parts = localParts(now(), timeZone);
      return {
        enabled: !stopped,
        timezone: timeZone,
        tickMs,
        retryMs,
        startedAt,
        lastCheckAt,
        activeSession: active?.session ?? null,
        jobs: REGIME_SCHEDULE.map((job) => jobStatus(job, parts)),
      };
    },
  };
}
