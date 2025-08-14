export class Box<T> {
  constructor(public value: T) {}
  map<U>(fn: (t: T) => U): Box<U> {
    return new Box(fn(this.value));
  }
}

export class Repository<T extends { id: string }> {
  private items: T[] = [];

  constructor(private readonly tableName: string) {}

  async findById(id: string): Promise<T | null> {
    return this.items.find((item) => item.id === id) || null;
  }

  async save(item: T): Promise<T> {
    const existing = await this.findById(item.id);
    if (existing) {
      const index = this.items.indexOf(existing);
      this.items[index] = item;
    } else {
      this.items.push(item);
    }
    return item;
  }
}
