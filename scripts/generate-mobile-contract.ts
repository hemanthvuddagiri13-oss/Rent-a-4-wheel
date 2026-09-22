import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { mobileOperations } from "../src/lib/mobile/contract";

const check = process.argv.includes("--check");
type Schema = { type?: string | string[]; const?: unknown; enum?: unknown[]; anyOf?: Schema[]; oneOf?: Schema[]; items?: Schema; properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean; [key: string]: unknown };
function schema(value: z.ZodType): Schema { const json = z.toJSONSchema(value, { io: "input" }); delete json.$schema; return json as Schema; }
function ts(s: Schema): string {
  if (Array.isArray(s.type)) return s.type.map(type => ts({ ...s, type })).join(" | ");
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (s.enum) return s.enum.map(v => JSON.stringify(v)).join(" | ");
  if (s.anyOf || s.oneOf) return (s.anyOf ?? s.oneOf)!.map(ts).join(" | ");
  if (s.type === "string") return "string";
  if (s.type === "number" || s.type === "integer") return "number";
  if (s.type === "boolean") return "boolean";
  if (s.type === "null") return "null";
  if (s.type === "array") return `Array<${ts(s.items!)}>`;
  if (s.type === "object") return Object.keys(s.properties ?? {}).length ? "{ " + Object.entries(s.properties ?? {}).map(([k, v]) => `${JSON.stringify(k)}${s.required?.includes(k) ? "" : "?"}: ${ts(v)}`).join("; ") + " }" : "Record<string, never>";
  throw new Error("Unsupported contract schema: " + JSON.stringify(s));
}
const paths: Record<string, Record<string, unknown>> = {}, me…6801 tokens truncated…  }, db);
}
