// public/js/header-kpis.js
const uptimeEl   = document.getElementById('uptime-value');
const mttrEl     = document.getElementById('mttr-value');
const mtbfEl     = document.getElementById('mtbf-value');
const planUnplan = document.getElementById('planned-vs-unplanned');

export async function updateKPIs() {
  try {
    const res = await fetch('/api/kpis/header');
    if (!res.ok) throw new Error(await res.text());
    const k = await res.json();
    uptimeEl.innerText   = `${k.uptimePct}%`;
    mttrEl.innerText     = `${k.mttrHrs}h`;
    mtbfEl.innerText     = `${k.mtbfHrs}h`;
    const total = k.plannedCount + k.unplannedCount;
    const pPct = total ? ((k.plannedCount/total)*100).toFixed(0)   : '0';
    const uPct = total ? ((k.unplannedCount/total)*100).toFixed(0) : '0';
    planUnplan.innerText = `${pPct}% vs ${uPct}%`;
  } catch (err) {
    console.error('Header KPI fetch failed:', err);
  }
}

export function initHeaderKPIs() {
  updateKPIs();
  setInterval(updateKPIs, 15 * 60 * 1000);
}
