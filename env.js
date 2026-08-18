import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(ROOT, ".env");
const LOCAL_ENV_FILE = path.join(ROOT, ".env.local");

function parseValue(value) {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function loadEnv(filePath = ENV_FILE) {
  try {
    const contents = fs.readFileSync(filePath, "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const separator = trimmed.indexOf("=");
      if (separator <= 0) continue;

      const key = trimmed.slice(0, separator).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key] !== undefined) continue;
      process.env[key] = parseValue(trimmed.slice(separator + 1));
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export function loadEnvFiles(filePaths = [LOCAL_ENV_FILE, ENV_FILE]) {
  for (const filePath of filePaths) loadEnv(filePath);
}

// Load local overrides first so the base .env cannot replace them. Shell values
// are already present in process.env and are never overwritten.
loadEnvFiles();
