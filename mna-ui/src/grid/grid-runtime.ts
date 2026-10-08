// Header state lives outside column definitions. Updating a filter publishes a snapshot,
// preserving AG Grid's column/header identity and the focused input DOM node.
export function createGridRuntime<T>(initial: T) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    publish: (next: T) => { if (Object.is(snapshot, next)) return; snapshot = next; for (const listener of listeners) listener(); },
  };
}
