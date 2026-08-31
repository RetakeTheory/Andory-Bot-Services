import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";

const WIDTH = 1280;
const TITLE_HEIGHT = 70;
const ROW_HEIGHT = 74;
const ROW_GAP = 10;
const SIDE = 30;
const FOOTER_HEIGHT = 48;
const BOTTOM = FOOTER_HEIGHT + 14;
const MAX_ROWS = 100;
const RENDERER_DIR = dirname(fileURLToPath(import.meta.url));
const FONT_DIR = process.env.ANDORY_FONT_DIR
  ? resolve(process.env.ANDORY_FONT_DIR)
  : resolve(RENDERER_DIR, "../assets/fonts");
const GAME_FONT_PATH = resolve(FONT_DIR, "Holodori-ResourceHanRoundedSC-Heavy.ttf");
const GAME_FALLBACK_FONT_PATH = resolve(FONT_DIR, "Holodori-NotoSansSC-ExtraBold.ttf");
const GAME_JP_FONT_PATH = resolve(FONT_DIR, "Holodori-TTRoGSanSerifStdN-Bd.ttf");
const FALLBACK_FONT_PATH = resolve(FONT_DIR, "NotoSansCJK-Bold.otf");
const FONT_FILES = [GAME_FONT_PATH, GAME_FALLBACK_FONT_PATH, GAME_JP_FONT_PATH, FALLBACK_FONT_PATH].filter(existsSync);
const HAN_FONT_FAMILY = "Resource Han Rounded SC Heavy";
const LATIN_FONT_FAMILY = "Noto Sans SC ExtraBold";
const JP_FONT_FAMILY = "TT-Ro GSan Serif StdN";

export async function renderRankingPng(data, query) {
  const svg = buildRankingSvg(data, query);
  return rasterizeSvg(svg);
}

export async function renderHelpPng(text) {
  return rasterizeSvg(buildHelpSvg(text));
}

export async function renderContentPng(kind, data, query = {}) {
  if (kind === "music") return rasterizeSvg(buildMusicSvg(data, query));
  if (kind === "card") return rasterizeSvg(buildCardSvg(data, query));
  if (kind === "character") return rasterizeSvg(buildCharacterSvg(data, query));
  if (kind === "character-ranking") return rasterizeSvg(buildCharacterRankingSvg(data, query));
  if (kind === "profile") return rasterizeSvg(buildProfileSvg(data, query));
  if (kind === "growth") return rasterizeSvg(buildGrowthSvg(data, query));
  throw new Error(`不支持的制图类型：${kind}`);
}

async function rasterizeSvg(svg) {
  const rasterized = new Resvg(svg, {
    font: {
      fontFiles: FONT_FILES,
      loadSystemFonts: FONT_FILES.length === 0,
      defaultFontFamily: FONT_FILES.length ? HAN_FONT_FAMILY : "sans-serif",
    },
  }).render().asPng();
  return sharp(rasterized)
    .png({ compressionLevel: 6, adaptiveFiltering: true })
    .toBuffer();
}

export function buildHelpSvg(text) {
  const lines = String(text).split("\n");
  const sections = new Set(["服务器与榜单", "榜型", "名次", "说明"]);
  let y = 44;
  const markup = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) {
      y += 12;
      continue;
    }
    if (index === 0) {
      markup.push(svgText(line, { x: 54, centerY: y, size: 34, fill: "#303746", weight: 900 }));
      y += 54;
      continue;
    }
    if (sections.has(line)) {
      markup.push(`<rect x="54" y="${y - 15}" width="8" height="28" rx="4" fill="#4a86f7"/>`);
      markup.push(svgText(line, { x: 78, centerY: y, size: 24, fill: "#555d6d", weight: 900 }));
      y += 42;
      continue;
    }
    markup.push(svgText(line, { x: 78, centerY: y, size: 20, fill: "#656d7d", weight: 700 }));
    y += 32;
  }
  const contentBottom = y + 18;
  const height = contentBottom + FOOTER_HEIGHT;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" xml:lang="zh-CN">
  <rect width="${WIDTH}" height="${height}" fill="#fbfbfc"/>
  <rect x="30" y="22" width="1220" height="${contentBottom - 22}" rx="12" fill="#ffffff" stroke="#d7dde7" stroke-width="1.5"/>
  ${markup.join("\n")}
  ${footerMarkup(height)}
</svg>`;
}

export function buildRankingSvg(data, query) {
  const record = objectValue(data) ?? {};
  const rows = Array.isArray(record.rank_infos) ? record.rank_infos.slice(0, MAX_ROWS) : [];
  const contentRows = Math.max(rows.length, 1);
  const height = TITLE_HEIGHT + contentRows * (ROW_HEIGHT + ROW_GAP) - ROW_GAP + BOTTOM;
  const header = rankingHeader(record, query);
  const rowMarkup = rows.length
    ? rows.map((row, index) => rankingRow(row, index, record, query)).join("")
    : emptyRow();

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" xml:lang="zh-CN">
  <defs>
    <linearGradient id="body" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#fcfcfd"/>
    </linearGradient>
    <linearGradient id="gold" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffd552"/>
      <stop offset="1" stop-color="#f4b400"/>
    </linearGradient>
    <linearGradient id="silver" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#d7dae1"/>
      <stop offset="1" stop-color="#aeb4c0"/>
    </linearGradient>
    <linearGradient id="bronze" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ff8a3d"/>
      <stop offset="1" stop-color="#db5b00"/>
    </linearGradient>
    <linearGradient id="pink" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f25fd8"/>
      <stop offset="0.58" stop-color="#ed7aeb"/>
      <stop offset="1" stop-color="#94bdff"/>
    </linearGradient>
    <linearGradient id="blue" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#5897ff"/>
      <stop offset="1" stop-color="#3e79ed"/>
    </linearGradient>
  </defs>
  <rect width="${WIDTH}" height="${height}" fill="#fbfbfc"/>
  ${svgText(header.eventName, { x: SIDE, centerY: 31, size: 23, fill: "#7d8492", weight: 700 })}
  ${svgText(header.regionName, { x: 640, centerY: 31, size: 23, anchor: "middle", fill: "#7d8492", weight: 700 })}
  ${svgText(header.boardName, { x: WIDTH - SIDE, centerY: 31, size: 23, anchor: "end", fill: "#7d8492", weight: 700 })}
  ${rowMarkup}
  ${footerMarkup(height)}
</svg>`;
}

export function buildMusicSvg(data, query = {}) {
  const music = objectValue(data?.item) ?? objectValue(data) ?? {};
  const height = 650;
  const region = query.region === "global" ? "美服/英服" : "日服";
  const jacket = embeddedImage(music.jacketBase64, "image/png", 48, 108, 410, 410, 12);
  const characterNames = Array.isArray(music.characters)
    ? music.characters.map((item) => stringValue(objectValue(item)?.name)).filter(Boolean).join(" · ")
    : "";
  const difficultyColors = ["#55dca0", "#f5bb4e", "#eb7ea4", "#8c7bea"];
  const difficultyNames = ["EASY", "NORMAL", "HARD", "EXPERT"];
  const difficulties = Array.isArray(music.difficulties) ? music.difficulties.slice(0, 4) : [];
  const difficultyMarkup = difficulties.map((value, index) => {
    const item = objectValue(value) ?? {};
    const x = 520 + index * 164;
    return `<rect x="${x}" y="438" width="104" height="32" rx="16" fill="${difficultyColors[index] ?? "#77808e"}"/>
      ${svgText(difficultyNames[index] ?? `LV${index + 1}`, { x: x + 52, centerY: 455, size: 16, anchor: "middle", fill: "#ffffff", weight: 900 })}
      ${svgText(integerText(item.level), { x: x + 119, centerY: 455, size: 24, fill: "#555d6d", weight: 900 })}`;
  }).join("\n");
  const bonus = musicLengthBonusText(music);
  const musicTitle = stringValue(music.title) ?? "未知乐曲";
  // Keep the complete title visible.  The old fixed-length truncation turned
  // long Japanese/Chinese names into an ellipsis even though the right side
  // of the music card still had room.  Scale the title to the available
  // single-line width instead.
  const musicTitleSize = fittedTextSize(musicTitle, 34, 690, 17);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" xml:lang="zh-CN">
  <defs><linearGradient id="jacketPlaceholder" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b4668"/><stop offset="1" stop-color="#20273c"/></linearGradient></defs>
  <rect width="${WIDTH}" height="${height}" fill="#fbfbfc"/>
  ${svgText("乐曲资料", { x: SIDE, centerY: 40, size: 29, fill: "#303746", weight: 900 })}
  ${svgText(region, { x: WIDTH - SIDE, centerY: 40, size: 20, anchor: "end", fill: "#858c99", weight: 700 })}
  <rect x="30" y="78" width="1220" height="510" rx="13" fill="#ffffff" stroke="#d7dde7" stroke-width="1.5"/>
  <rect x="48" y="108" width="410" height="410" rx="12" fill="url(#jacketPlaceholder)"/>
  ${jacket ?? `${svgText("MUSIC", { x: 253, centerY: 292, size: 46, anchor: "middle", fill: "#ffffff", weight: 900 })}${svgText(stringValue(music.jacketAssetId) ?? stringValue(music.id) ?? "", { x: 253, centerY: 344, size: 17, anchor: "middle", fill: "#cbd1df", weight: 700 })}`}
  ${svgText(musicTitle, { x: 520, centerY: 125, size: musicTitleSize, fill: "#303746", weight: 900 })}
  ${svgText(`ID  ${stringValue(music.id) ?? "—"}`, { x: 520, centerY: 168, size: 17, fill: "#858c99", weight: 700 })}
  ${infoLine("演唱", stringValue(music.singerName) ?? "—", 520, 213)}
  ${infoLine("作词", stringValue(music.lyricist) ?? "—", 520, 253)}
  ${infoLine("作曲", stringValue(music.composer) ?? "—", 520, 293)}
  ${infoLine("编曲", stringValue(music.arranger) ?? "—", 520, 333)}
  ${infoLine("评定值统计对象", music.ratingTarget ? (characterNames || "是") : "否", 520, 386)}
  ${difficultyMarkup}
  ${infoChip(`时长 ${formatDuration(music.playingSeconds)}`, 520, 505, "#4a86f7")}
  ${infoChip(`时长加成 ${bonus}`, 704, 505, "#f0aa3b", 214)}
  ${footerMarkup(height)}
</svg>`;
}

export function buildCardSvg(data, query = {}) {
  const card = objectValue(data?.item) ?? objectValue(data) ?? {};
  const region = query.region === "global" ? "美服/英服" : "日服";
  // Full card art is a landscape rectangle (the current bundles are 2:1).
  // Keep the complete frame/signature visible instead of cropping it into a
  // square thumbnail.
  const art = embeddedImage(card.artBase64, "image/png", 48, 126, 600, 300, 12);
  const parameters = [
    ["综合参数", card.parameter, "#303746"],
    ["Performance", card.performance, "#ed6c8d"],
    ["Technique", card.technique, "#4a86f7"],
    ["Sense", card.sense, "#9c6ee8"],
  ];
  const parameterMarkup = parameters.map(([label, value, color], index) => {
    const y = 265 + index * 44;
    return `${svgText(label, { x: 680, centerY: y, size: 20, fill: "#7b8391", weight: 700 })}${svgText(integerText(value), { x: 1190, centerY: y, size: 31, anchor: "end", fill: color, weight: 900 })}`;
  }).join("\n");
  const skillLabels = ["被动技能", "主动技能", "特殊技能"];
  const skills = Array.isArray(card.skills) ? card.skills : [];
  let skillY = 456;
  let skillLineCount = 0;
  const skillMarkup = skillLabels.map((label, index) => {
    const skill = objectValue(skills[index]);
    const description = stringValue(skill?.description) ?? stringValue(skill?.id) ?? "—";
    const lines = wrapText(`${label}：${translateSkillDescription(description)}`, 36);
    const markup = lines.map((line, lineIndex) => svgText(line, { x: 58, centerY: skillY + lineIndex * 21, size: 15, fill: "#6f7887", weight: 700 })).join("");
    skillY += lines.length * 21 + 8;
    skillLineCount += lines.length;
    return markup;
  }).join("\n");
  const height = Math.max(610, 456 + skillLineCount * 21 + (skillLabels.length - 1) * 8 + 70);
  const linkSkill = objectValue(card.linkSkill);
  const beforePermil = Number(linkSkill?.effectPermilUpBefore);
  const afterPermil = Number(linkSkill?.effectPermilUpAfter ?? linkSkill?.effectPermilUp);
  const linkValue = Number.isFinite(beforePermil) && Number.isFinite(afterPermil)
    ? `UP ${formatDecimal(beforePermil / 10)}%（绽放前） / ${formatDecimal(afterPermil / 10)}%（绽放后）`
    : Number.isFinite(afterPermil) ? `UP ${formatDecimal(afterPermil / 10)}%（绽放后）` : "—";
  const cardName = stringValue(card.name) ?? "未知卡面";
  const cardNameSize = fittedTextSize(cardName, 34, 455, 18);
  const attributeMarkup = embeddedImage(card.attributeIconBase64, card.attributeIconMimeType || "image/png", 1168, 99, 60, 60, 0) ?? "";
  const rarityMarkup = cardRarityMarkup(card);
  const linkGrid = connectRangeGrid(linkSkill?.range, 1090, 437, 15, 4);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" xml:lang="zh-CN">
  <defs>
    <linearGradient id="cardPlaceholder" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8bb7ff"/><stop offset="1" stop-color="#7056d8"/></linearGradient>
    <filter id="rarityColor" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="-0.71 0 0 0 1  0 -0.16 0 0 1  0 0 -0.09 0 1  0 0 0 1 0"/></filter>
  </defs>
  <rect width="${WIDTH}" height="${height}" fill="#fbfbfc"/>
  ${svgText("卡面资料", { x: SIDE, centerY: 40, size: 29, fill: "#303746", weight: 900 })}
  ${svgText(region, { x: WIDTH - SIDE, centerY: 40, size: 20, anchor: "end", fill: "#858c99", weight: 700 })}
  <rect x="30" y="78" width="1220" height="${height - 140}" rx="13" fill="#ffffff" stroke="#d7dde7" stroke-width="1.5"/>
  <rect x="48" y="126" width="600" height="300" rx="12" fill="url(#cardPlaceholder)"/>
  ${art ?? `${svgText("CARD", { x: 348, centerY: 267, size: 50, anchor: "middle", fill: "#ffffff", weight: 900 })}${svgText(stringValue(card.assetId) ?? stringValue(card.id) ?? "", { x: 348, centerY: 322, size: 16, anchor: "middle", fill: "#eef1fa", weight: 700 })}`}
  ${rarityMarkup}
  ${svgText(cardName, { x: 680, centerY: 130, size: cardNameSize, fill: "#303746", weight: 900 })}
  ${attributeMarkup}
  ${svgText(stringValue(card.characterName) ?? "—", { x: 680, centerY: 178, size: 25, fill: "#5d6574", weight: 700 })}
  ${svgText(`属性  ${cardAttributeName(card.attributeType, query.region)}`, { x: 1190, centerY: 178, size: 18, anchor: "end", fill: "#7d8593", weight: 800 })}
  ${svgText(`ID  ${stringValue(card.id) ?? "—"}`, { x: 680, centerY: 220, size: 17, fill: "#858c99", weight: 700 })}
  ${svgText(`Lv.${integerText(card.level || 1)} 基础参数`, { x: 1190, centerY: 220, size: 18, anchor: "end", fill: "#858c99", weight: 700 })}
  ${parameterMarkup}
  ${skillMarkup}
  ${smallFourSquareIcon(680, 448)}
  ${svgText("联结技能", { x: 710, centerY: 449, size: 18, fill: "#8a919e", weight: 700 })}
  ${svgText(linkValue, { x: 680, centerY: 492, size: fittedTextSize(linkValue, 20, 390, 15), fill: "#555d6d", weight: 900 })}
  ${linkGrid}
  ${footerMarkup(height)}
</svg>`;
}

export function buildCharacterSvg(data, query = {}) {
  const character = objectValue(data?.item) ?? objectValue(data) ?? {};
  const height = 610;
  const region = query.region === "global" ? "美服/英服" : "日服";
  const palette = characterPalette(character);
  const characterImage = embeddedImage(character.characterBase64, "image/png", 70, 108, 360, 360, 18);
  const motifIcon = embeddedImage(character.representativeObjectBase64, "image/png", 1060, 274, 120, 120, 16);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" xml:lang="zh-CN">
  <defs>
    <linearGradient id="characterBackground" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${palette[0]}"/><stop offset="1" stop-color="${palette[1]}"/></linearGradient>
    <linearGradient id="characterPlaceholder" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b4668"/><stop offset="1" stop-color="#20273c"/></linearGradient>
  </defs>
  <rect width="${WIDTH}" height="${height}" fill="#fbfbfc"/>
  <rect width="${WIDTH}" height="${height}" fill="url(#characterBackground)" opacity="0.18"/>
  ${svgText("角色资料", { x: SIDE, centerY: 40, size: 29, fill: "#303746", weight: 900 })}
  ${svgText(region, { x: WIDTH - SIDE, centerY: 40, size: 20, anchor: "end", fill: "#858c99", weight: 700 })}
  <rect x="30" y="78" width="1220" height="470" rx="13" fill="#ffffff" stroke="#d7dde7" stroke-width="1.5"/>
  <rect x="70" y="108" width="360" height="360" rx="18" fill="url(#characterPlaceholder)"/>
  ${characterImage ?? svgText("CHARACTER", { x: 250, centerY: 288, size: 36, anchor: "middle", fill: "#ffffff", weight: 900 })}
  ${svgText(truncateText(stringValue(character.name) ?? "未知角色", 22), { x: 470, centerY: 135, size: 36, fill: "#303746", weight: 900 })}
  ${svgText(stringValue(character.nameEng) ?? stringValue(character.shortNameEng) ?? "—", { x: 470, centerY: 182, size: 22, fill: "#5d6574", weight: 700 })}
  ${infoLine("角色ID", stringValue(character.id) ?? "—", 470, 242)}
  ${infoLine("生日", birthdayText(character), 470, 292)}
  ${infoLine("已通过别名", characterAliasesText(character), 470, 342)}
  <rect x="1060" y="274" width="120" height="120" rx="16" fill="#f3f5f8" stroke="#d7dde7" stroke-width="1.2"/>
  ${motifIcon ?? svgText("主题", { x: 1120, centerY: 334, size: 20, anchor: "middle", fill: "#9aa1ad", weight: 800 })}
  ${infoLine("资源ID", stringValue(character.assetId) ?? "—", 470, 438)}
  ${footerMarkup(height)}
</svg>`;
}

export function buildCharacterRankingSvg(data, query = {}) {
  const record = objectValue(data) ?? {};
  const character = objectValue(record.character) ?? {};
  return buildRankingSvg({
    ...record,
    event: { name: stringValue(character.name) ?? stringValue(character.id) ?? "角色" },
    board: "character",
  }, { ...query, boardLabel: "角色评定值榜" });
}

export function buildGrowthSvg(data, query = {}) {
  const record = objectValue(data) ?? {};
  const rows = Array.isArray(record.ranks) ? record.ranks.slice(0, 20) : [];
  const rowHeight = 126;
  const height = 112 + Math.max(rows.length, 1) * rowHeight + FOOTER_HEIGHT;
  const markup = rows.length ? rows.map((value, index) => {
    const item = objectValue(value) ?? {};
    const hours = Array.isArray(item.hours) ? item.hours : [];
    const latest = objectValue(hours.at(-1));
    const stops = Array.isArray(item.stops) ? item.stops : [];
    const y = 90 + index * rowHeight;
    return `<rect x="30" y="${y}" width="1220" height="108" rx="9" fill="#ffffff" stroke="#d7dde7" stroke-width="1.5"/>
      ${svgText(`#${integerText(item.rank)}`, { x: 62, centerY: y + 34, size: 30, fill: "#4a86f7", weight: 900 })}
      ${svgText(truncateText(stringValue(item.name) ?? "未知用户", 26), { x: 165, centerY: y + 34, size: 28, fill: "#555d6d", weight: 900 })}
      ${svgText(`${integerText(item.currentScore)} Pt`, { x: 1215, centerY: y + 34, size: 28, anchor: "end", fill: "#090a0d", weight: 900 })}
      ${svgText(`本小时 +${integerText(latest?.growth)} Pt`, { x: 165, centerY: y + 77, size: 19, fill: "#6d7584", weight: 700 })}
      ${svgText(`累计小时记录 ${hours.length}`, { x: 510, centerY: y + 77, size: 19, fill: "#6d7584", weight: 700 })}
      ${svgText(`停止增长时段 ${stops.length}`, { x: 835, centerY: y + 77, size: 19, fill: "#6d7584", weight: 700 })}`;
  }).join("\n") : emptyRow();
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" xml:lang="zh-CN">
  <rect width="${WIDTH}" height="${height}" fill="#fbfbfc"/>
  ${svgText(truncateText(stringValue(objectValue(record.event)?.name) ?? "活动增长记录", 30), { x: SIDE, centerY: 42, size: 27, fill: "#303746", weight: 900 })}
  ${svgText(query.region === "global" ? "美服/英服 · 活动开始至今" : "日服 · 活动开始至今", { x: WIDTH - SIDE, centerY: 42, size: 20, anchor: "end", fill: "#858c99", weight: 700 })}
  ${markup}
  ${footerMarkup(height)}
</svg>`;
}

export function buildProfileSvg(data, query = {}) {
  const record = objectValue(data) ?? {};
  const profile = objectValue(record.profile) ?? {};
  const deck = objectValue(record.highestLiveDeckEvaluation);
  const region = query.region === "global" || record.region === "global" ? "美服/英服" : "日服";
  const height = 790;
  const palette = embeddedImage(record.paletteBase64, stringValue(record.paletteMimeType) ?? "image/jpeg", 48, 126, 600, 300, 14);
  const name = stringValue(profile.name) ?? "未知用户";
  const basicHidden = profile.isBasicInfoPublish === false;
  const characterHidden = profile.isCharacterRankPublish === false;
  const liveHidden = profile.isLiveResultPublish === false;
  const emblems = Array.isArray(profile.emblemPositions)
    ? profile.emblemPositions.map(objectValue).filter(Boolean).slice(0, 5)
    : [];
  const emblemMarkup = emblems.length ? emblems.map((item, index) => {
    const x = 48 + index * 118;
    // Official emblems can be square (512×512) or wide (1024×512). Give each
    // one a full-size slot and preserve its aspect ratio; the text below the
    // old 72px thumbnail was redundant and made the actual title unreadable.
    const icon = embeddedImage(item.imageBase64, stringValue(item.imageMimeType) ?? "image/png", x, 488, 110, 110, 12);
    return icon ?? `<rect x="${x}" y="488" width="110" height="110" rx="12" fill="#eef1f6"/>`;
  }).join("") : svgText("未设置", { x: 58, centerY: 524, size: 20, fill: "#858c99", weight: 700 });
  const clearByDifficulty = profileCountMap(record.liveClearResults);
  const fullComboByDifficulty = profileCountMap(record.liveFullComboResults);
  const allPerfectByDifficulty = profileCountMap(record.liveAllPerfectResults);
  const difficultyRows = [
    [1, "EASY", "#55cfa0"],
    [2, "NORMAL", "#f0aa3b"],
    [3, "HARD", "#eb7ea4"],
    [4, "EXPERT", "#8c7bea"],
  ];
  const liveResultMarkup = difficultyRows.map(([type, label, color], index) => {
    const y = 535 + index * 32;
    return `${svgText(label, { x: 680, centerY: y, size: 15, fill: color, weight: 900 })}${svgText(integerText(clearByDifficulty.get(type) ?? 0), { x: 875, centerY: y, size: 18, anchor: "middle", fill: "#555d6d", weight: 800 })}${svgText(integerText(fullComboByDifficulty.get(type) ?? 0), { x: 1020, centerY: y, size: 18, anchor: "middle", fill: "#555d6d", weight: 800 })}${svgText(integerText(allPerfectByDifficulty.get(type) ?? 0), { x: 1160, centerY: y, size: 18, anchor: "middle", fill: "#555d6d", weight: 800 })}`;
  }).join("");
  const topRatings = Array.isArray(record.topMusicHighestScoreRatings) ? record.topMusicHighestScoreRatings : [];
  const highestRating = topRatings.reduce((best, value) => Math.max(best, Number(objectValue(value)?.value) || 0), 0);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" xml:lang="zh-CN">
  <defs><linearGradient id="profilePlaceholder" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#62cffa"/><stop offset="1" stop-color="#8aa6ff"/></linearGradient></defs>
  <rect width="${WIDTH}" height="${height}" fill="#fbfbfc"/>
  ${svgText("用户名片", { x: SIDE, centerY: 40, size: 29, fill: "#303746", weight: 900 })}
  ${svgText(region, { x: WIDTH - SIDE, centerY: 40, size: 20, anchor: "end", fill: "#858c99", weight: 700 })}
  <rect x="30" y="78" width="1220" height="650" rx="13" fill="#ffffff" stroke="#d7dde7" stroke-width="1.5"/>
  <rect x="48" y="126" width="600" height="300" rx="14" fill="url(#profilePlaceholder)"/>
  ${palette ?? svgText("PROFILE", { x: 348, centerY: 276, size: 50, anchor: "middle", fill: "#ffffff", weight: 900 })}
  ${svgText(name, { x: 680, centerY: 128, size: fittedTextSize(name, 34, 500, 18), fill: "#303746", weight: 900 })}
  ${svgText(`ID  ${stringValue(record.publicUserId) ?? "—"}`, { x: 680, centerY: 174, size: 18, fill: "#858c99", weight: 700 })}
  ${infoLine("Dream Rank", integerText(profile.level), 680, 222)}
  ${infoLine("状态消息", basicHidden ? "已隐藏" : stringValue(profile.message) || "—", 680, 270)}
  ${infoLine("成就数", integerText(record.achievementClearCount), 680, 318)}
  ${infoLine("最高编队评定值", characterHidden ? "已隐藏" : integerText(deck?.value), 680, 366)}
  ${infoLine("最高单角色评定值", characterHidden ? "已隐藏" : integerText(highestRating), 680, 414)}
  ${svgText("称号 / 徽章", { x: 58, centerY: 470, size: 18, fill: "#8a919e", weight: 700 })}
  ${emblemMarkup}
  ${svgText("歌曲游玩情况", { x: 680, centerY: 470, size: 18, fill: "#8a919e", weight: 700 })}
  ${liveHidden
    ? svgText("玩家已隐藏歌曲游玩记录", { x: 680, centerY: 514, size: 22, fill: "#858c99", weight: 800 })
    : `${svgText("Clear", { x: 875, centerY: 500, size: 15, anchor: "middle", fill: "#858c99", weight: 800 })}${svgText("FC", { x: 1020, centerY: 500, size: 15, anchor: "middle", fill: "#858c99", weight: 800 })}${svgText("AP", { x: 1160, centerY: 500, size: 15, anchor: "middle", fill: "#858c99", weight: 800 })}${liveResultMarkup}`}
  ${svgText(characterHidden ? "成员评定值与最高评定值已由玩家隐藏" : `成员总评定值 ${integerText(record.totalMusicHighestScoreRatingValue)} · 最佳成员 ${stringValue(deck?.characterName) ?? "—"}`, { x: 680, centerY: 690, size: 19, fill: "#6d7584", weight: 700 })}
  ${footerMarkup(height)}
</svg>`;
}

function profileCountMap(value) {
  const result = new Map();
  if (!Array.isArray(value)) return result;
  for (const item of value) {
    const row = objectValue(item);
    const type = Number(row?.difficultyType);
    const count = Number(row?.count);
    if (Number.isFinite(type) && Number.isFinite(count)) result.set(type, count);
  }
  return result;
}

function infoLine(label, value, x, y) {
  // Keep the value clear of the long grey label (notably "评定值统计对象").
  // A fixed gutter is more reliable than estimating rendered CJK widths in SVG.
  return `${svgText(label, { x, centerY: y, size: 18, fill: "#8a919e", weight: 700 })}${svgText(truncateText(value, 32), { x: x + 220, centerY: y, size: 22, fill: "#555d6d", weight: 700 })}`;
}

function infoChip(label, x, y, color, width = 156) {
  return `<rect x="${x}" y="${y - 18}" width="${width}" height="36" rx="18" fill="${color}"/>${svgText(label, { x: x + width / 2, centerY: y + 1, size: 17, anchor: "middle", fill: "#ffffff", weight: 900 })}`;
}

function musicLengthBonusText(music) {
  const bonus = objectValue(music?.liveLengthBonus);
  const value = Number(bonus?.twoThreeBoostPercent ?? music?.liveLengthBonusPercent);
  if (Number.isFinite(value)) return `+${Math.max(0, Math.trunc(value))}%`;
  const seconds = Number(music?.playingSeconds);
  if (!Number.isFinite(seconds) || seconds <= 90) return "+0%";
  return `+${Math.ceil((10 / 19) * (seconds - 90) * 1.2)}%`;
}

function birthdayText(character) {
  const month = positiveInteger(character?.birthMonth);
  const day = positiveInteger(character?.birthDay);
  return month && day ? `${month}月${day}日` : "—";
}

function characterAliasesText(character) {
  const aliases = Array.isArray(character?.aliases)
    ? character.aliases.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim())
    : [];
  return aliases.length ? aliases.join(" · ") : "暂无";
}

function cardAttributeName(value, region) {
  const type = Number(value);
  if (region === "global") return ({ 1: "Cute", 2: "Pure", 3: "Happy" })[type] ?? "Unknown";
  return ({ 1: "キュート", 2: "ピュア", 3: "ハッピー" })[type] ?? "不明";
}

function translateSkillDescription(value) {
  const source = String(value ?? "").trim();
  if (!/[A-Za-z]/.test(source)) return source || "—";
  const probability = { High: "高", Medium: "中", Low: "低" };
  const stats = { "All Stats": "全参数", Performance: "Performance", Technique: "Technique", Sense: "Sense" };
  return source
    .replace(/With (\d+) or more (.+?) Members, /g, (_match, count, group) => `编成${count}名以上${translateMemberGroup(group)}成员时，`)
    .replace(/When LIFE is (\d+) or higher, /g, (_match, life) => `LIFE达到${life}以上时，`)
    .replace(/With a Combo of (\d+) or more, /g, (_match, combo) => `连击达到${combo}以上时，`)
    .replace(/For (\d+)s, /g, (_match, seconds) => `${seconds}秒内，`)
    .replace(/Every (\d+)s with a (High|Medium|Low) Probability chance\./g, (_match, seconds, chance) => `每${seconds}秒以${probability[chance]}概率发动。`)
    .replace(/Grants (All Stats|Performance|Technique|Sense) UP (\d+)% to self\./g, (_match, stat, percent) => `自身${stats[stat]}提升${percent}%。`)
    .replace(/Grants (All Stats|Performance|Technique|Sense) UP (\d+)% to (\d+) (.+?) Members\./g, (_match, stat, percent, count, group) => `使${count}名${translateMemberGroup(group)}成员的${stats[stat]}提升${percent}%。`)
    .replace(/Grants Score Support Effect of (\d+)% to (\d+) (.+?) Members\./g, (_match, percent, count, group) => `使${count}名${translateMemberGroup(group)}成员的得分支援效果提升${percent}%。`)
    .replace(/Grants Score Support Effect of (\d+)%/g, (_match, percent) => `得分支援效果提升${percent}%`)
    .replace(/Score UP (\d+)%/g, (_match, percent) => `得分提升${percent}%`)
    .replace(/Skill Activation Rate UP (\d+)%/g, (_match, percent) => `技能发动率提升${percent}%`)
    .replace(/GOOD or higher becomes PERFECT/g, "GOOD及以上判定变为PERFECT")
    .replace(/Restores (\d+) LIFE/g, (_match, life) => `回复${life} LIFE`)
    .replace(/\. /g, "。")
    .replace(/\.$/, "。");
}

function translateMemberGroup(value) {
  return String(value)
    .replace(/^Cute Type$/, "Cute属性")
    .replace(/^Pure Type$/, "Pure属性")
    .replace(/^Happy Type$/, "Happy属性")
    .replace(/^ID Gen (\d+)$/, "ID第$1期生")
    .replace(/^Gen (\d+)$/, "第$1期生");
}

function wrapText(value, maxCharacters) {
  const source = String(value ?? "");
  if (!source) return [""];
  const characters = [...source];
  const lines = [];
  for (let offset = 0; offset < characters.length; offset += maxCharacters) {
    lines.push(characters.slice(offset, offset + maxCharacters).join(""));
  }
  return lines;
}

function formatDecimal(value) {
  return Number.isInteger(value) ? String(value) : Number(value).toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function smallFourSquareIcon(x, y) {
  return [0, 1].flatMap((row) => [0, 1].map((column) => `<rect x="${x + column * 10}" y="${y - 10 + row * 10}" width="8" height="8" rx="1.5" fill="#9da4b5"/>`)).join("");
}

function connectRangeGrid(range, x, y, cell, gap) {
  const positions = Array.isArray(range) ? range : [];
  const selected = new Set(positions.map((value) => {
    const point = objectValue(value) ?? {};
    return `${Number(point.x)},${Number(point.y)}`;
  }));
  const total = cell * 5 + gap * 4;
  const cells = [];
  for (let row = 0; row < 5; row += 1) {
    for (let column = 0; column < 5; column += 1) {
      const coordinateX = column - 2;
      const coordinateY = 2 - row;
      const isCenter = coordinateX === 0 && coordinateY === 0;
      const active = isCenter || selected.has(`${coordinateX},${coordinateY}`);
      cells.push(`<rect x="${x + column * (cell + gap)}" y="${y + row * (cell + gap)}" width="${cell}" height="${cell}" rx="3" fill="${active ? "#66d7e7" : "#e6e8ee"}"/>`);
    }
  }
  const center = x + 2 * (cell + gap) + cell / 2;
  const centerY = y + 2 * (cell + gap) + cell / 2;
  return `<g><rect x="${x - 8}" y="${y - 8}" width="${total + 16}" height="${total + 16}" rx="11" fill="#f8f9fb" stroke="#e4e7ed" stroke-width="1"/>${cells.join("")}<path d="${starPath(center, centerY, 13, 7, 5)}" fill="#7ce1ae" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/></g>`;
}

function starPath(centerX, centerY, outerRadius, innerRadius, points) {
  const values = [];
  for (let index = 0; index < points * 2; index += 1) {
    const radius = index % 2 === 0 ? outerRadius : innerRadius;
    const angle = -Math.PI / 2 + index * Math.PI / points;
    values.push(`${index ? "L" : "M"}${(centerX + Math.cos(angle) * radius).toFixed(2)},${(centerY + Math.sin(angle) * radius).toFixed(2)}`);
  }
  return `${values.join(" ")} Z`;
}

function characterPalette(character) {
  const colors = Array.isArray(character?.colors) ? character.colors : [];
  const first = safeHexColor(colors[0]) ?? "#8b95ad";
  const second = safeHexColor(colors[1]) ?? first;
  return [first, second];
}

function safeHexColor(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.startsWith("#") ? value : `#${value}`;
  return /^#[0-9a-f]{6}$/i.test(normalized) ? normalized : undefined;
}

function embeddedImage(base64, mimeType, x, y, width, height, radius) {
  if (typeof base64 !== "string" || !base64) return undefined;
  const id = `image-${x}-${y}`;
  return `<clipPath id="${id}"><rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}"/></clipPath><image href="data:${mimeType};base64,${base64}" x="${x}" y="${y}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet" clip-path="url(#${id})"/>`;
}

function fittedTextSize(value, preferredSize, maxWidth, minimumSize) {
  const widthUnits = Array.from(String(value ?? "")).reduce((total, character) => {
    if (/\s/u.test(character)) return total + 0.32;
    if (/[\u3040-\u30ff\u31f0-\u31ff\u3400-\u9fff\uf900-\ufaff]/u.test(character)) return total + 1;
    if (/[A-Z0-9]/u.test(character)) return total + 0.66;
    if (/[a-z]/u.test(character)) return total + 0.56;
    return total + 0.45;
  }, 0);
  if (!widthUnits) return preferredSize;
  return Math.max(minimumSize, Math.min(preferredSize, Math.floor(maxWidth / widthUnits)));
}

function cardRarityMarkup(card) {
  const base64 = stringValue(card?.rarityIconBase64);
  const rarity = Math.min(5, Math.max(0, Math.trunc(Number(card?.rarity))));
  if (!base64 || rarity < 3) return "";
  const mimeType = stringValue(card?.rarityIconMimeType) ?? "image/png";
  const size = 34;
  const gap = 2;
  const right = 638;
  const bottom = 416;
  return Array.from({ length: rarity }, (_value, index) => {
    const x = right - size;
    const y = bottom - size - index * (size + gap);
    return `<image href="data:${mimeType};base64,${base64}" x="${x}" y="${y}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet" filter="url(#rarityColor)"/>`;
  }).join("");
}

function formatDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return "—";
  const rounded = Math.round(value);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}

function footerMarkup(height, generatedAt = new Date()) {
  const y = height - 22;
  return `
  <line x1="${SIDE}" y1="${height - FOOTER_HEIGHT}" x2="${WIDTH - SIDE}" y2="${height - FOOTER_HEIGHT}" stroke="#e1e5ec" stroke-width="1"/>
  ${svgText("Generated by Andory", { x: SIDE, centerY: y, size: 15, fill: "#8b929f", weight: 700 })}
  ${svgText("Andory与Hololive官方与Qualiarts无关", { x: WIDTH / 2, centerY: y, size: 15, anchor: "middle", fill: "#8b929f", weight: 700 })}
  ${svgText(`DT:${formatDateTime(generatedAt)}`, { x: WIDTH - SIDE, centerY: y, size: 15, anchor: "end", fill: "#8b929f", weight: 700 })}`;
}

function formatDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

function rankingRow(value, index, record, query) {
  const row = objectValue(value) ?? {};
  const rank = positiveInteger(row.rank) ?? index + 1;
  const score = integerText(row.score);
  const name = truncateText(playerName(row), 25);
  const board = record?.board === "max" || record?.board === "total" || record?.board === "maxtotal"
    ? record.board
    : query?.board;
  const showPoints = board === "total";
  const speed = showPoints ? speedText(row.speed) : undefined;
  const y = TITLE_HEIGHT + index * (ROW_HEIGHT + ROW_GAP);
  const bottom = y + ROW_HEIGHT;
  const clipId = `row-${index}`;
  const fill = rankFill(rank);
  const rankSize = String(rank).length >= 5 ? 29 : String(rank).length === 4 ? 34 : 40;
  return `
  <g>
    <clipPath id="${clipId}"><rect x="${SIDE}" y="${y}" width="1220" height="${ROW_HEIGHT}" rx="7"/></clipPath>
    <rect x="${SIDE}" y="${y}" width="1220" height="${ROW_HEIGHT}" rx="7" fill="url(#body)"/>
    <path d="M ${SIDE} ${y} H 192 L 174 ${bottom} H ${SIDE} Z" fill="url(#${fill})" clip-path="url(#${clipId})"/>
    <rect x="${SIDE}" y="${y}" width="1220" height="${ROW_HEIGHT}" rx="7" fill="none" stroke="#d7dde7" stroke-width="1.5"/>
    ${svgText(rank, { x: 101, centerY: y + ROW_HEIGHT / 2 + 1, size: rankSize, anchor: "middle", fill: "#ffffff", weight: 900 })}
    ${svgText(name, { x: 225, centerY: y + ROW_HEIGHT / 2 + 1, size: 35, fill: "#555d6d", weight: 700 })}
    ${svgText(score, { x: showPoints ? 948 : 1218, centerY: y + ROW_HEIGHT / 2 + 1, size: 34, anchor: "end", fill: "#090a0d", weight: 900 })}
    ${showPoints ? svgText("Pt", { x: 966, centerY: y + ROW_HEIGHT / 2 + 2, size: 21, fill: "#090a0d", weight: 700 }) : ""}
    ${speed ? svgText(speed, { x: 1218, centerY: y + ROW_HEIGHT / 2 + 2, size: 18, anchor: "end", fill: "#747b89", weight: 700 }) : ""}
  </g>`;
}

function emptyRow() {
  return svgText("暂无排行榜数据", { x: 640, centerY: 112, size: 28, anchor: "middle", fill: "#7d8492", weight: 700 });
}

function svgText(value, { x, centerY, size, anchor = "start", fill, weight = 700 }) {
  const strokeWidth = weight >= 900 ? 0.9 : weight >= 800 ? 0.45 : 0;
  const stroke = strokeWidth > 0
    ? ` stroke="${fill}" stroke-width="${strokeWidth}" stroke-linejoin="round" paint-order="stroke fill"`
    : "";
  return `<text x="${x}" y="${centerY}" text-anchor="${anchor}" dominant-baseline="middle" fill="${fill}" font-family="${LATIN_FONT_FAMILY}" font-size="${size}" font-weight="${weight}" font-variant-numeric="tabular-nums"${stroke}>${fontRuns(value)}</text>`;
}

function fontRuns(value) {
  const source = String(value);
  const cjkFamily = /[\u3040-\u30ff\u31f0-\u31ff]/u.test(source) ? JP_FONT_FAMILY : HAN_FONT_FAMILY;
  const runs = [];
  for (const character of source) {
    const family = /[\u0000-\u024f]/u.test(character) ? LATIN_FONT_FAMILY : cjkFamily;
    const last = runs.at(-1);
    if (last?.family === family) last.text += character;
    else runs.push({ family, text: character });
  }
  return runs.map((run) => `<tspan font-family="${run.family}">${escapeXml(run.text)}</tspan>`).join("");
}

function rankingHeader(record, query) {
  const event = objectValue(record.event);
  const eventName = truncateText(stringValue(event?.name) ?? "未知活动", 28);
  const regionName = query?.region === "jp" ? "日服" : "美服";
  const board = record.board === "max" || record.board === "total" || record.board === "maxtotal"
    ? record.board
    : query?.board;
  let boardName = stringValue(query?.boardLabel) ?? "活动Pt榜";
  if (board === "max") {
    const music = stringValue(record.music_name) ?? stringValue(objectValue(record.music)?.name) ?? stringValue(record.music_id) ?? "未知歌曲";
    boardName = `歌曲 ${music} 最高分榜`;
  } else if (board === "maxtotal") {
    boardName = "歌曲总分最高分榜";
  }
  return {
    eventName,
    regionName,
    boardName: truncateText(boardName, 32),
  };
}

function rankFill(rank) {
  if (rank === 1) return "gold";
  if (rank === 2) return "silver";
  if (rank === 3) return "bronze";
  if (rank <= 100) return "pink";
  return "blue";
}

function playerName(row) {
  if (typeof row.name === "string" && row.name) return row.name;
  const user = objectValue(row.user_info);
  const profile = objectValue(user?.user_profile_info);
  return stringValue(profile?.name) ?? "未知用户";
}

function speedText(value) {
  const speed = objectValue(value);
  const raw = speed?.score_per_hour;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return "时速 采样中";
  const perHour = raw;
  const rounded = Math.round(perHour);
  return `时速 ${rounded >= 0 ? "+" : ""}${rounded} Pt/h`;
}

function integerText(value) {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  if (typeof value === "string" && /^-?\d+$/.test(value)) return value;
  return "0";
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function truncateText(value, maxLength) {
  const chars = [...String(value)];
  return chars.length <= maxLength ? chars.join("") : `${chars.slice(0, maxLength - 1).join("")}…`;
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function stringValue(value) {
  return typeof value === "string" && value ? value : undefined;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
