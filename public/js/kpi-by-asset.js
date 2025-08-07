async function loadAll() {
  const loadingEl = document.getElementById('loading');
  const errorEl   = document.getElementById('error-banner');
  loadingEl.style.display = 'block';
  errorEl.style.display   = 'none';
  try {
    const [assetsRes, fieldsRes] = await Promise.all([
      fetch('/api/assets'),
      fetch('/api/assets/fields')
    ]);
    if (!assetsRes.ok || !fieldsRes.ok) throw new Error('fetch');
    const assets = await assetsRes.json();
    const fields = await fieldsRes.json();

    const totalAssets = assets.length;
    const avgHours = totalAssets
      ? (assets.reduce((s, a) => s + (a.hoursPerWeek || 0), 0) / totalAssets).toFixed(1)
      : '0.0';
    const assetsEl = document.getElementById('assets-count');
    const avgEl    = document.getElementById('avg-hours-per-week');
    if (assetsEl) assetsEl.textContent = totalAssets;
    if (avgEl)    avgEl.textContent    = avgHours;

    const tbody = document.querySelector('#asset-fields tbody');
    if (tbody) {
      tbody.innerHTML = '';
      fields.forEach(f => {
        const tr = document.createElement('tr');
        const last = f.lastEdited ? new Date(f.lastEdited * 1000).toLocaleString() : '';
        tr.innerHTML = `
          <td>${f.assetID}</td>
          <td>${f.fieldID}</td>
          <td>${f.field}</td>
          <td>${f.value ?? ''}</td>
          <td>${last}</td>`;
        tbody.appendChild(tr);
      });
    }
  } catch (err) {
    console.error('Failed loading asset KPIs', err);
    errorEl.style.display = 'block';
  } finally {
    loadingEl.style.display = 'none';
  }
}

window.loadAll = loadAll;
loadAll();
