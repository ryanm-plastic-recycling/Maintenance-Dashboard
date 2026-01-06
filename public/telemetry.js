(function () {
  const STORAGE_KEY = 'pri_client_id';

  const safe = (fn) => {
    try { fn(); } catch { /* noop */ }
  };

  const generateId = () => {
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return `pri_${crypto.randomUUID()}`;
      }
    } catch {
      /* ignore */
    }
    return `pri_${Math.random().toString(36).slice(2)}`;
  };

  const clientId = (() => {
    try {
      const existing = localStorage.getItem(STORAGE_KEY);
      if (existing) return existing;
      const next = generateId();
      localStorage.setItem(STORAGE_KEY, next);
      return next;
    } catch {
      return 'unknown';
    }
  })();

  const send = (payload) => {
    safe(() => {
      const body = JSON.stringify(payload);
      const url = '/api/telemetry';

      if (navigator.sendBeacon) {
        const blob = new Blob([body], { type: 'application/json' });
        navigator.sendBeacon(url, blob);
        return;
      }

      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true
      }).catch(() => {});
    });
  };

  const track = (event, props) => {
    if (!event || typeof event !== 'string') return;
    send({
      event,
      page: location.pathname,
      clientId,
      props
    });
  };

  window.PRI_Telemetry = { track };

  document.addEventListener('DOMContentLoaded', () => {
    track('page_view');
  });
})();
