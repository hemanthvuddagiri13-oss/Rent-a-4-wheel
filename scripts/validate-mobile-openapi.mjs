import SwaggerParser from "@apidevtools/swagger-parser";
await SwaggerParser.validate("docs/api/mobile-v1.openapi.json", { resolve: { external: false } });
console.log("OpenAPI 3.1 validation passed (external reference resolution disabled).");
