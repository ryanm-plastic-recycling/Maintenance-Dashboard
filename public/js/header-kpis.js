// public/js/header-kpis.js
async function _updateHeader() {
  try {
    const res = await fetch('/api/kpis/header');
    if (!res.ok) throw new Error(await res.text());
    const k = await res.json();
    document.getElementById('uptime-value').innerText   = `${k.uptimePct}%`;
    document.getElementById('mttr-value').innerText     = `${k.mttrHrs}h`;
    document.getElementById('mtbf-value').innerText     = `${k.mtbfHrs}h`;
    const total = k.plannedCount + k.unplannedCount;
    const pPct  = total ? ((k.plannedCount/total)*100).toFixed(0)   : '0';
    const uPct  = total ? ((k.unplannedCount/total)*100).toFixed(0) : '0';
    document.getElementById('planned-vs-unplanned').innerText =
      `${pPct}% vs ${uPct}%`;
  } catch (err) {
    console.error('Header KPI fetch failed:', err);
  }
}

export async function initHeaderKPIs() {
  _updateHeader();
  setInterval(_updateHeader, 15 * 60 * 1000);
}

// expose for global use
window.updateKPIs = _updateHeader;
