/* Harness stand-in for the Electron preload. The editor talks to the Sinty
 * plugin over /p/diffusion/ipc instead of ipcRenderer. MPL-2.0. */
(function () {
  var handlers = {};
  var pulling = false;
  var seen = 0;
  var watchDir = "";
  var watchedMtime = null;
  var polling = false;

  function emit(channel, payload) {
    var list = handlers[channel] || [];
    for (var i = 0; i < list.length; i++) {
      try { list[i](payload); } catch (err) { console.error(err); }
    }
  }

  function pull() {
    if (pulling) return;
    pulling = true;
    fetch("/p/diffusion/ipc/inbox?since=" + seen, { method: "GET" })
      .then(function (res) { return res.ok ? res.json() : []; })
      .then(function (batch) {
        pulling = false;
        var items = Array.isArray(batch) ? batch : [];
        for (var i = 0; i < items.length; i++) {
          if (typeof items[i].id === "number" && items[i].id > seen) seen = items[i].id;
          emit(items[i].channel, items[i].payload);
        }
        setTimeout(pull, items.length ? 30 : 250);
      })
      .catch(function () {
        pulling = false;
        setTimeout(pull, 1000);
      });
  }

  try {
    localStorage.setItem("dspro.ui.layout.uiVisible", JSON.stringify({ value: true }));
  } catch (err) {}

  window.desktop = {
    platform: "win32",
    harness: true,
    getPathForFile: function () { return ""; },
    emit: emit,
    send: function (channel, payload) {
      if (channel === "dapi:reply") emit(channel, payload);
      if (channel === "main:request" && payload && payload.channel === "projects:watch" && payload.data && payload.data.dir) {
        watchDir = payload.data.dir;
      }
      fetch("/p/diffusion/ipc/out", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: channel, payload: payload }),
      }).then(function (res) { return res.ok ? res.json() : null; }).then(function (msg) {
        if (msg && msg.channel) emit(msg.channel, msg.payload);
      }).catch(function (err) { console.error(err); });
    },
    on: function (channel, cb) {
      (handlers[channel] || (handlers[channel] = [])).push(cb);
      return function () {
        handlers[channel] = (handlers[channel] || []).filter(function (fn) { return fn !== cb; });
      };
    },
  };
  // The canvas's own saves are not a reload. A newer file was written by the
  // agent, and this pane recompiles it with the folder it is already watching.
  function pollFilm() {
    if (!watchDir || polling || !window.desktop) return;
    polling = true;
    var id = "poll-" + Date.now();
    window.desktop.send("main:request", { id: id, channel: "projects:fs-stat", data: { dir: watchDir, source: "index.tsx" } });
    var stop = window.desktop.on("main:response", function (msg) {
      if (!msg || msg.id !== id) return;
      stop();
      polling = false;
      var row = msg.ok ? msg.data : null;
      if (!row || typeof row.mtime !== "number") return;
      if (watchedMtime == null) {
        watchedMtime = row.mtime;
        return;
      }
      if (row.mtime !== watchedMtime) {
        watchedMtime = row.mtime;
        if (row.external) emit("main:event", { channel: "projects:changed", data: { dir: watchDir, path: "index.tsx" } });
      }
    });
    setTimeout(function () { stop(); polling = false; }, 4000);
  }

  setInterval(pollFilm, 800);
  pull();
})();
