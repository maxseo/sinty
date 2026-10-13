import { EventEmitter } from "node:events";
import type { EventDataMap, SintyEvent } from "@sinty/sdk";

export type StreamOnlyEvent =
  | { type: "model.delta"; sessionId: string; turnId: string; ts: string; data: EventDataMap["model.delta"] }
  | { type: "tool.call.progress"; sessionId: string; turnId: string; ts: string; data: EventDataMap["tool.call.progress"] };

export type BusMessage = { kind: "journal"; event: SintyEvent } | { kind: "stream"; event: StreamOnlyEvent };

export class Bus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish(msg: BusMessage): void {
    this.emitter.emit("message", msg);
  }

  subscribe(fn: (msg: BusMessage) => void): () => void {
    this.emitter.on("message", fn);
    return () => this.emitter.off("message", fn);
  }
}
