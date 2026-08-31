import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SQLiteAPI } from "@7mind.io/sqlcipher-wasm";
import initSqlcipher from "@7mind.io/sqlcipher-wasm/dist/sqlcipher.mjs";
import { allBytes, firstString, firstVarint } from "./game-client.mjs";

const LANGUAGE_PACK = Object.freeze({ jp: "Jpn", global: "Eng" });
const INDEX_SCHEMA_VERSION = 10;
const REQUIRED_TYPES = Object.freeze([
  "Card",
  "CardLevel",
  "Character",
  "Music",
  "MusicDifficulty",
  "AssetEntry",
  "LivePassiveSkillLevel",
  "LiveActiveSkillLevel",
  "LiveSpecialSkillLevel",
  "SkillTreeConnectEffect",
  "SkillTreeConnectEffectExtent",
  "Emblem",
  "FanMark",
]);
let wasmPromise;

export class MasterDataStore {
  constructor(client) {
    this.client = client;
    this.region = client.region;
    this.cacheFile = path.resolve(".data", "master-index", `${this.region}.json`);
    this.index = undefined;
  }

  async ensure() {
    const version = this.client.masterInfo?.version;
    if (!version) throw new Error(`${this.region}: missing master version`);
    if (this.index?.version === version) return this.index;
    try {
      const cached = JSON.parse(await readFile(this.cacheFile, "utf8"));
      if (cached?.version === version && cached?.schemaVersion === INDEX_SCHEMA_VERSION) {
        this.index = cached;
        return cached;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") console.warn(`${this.region}: master index cache ignored: ${error.message}`);
    }
    this.index = await this.sync();
    await mkdir(path.dirname(this.cacheFile), { recursive: true });
    await writeFile(this.cacheFile, `${JSON.stringify(this.index)}\n`, "utf8");
    return this.index;
  }

  async sync() {
    const language = LANGUAGE_PACK[this.region];
    const types = [
      ...REQUIRED_TYPES,
      `LangCard_${language}`,
      `LangCharacter_${language}`,
      `LangMusic_${language}`,
      `LangLivePassiveSkillLevel_${language}`,
      `LangLiveActiveSkillLevel_${language}`,
      `LangLiveSpecialSkillLevel_${language}`,
      `LangSkillTreeConnectEffect_${language}`,
      `LangGeneratedLivePassiveSkillLevel_${language}`,
      `LangGeneratedLiveActiveSkillLevel_${language}`,
      `LangGeneratedLiveSpecialSkillLevel_${language}`,
      `LangGeneratedSkillTreeConnectEffect_${language}`,
      `LangEmblem_${language}`,
      `LangFanMark_${language}`,
    ];
    const packs = new Map(this.client.masterInfo.packs.map((pack) => [pack.type, pack]));
    const missing = types.filter((type) => !packs.has(type));
    if (missing.length) throw new Error(`${this.region}: missing master packs ${missing.join(", ")}`);
    const rows = {};
    for (const type of types) rows[type] = await readMasterRows(packs.get(type));

    const cardLang = decodeLang(rows[`LangCard_${language}`]);
    const characterLang = decodeLang(rows[`LangCharacter_${language}`]);
    const musicLang = decodeLang(rows[`LangMusic_${language}`]);
    const passiveSkillLang = mergedLang(rows[`LangLivePassiveSkillLevel_${language}`], rows[`LangGeneratedLivePassiveSkillLevel_${language}`]);
    const activeSkillLang = mergedLang(rows[`LangLiveActiveSkillLevel_${language}`], rows[`LangGeneratedLiveActiveSkillLevel_${language}`]);
    const specialSkillLang = mergedLang(rows[`LangLiveSpecialSkillLevel_${language}`], rows[`LangGeneratedLiveSpecialSkillLevel_${language}`]);
    const connectSkillLang = mergedLang(rows[`LangSkillTreeConnectEffect_${language}`], rows[`LangGeneratedSkillTreeConnectEffect_${language}`]);
    const emblemLang = decodeLang(rows[`LangEmblem_${language}`]);
    const fanMarkLang = decodeLang(rows[`LangFanMark_${language}`]);
    const characters = rows.Character.map((row) => decodeCharacter(row.dataHex, characterLang));
    const characterById = new Map(characters.map((item) => [item.id, item]));
    const levels = new Map(rows.CardLevel.map((row) => {
      const payload = Buffer.from(row.dataHex, "hex");
      return [`${firstString(payload, 1)}:${Number(firstVarint(payload, 2) ?? 0n)}`, Number(firstVarint(payload, 3) ?? 0n)];
    }));
    const passiveSkills = indexSkillLevels(rows.LivePassiveSkillLevel, passiveSkillLang);
    const activeSkills = indexSkillLevels(rows.LiveActiveSkillLevel, activeSkillLang);
    const specialSkills = indexSkillLevels(rows.LiveSpecialSkillLevel, specialSkillLang);
    const connectEffects = indexConnectEffects(rows.SkillTreeConnectEffect, connectSkillLang);
    const connectExtents = new Map();
    for (const row of rows.SkillTreeConnectEffectExtent) {
      const extent = decodeConnectEffectExtent(row.dataHex);
      const list = connectExtents.get(extent.groupId) ?? [];
      list.push(extent);
      connectExtents.set(extent.groupId, list);
    }
    const cards = rows.Card.map((row) => decodeCard(row.dataHex, cardLang, characterById, levels, {
      passiveSkills,
      activeSkills,
      specialSkills,
      connectEffects,
      connectExtents,
    }));
    const difficultyByMusic = new Map();
    for (const row of rows.MusicDifficulty) {
      const item = decodeDifficulty(row.dataHex);
      const list = difficultyByMusic.get(item.musicId) ?? [];
      list.push(item);
      difficultyByMusic.set(item.musicId, list);
    }
    const musics = rows.Music.map((row) => decodeMusic(row.dataHex, musicLang, characterById, difficultyByMusic));
    const assetEntries = rows.AssetEntry.map((row) => decodeAssetEntry(row.dataHex));
    const emblems = rows.Emblem.map((row) => decodeNamedAsset(row.dataHex, emblemLang));
    const fanMarks = rows.FanMark.map((row) => decodeNamedAsset(row.dataHex, fanMarkLang));
    return {
      schemaVersion: INDEX_SCHEMA_VERSION,
      region: this.region,
      version: this.client.masterInfo.version,
      syncedAt: new Date().toISOString(),
      cards,
      characters,
      musics,
      assetEntries,
      emblems,
      fanMarks,
    };
  }

  async findCard(term) {
    const index = await this.ensure();
    return fuzzyPick(index.cards, term, (item) => [item.id, item.name, item.characterName]);
  }

  async findMusic(term) {
    const index = await this.ensure();
    return fuzzyPick(index.musics, term, (item) => [item.id, item.title, item.titleRuby]);
  }

  async findCharacter(term) {
    const index = await this.ensure();
    return fuzzyPick(index.characters, term, (item) => [item.id, item.name, item.shortName, item.nameEng, item.shortNameEng, ...item.searchKeywords]);
  }
}

async function readMasterRows(pack) {
  const response = await fetch(pack.downloadUrl);
  if (!response.ok) throw new Error(`${pack.type}: master HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (pack.fileSize && bytes.length !== pack.fileSize) throw new Error(`${pack.type}: master size mismatch`);
  const Module = await sqlcipherModule();
  const virtualFile = `/${pack.fileName}.db`;
  Module.FS.writeFile(virtualFile, bytes);
  const sqlite = new SQLiteAPI(Module);
  const db = sqlite.open(virtualFile);
  try {
    db.exec(`PRAGMA key = \"x'${pack.cryptoKey}'\"`);
    const table = pack.type.startsWith("Lang") ? "Lang" : pack.type;
    const values = db.query(`SELECT *, hex(data) AS data_hex FROM \"${table}\"`);
    return values.map((row) => ({ ...row, dataHex: row.data_hex }));
  } finally {
    db.close();
    try { Module.FS.unlink(virtualFile); } catch {}
  }
}

async function sqlcipherModule() {
  wasmPromise ??= initSqlcipher();
  return wasmPromise;
}

function decodeLang(rows) {
  return new Map(rows.map((row) => {
    const payload = Buffer.from(row.dataHex, "hex");
    return [firstString(payload, 1), firstString(payload, 1000)];
  }));
}

function mergedLang(...rowSets) {
  const merged = new Map();
  for (const rows of rowSets) {
    for (const [key, value] of decodeLang(rows ?? [])) merged.set(key, value);
  }
  return merged;
}

function decodeCard(hex, lang, characterById, levels, skills = {}) {
  const payload = Buffer.from(hex, "hex");
  const characterId = firstString(payload, 2);
  const groupId = firstString(payload, 6);
  const base = levels.get(`${groupId}:1`) ?? 0;
  const performancePermil = Number(firstVarint(payload, 7) ?? 0n);
  const techniquePermil = Number(firstVarint(payload, 8) ?? 0n);
  const sensePermil = Number(firstVarint(payload, 9) ?? 0n);
  const passiveSkillId = firstString(payload, 11);
  const activeSkillId = firstString(payload, 12);
  const specialSkillId = firstString(payload, 13);
  const connectSkillId = firstString(payload, 22);
  const assetId = firstString(payload, 18);
  return {
    id: firstString(payload, 1),
    characterId,
    characterName: characterById.get(characterId)?.name ?? characterId,
    name: lang.get(firstString(payload, 3)) ?? firstString(payload, 3),
    rarity: Number(firstVarint(payload, 4) ?? 0n),
    attributeType: Number(firstVarint(payload, 5) ?? 0n),
    level: 1,
    parameter: base,
    performance: Math.round(base * performancePermil / 1000),
    technique: Math.round(base * techniquePermil / 1000),
    sense: Math.round(base * sensePermil / 1000),
    assetId,
    skills: [
      skillLookup(skills.passiveSkills, passiveSkillId),
      skillLookup(skills.activeSkills, activeSkillId),
      skillLookup(skills.specialSkills, specialSkillId),
    ].filter(Boolean),
    linkSkill: connectSkillLookup(skills.connectEffects, skills.connectExtents, connectSkillId),
  };
}

function indexSkillLevels(rows, lang) {
  const index = new Map();
  for (const row of rows ?? []) {
    const payload = Buffer.from(row.dataHex, "hex");
    const id = firstString(payload, 1);
    if (!id) continue;
    const level = Number(firstVarint(payload, 2) ?? 0n);
    const descriptionLangId = firstString(payload, 1000);
    const list = index.get(id) ?? [];
    list.push({
      id,
      level,
      descriptionLangId,
      description: cleanSkillDescription(lang.get(descriptionLangId) ?? descriptionLangId),
    });
    index.set(id, list);
  }
  for (const list of index.values()) list.sort((left, right) => left.level - right.level);
  return index;
}

function skillLookup(index, id) {
  if (!id) return undefined;
  const value = index?.get(id)?.[0];
  return value ? { ...value } : { id, level: 1, description: "" };
}

function decodeConnectEffect(hex, lang) {
  const payload = Buffer.from(hex, "hex");
  const descriptionLangId = firstString(payload, 1000);
  return {
    id: firstString(payload, 1),
    level: Number(firstVarint(payload, 2) ?? 0n),
    connectEffectType: Number(firstVarint(payload, 3) ?? 0n),
    extentGroupId: firstString(payload, 4),
    effectPermilUp: Number(firstVarint(payload, 5) ?? 0n),
    targetSkillTreeEffectId: firstString(payload, 7),
    targetNodeType: Number(firstVarint(payload, 8) ?? 0n),
    targetNodeGrade: Number(firstVarint(payload, 9) ?? 0n),
    descriptionLangId,
    description: cleanSkillDescription(lang.get(descriptionLangId) ?? descriptionLangId),
  };
}

function indexConnectEffects(rows, lang) {
  const index = new Map();
  for (const row of rows ?? []) {
    const effect = decodeConnectEffect(row.dataHex, lang);
    if (!effect.id) continue;
    const list = index.get(effect.id) ?? [];
    list.push(effect);
    index.set(effect.id, list);
  }
  for (const list of index.values()) list.sort((left, right) => left.level - right.level);
  return index;
}

function decodeConnectEffectExtent(hex) {
  const payload = Buffer.from(hex, "hex");
  return {
    groupId: firstString(payload, 1),
    positionX: signedInt32(firstVarint(payload, 2)),
    positionY: signedInt32(firstVarint(payload, 3)),
  };
}

function signedInt32(value) {
  return Number(BigInt.asIntN(32, value ?? 0n));
}

function cleanSkillDescription(value) {
  return String(value ?? "")
    .replace(/\[\/?[A-Za-z][^\]]*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function connectSkillLookup(index, extents, id) {
  if (!id) return undefined;
  const levels = index?.get(id) ?? [];
  if (!levels.length) return { id };
  const before = levels.find((item) => item.level === 1) ?? levels[0];
  const after = levels.find((item) => item.level === 2) ?? levels.at(-1);
  const positions = extents?.get(after.extentGroupId) ?? [];
  return {
    ...after,
    effectPermilUpBefore: before.effectPermilUp,
    effectPermilUpAfter: after.effectPermilUp,
    levels: levels.map((item) => ({
      level: item.level,
      effectPermilUp: item.effectPermilUp,
      description: item.description,
    })),
    range: positions.map((item) => ({ x: item.positionX, y: item.positionY })),
    rangeText: positions.length
      ? positions.map((item) => `(${item.positionX},${item.positionY})`).join(" ")
      : after.targetNodeGrade ? `目标节点 ${after.targetNodeGrade}` : "—",
  };
}

function decodeAssetEntry(hex) {
  const payload = Buffer.from(hex, "hex");
  return {
    id: firstString(payload, 1),
    assetId: firstString(payload, 2),
  };
}

function decodeNamedAsset(hex, lang) {
  const payload = Buffer.from(hex, "hex");
  const nameId = firstString(payload, 2);
  return {
    id: firstString(payload, 1),
    name: lang.get(nameId) ?? nameId,
    assetId: firstString(payload, 3),
  };
}

function decodeCharacter(hex, lang) {
  const payload = Buffer.from(hex, "hex");
  const nameId = firstString(payload, 2);
  const shortId = firstString(payload, 3);
  const assetId = firstString(payload, 22);
  return {
    id: firstString(payload, 1),
    name: lang.get(nameId) ?? firstString(payload, 4) ?? nameId,
    shortName: lang.get(shortId) ?? firstString(payload, 5) ?? shortId,
    nameEng: firstString(payload, 4),
    shortNameEng: firstString(payload, 5),
    characterProductionId: firstString(payload, 6),
    birthMonth: Number(firstVarint(payload, 9) ?? 0n),
    birthDay: Number(firstVarint(payload, 10) ?? 0n),
    assetId,
    characterImageAssetName: assetId ? `img_chr_full_2d_${assetId}` : "",
    // The game calls this the character motif.  It is the official
    // representative-object icon used by the character profile screen.
    representativeObjectAssetName: assetId ? `img_chr_motif_icon_default_main_${assetId}` : "",
    searchKeywords: allBytes(payload, 31).map((value) => lang.get(value.toString("utf8")) ?? value.toString("utf8")),
    colors: [100, 101, 102, 103].map((field) => firstString(payload, field)).filter(Boolean),
  };
}

function decodeMusic(hex, lang, characterById, difficultyByMusic) {
  const payload = Buffer.from(hex, "hex");
  const id = firstString(payload, 1);
  const playingSeconds = Number(firstVarint(payload, 15) ?? 0n);
  const characterIds = allBytes(payload, 101).map((value) => value.toString("utf8"));
  return {
    id,
    title: lang.get(firstString(payload, 2)) ?? firstString(payload, 2),
    titleRuby: lang.get(firstString(payload, 3)) ?? "",
    lyricist: lang.get(firstString(payload, 7)) ?? "",
    composer: lang.get(firstString(payload, 9)) ?? "",
    arranger: lang.get(firstString(payload, 11)) ?? "",
    jacketAssetId: firstString(payload, 13),
    playingSeconds,
    // Field 17 is Music.LiveScoreCoefficientPermil (note-score data), not
    // the song-length reward bonus. Keep it under its protocol name so it
    // cannot accidentally be rendered as a percentage again.
    liveScoreCoefficientPermil: Number(firstVarint(payload, 17) ?? 0n),
    // The authoritative value is only present in LiveFinishSingleResponse
    // (music_length_bonus_reward_quantity_up_permil_multiply).  It is not a
    // Music master field, so do not derive or guess it from playingSeconds.
    liveLengthBonusSource: "live_finish_response",
    ratingTarget: firstVarint(payload, 27) === 1n,
    characterIds,
    characters: characterIds.map((characterId) => ({ id: characterId, name: characterById.get(characterId)?.name ?? characterId })),
    singerName: lang.get(firstString(payload, 102)) ?? "",
    assetId: firstString(payload, 106),
    difficulties: (difficultyByMusic.get(id) ?? []).sort((left, right) => left.type - right.type),
  };
}

function decodeDifficulty(hex) {
  const payload = Buffer.from(hex, "hex");
  return {
    musicId: firstString(payload, 1),
    type: Number(firstVarint(payload, 2) ?? 0n),
    level: Number(firstVarint(payload, 3) ?? 0n),
  };
}

function fuzzyPick(items, term, fieldsFor) {
  const needle = normalizeSearch(term);
  if (!needle) return undefined;
  let best;
  for (const item of items) {
    for (const field of fieldsFor(item)) {
      const candidate = normalizeSearch(field);
      if (!candidate) continue;
      const score = similarity(needle, candidate);
      if (!best || score > best.similarity) best = { item, similarity: score, matched: field };
      if (score === 1) return best;
    }
  }
  return best;
}

function normalizeSearch(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("ja").replace(/[\s\p{P}\p{S}]+/gu, "");
}

function similarity(left, right) {
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return Math.min(left.length, right.length) / Math.max(left.length, right.length) * 0.2 + 0.78;
  const distance = levenshtein(left, right);
  return Math.max(0, 1 - distance / Math.max(left.length, right.length));
}

function levenshtein(left, right) {
  const prior = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = prior[0];
    prior[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const above = prior[column];
      prior[column] = Math.min(
        prior[column] + 1,
        prior[column - 1] + 1,
        diagonal + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return prior[right.length];
}
