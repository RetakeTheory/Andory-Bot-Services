import { createDecipheriv, createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fields } from "./game-client.mjs";
import sharp from "sharp";

const execFileAsync = promisify(execFile);

// These are the public Octo client keys shipped with the game.  Environment
// overrides make it possible to roll a key without changing source code when
// a future App Store release rotates them.
const DEFAULT_OCTO_KEY = "B46OtKlGGHoz6sxbOWDe3VUvBsagXxr5av38IQIKUKo=";
const DEFAULT_APP_OCTO_KEY = "CwFhQ+S5m4nERWVaq5oFZIP0cZLc0j7O/zllG0UYVNo=";
const DEFAULT_OCTO_VERSION = "200001";
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const COMMON_ICON_ATLAS = "debug_local_commonicon_atlas";
const CARD_ATTRIBUTE_SPRITES = Object.freeze({
  1: "ui_999_ico_element_cute_cl",
  2: "ui_999_ico_element_pure_cl",
  3: "ui_999_ico_element_happy_cl",
});
const CARD_RARITY_SPRITE = "ui_999_ico_star_rare_s";

const PYTHON_DEFAULT = "C:\\Users\\user\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe";

export class GameAssetStore {
  constructor(region, options = {}) {
    if (region !== "jp" && region !== "global") throw new Error(`Unsupported asset region: ${region}`);
    this.region = region;
    this.client = options.client;
    this.dataDir = options.dataDir ?? path.resolve(".data");
    this.catalogFile = path.join(this.dataDir, "assets", "catalog", `${region}.json`);
    this.bundleDir = path.join(this.dataDir, "assets", "bundles", region);
    this.imageDir = path.join(this.dataDir, "assets", "images", region);
    this.python = options.python ?? process.env.HOLODORI_PYTHON ?? PYTHON_DEFAULT;
    this.catalogPromise = undefined;
    this.imagePromises = new Map();
    this.userContentCookie = undefined;
    this.userContentCookiePromise = undefined;
  }

  musicAssetName(music) {
    const item = music?.item && typeof music.item === "object" ? music.item : music;
    const id = stringValue(item?.jacketAssetId) ?? stringValue(item?.assetId) ?? stringValue(item?.id);
    return id ? withAssetPrefix(id, "img_music_jacket_") : undefined;
  }

  cardAssetName(card) {
    const item = card?.item && typeof card.item === "object" ? card.item : card;
    const id = stringValue(item?.assetId);
    return id ? withAssetPrefix(id.replace(/^card-/, ""), "img_card_full_") : undefined;
  }

  async resolveMusicImage(music) {
    const assetName = this.musicAssetName(music);
    return assetName ? this.resolveImage(assetName) : undefined;
  }

  async resolveCardImage(card) {
    const assetName = this.cardAssetName(card);
    return assetName ? this.resolveImage(assetName) : undefined;
  }

  async resolveCardAttributeIcon(card) {
    const item = card?.item && typeof card.item === "object" ? card.item : card;
    const spriteName = CARD_ATTRIBUTE_SPRITES[Number(item?.attributeType)];
    return spriteName ? this.resolveSprite(COMMON_ICON_ATLAS, spriteName) : undefined;
  }

  async resolveCardRarityIcon(card) {
    const item = card?.item && typeof card.item === "object" ? card.item : card;
    const rarity = Number(item?.rarity);
    return Number.isInteger(rarity) && rarity >= 3 && rarity <= 5
      ? this.resolveSprite(COMMON_ICON_ATLAS, CARD_RARITY_SPRITE)
      : undefined;
  }

  characterAssetName(character) {
    const item = character?.item && typeof character.item === "object" ? character.item : character;
    const explicit = stringValue(item?.characterImageAssetName);
    if (explicit) return explicit;
    const id = stringValue(item?.assetId);
    return id ? `img_chr_full_2d_${id.replace(/^img_chr_full_2d_/, "")}` : undefined;
  }

  async resolveCharacterImage(character) {
    const assetName = this.characterAssetName(character);
    return assetName ? this.resolveImage(assetName) : undefined;
  }

  characterMotifAssetName(character) {
    const item = character?.item && typeof character.item === "object" ? character.item : character;
    const explicit = stringValue(item?.representativeObjectAssetName);
    if (explicit) return explicit;
    const id = stringValue(item?.assetId);
    return id ? `img_chr_motif_icon_default_main_${id.replace(/^img_chr_motif_icon_default_main_/, "")}` : undefined;
  }

  async resolveCharacterMotifImage(character) {
    const assetName = this.characterMotifAssetName(character);
    return assetName ? this.resolveImage(assetName) : undefined;
  }

  async resolveImage(assetName) {
    if (!/^[A-Za-z0-9_.-]+$/.test(assetName)) throw new Error(`Unsafe asset name: ${assetName}`);
    return this.resolveCatalogImage(assetName, assetName);
  }

  async resolveSprite(catalogAssetName, spriteName) {
    if (!/^[A-Za-z0-9_.-]+$/.test(catalogAssetName) || !/^[A-Za-z0-9_.-]+$/.test(spriteName)) {
      throw new Error(`Unsafe shared sprite name: ${catalogAssetName}/${spriteName}`);
    }
    return this.resolveCatalogImage(catalogAssetName, spriteName);
  }

  async getUserContentCdnCookie() {
    const now = Date.now();
    if (this.userContentCookie?.expiresAt > now + 60_000) return this.userContentCookie.value;
    if (!this.client?.getUserContentCdnSignedCookie) throw new Error(`${this.region}: game client cannot obtain a user-content cookie`);
    let promise = this.userContentCookiePromise;
    if (!promise) {
      promise = this.client.getUserContentCdnSignedCookie().then((signed) => {
        const policy = stringValue(signed?.policy);
        const expiresAt = Number(signed?.expiredTimeMilliseconds);
        if (!policy || !/^URLPrefix=.+:Expires=\d+:KeyName=.+:Signature=.+$/.test(policy)) {
          throw new Error(`${this.region}: invalid user-content CDN policy`);
        }
        const value = `Cloud-CDN-Cookie=${policy}`;
        this.userContentCookie = { value, expiresAt: Number.isFinite(expiresAt) ? expiresAt : now + 5 * 60_000 };
        return value;
      });
      this.userContentCookiePromise = promise;
    }
    try {
      return await promise;
    } finally {
      if (this.userContentCookiePromise === promise) this.userContentCookiePromise = undefined;
    }
  }

  async resolveCatalogImage(catalogAssetName, requestedName) {
    const cacheKey = `${catalogAssetName}#${requestedName}`;
    let promise = this.imagePromises.get(cacheKey);
    if (!promise) {
      promise = this.loadImage(catalogAssetName, requestedName);
      this.imagePromises.set(cacheKey, promise);
    }
    try {
      return await promise;
    } catch (error) {
      this.imagePromises.delete(cacheKey);
      throw error;
    }
  }

  async loadImage(catalogAssetName, requestedName) {
    const catalog = await this.getCatalog();
    const entry = catalog.entries[catalogAssetName];
    if (!entry) throw new Error(`${this.region}: asset not found in Octo catalog: ${catalogAssetName}`);
    await mkdir(this.bundleDir, { recursive: true });
    await mkdir(this.imageDir, { recursive: true });
    const imagePath = path.join(this.imageDir, `${requestedName}.png`);
    try {
      const info = await stat(imagePath);
      if (info.size > 0) {
        // Extracted files are normalized before being written. Re-running
        // sharp on every Bot restart adds hundreds of milliseconds to the
        // first card/music/profile render without changing the pixels.
        const png = await readFile(imagePath);
        return imageResult(requestedName, imagePath, png);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    const bundlePath = path.join(this.bundleDir, entry.objectName || catalogAssetName);
    let bundle;
    try {
      bundle = await readFile(bundlePath);
      if (entry.size && bundle.length !== entry.size) throw new Error("cached bundle size mismatch");
      if (entry.md5 && md5(bundle) !== entry.md5.toLowerCase()) throw new Error("cached bundle checksum mismatch");
    } catch {
      bundle = await this.download(entry);
      await writeFile(bundlePath, bundle);
    }

    const extracted = await extractUnityImage(this.python, bundlePath, imagePath, requestedName, catalogAssetName);
    const png = await optimizePng(await readFile(imagePath), requestedName);
    await writeFile(imagePath, png);
    return {
      ...imageResult(requestedName, imagePath, png),
      width: Number(extracted.width) || undefined,
      height: Number(extracted.height) || undefined,
      objectType: extracted.type,
    };
  }

  async download(entry) {
    const response = await fetch(entry.url, { headers: { accept: "application/octet-stream" } });
    if (!response.ok) throw new Error(`${this.region}: asset download failed (${response.status}) ${entry.url}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (entry.size && bytes.length !== entry.size) {
      throw new Error(`${this.region}: asset size mismatch for ${entry.name} (${bytes.length} != ${entry.size})`);
    }
    if (entry.md5 && md5(bytes) !== entry.md5.toLowerCase()) {
      throw new Error(`${this.region}: asset checksum mismatch for ${entry.name}`);
    }
    return bytes;
  }

  async getCatalog() {
    let promise = this.catalogPromise;
    if (!promise) {
      promise = this.loadCatalog();
      this.catalogPromise = promise;
    }
    try {
      return await promise;
    } catch (error) {
      this.catalogPromise = undefined;
      throw error;
    }
  }

  async loadCatalog() {
    const cached = await readJson(this.catalogFile);
    const ttl = positiveNumber(process.env.HOLODORI_ASSET_CATALOG_TTL_MS) ?? CATALOG_TTL_MS;
    if (cached?.entries && Date.now() - Number(cached.fetchedAt || 0) < ttl) return cached;
    try {
      const fresh = await this.fetchCatalog();
      await mkdir(path.dirname(this.catalogFile), { recursive: true });
      await writeFile(this.catalogFile, `${JSON.stringify(fresh)}\n`, "utf8");
      return fresh;
    } catch (error) {
      if (cached?.entries) {
        console.warn(`${this.region}: Octo catalog refresh failed; using cached revision ${cached.revisionId ?? "?"}:`, error instanceof Error ? error.message : error);
        return cached;
      }
      throw error;
    }
  }

  async fetchCatalog() {
    const system = this.client?.getSystemInfo ? await this.client.getSystemInfo() : undefined;
    const host = String(system?.apiHost || (this.region === "jp" ? "jp.game-hololive-dreams.com/asset" : "us.game-hololive-dreams.com/asset"))
      .replace(/^https?:\/\//, "")
      .replace(/\/+$/, "");
    const envId = positiveNumber(system?.assetEnvId) ?? 5;
    const version = process.env.HOLODORI_OCTO_VERSION ?? DEFAULT_OCTO_VERSION;
    const gen = process.env.HOLODORI_OCTO_GENERATION ?? "0";
    const override = process.env[`HOLODORI_${this.region === "jp" ? "JP" : "GLOBAL"}_OCTO_LIST_URL`];
    const endpoint = (override || `https://${host}/v2/pub/a/${envId}/v/${version}/list/{gen}`).replace("{gen}", encodeURIComponent(gen));
    const octoKey = process.env.HOLODORI_OCTO_KEY ?? DEFAULT_OCTO_KEY;
    const appOctoKey = process.env.HOLODORI_APP_OCTO_KEY ?? DEFAULT_APP_OCTO_KEY;
    const response = await fetch(endpoint, {
      headers: {
        "X-OCTO-KEY": octoKey,
        "X-APP-OCTO-KEY": appOctoKey,
        accept: "application/x-protobuf",
      },
    });
    if (!response.ok) throw new Error(`${this.region}: Octo catalog failed (${response.status}) ${endpoint}`);
    const body = Buffer.from(await response.arrayBuffer());
    const database = decodeOctoCatalog(decryptCatalog(body, octoKey));
    const entries = {};
    for (const entry of [...database.assetBundles, ...database.resources]) {
      if (!entry.name || !entry.objectName) continue;
      entries[entry.name] = {
        name: entry.name,
        objectName: entry.objectName,
        size: entry.size,
        md5: entry.md5,
        url: database.urlFormat.replace("{o}", entry.objectName),
      };
    }
    return {
      fetchedAt: Date.now(),
      region: this.region,
      revisionId: database.revisionId,
      serverTime: database.serverTime,
      urlFormat: database.urlFormat,
      entries,
    };
  }
}

export function contentAssetName(kind, data) {
  const item = data?.item && typeof data.item === "object" ? data.item : data;
  if (kind === "music") {
    const id = stringValue(item?.jacketAssetId) ?? stringValue(item?.assetId) ?? stringValue(item?.id);
    return id ? withAssetPrefix(id, "img_music_jacket_") : undefined;
  }
  if (kind === "card") {
    const id = stringValue(item?.assetId);
    return id ? withAssetPrefix(id.replace(/^card-/, ""), "img_card_full_") : undefined;
  }
  if (kind === "character") {
    const explicit = stringValue(item?.characterImageAssetName);
    if (explicit) return explicit;
    const id = stringValue(item?.assetId);
    return id ? `img_chr_full_2d_${id.replace(/^img_chr_full_2d_/, "")}` : undefined;
  }
  return undefined;
}

export async function attachContentImage(store, kind, data) {
  const assetName = contentAssetName(kind, data);
  const motifAssetName = kind === "character" ? store.characterMotifAssetName(data) : undefined;
  if (!assetName && !motifAssetName) return data;
  try {
    const images = kind === "character"
      ? await Promise.allSettled([store.resolveCharacterImage(data), store.resolveCharacterMotifImage(data)])
      : kind === "card"
        ? await Promise.allSettled([
            store.resolveCardImage(data),
            store.resolveCardAttributeIcon(data),
            store.resolveCardRarityIcon(data),
          ])
        : await Promise.allSettled([store.resolveMusicImage(data)]);
    const image = images[0]?.status === "fulfilled" ? images[0].value : undefined;
    const secondaryImage = images[1]?.status === "fulfilled" ? images[1].value : undefined;
    const tertiaryImage = images[2]?.status === "fulfilled" ? images[2].value : undefined;
    if (!image && !secondaryImage && !tertiaryImage) throw images.find((result) => result?.status === "rejected")?.reason ?? new Error("image unavailable");
    const base = data && typeof data === "object" ? data : {};
    const item = base.item && typeof base.item === "object" ? base.item : base;
    const enrichedItem = {
      ...item,
      ...(kind === "music" && image
          ? { jacketBase64: image.base64, jacketMimeType: image.mimeType }
          : kind === "card"
            ? {
                ...(image ? { artBase64: image.base64, artMimeType: image.mimeType } : {}),
                ...(secondaryImage ? { attributeIconBase64: secondaryImage.base64, attributeIconMimeType: secondaryImage.mimeType } : {}),
                ...(tertiaryImage ? { rarityIconBase64: tertiaryImage.base64, rarityIconMimeType: tertiaryImage.mimeType } : {}),
              }
          : {
              ...(image ? { characterBase64: image.base64, characterMimeType: image.mimeType } : {}),
              ...(secondaryImage ? { representativeObjectBase64: secondaryImage.base64, representativeObjectMimeType: secondaryImage.mimeType } : {}),
            }),
    };
    return base.item && typeof base.item === "object" ? { ...base, item: enrichedItem } : enrichedItem;
  } catch (error) {
    // Art is supplementary: a catalog outage must not make the ranking/content
    // query itself fail. The renderer will show its deterministic placeholder.
    console.warn(`${store.region}: art import failed for ${assetName}:`, error instanceof Error ? error.message : error);
    return data;
  }
}

async function extractUnityImage(python, bundlePath, imagePath, assetName, bundleAssetName = assetName) {
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/extract-unity-image.py");
  const candidates = [python, "python", "python3", "py"];
  let lastError;
  for (const command of [...new Set(candidates.filter(Boolean))]) {
    try {
      const scriptArgs = [script, bundlePath, "--name", assetName, "--bundle-name", bundleAssetName, "--output", imagePath];
      const args = command === "py" ? ["-3", ...scriptArgs] : scriptArgs;
      const result = await execFileAsync(command, args, { cwd: path.resolve("."), maxBuffer: 1024 * 1024, windowsHide: true });
      const line = String(result.stdout).trim().split(/\r?\n/).at(-1);
      return JSON.parse(line);
    } catch (error) {
      lastError = error;
      if (error?.code !== "ENOENT" && !/not found|cannot find/i.test(String(error?.message ?? ""))) throw error;
    }
  }
  throw lastError ?? new Error("Python runtime unavailable for Unity image extraction");
}

function decodeOctoCatalog(payload) {
  const database = { revisionId: 0, urlFormat: "", serverTime: 0, assetBundles: [], resources: [] };
  for (const { field, wire, value } of fields(payload)) {
    if (field === 1 && wire === 0) database.revisionId = Number(value);
    else if (field === 2 && Buffer.isBuffer(value)) database.assetBundles.push(decodeOctoEntry(value));
    else if (field === 3 && Buffer.isBuffer(value)) database.resources.push(decodeOctoEntry(value));
    else if (field === 4 && Buffer.isBuffer(value)) database.urlFormat = value.toString("utf8");
    else if (field === 7 && wire === 0) database.serverTime = Number(value);
  }
  return database;
}

function decodeOctoEntry(payload) {
  const entry = { id: 0, name: "", size: 0, md5: "", objectName: "", dependencies: [] };
  for (const { field, wire, value } of fields(payload)) {
    if (field === 1 && wire === 0) entry.id = Number(value);
    else if (field === 2 && Buffer.isBuffer(value)) entry.name = value.toString("utf8");
    else if (field === 3 && wire === 0) entry.size = Number(value);
    else if (field === 5 && Buffer.isBuffer(value)) entry.md5 = value.toString("utf8");
    else if (field === 6 && Buffer.isBuffer(value)) entry.dependencies = packedVarints(value);
    else if (field === 7 && Buffer.isBuffer(value)) entry.objectName = value.toString("utf8");
  }
  return entry;
}

function decryptCatalog(body, apiKey) {
  if (body.length < 32) throw new Error(`Octo catalog is too short (${body.length} bytes)`);
  const key = createHash("sha256").update(apiKey, "utf8").digest();
  const decipher = createDecipheriv("aes-256-cbc", key, body.subarray(0, 16));
  const plain = Buffer.concat([decipher.update(body.subarray(16)), decipher.final()]);
  const pad = plain.at(-1);
  return pad > 0 && pad <= 16 ? plain.subarray(0, plain.length - pad) : plain;
}

function packedVarints(payload) {
  const values = [];
  let offset = 0;
  while (offset < payload.length) {
    const [value, next] = readVarint(payload, offset);
    values.push(Number(value));
    offset = next;
  }
  return values;
}

function readVarint(payload, offset) {
  let value = 0n;
  let shift = 0n;
  while (offset < payload.length) {
    const byte = payload[offset++];
    value |= BigInt(byte & 0x7f) << shift;
    if (!(byte & 0x80)) return [value, offset];
    shift += 7n;
  }
  throw new Error("Truncated Octo varint");
}

function imageResult(assetName, filePath, png) {
  return { assetName, path: filePath, mimeType: "image/png", base64: png.toString("base64") };
}

async function optimizePng(value, assetName = "") {
  const pipeline = sharp(value);
  if (assetName.startsWith("img_chr_full_2d_")) pipeline.trim();
  return pipeline
    .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}

function md5(value) {
  return createHash("md5").update(value).digest("hex");
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function stringValue(value) {
  return typeof value === "string" && value ? value : undefined;
}

function withAssetPrefix(value, prefix) {
  return value.startsWith(prefix) ? value : `${prefix}${value}`;
}
