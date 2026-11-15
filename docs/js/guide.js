/* Guide edition switcher (Windows / macOS) for the guide page. */
(function () {
  const editions = { windows: document.getElementById('guideWindows'), macos: document.getElementById('guideMac') };
  const buttons = document.querySelectorAll('[data-guide-os]');
  const selectEdition = (os) => {
    Object.entries(editions).forEach(([key, panel]) => { panel.hidden = key !== os; });
    buttons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.guideOs === os)));
    document.getElementById('guideTitle').textContent = os === 'macos' ? "Beginner's Guide to After Effects (MacBook Edition)" : "Beginner's Guide to After Effects";
    document.getElementById('guideLede').textContent = os === 'macos' ? 'Start here for MacBook setup, Apple Silicon plugin tips, composition settings, and macOS shortcuts.' : 'Start here for After Effects setup, plugins, composition settings, and shortcuts.';
  };
  let storedOs;
  try { storedOs = JSON.parse(localStorage.getItem('kyro.os.v1')); } catch {}
  const requestedOs = new URLSearchParams(location.search).get('os');
  const defaultOs = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent + ' ' + navigator.platform) ? 'macos' : 'windows';
  selectEdition(requestedOs === 'macos' || requestedOs === 'windows' ? requestedOs : storedOs === 'macos' || storedOs === 'windows' ? storedOs : defaultOs);
  buttons.forEach(button => button.addEventListener('click', () => {
    selectEdition(button.dataset.guideOs);
    try { localStorage.setItem('kyro.os.v1', JSON.stringify(button.dataset.guideOs)); } catch {}
  }));
})();
