console.log('[header-kpis.js] module loaded');

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return '--%';
  return `${Number(n).toFixed(1)}%`;
}

async function fetchJsonNo304(url) {
  const u = `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`;
  const res = await fetch(u, { cache: 'no-store' });
  if (!res.ok) {
    if (res.status === 304) {
      const res2 = await fetch(u, { cache: 'reload' });
      if (!res2.ok) throw new Error(`HTTP ${res2.status}`);
      return res2.json();
    }
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

export async function loadHeaderKpis() {
  try {
    const data = await fetchJsonNo304('/api/kpis/by-asset?timeframe=lastWeek');

    // Prefer server aggregate; fallback to compute if missing
    let downtime = data?.totals?.downtimePct;
    if (downtime == null && data?.assets) {
      const sums = Object.values(data.assets).reduce((a, x) => {
        a.op += Number(x.operationalHours || 0);
        a.dt += Number(x.downtimeHrs || 0);
        return a;
      }, { op: 0, dt: 0 });
      downtime = sums.op ? (100 * sums.dt / sums.op) : null;
    }

    setText('downtime-value', fmtPct(downtime));
  } catch (e) {
    console.error('Header KPI load error', e);
    setText('downtime-value', '--%');
  }
}

// Ensure DOM is ready before writing to the header
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', loadHeaderKpis);
} else {
  loadHeaderKpis();
}
