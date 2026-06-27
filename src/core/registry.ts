/**
 * A tiny keyed registry used for the three plug-in points: drivers, evaluators,
 * and task types. Keeping registration explicit (rather than magic file-system
 * scanning) makes the extension model obvious: build a plug-in, `register()` it.
 */
export class Registry<T> {
  private readonly items = new Map<string, T>();

  constructor(
    /** Human label used in error messages, e.g. "driver". */
    private readonly kind: string,
    /** Extracts the unique key from an item, e.g. `(d) => d.name`. */
    private readonly keyOf: (item: T) => string,
  ) {}

  register(item: T): this {
    const key = this.keyOf(item);
    if (!key) throw new Error(`Cannot register ${this.kind} with an empty key.`);
    if (this.items.has(key)) {
      throw new Error(`A ${this.kind} named "${key}" is already registered.`);
    }
    this.items.set(key, item);
    return this;
  }

  /** Register, replacing any existing item with the same key. */
  override(item: T): this {
    this.items.set(this.keyOf(item), item);
    return this;
  }

  has(key: string): boolean {
    return this.items.has(key);
  }

  tryGet(key: string): T | undefined {
    return this.items.get(key);
  }

  get(key: string): T {
    const item = this.items.get(key);
    if (!item) {
      const available = this.keys().join(", ") || "<none>";
      throw new Error(`Unknown ${this.kind} "${key}". Available: ${available}.`);
    }
    return item;
  }

  keys(): string[] {
    return [...this.items.keys()].sort();
  }

  list(): T[] {
    return [...this.items.values()];
  }
}
