/**
 * Fixture: patterns that must NOT trigger the DI-fallback-shape check (ADR-026 / mt#2642).
 */

interface Client {
  send(): void;
}

interface Widget {
  render(): void;
}

// A required (non-optional) `deps` parameter — no `??` fallback at all, so nothing to flag.
// This is the sanctioned "leaf module" DI idiom (ADR-026 rule 2): dependencies are visible,
// required, and test-injectable without a container.
function makeClientRequired(deps: { client: Client }): Client {
  return deps.client;
}

// Non-optional member access before `new <PascalCase>(...)` — NOT the banned shape. Shape 2
// requires optional chaining (`?.`) on the left; a plain `.` access falls outside this rule's
// pattern (though it may still warrant its own review depending on `deps`'s optionality).
function makeWidgetNonOptionalAccess(deps: { widget?: WidgetImpl }): Widget {
  return deps.widget ?? new WidgetImpl();
}

declare class WidgetImpl implements Widget {
  render(): void;
}

// A plain default value — the right-hand side is neither `create<PascalCase>(...)` nor
// `new <PascalCase>(...)`, so it is an ordinary nullish-coalescing default, not a DI fallback.
function withDefault(x?: number): number {
  return x ?? 0;
}

// `create` factory call with a lowercase-start name does not match the
// `create<PascalCase>` naming convention this rule keys on.
function withLowercaseFactory(x?: Client): Client {
  return x ?? createclient();
}

declare function createclient(): Client;
