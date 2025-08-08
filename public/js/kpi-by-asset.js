let mappings;
await fetch('/mappings.json')
  .then(r => r.json())
  .then(m => mappings = m)
  .catch(err => console.error('Failed to load mappings', err));

const timeframeSelect = document.getElementById('timeframe-select');
const tbody     = document.querySelector('#kpi-by-asset tbody');

console.log('[kpi-by-asset.js] module loaded');

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

export async function loadAll() {
  const tf = timeframeSelect?.value || 'lastMonth';
  const loadingEl = document.getElementById('loading');
  const errorEl   = document.getElementById('error-banner');

  if (loadingEl) loadingEl.style.display = 'flex';
  if (errorEl)   errorEl.style.display = 'none';
  try {
    const res = await fetch(`/api/kpis/by-asset?timeframe=${encodeURIComponent(tf)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const assets = data.assets;

    // clear table
    tbody.innerHTML = '';

    // each key is an assetID
    Object.values(assets).forEach(a => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${a.name}</td>
        <td>${a.uptimePct.toFixed(1)}</td>
        <td>${a.mttrHrs.toFixed(1)}</td>
        <td>${a.mtbfHrs.toFixed(1)}</td>
        <td>${((a.plannedCount/(a.plannedCount+a.unplannedCount))*100||0).toFixed(1)}</td>
        <td>${((a.unplannedCount/(a.plannedCount+a.unplannedCount))*100||0).toFixed(1)}</td>
      `;
      tbody.appendChild(tr);
    });

    // update the card averages
    const rows = Object.values(assets);
    const total = rows.length;
    const avg = key => total
      ? rows.reduce((sum,r) => sum + (r[key]||0), 0)/total
      : 0;
    setText('total-assets', total);
    setText('avg-uptime',  avg('uptimePct').toFixed(1) + '%');
    setText('avg-mttr',    avg('mttrHrs').toFixed(1));
    setText('avg-mtbf',    avg('mtbfHrs').toFixed(1));
    setText('avg-planned', ((avg('plannedCount')/(avg('plannedCount')+avg('unplannedCount')))*100||0).toFixed(1)+'%');
    setText('avg-unplanned',((avg('unplannedCount')/(avg('plannedCount')+avg('unplannedCount')))*100||0).toFixed(1)+'%');
  } catch (err) {
    console.error('loadAll failed:', err);
    if (errorEl) errorEl.style.display = 'block';
  } finally {
    if (loadingEl) loadingEl.style.display = 'none';
  }
}

if (timeframeSelect) {
  const saved = localStorage.getItem('kpiTimeframe');
  if (saved && [...timeframeSelect.options].some(o => o.value === saved)) {
    timeframeSelect.value = saved;
  }
  timeframeSelect.addEventListener('change', () => {
    localStorage.setItem('kpiTimeframe', timeframeSelect.value);
    loadAll();
  });
}

// expose to non-module inline scripts that call loadAll()
window.loadAll = loadAll;
loadAll();

