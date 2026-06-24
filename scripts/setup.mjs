#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const envPath = resolve(root, ".env");
const exampleEnvPath = resolve(root, ".env.example");
const workerDevVarsPath = resolve(root, "apps/worker/.dev.vars");
const args = new Set(process.argv.slice(2));

const secretKeys = [
  "ADMIN_SESSION_SECRET",
  "ADMIN_SETUP_TOKEN",
  "INTERNAL_MAINTENANCE_SECRET"
];

main();

function main() {
  ensureEnvFile();
  const env = readEnvFile(envPath);
  let changed = false;

  for (const key of secretKeys) {
    if (!env.get(key)) {
      env.set(key, randomSecret());
      changed = true;
    }
  }

  if (changed) writeEnvFile(envPath, env);
  writeWorkerDevVars(workerDevVarsPath, env);

  console.log("Distilled.news setup");
  console.log(`- prepared ${relative(envPath)}`);
  console.log(`- prepared ${relative(workerDevVarsPath)}`);
  console.log("- generated missing admin/session/maintenance secrets");

  checkCommand("node", ["--version"]);
  checkCommand("npx", ["pnpm@10.12.1", "--version"]);

  if (args.has("--check")) {
    run("npx", ["pnpm@10.12.1", "--filter", "@distilled/worker", "exec", "wrangler", "whoami"], { optional: true });
    run("npx", ["pnpm@10.12.1", "--filter", "@distilled/worker", "exec", "wrangler", "deploy", "--dry-run"], { optional: true });
  }

  if (args.has("--apply-remote-migrations")) {
    run("npx", ["pnpm@10.12.1", "--filter", "@distilled/worker", "db:migrate:remote"]);
  }

  if (args.has("--deploy")) {
    run("npx", ["pnpm@10.12.1", "deploy"]);
  }

  console.log("\nNext useful commands:");
  console.log("- npx pnpm@10.12.1 install");
  console.log("- npx pnpm@10.12.1 test");
  console.log("- npx pnpm@10.12.1 --filter @distilled/worker db:migrate:remote");
  console.log("- npx pnpm@10.12.1 deploy");
  console.log("\nOptional: run setup with --check, --apply-remote-migrations, or --deploy.");
}

function ensureEnvFile() {
  if (existsSync(envPath)) return;
  const initial = existsSync(exampleEnvPath)
    ? readFileSync(exampleEnvPath, "utf8")
    : "";
  writeFileSync(envPath, initial, "utf8");
}

function readEnvFile(path) {
  const env = new Map();
  const lines = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    env.set(trimmed.slice(0, index), trimmed.slice(index + 1));
  }
  return env;
}

function writeEnvFile(path, env) {
  const existing = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : [];
  const seen = new Set();
  const lines = existing.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) return line;
    const key = trimmed.slice(0, trimmed.indexOf("="));
    if (!env.has(key)) return line;
    seen.add(key);
    return `${key}=${env.get(key)}`;
  });

  for (const [key, value] of env) {
    if (!seen.has(key)) lines.push(`${key}=${value}`);
  }

  writeFileSync(path, `${lines.join("\n").replace(/\n*$/, "")}\n`, "utf8");
}

function writeWorkerDevVars(path, env) {
  mkdirSync(dirname(path), { recursive: true });
  const lines = [];
  for (const [key, value] of env) {
    if (!value || value.includes("<") || value.includes("fill-")) continue;
    lines.push(`${key}=${value}`);
  }
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
}

function checkCommand(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: root, encoding: "utf8" });
  if (result.status === 0) {
    console.log(`- ${command} ${commandArgs.join(" ")}: ${result.stdout.trim() || "ok"}`);
    return;
  }
  console.log(`- ${command} ${commandArgs.join(" ")}: unavailable`);
}

function run(command, commandArgs, options = {}) {
  console.log(`\n$ ${command} ${commandArgs.join(" ")}`);
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: "inherit"
  });
  if (result.status === 0 || options.optional) return;
  process.exit(result.status ?? 1);
}

function randomSecret() {
  return randomBytes(32).toString("base64url");
}

function relative(path) {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}
