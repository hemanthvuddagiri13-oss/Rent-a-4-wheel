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
const paths: Record<string, Record<string, unknown>> = {}, metadata: Record<string, unknown> = {};
const error = { type: "object", additionalProperties: false, required: ["data", "error", "requestId"], properties: { data: { type: "null" }, error: { type: "object", additionalProperties: false, required: ["code"], properties: { code: { type: "string", enum: ["UNAUTHORIZED", "FORBIDDEN", "INVALID_REQUEST", "NOT_FOUND", "CONFLICT", "RATE_LIMITED", "UNAVAILABLE"] } } }, requestId: { type: "string", format: "uuid" } } };
const headers = { "X-API-Version": { schema: { type: "string", const: "1" }, description: "Contract version" }, "X-Request-ID": { schema: { type: "string", format: "uuid" }, description: "Server-generated correlation ID" }, "Cache-Control": { schema: { type: "string", const: "private, no-store" }, description: "Private responses must not be cached" } };
const declarations: string[] = [];
for (const op of mobileOperations) {
  if (metadata[op.operationId]) throw new Error("Duplicate operation ID");
  const parameterNames = [...op.path.matchAll(/\{([^}]+)\}/g)].map(m => m[1]);
  const parameters: unknown[] = parameterNames.map(name => ({ name, in: "path", required: true, schema: { type: "string", minLength: 1, maxLength: 128 } }));
  parameters.push({ name: "X-API-Version", in: "header", required: false, schema: { type: "string", const: "1" } });
  if (op.paginated) parameters.push({ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 50, default: 20 } }, { name: "cursor", in: "query", schema: { type: "string", maxLength: 128 } });
  if (op.idempotent) parameters.push({ name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", pattern: "^[A-Za-z0-9_-]{16,128}$" } });
  if (op.capability) parameters.push({ name: "X-File-Access", in: "header", required: true, schema: { type: "string", maxLength: 1024 }, description: "60-second purpose-bound capability; bearer authentication remains required" });
  const response = schema(op.response), responses: Record<string, unknown> = {
    "200": { description: "Completed request; authority and availability remain subject to current state", headers, content: op.binary === "response" ? Object.fromEntries((op.responseMediaTypes ?? ["application/octet-stream"]).map(type => [type, { schema: { type: "string", format: "binary" } }])) : { "application/json": { schema: { type: "object", additionalProperties: false, required: ["data", "error", "requestId"], properties: { data: response, error: { type: "null" }, requestId: { type: "string", format: "uuid" } } } } } },
  };
  for (const status of [400, 401, 403, 404, 409, 413, 415, 429, 500, 503]) responses[status] = { $ref: "#/components/responses/TypedError" };
  const path = "/api/v1/mobile" + op.path; paths[path] ??= {};
  if (paths[path][op.method.toLowerCase()]) throw new Error("Duplicate route");
  paths[path][op.method.toLowerCase()] = { operationId: op.operationId, security: op.auth ? [{ nativeBearer: [] }] : [], parameters, responses,
    ...(op.body ? { requestBody: { required: true, content: op.binary === "request" ? Object.fromEntries(["image/png", "image/jpeg", "image/webp"].map(t => [t, { schema: { type: "string", format: "binary" } }])) : { "application/json": { schema: schema(op.body) } } } } : {}) };
  const fields = [parameterNames.length ? `params: { ${parameterNames.map(p => `${JSON.stringify(p)}: string`).join("; ")} }` : "params?: never", ...(op.body ? [`body: ${op.binary === "request" ? "Uint8Array" : ts(schema(op.body))}`] : ["body?: never"]), op.idempotent ? "idempotencyKey: string" : "idempotencyKey?: never", op.capability ? "fileAccess: string" : "fileAccess?: never", op.paginated ? "query?: { limit?: number; cursor?: string }" : "query?: never", ...(op.binary === "request" ? ['contentType: "image/png" | "image/jpeg" | "image/webp"'] : [])];
  declarations.push(`  ${JSON.stringify(op.operationId)}: { input: { ${fields.join("; ")} }; output: ${op.binary === "response" ? "ArrayBuffer" : ts(response)} };`);
  metadata[op.operationId] = { path: op.path, method: op.method, auth: op.auth, binary: op.binary ?? null };
}
const spec = { openapi: "3.1.0", info: { title: "Rent A 4Wheel native API", version: "1.0.0", description: "Phase 7A staging foundation. Live finance is disabled. No administrative mutation surface." }, servers: [{ url: "https://staging.example.invalid", description: "Replace with the approved staging origin; no production approval implied" }], components: { responses: { TypedError: { description: "Typed error; no private diagnostic payload", headers, content: { "application/json": { schema: error } } } }, securitySchemes: { nativeBearer: { type: "http", scheme: "bearer", bearerFormat: "opaque ma_ credential", description: "Five-minute database-authorized device credential" } } }, paths };
const generated = `// Generated by scripts/generate-mobile-contract.ts. Do not edit.\nexport interface MobileOperations {\n${declarations.join("\n")}\n}\nexport const operationMetadata = ${JSON.stringify(metadata, null, 2)} as const;\n`;
function output(file: string, content: string) { if (check) { if (readFileSync(file, "utf8").replaceAll("\r\n", "\n") !== content) throw new Error("Contract drift: " + file); } else writeFileSync(file, content); }
mkdirSync("packages/mobile-client/src", { recursive: true }); mkdirSync("docs/api", { recursive: true });
output("docs/api/mobile-v1.openapi.json", JSON.stringify(spec, null, 2) + "\n");
output("packages/mobile-client/src/generated.ts", generated);
console.log(`Validated ${mobileOperations.length} unique operations; ${check ? "generated artifacts match" : "artifacts generated"}.`);
