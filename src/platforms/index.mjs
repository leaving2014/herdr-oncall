import { createHerdrAdapter } from "./herdr.mjs";
import { assertPlatformAdapter } from "./contract.mjs";

const factories = new Map([["herdr", createHerdrAdapter]]);

export function registerPlatform(kind, factory) {
  if (!kind || typeof kind !== "string") {
    throw new Error("platform kind must be a string");
  }
  if (typeof factory !== "function") {
    throw new Error(`platform factory for ${kind} must be a function`);
  }
  factories.set(kind, factory);
}

export function createPlatformAdapter(kind, deps) {
  const factory = factories.get(kind);
  if (!factory) {
    throw new Error(`unknown platform ${kind}`);
  }
  return assertPlatformAdapter(factory(deps));
}

export function platformKinds() {
  return [...factories.keys()];
}
