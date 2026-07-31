/**
 * Fixture: the banned DI-fallback shape (ADR-026 / mt#2642).
 *
 * Both violations below use an OPTIONAL dependency that falls back to a live construction
 * when unset — this bypasses DI-container registration and hides missing wiring behind an
 * apparently-working default.
 */

interface Client {
  send(): void;
}

interface Widget {
  render(): void;
}

// Shape 1: `<identifier> ?? create<PascalCase>(...)` — bare-identifier fallback to a factory
// function named with the `create<PascalCase>` convention.
function makeClient(x?: Client): Client {
  const client = x ?? createConfiguredY();
  return client;
}

// Shape 2: `<identifier>?.<prop> ?? new <PascalCase>(...)` — optional-member-access fallback
// to a direct class construction.
function makeWidget(deps?: { y?: Widget }): Widget {
  const widget = deps?.y ?? new Z();
  return widget;
}

declare function createConfiguredY(): Client;
declare class Z implements Widget {
  render(): void;
}
