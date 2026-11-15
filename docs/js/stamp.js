/* Live "site updated" stamp shared by the about and guide pages. */
(function () {
  const two = (n) => String(n).padStart(2, '0');
  const el = document.getElementById('siteUpdated');
  const tick = () => {
    const d = new Date();
    el.textContent = d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) +
      ' ' + two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds());
  };
  tick();
  setInterval(tick, 1000);
})();
