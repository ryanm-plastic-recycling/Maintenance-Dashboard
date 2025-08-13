import { computeHACO, OHLC } from '../src/indicators/haco.js';
import fs from 'fs';

const candles: OHLC[] = JSON.parse(fs.readFileSync(new URL('./fixtures/sample_candles.json', import.meta.url), 'utf-8'));

test('haOpen recursion', () => {
  const series = computeHACO(candles, { lengthUp: 2, lengthDown: 2, alertLookbackBars: 1 });
  expect(series.length).toBe(candles.length);
  const haCloseRaw0 = (candles[0].o + candles[0].h + candles[0].l + candles[0].c) / 4;
  const haOpen1Expected = (series[0].haOpen + haCloseRaw0) / 2;
  expect(series[1].haOpen).toBeCloseTo(haOpen1Expected);
});

test('Alert emulation works for lookback', () => {
  const series0 = computeHACO(candles, { lengthUp: 2, lengthDown: 2, alertLookbackBars: 0 });
  const series1 = computeHACO(candles, { lengthUp: 2, lengthDown: 2, alertLookbackBars: 1 });
  expect(series0[1].keep1U_alert).toBe(false);
  expect(series1[1].keep1U_alert).toBe(true);
});
