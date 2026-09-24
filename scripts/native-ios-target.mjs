import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Require the SDK-matched runtime, never an arbitrary older iPhone. */
export function selectRuntime(inventory) {
  const matches = inventory.runtimes.filter((runtime) =>
    runtime.isAvailable === true && runtime.version === "26.5" &&
    runtime.identifier === "com.apple.CoreSimulator.SimRuntime.iOS-26-5");
  if (matches.length !== 1) throw new Error("Expected exactly one available iOS 26.5 runtime");
  return matches[0].identifier;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(selectRuntime(JSON.parse(readFileSync(process.argv[2], "utf8"))));
}
