/* Harness stand-in for the Electron preload. The editor talks to the Sinty
 * plugin over /p/diffusion/ipc instead of ipcRenderer. MPL-2.0. */
(function () {
  var inbox = [];
  var handlers = {};
  var pulling = false;

  function emit(channel, payload) {
    var list = handlers[channel] || [];
    for (var i = 0; i < list.length; i++) {
      try { list[i](payload); } catch (err) { console.error(err); }
    }
  }

  function pull() {
    if (pulling) return;
    pulling = true;
    fetch("/p/diffusion/ipc/inbox", { method: "GET" })
      .then(function (res) { return res.ok ? res.json() : []; })
      .then(function (batch) {
        pulling = false;
        var items = Array.isArray(batch) ? batch : [];
        for (var i = 0; i < items.length; i++) emit(items[i].channel, items[i].payload);
        setTimeout(pull, items.length ? 30 : 250);
      })
      .catch(function () {
        pulling = false;
        setTimeout(pull, 1000);
      });
  }

  window.desktop = {
    platform: "win32",
    getPathForFile: function () { return ""; },
    send: function (channel, payload) {
      fetch("/p/diffusion/ipc/out", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: channel, payload: payload }),
      }).catch(function (err) { console.error(err); });
    },
    on: function (channel, cb) {
      (handlers[channel] || (handlers[channel] = [])).push(cb);
      return function () {
        handlers[channel] = (handlers[channel] || []).filter(function (fn) { return fn !== cb; });
      };
    },
  };
  pull();
})();
