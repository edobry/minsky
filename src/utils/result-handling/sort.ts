// Sort comparator stubs for list/get commands

export type SortDirection = "asc" | "desc";

export function byUpdated<T extends { updatedAt?: string }>(direction: SortDirection = "desc") {
  return (a: T, b: T) => {
    const at = a.updatedAt ? Date.parse(a.updatedAt) : 0;
    const bt = b.updatedAt ? Date.parse(b.updatedAt) : 0;
    const delta = at - bt;
    return direction === "asc" ? delta : -delta;
  };
}

export function byCreated<T extends { createdAt?: string }>(direction: SortDirection = "desc") {
  return (a: T, b: T) => {
    const at = a.createdAt ? Date.parse(a.createdAt) : 0;
    const bt = b.createdAt ? Date.parse(b.createdAt) : 0;
    const delta = at - bt;
    return direction === "asc" ? delta : -delta;
  };
}

export function byNumber<T extends { number?: number }>(direction: SortDirection = "asc") {
  return (a: T, b: T) => {
    const an = typeof a.number === "number" ? a.number : Number.NEGATIVE_INFINITY;
    const bn = typeof b.number === "number" ? b.number : Number.NEGATIVE_INFINITY;
    const delta = an - bn;
    return direction === "asc" ? delta : -delta;
  };
}
