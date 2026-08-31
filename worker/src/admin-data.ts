import { requireAdminSession, requireSystemAccess } from "./auth";
import { HttpError } from "./model";

const JOB_PREFIX = "admin/jobs/";
const IPA_PREFIX = "admin/ipa/";
const CURRENT_PREFIX = "admin/current/";
const PART_SIZE = 10 * 1024 * 1024;
const MAX_IPA_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_PART_BYTES = 12 * 1024 * 1024;
const JOB_RETENTION_MS = 14 * 24 * 60 * 60_000;
const UPLOAD_RETENTION_MS = 24 * 60 * 60_000;
const UPLOAD_PART_ROUTE = /^\/api\/v1\/admin\/uploads\/([0-9a-f-]{36})\/parts\/(\d+)$/i;
const UPLOAD_COMPLETE_ROUTE = /^\/api\/v1\/admin\/uploads\/([0-9a-f-]{36})\/complete$/i;
const UPLOAD_ABORT_ROUTE = /^\/api\/v1\/admin\/uploads\/([0-9a-f-]{36})$/i;
const INTERNAL_DOWNLOAD_ROUTE = /^\/internal\/admin\/jobs\/([0-9a-f-]{36})\/ipa$/i;
const INTERNAL_COMPLETE_ROUTE = /^\/internal\/admin\/jobs\/([0-9a-f-]{36})\/complete$/i;

type Region = "jp" | "global";
type JobKind = "ipa" | "master-refresh";
type JobStatus = "uploading" | "queued" | "processing" | "completed" | "failed" | "aborted";

interface AdminJob {
  id: string;
  kind: JobKind;
  region: Region;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  fileName?: string;
  declaredSize?: number;
  objectKey?: string;
  uploadId?: string;
  result?: Record<string, unknown>;
  error?: string;
}

export async function handleAdminDataRoute(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/v1/admin/")) return null;
  const account = await requireAdminSession(request, env);
  if (url.pathname === "/api/v1/admin/data/status") {
    if (request.method !== "GET") throw new HttpError(405, "只支持 GET");
    const [jobs, jp, global] = await Promise.all([
      recentJobs(env.ADMIN_DATA),
      readJson<Record<string, unknown>>(env.ADMIN_DATA, `${CURRENT_PREFIX}jp.json`),
      readJson<Record<string, unknown>>(env.ADMIN_DATA, `${CURRENT_PREFIX}global.json`),
    ]);
    return json({ ok: true, current: { jp, global }, jobs });
  }
  if (url.pathname === "/api/v1/admin/master/refresh") {
    if (request.method !== "POST") throw new HttpError(405, "只支持 POST");
    requireSameOrigin(request);
    const body = await jsonBody(request, 2048);
    const region = validRegion(body.region);
    const job = newJob("master-refresh", region, account.id);
    job.status = "queued";
    await writeJob(env.ADMIN_DATA, job);
    await notifyDataBot(env);
    return json({ ok: true, job }, { status: 202 });
  }
  if (url.pathname === "/api/v1/admin/uploads") {
    if (request.method !== "POST") throw new HttpError(405, "只支持 POST");
    requireSameOrigin(request);
    const body = await jsonBody(request, 4096);
    const region = validRegion(body.region);
    const fileName = validIpaName(body.fileName);
    const declaredSize = Number(body.size);
    if (!Number.isSafeInteger(declaredSize) || declaredSize < 1 || declaredSize > MAX_IPA_BYTES) {
      throw new HttpError(400, "IPA 大小无效或超过 4 GiB 上限");
    }
    const job = newJob("ipa", region, account.id);
    job.fileName = fileName;
    job.declaredSize = declaredSize;
    job.objectKey = `${IPA_PREFIX}${region}/${job.id}.ipa`;
    const upload = await env.ADMIN_DATA.createMultipartUpload(job.objectKey, {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: { region, jobId: job.id },
    });
    job.uploadId = upload.uploadId;
    await writeJob(env.ADMIN_DATA, job);
    return json({ ok: true, job, uploadId: upload.uploadId, partSize: PART_SIZE }, { status: 201 });
  }
  const partMatch = UPLOAD_PART_ROUTE.exec(url.pathname);
  if (partMatch) {
    if (request.method !== "PUT") throw new HttpError(405, "只支持 PUT");
    requireSameOrigin(request);
    const job = await ownedUpload(env.ADMIN_DATA, partMatch[1]!, account.id);
    const partNumber = Number(partMatch[2]);
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) throw new HttpError(400, "分块编号无效");
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > MAX_PART_BYTES) throw new HttpError(413, "上传分块过大");
    if (!request.body) throw new HttpError(400, "上传分块为空");
    const upload = env.ADMIN_DATA.resumeMultipartUpload(job.objectKey!, job.uploadId!);
    const part = await upload.uploadPart(partNumber, request.body);
    return json({ ok: true, part });
  }
  const completeMatch = UPLOAD_COMPLETE_ROUTE.exec(url.pathname);
  if (completeMatch) {
    if (request.method !== "POST") throw new HttpError(405, "只支持 POST");
    requireSameOrigin(request);
    const job = await ownedUpload(env.ADMIN_DATA, completeMatch[1]!, account.id);
    const body = await jsonBody(request, 256 * 1024);
    const parts = validParts(body.parts);
    const upload = env.ADMIN_DATA.resumeMultipartUpload(job.objectKey!, job.uploadId!);
    const object = await upload.complete(parts);
    if (object.size !== job.declaredSize) {
      await env.ADMIN_DATA.delete(job.objectKey!);
      job.status = "failed";
      job.error = `上传大小不一致：预期 ${job.declaredSize}，实际 ${object.size}`;
      job.updatedAt = new Date().toISOString();
      await writeJob(env.ADMIN_DATA, job);
      throw new HttpError(400, job.error);
    }
    job.status = "queued";
    job.updatedAt = new Date().toISOString();
    delete job.uploadId;
    await writeJob(env.ADMIN_DATA, job);
    await notifyDataBot(env);
    return json({ ok: true, job }, { status: 202 });
  }
  const abortMatch = UPLOAD_ABORT_ROUTE.exec(url.pathname);
  if (abortMatch) {
    if (request.method !== "DELETE") throw new HttpError(405, "只支持 DELETE");
    requireSameOrigin(request);
    const job = await ownedUpload(env.ADMIN_DATA, abortMatch[1]!, account.id);
    await env.ADMIN_DATA.resumeMultipartUpload(job.objectKey!, job.uploadId!).abort();
    job.status = "aborted";
    job.updatedAt = new Date().toISOString();
    delete job.uploadId;
    await writeJob(env.ADMIN_DATA, job);
    return json({ ok: true, job });
  }
  throw new HttpError(404, "管理员数据接口不存在");
}

export async function handleInternalAdminDataRoute(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/internal/admin/")) return null;
  await requireSystemAccess(request, env);
  if (url.pathname === "/internal/admin/jobs/claim") {
    if (request.method !== "POST") throw new HttpError(405, "只支持 POST");
    const jobs = await recentJobs(env.ADMIN_DATA, 100);
    const job = jobs.filter((item) => item.status === "queued").sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!job) return json({ ok: true, job: null });
    job.status = "processing";
    job.updatedAt = new Date().toISOString();
    await writeJob(env.ADMIN_DATA, job);
    return json({ ok: true, job: publicJob(job), downloadPath: job.kind === "ipa" ? `/internal/admin/jobs/${job.id}/ipa` : undefined });
  }
  const downloadMatch = INTERNAL_DOWNLOAD_ROUTE.exec(url.pathname);
  if (downloadMatch) {
    if (request.method !== "GET") throw new HttpError(405, "只支持 GET");
    const job = await readJob(env.ADMIN_DATA, downloadMatch[1]!);
    if (!job || job.kind !== "ipa" || !job.objectKey || job.status !== "processing") throw new HttpError(404, "IPA 任务不存在");
    const object = await env.ADMIN_DATA.get(job.objectKey);
    if (!object) throw new HttpError(404, "IPA 临时对象不存在");
    return new Response(object.body, {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(object.size),
        "cache-control": "no-store",
      },
    });
  }
  const completeMatch = INTERNAL_COMPLETE_ROUTE.exec(url.pathname);
  if (completeMatch) {
    if (request.method !== "POST") throw new HttpError(405, "只支持 POST");
    const job = await readJob(env.ADMIN_DATA, completeMatch[1]!);
    if (!job) throw new HttpError(404, "任务不存在");
    const body = await jsonBody(request, 64 * 1024);
    const ok = body.ok === true;
    job.status = ok ? "completed" : "failed";
    job.updatedAt = new Date().toISOString();
    job.result = ok && body.result && typeof body.result === "object" && !Array.isArray(body.result)
      ? body.result as Record<string, unknown>
      : undefined;
    job.error = ok ? undefined : String(body.error ?? "任务失败").slice(0, 2000);
    await writeJob(env.ADMIN_DATA, job);
    if (ok && job.result) {
      const previous = await readJson<Record<string, unknown>>(env.ADMIN_DATA, `${CURRENT_PREFIX}${job.region}.json`) ?? {};
      await env.ADMIN_DATA.put(`${CURRENT_PREFIX}${job.region}.json`, JSON.stringify({
        ...previous,
        region: job.region,
        kind: job.kind,
        updatedAt: job.updatedAt,
        ...job.result,
      }), { httpMetadata: { contentType: "application/json" } });
    }
    // IPA is a transient staging object. Delete it after every terminal parse
    // result so third-party binaries never become durable project storage.
    if (job.objectKey) await env.ADMIN_DATA.delete(job.objectKey);
    return json({ ok: true });
  }
  throw new HttpError(404, "系统数据接口不存在");
}

export async function cleanupAdminData(env: Env): Promise<void> {
  const now = Date.now();
  const jobObjects = await env.ADMIN_DATA.list({ prefix: JOB_PREFIX, limit: 1000 });
  for (const object of jobObjects.objects) {
    if (object.uploaded.getTime() >= now - UPLOAD_RETENTION_MS) continue;
    const job = await readJson<AdminJob>(env.ADMIN_DATA, object.key);
    if (job?.status !== "uploading" || !job.objectKey || !job.uploadId) continue;
    try {
      await env.ADMIN_DATA.resumeMultipartUpload(job.objectKey, job.uploadId).abort();
    } catch {
      // R2 may already have expired or completed the multipart upload.
    }
    job.status = "aborted";
    job.error = "上传超过 24 小时未完成，已自动清理";
    job.updatedAt = new Date().toISOString();
    delete job.uploadId;
    await writeJob(env.ADMIN_DATA, job);
  }
  await deleteOlderThan(env.ADMIN_DATA, IPA_PREFIX, now - UPLOAD_RETENTION_MS);
  await deleteOlderThan(env.ADMIN_DATA, JOB_PREFIX, now - JOB_RETENTION_MS);
}

async function notifyDataBot(env: Env): Promise<void> {
  const channel = /^[A-Za-z0-9_-]{1,64}$/.test(env.DEFAULT_CHANNEL) ? env.DEFAULT_CHANNEL : "main";
  await env.BOT_RELAY.getByName(channel).fetch("https://relay/admin/notify", { method: "POST" });
}

function newJob(kind: JobKind, region: Region, createdBy: string): AdminJob {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), kind, region, status: "uploading", createdAt: now, updatedAt: now, createdBy };
}

function validRegion(value: unknown): Region {
  if (value === "jp" || value === "global") return value;
  throw new HttpError(400, "region 只支持 jp 或 global");
}

function validIpaName(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "请选择 IPA 文件");
  const name = value.trim();
  if (!/^[^\\/\u0000-\u001f]{1,180}\.ipa$/iu.test(name)) throw new HttpError(400, "文件必须是 .ipa，且名称不能包含路径");
  return name;
}

function validParts(value: unknown): R2UploadedPart[] {
  if (!Array.isArray(value) || !value.length || value.length > 10_000) throw new HttpError(400, "上传分块清单无效");
  const parts = value.map((item) => {
    const row = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const partNumber = Number(row.partNumber);
    const etag = typeof row.etag === "string" ? row.etag : "";
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000 || !etag || etag.length > 256) throw new HttpError(400, "上传分块清单无效");
    return { partNumber, etag };
  });
  parts.sort((a, b) => a.partNumber - b.partNumber);
  if (parts.some((part, index) => part.partNumber !== index + 1)) throw new HttpError(400, "上传分块编号必须连续");
  return parts;
}

async function ownedUpload(bucket: R2Bucket, id: string, accountId: string): Promise<AdminJob> {
  const job = await readJob(bucket, id);
  if (!job || job.kind !== "ipa" || job.status !== "uploading" || job.createdBy !== accountId || !job.objectKey || !job.uploadId) {
    throw new HttpError(404, "上传任务不存在或已结束");
  }
  return job;
}

async function recentJobs(bucket: R2Bucket, limit = 30): Promise<AdminJob[]> {
  const listed = await bucket.list({ prefix: JOB_PREFIX, limit: Math.max(limit, 100) });
  const rows = (await Promise.all(listed.objects.map((object) => readJson<AdminJob>(bucket, object.key)))).filter((job): job is AdminJob => Boolean(job));
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit).map(publicJob);
}

function publicJob(job: AdminJob): AdminJob {
  const { uploadId: _uploadId, objectKey: _objectKey, createdBy: _createdBy, ...safe } = job;
  return safe as AdminJob;
}

async function readJob(bucket: R2Bucket, id: string): Promise<AdminJob | null> {
  return readJson<AdminJob>(bucket, `${JOB_PREFIX}${id}.json`);
}

async function writeJob(bucket: R2Bucket, job: AdminJob): Promise<void> {
  await bucket.put(`${JOB_PREFIX}${job.id}.json`, JSON.stringify(job), { httpMetadata: { contentType: "application/json" } });
}

async function readJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  try {
    return await object.json<T>();
  } catch {
    return null;
  }
}

async function deleteOlderThan(bucket: R2Bucket, prefix: string, before: number): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    const keys = page.objects.filter((object) => object.uploaded.getTime() < before).map((object) => object.key);
    if (keys.length) await bucket.delete(keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

async function jsonBody(request: Request, limit: number): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > limit) throw new HttpError(413, "请求体过大");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > limit) throw new HttpError(413, "请求体过大");
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "请求体必须是 JSON 对象");
  }
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
