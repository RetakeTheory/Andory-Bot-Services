import assert from "node:assert/strict";
import { appendSpeedPoint, linearSpeed } from "../src/speed.ts";

const hour = 3_600_000;
const samples = [
  { at: 0, score: 100 },
  { at: hour / 2, score: 200 },
  { at: hour, score: 300 },
];
const metric = linearSpeed(samples, hour);
assert.equal(metric.score_per_hour, 200);
assert.equal(metric.sample_count, 3);
assert.equal(metric.window_seconds, 3600);
assert.equal(metric.score_delta, 200);
assert.equal(metric.r_squared, 1);

const first = appendSpeedPoint(
  undefined,
  { eventId: "event-a", chapterId: "chapter-1", musicId: "music-1" },
  { at: hour, score: 500 },
  30_000,
  2 * hour,
);
const ignoredTooSoon = appendSpeedPoint(
  first,
  { eventId: "event-a", chapterId: "chapter-1", musicId: "music-1" },
  { at: hour + 10_000, score: 550 },
  30_000,
  2 * hour,
);
assert.equal(ignoredTooSoon.samples.length, 1);

const resetForNewEvent = appendSpeedPoint(
  ignoredTooSoon,
  { eventId: "event-b", chapterId: "chapter-1", musicId: "music-1" },
  { at: 2 * hour, score: 50 },
  30_000,
  2 * hour,
);
assert.deepEqual(resetForNewEvent.samples, [{ at: 2 * hour, score: 50 }]);
assert.equal(linearSpeed(resetForNewEvent.samples, hour).score_per_hour, null);

console.log("linear ranking speed test passed");
