(async function(){
  await checkBurnIn();
})();

async function checkBurnIn() {
  try {
    const res = await fetch('/config.json', { cache: 'no-store' });
    const cfg = await res.json();
    const sched = cfg.burnInSchedule;
    if (!sched) return false;
    const override = localStorage.getItem('burnInOverride');
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
