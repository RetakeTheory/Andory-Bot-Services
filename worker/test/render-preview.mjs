import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderContentPng, renderHelpPng, renderRankingPng } from "../examples/ranking-renderer.mjs";

const ranks = [1, 2, 3, 10, 100, 500, 1000, 5000, 10000];
const data = {
  region: "global",
  board: "max",
  music_id: "m0338",
  music_name: "Shiny Smily Story",
  event: { name: "Point Rally Event" },
  rank_infos: ranks.map((rank, index) => ({
    rank,
    score: 899100 - index * 1234,
    user_info: { user_profile_info: { name: index === 6 ? "Inanis" : `Player ${rank}` } },
    speed: { score_per_hour: index === 0 ? null : 1200 + index * 321 },
  })),
};

const outputDirectory = path.resolve("test-output");
await mkdir(outputDirectory, { recursive: true });
const output = path.join(outputDirectory, "ranking-preview.png");
await writeFile(output, await renderRankingPng(data, { region: "global", board: "max", view: "top" }));
const helpOutput = path.join(outputDirectory, "help-preview.png");
await writeFile(helpOutput, await renderHelpPng([
  "Andory 指令帮助",
  "",
  "服务器与榜单",
  "/rkt  日服 TOP 榜（默认）",
  "/rkg  日服 Grade 榜",
  "/enrkt  美服 TOP 榜",
  "/enrkg  美服 Grade 榜",
  "",
  "榜型",
  "total：活动总积分（省略榜型时默认）",
  "max：单曲最高分",
  "mt / maxtotal：活动多曲最高分合计",
  "",
  "名次",
  "单名次：/enrkt 1",
  "连续范围：/enrkt max 1-10",
  "完整返回榜单：/enrkt all total",
  "",
  "说明",
  "Top 支持 1-100；100 以外只能查询服务器已发布的 Grade 档位。",
].join("\n")));
console.log(output);
console.log(helpOutput);

const musicOutput = path.join(outputDirectory, "music-preview.png");
await writeFile(musicOutput, await renderContentPng("music", {
  item: {
    id: "m0073",
    title: "鬼ノ宴",
    singerName: "ロボ子さん",
    lyricist: "TOMONARISORA",
    composer: "TOMONARISORA",
    arranger: "TOMONARISORA",
    playingSeconds: 132,
    liveLengthBonus: {
      basePercent: 22,
      oneBoostPercent: 29,
      twoThreeBoostPercent: 27,
      fourPlusBoostPercent: 22,
      defaultBoostCount: 2,
    },
    ratingTarget: true,
    characters: [{ id: "chr-00002", name: "ロボ子さん" }],
    difficulties: [{ level: 4 }, { level: 11 }, { level: 19 }, { level: 25 }],
    jacketAssetId: "jacket-m0073",
  },
}, { region: "jp" }));
console.log(musicOutput);

const cardOutput = path.join(outputDirectory, "card-preview.png");
await writeFile(cardOutput, await renderContentPng("card", {
  item: {
    id: "card-00012-5-uniq-0062-00",
    name: "Energeticスプラッシュ！",
    characterName: "小鳥遊キアラ",
    level: 1,
    parameter: 5269,
    performance: 1612,
    technique: 1549,
    sense: 2108,
    attributeType: 2,
    rarity: 5,
    assetId: "card-00012-5-uniq-0062-00",
    skills: [
      { description: "Grants All Stats UP 11% to 2 Pure Type Members." },
      { description: "For 7s, Score UP 45%." },
      { description: "For 10s, Grants Score Support Effect of 135%." },
    ],
    linkSkill: {
      description: "Grants Holomem Board Effect UP 200% for all within range.",
      effectPermilUp: 2000,
      effectPermilUpBefore: 1000,
      effectPermilUpAfter: 2000,
      rangeText: "(0,-1) (0,-2) (0,1) (0,2)",
      range: [{ x: 0, y: -1 }, { x: 0, y: -2 }, { x: 0, y: 1 }, { x: 0, y: 2 }],
    },
  },
}, { region: "jp" }));
console.log(cardOutput);
