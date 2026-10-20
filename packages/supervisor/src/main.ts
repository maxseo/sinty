import type { FromSupervisor, ToSupervisor } from "./protocol.js";
import { Supervisor } from "./supervisor.js";

const send = (msg: FromSupervisor): void => {
  process.send?.(msg);
};

let sup: Supervisor | undefined;

process.on("message", (msg: ToSupervisor) => {
  try {
    switch (msg.t) {
      case "init":
        sup = new Supervisor(msg.settings, msg.tools, msg.incidents);
        send({ t: "ready" });
        break;
      case "settings":
        sup?.setSettings(msg.settings);
        break;
      case "tools":
        sup?.setTools(msg.tools);
        break;
      case "incident.stored":
        sup?.addIncident(msg.incident);
        break;
      case "event":
        for (const incident of sup?.onEvent(msg.event) ?? []) {
          send({ t: "incident.resolved", sessionId: msg.event.sessionId, turnId: msg.event.turnId ?? "", incident });
        }
        break;
      case "checkpoint":
        send({ t: "actions", id: msg.id, actions: sup?.checkpoint(msg.turnId, msg.phase) ?? [] });
        break;
    }
  } catch (e) {
    send({ t: "log", level: "error", msg: e instanceof Error ? (e.stack ?? e.message) : String(e) });
    if (msg.t === "checkpoint") send({ t: "actions", id: msg.id, actions: [] });
  }
});

process.on("disconnect", () => process.exit(0));
