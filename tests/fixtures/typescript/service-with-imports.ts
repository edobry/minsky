import { Logger } from "./logger";

export class Service {
  constructor(private readonly logger: Logger) {}

  ping(): string {
    return "pong";
  }
}

import { EventEmitter } from "events";

export class NotificationService extends EventEmitter {
  notify(message: string): void {
    this.emit("notification", message);
  }
}
