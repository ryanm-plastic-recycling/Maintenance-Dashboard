export interface OHLC { time: number; o: number; h: number; l: number; c: number; }

export interface HACOParams {
  lengthUp: number;
  lengthDown: number;
  alertLookbackBars: number;
}

export interface HACOBar extends OHLC {
  haOpen: number;
  haC: number;
  mid: number;
  TMA1U: number; TMA2U: number; ZlHaU: number; TMA1CU: number; TMA2CU: number; ZlClU: number; ZlDifU: number;
  TMA1D: number; TMA2D: number; ZlHaD: number; TMA1CD: number; TMA2CD: number; ZlClD: number; ZlDifD: number;
  keep1U_alert: boolean; keep1U_price: boolean; keep1U: boolean; keep2U: boolean; keepingU: boolean; keepallU: boolean; keep3U: boolean; utr: boolean;
  keep1D: boolean; keep2D: boolean; keepingD: boolean; keepallD: boolean; keep3D: boolean; dtr: boolean;
  upw: boolean; dnw: boolean; state: number; reason: string[];
}

const DEFAULT_PARAMS: HACOParams = { lengthUp: 34, lengthDown: 34, alertLookbackBars: 1 };

function emaSeries(values: number[], length: number): number[] {
  const alpha = 2 / (length + 1);
  const result: number[] = [];
  values.forEach((v, i) => {
    if (i === 0) result[i] = v; else result[i] = alpha * v + (1 - alpha) * result[i - 1];
  });
  return result;
}

function temaSeries(values: number[], length: number): number[] {
  const ema1 = emaSeries(values, length);
  const ema2 = emaSeries(ema1, length);
  const ema3 = emaSeries(ema2, length);
  return ema1.map((v, i) => 3 * v - 3 * ema2[i] + ema3[i]);
}

function alertLookback(arr: boolean[], idx: number, lookback: number): boolean {
  for (let j = 0; j <= lookback; j++) {
    const k = idx - j;
    if (k >= 0 && arr[k]) return true;
  }
  return false;
}

export function computeHACO(candles: OHLC[], params: Partial<HACOParams> = {}): HACOBar[] {
  const p: HACOParams = { ...DEFAULT_PARAMS, ...params };
  const lenU = p.lengthUp;
  const lenD = p.lengthDown;
  const lookback = p.alertLookbackBars;
  const n = candles.length;

  const haCloseRaw: number[] = [];
  const haOpen: number[] = [];
  const haC: number[] = [];
  const mid: number[] = [];

  for (let i = 0; i < n; i++) {
    const { o, h, l, c } = candles[i];
    haCloseRaw[i] = (o + h + l + c) / 4;
    if (i === 0) haOpen[i] = (o + c) / 2; else haOpen[i] = (haOpen[i - 1] + haCloseRaw[i - 1]) / 2;
    haC[i] = (haCloseRaw[i] + haOpen[i] + Math.max(h, haOpen[i]) + Math.min(l, haOpen[i])) / 4;
    mid[i] = (h + l) / 2;
  }

  const TMA1U = temaSeries(haC, lenU);
  const TMA2U = temaSeries(TMA1U, lenU);
  const ZlHaU = TMA1U.map((v, i) => v + (v - TMA2U[i]));
  const TMA1CU = temaSeries(mid, lenU);
  const TMA2CU = temaSeries(TMA1CU, lenU);
  const ZlClU = TMA1CU.map((v, i) => v + (v - TMA2CU[i]));
  const ZlDifU = ZlClU.map((v, i) => v - ZlHaU[i]);

  const TMA1D = temaSeries(haC, lenD);
  const TMA2D = temaSeries(TMA1D, lenD);
  const ZlHaD = TMA1D.map((v, i) => v + (v - TMA2D[i]));
  const TMA1CD = temaSeries(mid, lenD);
  const TMA2CD = temaSeries(TMA1CD, lenD);
  const ZlClD = TMA1CD.map((v, i) => v + (v - TMA2CD[i]));
  const ZlDifD = ZlClD.map((v, i) => v - ZlHaD[i]);

  const keep1UArr: boolean[] = haC.map((v, i) => v >= haOpen[i]);
  const keep1DArr: boolean[] = haC.map((v, i) => v < haOpen[i]);

  const bars: HACOBar[] = [];
  let prevState = 0;
  let prevKeepallU = false; let prevKeepallD = false;
  let prevKeepingU = false; let prevKeepingD = false;
  let prevUtr = false; let prevDtr = false;
  for (let i = 0; i < n; i++) {
    const candle = candles[i];
    const prevCandle = i > 0 ? candles[i - 1] : candle;

    const keep1U_alert = alertLookback(keep1UArr, i, lookback);
    const keep1U_price = (candle.c >= haC[i]) || (candle.h > prevCandle.h) || (candle.l > prevCandle.l);
    const keep1U = keep1U_alert || keep1U_price;
    const keep2U = ZlDifU[i] >= 0;
    const keepingU = keep1U || keep2U;
    const keepallU = keepingU || (prevKeepingU && candle.c >= candle.o) || (candle.c >= prevCandle.c);
    const range = candle.h - candle.l;
    const keep3U = range === 0 ? false : (Math.abs(candle.c - candle.o) < range * 0.35 && candle.h >= prevCandle.l);
    const utr = keepallU || (prevKeepallU && keep3U);

    const keep1D = alertLookback(keep1DArr, i, lookback);
    const keep2D = ZlDifD[i] < 0;
    const keepingD = keep1D || keep2D;
    const keepallD = keepingD || (prevKeepingD && candle.c < candle.o) || (candle.c < prevCandle.c);
    const keep3D = range === 0 ? false : (Math.abs(candle.c - candle.o) < range * 0.35 && candle.l <= prevCandle.h);
    const dtr = keepallD || (prevKeepallD && keep3D);

    const upw = !dtr && prevDtr && utr;
    const dnw = !utr && prevUtr && dtr;
    const state = upw ? 1 : dnw ? 0 : prevState;

    const reasons: string[] = [];
    if (keep1U_alert) reasons.push('keep1U_alert');
    if (keep1U_price) reasons.push('keep1U_price');
    if (keep2U) reasons.push('keep2U');
    if (utr) reasons.push('utr');
    if (upw) reasons.push('upw');
    if (keep1D) reasons.push('keep1D');
    if (keep2D) reasons.push('keep2D');
    if (dtr) reasons.push('dtr');
    if (dnw) reasons.push('dnw');

    bars[i] = {
      time: candle.time, o: candle.o, h: candle.h, l: candle.l, c: candle.c,
      haOpen: haOpen[i], haC: haC[i], mid: mid[i],
      TMA1U: TMA1U[i], TMA2U: TMA2U[i], ZlHaU: ZlHaU[i], TMA1CU: TMA1CU[i], TMA2CU: TMA2CU[i], ZlClU: ZlClU[i], ZlDifU: ZlDifU[i],
      TMA1D: TMA1D[i], TMA2D: TMA2D[i], ZlHaD: ZlHaD[i], TMA1CD: TMA1CD[i], TMA2CD: TMA2CD[i], ZlClD: ZlClD[i], ZlDifD: ZlDifD[i],
      keep1U_alert, keep1U_price, keep1U, keep2U, keepingU, keepallU, keep3U, utr,
      keep1D, keep2D, keepingD, keepallD, keep3D, dtr,
      upw, dnw, state, reason: reasons,
    };

    prevState = state;
    prevKeepallU = keepallU;
    prevKeepallD = keepallD;
    prevKeepingU = keepingU;
    prevKeepingD = keepingD;
    prevUtr = utr;
    prevDtr = dtr;
  }

  return bars;
}
