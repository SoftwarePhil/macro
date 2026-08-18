import { EventEmitter } from "events";
import test from "node:test";
import assert from "node:assert/strict";
import { createScheduler } from "../scheduler.js";

const AFTER_CLOSE_ET = new Date("2026-08-17T20:30:00.000Z");

function fakeSpawn(calls, completed) {
  return (_pythonBin, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    const session = args.at(-1);
    calls.push(session);
    queueMicrotask(() => {
      completed.add(session);
      child.emit("close", 0, null);
    });
    return child;
  };
}

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for scheduler");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("catches up open before close and runs each session once", async () => {
  const calls = [];
  const completed = new Set();
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

test("does not rerun sessions already recorded in SQLite", async () => {
  const calls = [];
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
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};

  const scheduler = createScheduler({
    rootDir: process.cwd(),
    timeZone: "America/New_York",
    now: () => AFTER_CLOSE_ET,
    isSessionComplete: () => false,
    spawnJob: () => child,
  });

  scheduler.start();
  assert.equal(scheduler.getStatus().jobs.find((job) => job.session === "Open").running, true);

  scheduler.stop();

  const status = scheduler.getStatus();
  assert.equal(status.activeSession, null);
  assert.equal(status.jobs.every((job) => !job.running), true);
});

test("does not start another job after stopping an in-progress check", async () => {
  const calls = [];
  let child;
  const scheduler = createScheduler({
    rootDir: process.cwd(),
    timeZone: "America/New_York",
    now: () => AFTER_CLOSE_ET,
    isSessionComplete: () => false,
    spawnJob: (_pythonBin, args) => {
      child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => queueMicrotask(() => child.emit("close", 0, null));
      calls.push(args.at(-1));
      return child;
    },
  });

  scheduler.start();
  await waitFor(() => calls.length === 1);

  scheduler.stop();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, ["open"]);
});
