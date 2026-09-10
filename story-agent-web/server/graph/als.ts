import { AsyncLocalStorage } from "node:async_hooks";
import type { OrchestratorEvent } from "../agents/types.js";

type Store = { emit: (event: OrchestratorEvent) => void };

const als = new AsyncLocalStorage<Store>();

export function runWithEmit<T>(
  emit: (event: OrchestratorEvent) => void,
  fn: () => Promise<T>
): Promise<T> {
  return als.run({ emit }, fn);
}

export function emitEvent(event: OrchestratorEvent): void {
  als.getStore()?.emit(event);
}
