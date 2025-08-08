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

function countWeekdays(start, end) {
  let count = 0;
  const cur = new Date(start);
  cur.setHours(0, 0, 0, 0);
  while (cur <= end) {
    const day = cur.getDay();
    if (day !== 0 && day !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
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
    const workDays = countWeekdays(start, end);
    const startTs = start.getTime() / 1000;
    const endTs   = end.getTime() / 1000;

    const [assetsRes, laborRes, tasksRes] = await Promise.all([
      fetch('/api/assets'),
      fetch('/api/tasks/labor'),
      fetch('/api/tasks')
    ]);

    if (!assetsRes.ok || !laborRes.ok || !tasksRes.ok) {
      throw new Error('fetch');
    }

    const [assets, laborJson, tasksJson] = await Promise.all([
      assetsRes.json(),
      laborRes.json(),
      tasksRes.json()
    ]);

    const laborEntries = (laborJson.data?.entries || laborJson.entries || laborJson)
      .filter(e => {
        const logged = e.DateLogged || e.dateLogged || e.dateCompleted;
        return logged >= startTs && logged <= endTs;
      });

    const tasks = (tasksJson.data?.tasks || tasksJson.tasks || tasksJson)
      .filter(t => {
        const date = t.dateCompleted ?? t.createdDate;
        return date >= startTs && date <= endTs;
      });

    const rows = [];
    for (const asset of assets) {
      const id = asset.id || asset.assetID || asset.assetId;
      const name = mappings.asset?.[id]
        || mappings.productionAssets?.find(a => a.id === id)?.name
        || asset.name
        || `Asset ${id}`;

      const aLabor = laborEntries.filter(l => (l.assetID || l.assetId) === id);
      const aTasks = tasks.filter(t => (t.assetID || t.assetId) === id);

      const downtimeSec = aLabor.reduce((s, e) => s + (e.TimeSpent ?? e.timeSpent ?? e.duration ?? 0), 0);
      const downtimeHrs = downtimeSec / 3600;

      const failures = aTasks.filter(t => {
        const typeName = mappings.type?.[t.type] || t.typeName;
        return typeName === 'Unplanned WO' || typeName === 'Work Request';
      }).length;

      const plannedCount = aTasks.filter(t => {
        const typeName = mappings.type?.[t.type] || t.typeName;
        return typeName === 'PM' || typeName === 'Planned WO';
      }).length;

      const totalTasks = aTasks.length;

      const uptimePct   = workDays ? 100 - (downtimeHrs / (24 * workDays)) * 100 : 0;
      const mttr        = failures ? downtimeHrs / failures : 0;
      const mtbf        = failures ? ((workDays * 24 - downtimeHrs) / failures) : 0;
      const plannedPct  = totalTasks ? (plannedCount / totalTasks) * 100 : 0;
      const unplannedPct = totalTasks ? (failures / totalTasks) * 100 : 0;

      rows.push({ name, uptimePct, mttr, mtbf, plannedPct, unplannedPct });
    }

    tbody.innerHTML = '';
    rows.forEach(r => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${r.name}</td>
        <td>${r.uptimePct.toFixed(1)}</td>
        <td>${r.mttr.toFixed(1)}</td>
        <td>${r.mtbf.toFixed(1)}</td>
        <td>${r.plannedPct.toFixed(1)}</td>
        <td>${r.unplannedPct.toFixed(1)}</td>`;
      tbody.appendChild(tr);
    });

    const totalAssets = rows.length;
    const avg = key => totalAssets ? rows.reduce((s, r) => s + r[key], 0) / totalAssets : 0;

    setText('total-assets', totalAssets);
    setText('avg-uptime', `${avg('uptimePct').toFixed(1)}%`);
    setText('avg-mttr', avg('mttr').toFixed(1));
    setText('avg-mtbf', avg('mtbf').toFixed(1));
    setText('avg-planned', `${avg('plannedPct').toFixed(1)}%`);
    setText('avg-unplanned', `${avg('unplannedPct').toFixed(1)}%`);
  } catch (err) {
    console.error('Failed loading KPIs by asset', err);
    errorEl.style.display = 'block';
  } finally {
    loadingEl.style.display = 'none';
  }
}

window.loadAll = loadAll;
loadAll();

