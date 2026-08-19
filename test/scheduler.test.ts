import { EventEmitter } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";
import { createScheduler } from "../lib/scheduler";

const AFTER_CLOSE_ET = new Date("2026-08-17T20:30:00.000Z");

class MockChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = () => true;
}

function fakeSpawn(calls: string[], completed: Set<string>) {
  return (_pythonBin: string, args: string[]) => {
    const child = new MockChild();
    const session = args.at(-1) as string;
    calls.push(session);
    queueMicrotask(() => {
      completed.add(session);
      child.emit("close", 0, null);
    });
    return child;
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for scheduler");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("catches up open before close and runs each session once", async () => {
  const calls: string[] = [];
  const completed = new Set<string>();
  const scheduler = createScheduler({
    rootDir: process.cwd(),
    timeZone: "America/New_York",
    now: () => AFTER_CLOSE_ET,
    tickMs: 10,
    isSessionComplete: (_date, session) => completed.has(session),
    spawnJob: fakeSpawn(calls, completed),
  });

  scheduler.start();
  await waitFor(() => calls.length === 2);
  scheduler.stop();

  assert.deepEqual(calls, ["open", "close"]);
});

test("does not rerun sessions already marked complete", async () => {
  const calls: string[] = [];
  const completed = new Set(["open", "close"]);
  const scheduler = createScheduler({
    rootDir: process.cwd(),
    timeZone: "America/New_York",
    now: () => AFTER_CLOSE_ET,
    tickMs: 10,
    isSessionComplete: (_date, session) => completed.has(session),
    spawnJob: fakeSpawn(calls, completed),
  });

  scheduler.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  scheduler.stop();

  assert.deepEqual(calls, []);
});

test("clears a session running state when stopped before close", async () => {
  const child = new MockChild();

  const scheduler = createScheduler({
    rootDir: process.cwd(),
    timeZone: "America/New_York",
    now: () => AFTER_CLOSE_ET,
    isSessionComplete: () => false,
    spawnJob: () => child,
  });

  scheduler.start();
  assert.equal(scheduler.getStatus().jobs.find((job) => job.session === "Open")?.running, true);

  scheduler.stop();

  const status = scheduler.getStatus();
  assert.equal(status.activeSession, null);
  assert.equal(status.jobs.every((job) => !job.running), true);
});

test("does not start another job after stopping an in-progress check", async () => {
  const calls: string[] = [];
  let child: MockChild;
  const scheduler = createScheduler({
    rootDir: process.cwd(),
    timeZone: "America/New_York",
    now: () => AFTER_CLOSE_ET,
    isSessionComplete: () => false,
    spawnJob: (_pythonBin: string, args: string[]) => {
      child = new MockChild();
      child.kill = () => {
        queueMicrotask(() => child.emit("close", 0, null));
        return true;
      };
      calls.push(args.at(-1) as string);
      return child;
    },
  });

  scheduler.start();
  await waitFor(() => calls.length === 1);

  scheduler.stop();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, ["open"]);
});

test("coordinates catch-up work across scheduler instances", async () => {
  const calls: string[] = [];
  const completed = new Set<string>();
  const claims = new Set<string>();
  const claimSession = (date: string, session: string) => {
    const key = `${date}:${session}`;
    if (claims.has(key)) return false;
    claims.add(key);
    return true;
  };
  const options = {
    rootDir: process.cwd(),
    timeZone: "America/New_York",
    now: () => AFTER_CLOSE_ET,
    tickMs: 10,
    isSessionComplete: (_date: string, session: string) => completed.has(session),
    claimSession,
    spawnJob: fakeSpawn(calls, completed),
  };
  const first = createScheduler({ ...options, ownerId: "first" });
  const second = createScheduler({ ...options, ownerId: "second" });

  first.start();
  second.start();
  await waitFor(() => calls.length === 2);
  await new Promise((resolve) => setTimeout(resolve, 30));
  first.stop();
  second.stop();

  assert.deepEqual(calls, ["open", "close"]);
});
