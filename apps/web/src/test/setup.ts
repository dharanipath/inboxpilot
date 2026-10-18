import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { MotionGlobalConfig } from "framer-motion";
import { afterAll, afterEach, beforeAll } from "vitest";

import { server } from "./server";

MotionGlobalConfig.skipAnimations = true; // exits complete immediately in tests

// jsdom lacks these browser APIs used by Radix / theme code
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  addListener: () => undefined,
  removeListener: () => undefined,
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;
Element.prototype.scrollIntoView ??= () => undefined;
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= () => undefined;

// EventSource: tests drive SSE through FakeEventSource.instances
export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, ((e: Event) => void)[]>();
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: Event) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: unknown) {
    const e = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }
}
globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  FakeEventSource.instances = [];
  localStorage.clear();
});
afterAll(() => server.close());
