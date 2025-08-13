import { hacoSignals, hacoScan, hacoExplainLast } from '../src/signals/haco.js';
import { HACOBar } from '../src/indicators/haco.js';

const sample: HACOBar[] = [
  {
    time: 1, o:0,h:0,l:0,c:0,
    haOpen:0,haC:0,mid:0,
    TMA1U:0,TMA2U:0,ZlHaU:0,TMA1CU:0,TMA2CU:0,ZlClU:0,ZlDifU:0,
    TMA1D:0,TMA2D:0,ZlHaD:0,TMA1CD:0,TMA2CD:0,ZlClD:0,ZlDifD:0,
    keep1U_alert:false, keep1U_price:false, keep1U:false, keep2U:false, keepingU:false, keepallU:false, keep3U:false, utr:false,
    keep1D:false, keep2D:false, keepingD:false, keepallD:false, keep3D:false, dtr:false,
    upw:true, dnw:false, state:1, reason:[]
  },
  {
    time: 2, o:0,h:0,l:0,c:0,
    haOpen:0,haC:0,mid:0,
    TMA1U:0,TMA2U:0,ZlHaU:0,TMA1CU:0,TMA2CU:0,ZlClU:0,ZlDifU:0,
    TMA1D:0,TMA2D:0,ZlHaD:0,TMA1CD:0,TMA2CD:0,ZlClD:0,ZlDifD:0,
    keep1U_alert:false, keep1U_price:false, keep1U:false, keep2U:false, keepingU:false, keepallU:false, keep3U:false, utr:false,
    keep1D:false, keep2D:false, keepingD:false, keepallD:false, keep3D:false, dtr:false,
    upw:false, dnw:false, state:1, reason:[]
  },
  {
    time:3, o:0,h:0,l:0,c:0,
    haOpen:0,haC:0,mid:0,
    TMA1U:0,TMA2U:0,ZlHaU:0,TMA1CU:0,TMA2CU:0,ZlClU:0,ZlDifU:0,
    TMA1D:0,TMA2D:0,ZlHaD:0,TMA1CD:0,TMA2CD:0,ZlClD:0,ZlDifD:0,
    keep1U_alert:false, keep1U_price:false, keep1U:false, keep2U:false, keepingU:false, keepallU:false, keep3U:false, utr:false,
    keep1D:false, keep2D:false, keepingD:false, keepallD:false, keep3D:false, dtr:true,
    upw:false, dnw:true, state:0, reason:[]
  }
];

test('hacoSignals returns buy/sell indices', () => {
  const res = hacoSignals(sample);
  expect(res.buyIdx).toEqual([0]);
  expect(res.sellIdx).toEqual([2]);
  expect(res.lastState).toBe(0);
});

test('hacoScan and hacoExplainLast use last bar', () => {
  const scan = hacoScan(sample);
  expect(scan).toEqual({ buy: false, sell: true, state: 0, changed: true });
  const explain = hacoExplainLast(sample);
  expect(explain.state).toBe(0);
  expect(explain.changed).toBe(true);
});
