import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AccountRecord, AccountRole, Env, Repository } from "./types";

export const SESSION_COOKIE = "ln_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const VOTER_COOKIE = "ln_voter";
const VOTER_TTL_SECONDS = 60 * 60 * 24 * 365;
const PASSWORD_ITERATIONS = 100_000;
type AppEnv = { Bindings: Env; Variables: { repo: Repository; account?: AccountRecord } };

export interface SessionClaims {
  sub: string;
  role: AccountRole;
  exp: number;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function normalizeUsername(username: string): string {
  return (
    username
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "user"
  );
}

export async function hashPassword(password: string, salt = randomToken(16)): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: toArrayBuffer(fromBase64Url(salt)),
      iterations: PASSWORD_ITERATIONS
    },
    key,
    256
  );
  return `pbkdf2-sha256:${PASSWORD_ITERATIONS}:${salt}:${toBase64Url(new Uint8Array(bits))}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [, iterations, salt, expected] = encoded.split(":");
  if (!iterations || !salt || !expected) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: toArrayBuffer(fromBase64Url(salt)),
      iterations: Number(iterations)
    },
    key,
    256
  );
  return timingSafeEqual(toBase64Url(new Uint8Array(bits)), expected);
}

export async function createSession(secret: string, account: AccountRecord, now = new Date()): Promise<string> {
  const payload = toBase64Url(
    new TextEncoder().encode(
      JSON.stringify({
        sub: account.id,
        role: account.role,
        exp: Math.floor(now.getTime() / 1000) + SESSION_TTL_SECONDS
      })
    )
  );
  const signature = await sign(payload, secret);
  return `${payload}.${signature}`;
}

export async function verifySession(token: string | undefined, secret: string, now = new Date()): Promise<SessionClaims | null> {
  if (!token || !secret) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  if (!timingSafeEqual(await sign(payload, secret), signature)) return null;

  const decoded = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as SessionClaims;
  if (!decoded.sub || (decoded.role !== "admin" && decoded.role !== "user")) return null;
  if (decoded.exp <= Math.floor(now.getTime() / 1000)) return null;
  return decoded;
}

export function setSessionCookie(c: Context<AppEnv>, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: new URL(c.req.url).protocol === "https:",
    path: "/",
    maxAge: SESSION_TTL_SECONDS
  });
}

export function clearSessionCookie(c: Context<AppEnv>): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export async function getVoterId(c: Context<AppEnv>, now = new Date()): Promise<string | null> {
  const secret = c.env.ADMIN_SESSION_SECRET ?? "";
  if (!secret) return null;

  const token = getCookie(c, VOTER_COOKIE);
  if (!token) return null;
  return verifyTokenSubject(token, secret, now);
}

export async function getOrCreateVoterId(c: Context<AppEnv>, now = new Date()): Promise<string | null> {
  const secret = c.env.ADMIN_SESSION_SECRET ?? "";
  if (!secret) return null;

  const existing = await getVoterId(c, now);
  if (existing) return existing;

  const voterId = crypto.randomUUID();
  setCookie(c, VOTER_COOKIE, await createSignedToken(voterId, secret, VOTER_TTL_SECONDS, now), {
    httpOnly: true,
    sameSite: "Lax",
    secure: new URL(c.req.url).protocol === "https:",
    path: "/",
    maxAge: VOTER_TTL_SECONDS
  });
  return voterId;
}

export function accountAuth(repoForContext: (c: Context<AppEnv>) => Repository): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const repo = repoForContext(c);
    c.set("repo", repo);
    const claims = await verifySession(getCookie(c, SESSION_COOKIE), c.env.ADMIN_SESSION_SECRET ?? "");
    if (!claims) return c.json({ error: "unauthorized" }, 401);
    const account = await repo.getAccountById(claims.sub);
    if (!account || account.disabledAt) return c.json({ error: "unauthorized" }, 401);
    c.set("account", account);
    await next();
  };
}

export function adminAuth(repoForContext: (c: Context<AppEnv>) => Repository): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const repo = repoForContext(c);
    c.set("repo", repo);
    const secret = c.env.ADMIN_SESSION_SECRET;
    if (!secret) return c.json({ error: "ADMIN_SESSION_SECRET is not configured" }, 500);

    const claims = await verifySession(getCookie(c, SESSION_COOKIE), secret);
    if (claims) {
      const account = await repo.getAccountById(claims.sub);
      if (account?.role === "admin" && !account.disabledAt) {
        c.set("account", account);
        await next();
        return;
      }
    }

    if (c.req.header("x-lownoise-admin") !== secret) return c.json({ error: "unauthorized" }, 401);
    const account = (await repo.listAccounts()).find((item) => item.role === "admin" && !item.disabledAt);
    if (account) c.set("account", account);
    await next();
  };
}

export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return toBase64Url(new Uint8Array(digest));
}

async function sign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return toBase64Url(new Uint8Array(signature));
}

async function createSignedToken(subject: string, secret: string, ttlSeconds: number, now = new Date()): Promise<string> {
  const payload = toBase64Url(
    new TextEncoder().encode(
      JSON.stringify({
        sub: subject,
        exp: Math.floor(now.getTime() / 1000) + ttlSeconds
      })
    )
  );
  const signature = await sign(payload, secret);
  return `${payload}.${signature}`;
}

async function verifyTokenSubject(token: string, secret: string, now = new Date()): Promise<string | null> {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  if (!timingSafeEqual(await sign(payload, secret), signature)) return null;

  const decoded = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as { sub: string; exp: number };
  if (decoded.exp <= Math.floor(now.getTime() / 1000)) return null;
  return decoded.sub;
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) {
    result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return result === 0;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
