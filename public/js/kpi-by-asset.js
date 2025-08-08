let mappings;
await fetch('/mappings.json')
  .then(r => r.json())
  .then(m => mappings = m)
  .catch(err => console.error('Failed to load mappings', err));

const errorEl   = document.getElementById('error-banner');
const loadingEl = document.getElementById('loading');
const tbody     = document.querySelector('#kpi-by-asset tbody');
const selectEl  = document.getElementById('timeframe-select');

console.log('[kpi-by-asset.js] module loaded');

selectEl.addEventListener('change', () => loadAll());

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function startOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday start
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfWeek(date) {
  const d = startOfWeek(date);
  d.setDate(d.getDate() + 6);
  d.setHours(23, 59, 59, 999);
  return d;
}

function getRange(option) {
  const now = new Date();
  let start, end;
  switch (option) {
    case 'currentWeek':
      start = startOfWeek(now);
      end = now;
      break;
    case 'lastWeek': {
      const d = new Date(now);
      d.setDate(d.getDate() - 7);
      start = startOfWeek(d);
      end = endOfWeek(d);
      break;
    }
    case 'currentMonth':
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      end = now;
      break;
    case 'lastMonth': {
      const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      start = d;
      end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
      break;
    }
    case 'currentYear':
      start = new Date(now.getFullYear(), 0, 1);
      end = now;
      break;
    case 'lastYear':
      start = new Date(now.getFullYear() - 1, 0, 1);
      end = new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59);
      break;
    default:
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      end = now;
  }
  return { start, end };
}

async function loadAll() {
  loadingEl.style.display = 'block';
  errorEl.style.display   = 'none';
  try {
    const { start, end } = getRange(selectEl.value);
    const qs = '?start=' + Math.floor(start.getTime()/1000)
             + '&end='   + Math.floor(end.getTime()/1000);

    // fetch the per‐asset rollups in one go:
    const res = await fetch('/api/kpis/by-asset' + qs);
    if (!res.ok) throw new Error(await res.text());
    const { assets } = await res.json();

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
    console.error('Failed loading KPIs by asset', err);
    errorEl.style.display = 'block';
  } finally {
    loadingEl.style.display = 'none';
  }
}

window.loadAll = loadAll;
loadAll();

