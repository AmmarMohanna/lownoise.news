#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = resolve(root, ".env");
const exampleEnvPath = resolve(root, ".env.example");
const workerDir = resolve(root, "apps/worker");
const workerDevVarsPath = resolve(workerDir, ".dev.vars");
const workerConfigPath = resolve(workerDir, "wrangler.toml");
const args = new Set(process.argv.slice(2));

const secretKeys = [
  "ADMIN_SESSION_SECRET",
  "ADMIN_SETUP_TOKEN",
  "INTERNAL_MAINTENANCE_SECRET"
];

const runtimeSecretKeys = [
  ...secretKeys,
  "OPENAI_API_KEY",
  "CLOUDFLARE_AI_GATEWAY_TOKEN",
  "APIFY_API_TOKEN",
  "TURNSTILE_SECRET_KEY"
];

const runtimeVarKeys = [
  "PUBLIC_API_BASE_URL",
  "PUBLIC_WEB_BASE_URL",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_AI_GATEWAY_ID",
  "OPENAI_MODEL",
  "OPENAI_INPUT_PRICE_USD_PER_MILLION_TOKENS",
  "OPENAI_OUTPUT_PRICE_USD_PER_MILLION_TOKENS",
  "EMAIL_FROM",
  "TURNSTILE_SITE_KEY",
  "APIFY_X_ACTOR_ID",
  "APIFY_LINKEDIN_COMPANY_ACTOR_ID",
  "APIFY_LINKEDIN_PROFILE_ACTOR_ID",
  "APIFY_X_PRICE_USD_PER_1000_RESULTS"
];

const resourceKeys = [
  "DISTILLED_WORKER_NAME",
  "DISTILLED_D1_DATABASE_NAME",
  "DISTILLED_D1_DATABASE_ID",
  "DISTILLED_R2_BUCKET_NAME",
  "DISTILLED_PROCESSING_QUEUE_NAME",
  "DISTILLED_PROCESSING_DEAD_LETTER_QUEUE_NAME",
  "DISTILLED_CUSTOM_DOMAINS"
];

const persistedEnvKeys = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_ZONE_ID",
  ...resourceKeys,
  ...runtimeVarKeys,
  ...runtimeSecretKeys
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

  if (shouldPrepareCloudflareConfig()) {
    changed = ensureResourceDefaults(env) || changed;
  }

  if (changed) writeEnvFile(envPath, env);
  writeWorkerDevVars(workerDevVarsPath, env);

  console.log("Distilled.news setup");
  console.log(`- prepared ${relative(envPath)}`);
  console.log(`- prepared ${relative(workerDevVarsPath)}`);
  console.log("- generated missing admin/session/maintenance secrets");

  checkCommand("node", ["--version"]);
  checkCommand("npx", ["pnpm@10.12.1", "--version"]);

  if (args.has("--provision-cloudflare")) {
    requireCloudflareCredentials(env);
    const resources = readResourceConfig(env);
    const databaseId = ensureD1Database(resources.d1DatabaseName, env);
    if (env.get("DISTILLED_D1_DATABASE_ID") !== databaseId) {
      env.set("DISTILLED_D1_DATABASE_ID", databaseId);
      writeEnvFile(envPath, env);
    }
    ensureR2Bucket(resources.r2BucketName, env);
    ensureQueue(resources.processingQueueName, env);
    ensureQueue(resources.deadLetterQueueName, env);
    writeWranglerConfig(workerConfigPath, readResourceConfig(env), env);
    console.log(`- wrote ${relative(workerConfigPath)}`);
  } else if (args.has("--write-wrangler")) {
    const resources = readResourceConfig(env);
    if (!resources.d1DatabaseId) {
      throw new Error("DISTILLED_D1_DATABASE_ID is required for --write-wrangler. Use --provision-cloudflare to create one.");
    }
    writeWranglerConfig(workerConfigPath, resources, env);
    console.log(`- wrote ${relative(workerConfigPath)}`);
  }

  if (args.has("--set-secrets") || args.has("--provision-cloudflare")) {
    setWorkerSecrets(env);
  }

  if (args.has("--check")) {
    runWrangler(["whoami"], env, { optional: true });
    runWrangler(["deploy", "--dry-run"], env, { optional: true });
  }

  if (args.has("--apply-remote-migrations")) {
    runWrangler(["d1", "migrations", "apply", "DB", "--remote"], env);
  }

  if (args.has("--deploy")) {
    run("npx", ["pnpm@10.12.1", "run", "deploy"], { env });
  }

  console.log("\nNext useful commands:");
  console.log("- npx pnpm@10.12.1 install");
  console.log("- npx pnpm@10.12.1 test");
  console.log("- npx pnpm@10.12.1 run setup -- --provision-cloudflare --apply-remote-migrations --deploy");
  console.log("\nOptional flags: --check, --write-wrangler, --set-secrets, --provision-cloudflare, --apply-remote-migrations, --deploy.");
}

function shouldPrepareCloudflareConfig() {
  return args.has("--provision-cloudflare") || args.has("--write-wrangler");
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
    env.set(trimmed.slice(0, index), parseEnvValue(trimmed.slice(index + 1)));
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
    return `${key}=${formatEnvValue(env.get(key))}`;
  });

  for (const key of persistedEnvKeys) {
    if (env.has(key) && !seen.has(key)) {
      lines.push(`${key}=${formatEnvValue(env.get(key))}`);
      seen.add(key);
    }
  }

  writeFileSync(path, `${lines.join("\n").replace(/\n*$/, "")}\n`, "utf8");
}

function writeWorkerDevVars(path, env) {
  mkdirSync(dirname(path), { recursive: true });
  const lines = [];
  for (const key of [...runtimeVarKeys, ...runtimeSecretKeys]) {
    const value = env.get(key);
    if (!usableEnvValue(value)) continue;
    lines.push(`${key}=${formatEnvValue(value)}`);
  }
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
}

function ensureResourceDefaults(env) {
  let changed = false;
  const defaults = {
    DISTILLED_WORKER_NAME: "distilled-news",
    DISTILLED_D1_DATABASE_NAME: "distilled-news",
    DISTILLED_R2_BUCKET_NAME: "distilled-news-raw",
    DISTILLED_PROCESSING_QUEUE_NAME: "distilled-news-processing",
    DISTILLED_PROCESSING_DEAD_LETTER_QUEUE_NAME: "distilled-news-processing-dlq"
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (!env.get(key)) {
      env.set(key, value);
      changed = true;
    }
  }
  return changed;
}

function readResourceConfig(env) {
  ensureResourceDefaults(env);
  return {
    workerName: env.get("DISTILLED_WORKER_NAME"),
    d1DatabaseName: env.get("DISTILLED_D1_DATABASE_NAME"),
    d1DatabaseId: env.get("DISTILLED_D1_DATABASE_ID"),
    r2BucketName: env.get("DISTILLED_R2_BUCKET_NAME"),
    processingQueueName: env.get("DISTILLED_PROCESSING_QUEUE_NAME"),
    deadLetterQueueName: env.get("DISTILLED_PROCESSING_DEAD_LETTER_QUEUE_NAME"),
    customDomains: splitCsv(env.get("DISTILLED_CUSTOM_DOMAINS"))
  };
}

function requireCloudflareCredentials(env) {
  const missing = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"].filter((key) => !usableEnvValue(envValue(env, key)));
  if (missing.length > 0) {
    throw new Error(`Missing required Cloudflare value(s): ${missing.join(", ")}`);
  }
}

function ensureD1Database(name, env) {
  const existing = listD1Databases(env).find((database) => database.name === name);
  if (existing?.uuid || existing?.id) {
    console.log(`- D1 database ${name}: exists`);
    return existing.uuid ?? existing.id;
  }

  const result = runWranglerCapture(["d1", "create", name], env);
  const databaseId = parseD1DatabaseId(`${result.stdout}\n${result.stderr}`);
  if (!databaseId) throw new Error(`Could not parse D1 database id for ${name}.`);
  console.log(`- D1 database ${name}: created`);
  return databaseId;
}

function listD1Databases(env) {
  const result = runWranglerCapture(["d1", "list", "--json"], env, { optional: true });
  if (result.status !== 0) return [];
  try {
    const payload = JSON.parse(result.stdout);
    return Array.isArray(payload) ? payload : [];
  } catch {
    return [];
  }
}

function parseD1DatabaseId(output) {
  return output.match(/database_id\s*=\s*"([^"]+)"/)?.[1] ??
    output.match(/"database_id"\s*:\s*"([^"]+)"/)?.[1] ??
    output.match(/"uuid"\s*:\s*"([^"]+)"/)?.[1];
}

function ensureR2Bucket(name, env) {
  const result = runWranglerCapture(["r2", "bucket", "create", name], env, { optional: true });
  if (result.status === 0 || alreadyExists(result)) {
    console.log(`- R2 bucket ${name}: ready`);
    return;
  }
  throwCommandError(result, `Could not create R2 bucket ${name}`);
}

function ensureQueue(name, env) {
  const result = runWranglerCapture(["queues", "create", name], env, { optional: true });
  if (result.status === 0 || alreadyExists(result)) {
    console.log(`- Queue ${name}: ready`);
    return;
  }
  throwCommandError(result, `Could not create Queue ${name}`);
}

function setWorkerSecrets(env) {
  const secrets = {};
  for (const key of runtimeSecretKeys) {
    const value = envValue(env, key);
    if (usableEnvValue(value)) secrets[key] = value;
  }
  if (Object.keys(secrets).length === 0) {
    console.log("- Worker secrets: no non-empty secrets to upload");
    return;
  }
  runWrangler(["secret", "bulk"], env, { input: JSON.stringify(secrets) });
  console.log(`- Worker secrets: uploaded ${Object.keys(secrets).length}`);
}

function writeWranglerConfig(path, resources, env) {
  const publicApiBaseUrl = env.get("PUBLIC_API_BASE_URL") || "https://distilled-news.workers.dev";
  const publicWebBaseUrl = env.get("PUBLIC_WEB_BASE_URL") || publicApiBaseUrl;
  const vars = {
    PUBLIC_API_BASE_URL: publicApiBaseUrl,
    PUBLIC_WEB_BASE_URL: publicWebBaseUrl,
    CLOUDFLARE_ACCOUNT_ID: envValue(env, "CLOUDFLARE_ACCOUNT_ID"),
    CLOUDFLARE_AI_GATEWAY_ID: env.get("CLOUDFLARE_AI_GATEWAY_ID") || "default",
    OPENAI_MODEL: env.get("OPENAI_MODEL") || "gpt-4.1-mini",
    EMAIL_FROM: env.get("EMAIL_FROM") || "Distilled.news <noreply@example.com>",
    APIFY_X_ACTOR_ID: env.get("APIFY_X_ACTOR_ID") || "kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest",
    APIFY_LINKEDIN_COMPANY_ACTOR_ID: env.get("APIFY_LINKEDIN_COMPANY_ACTOR_ID") || "harvestapi/linkedin-company-posts",
    APIFY_LINKEDIN_PROFILE_ACTOR_ID: env.get("APIFY_LINKEDIN_PROFILE_ACTOR_ID") || "harvestapi/linkedin-profile-posts"
  };

  const lines = [
    `name = ${tomlString(resources.workerName)}`,
    `main = "src/index.ts"`,
    `compatibility_date = "2026-06-16"`,
    `compatibility_flags = ["nodejs_compat"]`,
    `workers_dev = true`,
    "",
    "[assets]",
    `directory = "../web/dist"`,
    `binding = "ASSETS"`,
    `not_found_handling = "single-page-application"`,
    `run_worker_first = true`,
    "",
    "[vars]",
    ...Object.entries(vars)
      .filter(([, value]) => usableEnvValue(value))
      .map(([key, value]) => `${key} = ${tomlString(value)}`),
    "",
    "[[d1_databases]]",
    `binding = "DB"`,
    `database_name = ${tomlString(resources.d1DatabaseName)}`,
    `database_id = ${tomlString(resources.d1DatabaseId)}`,
    `migrations_dir = "migrations"`,
    "",
    "[[r2_buckets]]",
    `binding = "RAW_ARCHIVE"`,
    `bucket_name = ${tomlString(resources.r2BucketName)}`,
    "",
    "[[send_email]]",
    `name = "EMAIL"`,
    "",
    "[[queues.producers]]",
    `binding = "PROCESSING_QUEUE"`,
    `queue = ${tomlString(resources.processingQueueName)}`,
    "",
    "[[queues.consumers]]",
    `queue = ${tomlString(resources.processingQueueName)}`,
    `max_batch_size = 1`,
    `max_batch_timeout = 5`,
    `max_retries = 4`,
    `retry_delay = 60`,
    `dead_letter_queue = ${tomlString(resources.deadLetterQueueName)}`,
    "",
    "[observability]",
    `enabled = true`,
    `head_sampling_rate = 1`,
    "",
    "[triggers]",
    `crons = ["* * * * *"]`
  ];

  for (const domain of resources.customDomains) {
    lines.push("", "[[routes]]", `pattern = ${tomlString(domain)}`, "custom_domain = true");
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

function runWrangler(commandArgs, env, options = {}) {
  return run("npx", wranglerArgs(commandArgs), { ...options, env });
}

function runWranglerCapture(commandArgs, env, options = {}) {
  return runCapture("npx", wranglerArgs(commandArgs), { ...options, env });
}

function wranglerArgs(commandArgs) {
  return ["pnpm@10.12.1", "--filter", "@distilled/worker", "exec", "wrangler", ...commandArgs];
}

function run(command, commandArgs, options = {}) {
  console.log(`\n$ ${command} ${commandArgs.join(" ")}`);
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    input: options.input,
    stdio: options.input ? ["pipe", "inherit", "inherit"] : "inherit",
    env: processEnv(options.env)
  });
  if (result.status === 0 || options.optional) return result;
  process.exit(result.status ?? 1);
}

function runCapture(command, commandArgs, options = {}) {
  console.log(`\n$ ${command} ${commandArgs.join(" ")}`);
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    input: options.input,
    encoding: "utf8",
    env: processEnv(options.env)
  });
  if (result.status === 0 || options.optional) return result;
  throwCommandError(result, `${command} ${commandArgs.join(" ")} failed`);
}

function throwCommandError(result, message) {
  throw new Error(`${message}\n${result.stdout ?? ""}${result.stderr ?? ""}`.trim());
}

function processEnv(envMap) {
  if (!envMap) return process.env;
  const merged = { ...process.env };
  for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) {
    const value = envValue(envMap, key);
    if (usableEnvValue(value)) merged[key] = value;
  }
  return merged;
}

function envValue(envMap, key) {
  return envMap?.get?.(key) || process.env[key] || "";
}

function alreadyExists(result) {
  return /already exists|already have|exists already/i.test(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
}

function parseEnvValue(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function formatEnvValue(value) {
  const text = String(value ?? "");
  if (!text) return "";
  return /[\s#"'`]/.test(text) ? JSON.stringify(text) : text;
}

function usableEnvValue(value) {
  return Boolean(value && !String(value).includes("<") && !String(value).includes("fill-"));
}

function splitCsv(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.replace(/^https?:\/\//i, "").replace(/\/+$/, ""));
}

function tomlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function randomSecret() {
  return randomBytes(32).toString("base64url");
}

function relative(path) {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}
