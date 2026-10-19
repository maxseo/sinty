import { EventEmitter } from "node:events";
import type { SintyEvent, StreamEvent } from "@sinty/sdk";

export type StreamOnlyEvent = StreamEvent;

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
