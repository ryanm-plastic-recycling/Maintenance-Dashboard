(async function(){
  const active = await checkBurnIn();
  if (window.location.pathname === '/burnin.html') {
    if (!active) {
      localStorage.removeItem('burnInOverride');
      localStorage.removeItem('burnInOverrideEnd');
      window.location.href = '/index.html';
    } else {
      setInterval(async () => {
        const stillBurn = await checkBurnIn();
        if (!stillBurn) {
          localStorage.removeItem('burnInOverride');
          localStorage.removeItem('burnInOverrideEnd');
          window.location.href = '/index.html';
        }
      }, 60000);
    }
  }
})();

async function checkBurnIn() {
  try {
    const res = await fetch('/config.json', { cache: 'no-store' });
    const cfg = await res.json();
    const sched = cfg.burnInSchedule || { start: '19:00', end: '05:00' };
    const override = localStorage.getItem('burnInOverride');
    const overrideEnd = parseInt(localStorage.getItem('burnInOverrideEnd'), 10);
    const now = new Date();
    const [sh, sm] = sched.start.split(':').map(Number);
    const [eh, em] = sched.end.split(':').map(Number);
    const start = new Date();
    start.setHours(sh, sm, 0, 0);
    const end = new Date();
    end.setHours(eh, em, 0, 0);
    let inWindow;
    if (start <= end) {
      inWindow = now >= start && now < end;
    } else {
      inWindow = now >= start || now < end;
    }
    if (override === 'on' && overrideEnd && now.getTime() > overrideEnd) {
      localStorage.removeItem('burnInOverride');
      localStorage.removeItem('burnInOverrideEnd');
      return false;
    }
    const shouldBurn = (inWindow && override !== 'off') || override === 'on';
    if (shouldBurn && window.location.pathname !== '/burnin.html') {
      localStorage.setItem('lastPage', window.location.pathname);
      window.location.href = '/burnin.html';
      return true;
    }
    return shouldBurn;
  } catch (err) {
    console.error('Burn-in check failed', err);
    return false;
  }
}

window.checkBurnIn = checkBurnIn;
