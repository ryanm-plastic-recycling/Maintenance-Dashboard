import { HACOBar } from '../indicators/haco.js';

export function hacoSignals(series: HACOBar[]): { buyIdx: number[]; sellIdx: number[]; lastState: number } {
  const buyIdx: number[] = [];
  const sellIdx: number[] = [];
  series.forEach((bar, idx) => {
    if (bar.upw) buyIdx.push(idx);
    if (bar.dnw) sellIdx.push(idx);
  });
  const lastState = series.length ? series[series.length - 1].state : 0;
  return { buyIdx, sellIdx, lastState };
}

export function hacoScan(series: HACOBar[]): { buy: boolean; sell: boolean; state: number; changed: boolean } {
  if (!series.length) return { buy: false, sell: false, state: 0, changed: false };
  const last = series[series.length - 1];
  return { buy: last.upw, sell: last.dnw, state: last.state, changed: last.upw || last.dnw };
}

export function hacoExplainLast(series: HACOBar[]): { state: number; changed: boolean; reasons: string[]; snapshot: HACOBar } {
  if (!series.length) return { state: 0, changed: false, reasons: [], snapshot: undefined as any };
  const last = series[series.length - 1];
  return { state: last.state, changed: last.upw || last.dnw, reasons: last.reason, snapshot: last };
}
