import { describe, expect, it } from "vitest";
import { selectRuntime } from "../scripts/native-ios-target.mjs";
const target = { identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-5", version: "26.5", isAvailable: true };
describe("installed iOS acceptance runtime", () => {
  it("ignores older runtimes and other platforms regardless of inventory order", () => {
    const other = { ...target, identifier: "com.apple.CoreSimulator.SimRuntime.tvOS-26-5" };
    const old = { ...target, identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-4", version: "26.4" };
    for (const runtimes of [[old, other, target], [target, other, old]]) {
      expect(selectRuntime({ runtimes })).toBe(target.identifier);
    }
  });
  it("fails closed for absent, unavailable or ambiguous runtimes", () => {
    for (const runtimes of [[], [{ ...target, isAvailable: false }], [target, target]]) {
      expect(() => selectRuntime({ runtimes })).toThrow("exactly one available iOS 26.5");
    }
  });
});
