export class EventHandler {
  private listeners: Function[] = [];
  private maxListeners: number = 100;
  
  addListener(fn: Function) {
    if (this.listeners.length >= this.maxListeners) {
      throw new Error("Maximum listeners exceeded");
    }
    this.listeners.push(fn);
  }
  
  removeListener(fn: Function) {
    const index = this.listeners.indexOf(fn);
    if (index > -1) {
      this.listeners.splice(index, 1);
    }
  }
}