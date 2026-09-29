/* Runs synchronously in <head>, before first paint: marks the page when the app is already installed or its install
   prompt was dismissed, so CSS can hide the install button with no flash. Keep in step with js/install.js. */
(function () {
  var r = document.documentElement, now = Date.now(), DAY = 864e5;
  function num(k) { try { var v = JSON.parse(localStorage.getItem(k)); return v && typeof v === 'object' ? v : null; } catch (e) { return null; } }
  var standalone = false;
  ['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay'].forEach(function (m) { try { if (matchMedia('(display-mode: ' + m + ')').matches) standalone = true; } catch (e) { /* unsupported mode */ } });
  if (navigator.standalone === true || String(document.referrer || '').indexOf('android-app://') === 0) standalone = true;
  var inst = num('ve.installed'), dis = num('ve.installDismissed');
  if (standalone || (inst && inst.t && now - inst.t < 730 * DAY)) r.setAttribute('data-installed', '');
  else if (dis && dis.until > now) r.setAttribute('data-install-dismissed', '');
})();
