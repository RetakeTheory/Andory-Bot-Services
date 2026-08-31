import { HttpError } from "./model";

const SESSION_COOKIE = "andory_session";
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const PASSWORD_ITERATIONS = 120_000;
const FAKE_PASSWORD_SALT = "AAAAAAAAAAAAAAAAAAAAAA";
const FAKE_PASSWORD_HASH = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const MAX_ACTIVE_CREDENTIALS_PER_SCOPE = 5;
const CREDENTIAL_ROUTE = /^\/api\/v1\/credentials\/([0-9a-f-]{36})\/?$/i;

export type AccountRole = "user" | "admin";
export type CredentialScope = "bot" | "audit";

export interface AccountSession {
  id: string;
  email: string;
  role: AccountRole;
  mfaVerified: boolean;
}

interface AccountRow {
  id: string;
  email: string;
  role: AccountRole;
  password_salt?: string;
  password_hash?: string;
}

interface CredentialRow {
  id: string;
  scope: CredentialScope;
  role: AccountRole;
}

export interface AuthorizedBotSocket {
  protocol: "auto" | "custom" | "onebot11";
  principal: string;
}

interface SessionRow {
  id: string;
  email: string;
  role: AccountRole;
  mfaVerified: number;
}

export async function handleAccountRoute(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/v1/auth/me") {
    if (request.method !== "GET") throw new HttpError(405, "只支持 GET");
    const account = await optionalSession(request, env);
    return json({ ok: true, account, mfaRequired: account?.role === "admin" && !account.mfaVerified });
  }
  if (url.pathname === "/api/v1/auth/register") {
    if (request.method !== "POST") throw new HttpError(405, "只支持 POST");
    requireSameOrigin(request);
    const body = await jsonBody(request);
    const email = normalizedEmail(body.email);
    const password = validPassword(body.password);
    const salt = randomToken(16);
    const accountId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const passwordHash = await derivePassword(password, salt);
    try {
      await env.ALIAS_DB.prepare(`
        INSERT INTO accounts (id, email, password_salt, password_hash, role, created_at)
        VALUES (?, ?, ?, ?, 'user', ?)
      `).bind(accountId, email, salt, passwordHash, createdAt).run();
    } catch (error) {
      if (messageOf(error).includes("UNIQUE constraint failed")) throw new HttpError(409, "该邮箱已注册");
      throw error;
    }
    return createSessionResponse(env, { id: accountId, email, role: "user", mfaVerified: true }, 201);
  }
  if (url.pathname === "/api/v1/auth/login") {
    if (request.method !== "POST") throw new HttpError(405, "只支持 POST");
    requireSameOrigin(request);
    const body = await jsonBody(request);
    const email = normalizedEmail(body.email);
    const password = validPassword(body.password);
    const account = await env.ALIAS_DB.prepare(`
      SELECT id, email, role, password_salt, password_hash
      FROM accounts WHERE email = ?
    `).bind(email).first<AccountRow>();
    const candidate = await derivePassword(password, account?.password_salt ?? FAKE_PASSWORD_SALT);
    if (!account || !constantTimeText(candidate, account.password_hash ?? FAKE_PASSWORD_HASH)) throw new HttpError(401, "邮箱或密码错误");
    const hasTotp = account.role === "admin" && Boolean(await env.ALIAS_DB.prepare("SELECT 1 AS present FROM account_totp WHERE account_id = ?").bind(account.id).first());
    if (account.role === "admin" && !hasTotp) throw new HttpError(503, "管理员尚未配置 Authenticator，请联系部署者恢复");
    return createSessionResponse(env, { id: account.id, email: account.email, role: account.role, mfaVerified: account.role !== "admin" });
  }
  if (url.pathname === "/api/v1/auth/logout") {
    if (request.method !== "POST") throw new HttpError(405, "只支持 POST");
    requireSameOrigin(request);
    const token = cookieValue(request, SESSION_COOKIE);
    if (token) await env.ALIAS_DB.prepare("DELETE FROM account_sessions WHERE token_hash = ?").bind(await tokenHash(token)).run();
    return json({ ok: true }, { headers: { "set-cookie": clearSessionCookie() } });
  }
  if (url.pathname === "/api/v1/auth/bootstrap-admin") {
    if (request.method !== "POST") throw new HttpError(405, "只支持 POST");
    requireSameOrigin(request);
    const account = await requirePasswordSession(request, env);
    const body = await jsonBody(request);
    const bootstrapToken = typeof body.bootstrapToken === "string" ? body.bootstrapToken : "";
    if (!env.ADMIN_BOOTSTRAP_TOKEN || !constantTimeText(bootstrapToken, env.ADMIN_BOOTSTRAP_TOKEN)) {
      throw new HttpError(401, "管理员激活密钥无效");
    }
    const secret = base32Encode(crypto.getRandomValues(new Uint8Array(20)));
    const encrypted = await encryptTotpSecret(secret, env);
    const [promotion] = await env.ALIAS_DB.batch([
      env.ALIAS_DB.prepare(`
        UPDATE accounts SET role = 'admin'
        WHERE id = ? AND role != 'admin' AND NOT EXISTS (SELECT 1 FROM accounts WHERE role = 'admin')
      `).bind(account.id),
      env.ALIAS_DB.prepare(`
        INSERT INTO account_totp (account_id, encrypted_secret, confirmed_at)
        SELECT id, ?, NULL FROM accounts WHERE id = ? AND role = 'admin'
        ON CONFLICT(account_id) DO NOTHING
      `).bind(encrypted, account.id),
      env.ALIAS_DB.prepare("UPDATE account_sessions SET mfa_verified = 0 WHERE account_id = ?").bind(account.id),
    ]);
    if (!promotion?.meta.changes) throw new HttpError(409, "首位管理员已经激活");
    const admin = { ...account, role: "admin" as const, mfaVerified: false };
    return json({ ok: true, account: admin, mfaRequired: true, totpSetup: { secret, uri: totpUri(account.email, secret) } });
  }
  if (url.pathname === "/api/v1/auth/totp/verify") {
    if (request.method !== "POST") throw new HttpError(405, "只支持 POST");
    requireSameOrigin(request);
    const account = await requirePasswordSession(request, env);
    if (account.role !== "admin") throw new HttpError(403, "普通用户不需要 Authenticator");
    const body = await jsonBody(request);
    const code = typeof body.code === "string" ? body.code.replaceAll(" ", "") : "";
    const totp = await env.ALIAS_DB.prepare("SELECT encrypted_secret, last_counter FROM account_totp WHERE account_id = ?").bind(account.id).first<{ encrypted_secret: string; last_counter: number }>();
    if (!totp) throw new HttpError(409, "管理员尚未配置 Authenticator");
    const secret = await decryptTotpSecret(totp.encrypted_secret, env);
    const matchedCounter = await matchingTotpCounter(secret, code, Number(totp.last_counter));
    if (matchedCounter === null) throw new HttpError(401, "动态验证码无效、已过期或已使用");
    const sessionToken = cookieValue(request, SESSION_COOKIE);
    const totpUpdate = await env.ALIAS_DB.prepare(`
      UPDATE account_totp SET confirmed_at = COALESCE(confirmed_at, ?), last_counter = ?
      WHERE account_id = ? AND last_counter < ?
    `).bind(new Date().toISOString(), matchedCounter, account.id, matchedCounter).run();
    if (!totpUpdate.meta.changes) throw new HttpError(401, "动态验证码已经使用");
    await env.ALIAS_DB.prepare("UPDATE account_sessions SET mfa_verified = 1 WHERE token_hash = ? AND account_id = ?").bind(await tokenHash(sessionToken), account.id).run();
    return json({ ok: true, account: { ...account, mfaVerified: true }, mfaRequired: false });
  }
  if (url.pathname === "/api/v1/credentials") {
    if (request.method === "GET") return listCredentials(request, env);
    if (request.method === "POST") return createCredential(request, env);
    throw new HttpError(405, "只支持 GET 或 POST");
  }
  const credentialMatch = CREDENTIAL_ROUTE.exec(url.pathname);
  if (credentialMatch) {
    if (request.method !== "DELETE") throw new HttpError(405, "只支持 DELETE");
    requireSameOrigin(request);
    const account = await requireSession(request, env);
    const result = await env.ALIAS_DB.prepare(`
      UPDATE bot_credentials SET revoked_at = ?
      WHERE id = ? AND account_id = ? AND revoked_at IS NULL
    `).bind(new Date().toISOString(), credentialMatch[1], account.id).run();
    if (!result.meta.changes) throw new HttpError(404, "未找到该 credential");
    return json({ ok: true });
  }
  return null;
}

export async function requireSession(request: Request, env: Env): Promise<AccountSession> {
  const account = await requirePasswordSession(request, env);
  if (account.role === "admin" && !account.mfaVerified) throw new HttpError(401, "请输入 Authenticator 动态验证码");
  return account;
}

async function requirePasswordSession(request: Request, env: Env): Promise<AccountSession> {
  const account = await optionalSession(request, env);
  if (!account) throw new HttpError(401, "请先登录");
  return account;
}

export async function requireAdminSession(request: Request, env: Env): Promise<AccountSession> {
  const account = await requireSession(request, env);
  if (account.role !== "admin") throw new HttpError(403, "仅管理员可访问");
  return account;
}

export async function requireAuditAccess(request: Request, env: Env): Promise<void> {
  const session = await optionalSession(request, env);
  if (session?.role === "admin" && session.mfaVerified) return;
  const credential = await credentialFromRequest(request, env);
  if (credential?.scope === "audit" && credential.role === "admin") return;
  throw new HttpError(401, "管理员未授权");
}

export async function requireSystemAccess(request: Request, env: Env): Promise<void> {
  if (!env.BOT_WS_TOKEN) throw new HttpError(503, "尚未配置系统 Token");
  if (!(await staticTokenMatches(request, env.BOT_WS_TOKEN))) throw new HttpError(401, "游戏数据端未授权");
}

export async function authorizeBotSocket(request: Request, env: Env, protocol: string): Promise<AuthorizedBotSocket> {
  if (!/^(auto|custom|onebot11)$/.test(protocol)) throw new HttpError(400, "protocol 只支持 auto、custom 或 onebot11");
  if (env.BOT_WS_TOKEN && await staticTokenMatches(request, env.BOT_WS_TOKEN)) {
    return { protocol: protocol as AuthorizedBotSocket["protocol"], principal: "system" };
  }
  if (protocol === "custom") throw new HttpError(401, "自定义数据端仅接受系统凭据");
  const credential = await credentialFromRequest(request, env);
  if (!credential || (credential.scope !== "bot" && credential.scope !== "audit")) throw new HttpError(401, "Bot credential 无效");
  return { protocol: "onebot11", principal: `credential:${credential.id}` };
}

export async function requirePublicApiAccess(request: Request, env: Env): Promise<void> {
  if (!env.PUBLIC_API_TOKEN) return;
  if (await staticTokenMatches(request, env.PUBLIC_API_TOKEN)) return;
  const credential = await credentialFromRequest(request, env);
  if (credential?.scope === "bot" || credential?.scope === "audit") return;
  throw new HttpError(401, "API credential 无效");
}

async function optionalSession(request: Request, env: Env): Promise<AccountSession | null> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) return null;
  const row = await env.ALIAS_DB.prepare(`
    SELECT a.id, a.email, a.role, s.mfa_verified AS mfaVerified
    FROM account_sessions s JOIN accounts a ON a.id = s.account_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).bind(await tokenHash(token), new Date().toISOString()).first<SessionRow>();
  return row ? { ...row, mfaVerified: Boolean(row.mfaVerified) } : null;
}

async function createSessionResponse(env: Env, account: AccountSession, status = 200): Promise<Response> {
  const token = randomToken(32);
  const now = Date.now();
  await env.ALIAS_DB.prepare(`
    INSERT INTO account_sessions (token_hash, account_id, mfa_verified, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(await tokenHash(token), account.id, account.mfaVerified ? 1 : 0, new Date(now + SESSION_SECONDS * 1000).toISOString(), new Date(now).toISOString()).run();
  return json({ ok: true, account, mfaRequired: account.role === "admin" && !account.mfaVerified }, { status, headers: { "set-cookie": sessionCookie(token) } });
}

async function listCredentials(request: Request, env: Env): Promise<Response> {
  const account = await requireSession(request, env);
  const result = await env.ALIAS_DB.prepare(`
    SELECT id, scope, label, token_hint AS tokenHint, created_at AS createdAt
    FROM bot_credentials
    WHERE account_id = ? AND revoked_at IS NULL
    ORDER BY created_at DESC LIMIT 20
  `).bind(account.id).all();
  return json({ ok: true, account, credentials: result.results });
}

async function createCredential(request: Request, env: Env): Promise<Response> {
  requireSameOrigin(request);
  const account = await requireSession(request, env);
  const body = await jsonBody(request);
  const scope = body.scope === "audit" ? "audit" : body.scope === "bot" ? "bot" : null;
  if (!scope) throw new HttpError(400, "scope 只支持 bot 或 audit");
  if (scope === "audit" && account.role !== "admin") throw new HttpError(403, "只有管理员可以签发 audit credential");
  const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : scope === "audit" ? "Audit" : "OneBot";
  if (label.length > 40) throw new HttpError(400, "名称不能超过 40 个字符");
  const count = await env.ALIAS_DB.prepare(`
    SELECT COUNT(*) AS count FROM bot_credentials
    WHERE account_id = ? AND scope = ? AND revoked_at IS NULL
  `).bind(account.id, scope).first<{ count: number }>();
  if (Number(count?.count ?? 0) >= MAX_ACTIVE_CREDENTIALS_PER_SCOPE) {
    throw new HttpError(409, `每种类型最多保留 ${MAX_ACTIVE_CREDENTIALS_PER_SCOPE} 个 credential，请先撤销旧项`);
  }
  const raw = `andory_${scope}_${randomToken(32)}`;
  const credential = {
    id: crypto.randomUUID(),
    scope,
    label,
    tokenHint: raw.slice(-6),
    createdAt: new Date().toISOString(),
  };
  await env.ALIAS_DB.prepare(`
    INSERT INTO bot_credentials (id, account_id, scope, label, token_hash, token_hint, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(credential.id, account.id, scope, label, await tokenHash(raw), credential.tokenHint, credential.createdAt).run();
  return json({ ok: true, credential: { ...credential, value: raw, shownOnce: true } }, { status: 201 });
}

async function credentialFromRequest(request: Request, env: Env): Promise<CredentialRow | null> {
  const token = bearerToken(request);
  if (!token.startsWith("andory_")) return null;
  return env.ALIAS_DB.prepare(`
    SELECT c.id, c.scope, a.role
    FROM bot_credentials c JOIN accounts a ON a.id = c.account_id
    WHERE c.token_hash = ? AND c.revoked_at IS NULL
  `).bind(await tokenHash(token)).first<CredentialRow>();
}

async function staticTokenMatches(request: Request, expected: string): Promise<boolean> {
  return constantTimeText(bearerToken(request), expected);
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get("Authorization");
  return authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : new URL(request.url).searchParams.get("token") ?? "";
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > 8192) throw new HttpError(413, "请求体过大");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > 8192) throw new HttpError(413, "请求体过大");
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "请求体必须是 JSON 对象");
  }
}

function normalizedEmail(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "请输入邮箱");
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "邮箱格式无效");
  return email;
}

function validPassword(value: unknown): string {
  if (typeof value !== "string" || value.length < 10 || value.length > 128) throw new HttpError(400, "密码长度应为 10–128 个字符");
  return value;
}

async function encryptTotpSecret(secret: string, env: Env): Promise<string> {
  if (!env.AUTH_ENCRYPTION_KEY) throw new HttpError(503, "尚未配置 Authenticator 加密密钥");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await authEncryptionKey(env.AUTH_ENCRYPTION_KEY, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(secret));
  return `${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`;
}

async function decryptTotpSecret(value: string, env: Env): Promise<string> {
  if (!env.AUTH_ENCRYPTION_KEY) throw new HttpError(503, "尚未配置 Authenticator 加密密钥");
  const [iv, ciphertext] = value.split(".");
  if (!iv || !ciphertext) throw new HttpError(500, "Authenticator 配置损坏");
  const key = await authEncryptionKey(env.AUTH_ENCRYPTION_KEY, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(iv) }, key, fromBase64Url(ciphertext));
  return new TextDecoder().decode(plaintext);
}

async function authEncryptionKey(secret: string, usages: KeyUsage[]): Promise<CryptoKey> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, usages);
}

async function matchingTotpCounter(secret: string, code: string, lastCounter: number): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const counter = Math.floor(Date.now() / 30_000);
  for (const drift of [-1, 0, 1]) {
    const candidateCounter = counter + drift;
    if (candidateCounter > lastCounter && constantTimeText(await totpCode(secret, candidateCounter), code)) return candidateCounter;
  }
  return null;
}

async function totpCode(secret: string, counter: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", base32Decode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const message = new Uint8Array(8);
  let value = BigInt(counter);
  for (let index = 7; index >= 0; index -= 1) {
    message[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(binary % 1_000_000).padStart(6, "0");
}

function base32Encode(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0, output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(value: string): Uint8Array<ArrayBuffer> {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, buffer = 0;
  const output: number[] = [];
  for (const character of value.replaceAll("=", "").toUpperCase()) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new HttpError(500, "Authenticator 配置损坏");
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const bytes = new Uint8Array(output.length);
  bytes.set(output);
  return bytes;
}

function totpUri(email: string, secret: string): string {
  const label = encodeURIComponent(`Andory:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=Andory&algorithm=SHA1&digits=6&period=30`;
}

async function derivePassword(password: string, salt: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: fromBase64Url(salt), iterations: PASSWORD_ITERATIONS }, key, 256);
  return toBase64Url(new Uint8Array(bits));
}

async function tokenHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomToken(bytes: number): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function toBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function constantTimeText(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) difference |= (a[index % (a.length || 1)] ?? 0) ^ (b[index % (b.length || 1)] ?? 0);
  return difference === 0;
}

function cookieValue(request: Request, name: string): string {
  for (const item of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = item.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`;
}

function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

function requireSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw new HttpError(403, "跨站请求已拒绝");
}

function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(JSON.stringify(value), { ...init, headers });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
