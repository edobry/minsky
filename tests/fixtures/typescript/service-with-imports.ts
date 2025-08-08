import { EventEmitter } from "events";

export class NotificationService extends EventEmitter {
  notify(message: string): void {
    this.emit("notification", message);
  }
}
