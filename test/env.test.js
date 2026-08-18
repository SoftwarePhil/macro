import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import test from "node:test";
import { loadEnv, loadEnvFiles } from "../env.js";

test("loads .env values without overriding shell values", () => {
  const suffix = `${process.pid}_${Date.now()}`;
  const loadedKey = `REGIME_ENV_LOADED_${suffix}`;
  const presetKey = `REGIME_ENV_PRESET_${suffix}`;
  const filePath = path.join(os.tmpdir(), `regime-dashboard-${suffix}.env`);

  fs.writeFileSync(
    filePath,
    `# comment\n${loadedKey}="loaded value"\n${presetKey}=from-file\nINVALID-KEY=ignored\n`,
  );
  process.env[presetKey] = "from-shell";

  try {
    loadEnv(filePath);
    assert.equal(process.env[loadedKey], "loaded value");
    assert.equal(process.env[presetKey], "from-shell");
    assert.equal(process.env["INVALID-KEY"], undefined);
  } finally {
    delete process.env[loadedKey];
    delete process.env[presetKey];
    fs.rmSync(filePath, { force: true });
  }
});

test("loads .env.local before .env so local values win", () => {
  const suffix = `${process.pid}_${Date.now()}`;
  const key = `REGIME_ENV_LOCAL_${suffix}`;
  const basePath = path.join(os.tmpdir(), `regime-dashboard-${suffix}.env`);
  const localPath = path.join(os.tmpdir(), `regime-dashboard-${suffix}.env.local`);

  fs.writeFileSync(basePath, `${key}=base\n`);
  fs.writeFileSync(localPath, `${key}=local\n`);

  try {
    delete process.env[key];
    loadEnvFiles([localPath, basePath]);
    assert.equal(process.env[key], "local");
  } finally {
    delete process.env[key];
    fs.rmSync(basePath, { force: true });
    fs.rmSync(localPath, { force: true });
  }
});
