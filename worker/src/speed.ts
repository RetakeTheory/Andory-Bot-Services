export interface SpeedPoint {
  at: number;
  score: number;
}

export interface SpeedSeries {
  eventId: string;
  chapterId: string;
  musicId: string;
  samples: SpeedPoint[];
}

export interface SpeedMetric {
  method: "linear_regression";
  score_per_hour: number | null;
  sample_count: number;
  window_seconds: number;
  score_delta: number;
  r_squared: number | null;
  sampled_at: string;
}

export function appendSpeedPoint(
  previous: SpeedSeries | undefined,
  identity: Pick<SpeedSeries, "eventId" | "chapterId" | "musicId">,
  point: SpeedPoint,
  minIntervalMs: number,
  retentionMs: number,
): SpeedSeries {
  const sameSeries = previous
    && previous.eventId === identity.eventId
    && previous.chapterId === identity.chapterId
    && previous.musicId === identity.musicId;
  const cutoff = point.at - retentionMs;
  const samples = sameSeries
    ? previous.samples.filter((sample) => sample.at >= cutoff && sample.at <= point.at)
    : [];
  const last = samples.at(-1);
  if (!last || point.at - last.at >= minIntervalMs) samples.push(point);
  return { ...identity, samples };
}

export function linearSpeed(samples: SpeedPoint[], windowMs: number): SpeedMetric | undefined {
  const latest = samples.at(-1);
  if (!latest) return undefined;
  const points = samples.filter((point) => point.at >= latest.at - windowMs && point.at <= latest.at);
  const first = points[0]!;
  const last = points.at(-1)!;
  const windowSeconds = Math.max(0, Math.round((last.at - first.at) / 1000));
  if (points.length < 2 || last.at <= first.at) {
    return {
      method: "linear_regression",
      score_per_hour: null,
      sample_count: points.length,
      window_seconds: windowSeconds,
      score_delta: last.score - first.score,
      r_squared: null,
      sampled_at: new Date(last.at).toISOString(),
    };
  }

  const origin = first.at;
  const values = points.map((point) => ({ x: (point.at - origin) / 3_600_000, y: point.score }));
  const meanX = values.reduce((sum, point) => sum + point.x, 0) / values.length;
  const meanY = values.reduce((sum, point) => sum + point.y, 0) / values.length;
  const covariance = values.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0);
  const varianceX = values.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
  const slope = varianceX === 0 ? 0 : covariance / varianceX;
  const intercept = meanY - slope * meanX;
  const residual = values.reduce((sum, point) => sum + (point.y - (intercept + slope * point.x)) ** 2, 0);
  const total = values.reduce((sum, point) => sum + (point.y - meanY) ** 2, 0);
  const rSquared = total === 0 ? 1 : Math.max(0, Math.min(1, 1 - residual / total));
  return {
    method: "linear_regression",
    score_per_hour: Math.round(slope),
    sample_count: points.length,
    window_seconds: windowSeconds,
    score_delta: last.score - first.score,
    r_squared: Math.round(rSquared * 10_000) / 10_000,
    sampled_at: new Date(last.at).toISOString(),
  };
}
