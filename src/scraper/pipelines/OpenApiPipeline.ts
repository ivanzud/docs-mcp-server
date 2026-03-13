import yaml from "yaml";
import type { Chunk } from "../../splitter/types";
import type { AppConfig } from "../../utils/config";
import { MimeTypeUtils } from "../../utils/mimeTypeUtils";
import type { ContentFetcher, RawContent } from "../fetcher/types";
import type { ScraperOptions } from "../types";
import { convertToString } from "../utils/buffer";
import { BasePipeline } from "./BasePipeline";
import type { PipelineResult } from "./types";

// ---- Lightweight OpenAPI/Swagger type helpers ----

interface OpenApiInfo {
  title?: string;
  version?: string;
  description?: string;
  termsOfService?: string;
  contact?: { name?: string; url?: string; email?: string };
  license?: { name?: string; url?: string };
}

interface OpenApiServer {
  url: string;
  description?: string;
}

interface OpenApiSpec {
  openapi?: string;
  swagger?: string;
  info?: OpenApiInfo;
  host?: string;
  basePath?: string;
  schemes?: string[];
  servers?: OpenApiServer[];
  paths?: Record<string, Record<string, unknown>>;
  components?: {
    schemas?: Record<string, unknown>;
    securitySchemes?: Record<string, unknown>;
  };
  definitions?: Record<string, unknown>;
  securityDefinitions?: Record<string, unknown>;
  tags?: Array<{ name: string; description?: string }>;
}

// HTTP methods recognised by OpenAPI
const HTTP_METHODS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]);

/**
 * Pipeline for processing OpenAPI / Swagger specification files.
 *
 * Detection:
 *  - Filename match (openapi.json, swagger.json, openapi.yaml, swagger.yaml)
 *  - OR content inspection: top-level "openapi" or "swagger" key in parsed JSON/YAML
 *
 * Output: semantic markdown chunks grouped by overview, endpoint, and schema.
 */
export class OpenApiPipeline extends BasePipeline {
  constructor(_config: AppConfig) {
    super();
  }

  // ------------------------------------------------------------------
  // canProcess — must run BEFORE JsonPipeline so we intercept OpenAPI files
  // ------------------------------------------------------------------

  canProcess(mimeType: string, content?: string | Buffer): boolean {
    if (!mimeType) return false;

    const isJsonMime = MimeTypeUtils.isJson(mimeType);
    const isYamlMime = this.isYaml(mimeType);

    if (!isJsonMime && !isYamlMime) return false;

    // If we have content, try to detect OpenAPI/Swagger keys
    if (content) {
      const text = typeof content === "string" ? content : content.toString("utf-8");
      return this.looksLikeOpenApi(text, isJsonMime);
    }

    // Without content we cannot confirm — let the generic pipeline handle it
    return false;
  }

  // ------------------------------------------------------------------
  // process
  // ------------------------------------------------------------------

  async process(
    rawContent: RawContent,
    _options: ScraperOptions,
    _fetcher?: ContentFetcher,
  ): Promise<PipelineResult> {
    const contentString = convertToString(rawContent.content, rawContent.charset);

    let spec: OpenApiSpec;
    try {
      spec = this.parseSpec(contentString, rawContent.mimeType);
    } catch (error) {
      // If parsing fails, return raw text with a single chunk
      return {
        textContent: contentString,
        links: [],
        errors: [error instanceof Error ? error : new Error(String(error))],
        chunks: [
          {
            types: ["text"],
            content: contentString,
            section: { level: 1, path: ["openapi"] },
          },
        ],
      };
    }

    const chunks: Chunk[] = [];
    const title = spec.info?.title ?? "API Specification";

    // 1. Overview chunk
    chunks.push(this.buildOverviewChunk(spec));

    // 2. Endpoint chunks (one per path + method)
    if (spec.paths) {
      for (const [path, pathItem] of Object.entries(spec.paths)) {
        if (!pathItem || typeof pathItem !== "object") continue;
        for (const [method, operation] of Object.entries(
          pathItem as Record<string, unknown>,
        )) {
          if (!HTTP_METHODS.has(method.toLowerCase())) continue;
          if (!operation || typeof operation !== "object") continue;
          chunks.push(
            this.buildEndpointChunk(
              path,
              method.toUpperCase(),
              operation as Record<string, unknown>,
            ),
          );
        }
      }
    }

    // 3. Schema / model definition chunks
    const schemas = spec.components?.schemas ?? spec.definitions ?? {};
    for (const [name, schema] of Object.entries(schemas)) {
      if (!schema || typeof schema !== "object") continue;
      chunks.push(this.buildSchemaChunk(name, schema as Record<string, unknown>));
    }

    // Assemble full markdown text (concatenation of all chunks)
    const textContent = chunks.map((c) => c.content).join("\n\n---\n\n");

    return {
      title,
      contentType: "text/markdown",
      textContent,
      links: [],
      errors: [],
      chunks,
    };
  }

  // ------------------------------------------------------------------
  // Helpers — detection
  // ------------------------------------------------------------------

  private isYaml(mimeType: string): boolean {
    return (
      mimeType === "text/yaml" ||
      mimeType === "text/x-yaml" ||
      mimeType === "application/yaml" ||
      mimeType === "application/x-yaml"
    );
  }

  /**
   * Lightweight content sniff — avoids full parse.
   * Checks for `"openapi"` / `"swagger"` near the start of the document.
   */
  private looksLikeOpenApi(text: string, isJson: boolean): boolean {
    // Only inspect the first 2 KB for performance
    const head = text.slice(0, 2048);

    if (isJson) {
      // JSON: look for top-level key "openapi" or "swagger"
      return /^\s*\{[\s\S]*?"(?:openapi|swagger)"\s*:/.test(head);
    }

    // YAML: look for unindented `openapi:` or `swagger:` key
    return /^(?:openapi|swagger)\s*:/m.test(head);
  }

  private parseSpec(content: string, mimeType: string): OpenApiSpec {
    if (MimeTypeUtils.isJson(mimeType)) {
      return JSON.parse(content) as OpenApiSpec;
    }
    // YAML
    return yaml.parse(content) as OpenApiSpec;
  }

  // ------------------------------------------------------------------
  // Chunk builders
  // ------------------------------------------------------------------

  private buildOverviewChunk(spec: OpenApiSpec): Chunk {
    const lines: string[] = [];
    const info = spec.info;

    lines.push(`# ${info?.title ?? "API Specification"}`);

    if (info?.version) {
      lines.push(`**Version:** ${info.version}`);
    }

    if (info?.description) {
      lines.push("");
      lines.push(info.description);
    }

    // Servers / base URL
    if (spec.servers && spec.servers.length > 0) {
      lines.push("");
      lines.push("## Servers");
      for (const server of spec.servers) {
        const desc = server.description ? ` - ${server.description}` : "";
        lines.push(`- \`${server.url}\`${desc}`);
      }
    } else if (spec.host) {
      // Swagger 2.0 style
      const schemes = spec.schemes?.join(", ") ?? "https";
      lines.push("");
      lines.push("## Base URL");
      lines.push(`- \`${schemes}://${spec.host}${spec.basePath ?? ""}\``);
    }

    // Authentication / Security Schemes
    const securitySchemes = spec.components?.securitySchemes ?? spec.securityDefinitions;
    if (securitySchemes && typeof securitySchemes === "object") {
      lines.push("");
      lines.push("## Authentication");
      for (const [name, scheme] of Object.entries(securitySchemes)) {
        if (!scheme || typeof scheme !== "object") continue;
        const s = scheme as Record<string, unknown>;
        const type = (s.type as string) ?? "unknown";
        const desc = s.description ? ` - ${s.description}` : "";
        lines.push(`- **${name}** (\`${type}\`)${desc}`);
      }
    }

    // Tags
    if (spec.tags && spec.tags.length > 0) {
      lines.push("");
      lines.push("## Tags");
      for (const tag of spec.tags) {
        const desc = tag.description ? ` - ${tag.description}` : "";
        lines.push(`- **${tag.name}**${desc}`);
      }
    }

    if (info?.termsOfService) {
      lines.push("");
      lines.push(`**Terms of Service:** ${info.termsOfService}`);
    }

    if (info?.contact) {
      const parts: string[] = [];
      if (info.contact.name) parts.push(info.contact.name);
      if (info.contact.email) parts.push(`<${info.contact.email}>`);
      if (info.contact.url) parts.push(info.contact.url);
      if (parts.length > 0) {
        lines.push("");
        lines.push(`**Contact:** ${parts.join(" | ")}`);
      }
    }

    if (info?.license) {
      const licParts: string[] = [info.license.name ?? "Unknown"];
      if (info.license.url) licParts.push(info.license.url);
      lines.push(`**License:** ${licParts.join(" - ")}`);
    }

    return {
      types: ["text"],
      content: lines.join("\n"),
      section: { level: 1, path: ["openapi", "overview"] },
    };
  }

  private buildEndpointChunk(
    path: string,
    method: string,
    operation: Record<string, unknown>,
  ): Chunk {
    const lines: string[] = [];
    const operationId = operation.operationId as string | undefined;
    const summary = operation.summary as string | undefined;
    const description = operation.description as string | undefined;
    const tags = operation.tags as string[] | undefined;
    const deprecated = operation.deprecated as boolean | undefined;

    // Heading
    lines.push(`## ${method} ${path}`);

    if (operationId) {
      lines.push(`**Operation ID:** \`${operationId}\``);
    }
    if (tags && tags.length > 0) {
      lines.push(`**Tags:** ${tags.join(", ")}`);
    }
    if (deprecated) {
      lines.push("**DEPRECATED**");
    }
    if (summary) {
      lines.push("");
      lines.push(summary);
    }
    if (description && description !== summary) {
      lines.push("");
      lines.push(description);
    }

    // Parameters
    const parameters = operation.parameters as Array<Record<string, unknown>> | undefined;
    if (parameters && parameters.length > 0) {
      lines.push("");
      lines.push("### Parameters");
      lines.push("");
      lines.push("| Name | In | Type | Required | Description |");
      lines.push("|------|-----|------|----------|-------------|");
      for (const param of parameters) {
        const name = (param.name as string) ?? "";
        const loc = (param.in as string) ?? "";
        const required = param.required ? "Yes" : "No";
        const desc = ((param.description as string) ?? "").replace(/\n/g, " ");
        const type = this.resolveParamType(param);
        lines.push(`| \`${name}\` | ${loc} | ${type} | ${required} | ${desc} |`);
      }
    }

    // Request body (OpenAPI 3.x)
    const requestBody = operation.requestBody as Record<string, unknown> | undefined;
    if (requestBody) {
      lines.push("");
      lines.push("### Request Body");
      const reqDesc = requestBody.description as string | undefined;
      const required = requestBody.required ? " (required)" : "";
      if (reqDesc) {
        lines.push(`${reqDesc}${required}`);
      }
      const contentMap = requestBody.content as Record<string, unknown> | undefined;
      if (contentMap) {
        for (const [mediaType, mediaObj] of Object.entries(contentMap)) {
          lines.push("");
          lines.push(`**Content-Type:** \`${mediaType}\``);
          if (mediaObj && typeof mediaObj === "object") {
            const schema = (mediaObj as Record<string, unknown>).schema as
              | Record<string, unknown>
              | undefined;
            if (schema) {
              lines.push("");
              lines.push("```json");
              lines.push(JSON.stringify(schema, null, 2));
              lines.push("```");
            }
          }
        }
      }
    }

    // Responses
    const responses = operation.responses as Record<string, unknown> | undefined;
    if (responses) {
      lines.push("");
      lines.push("### Responses");
      for (const [statusCode, resp] of Object.entries(responses)) {
        if (!resp || typeof resp !== "object") continue;
        const r = resp as Record<string, unknown>;
        const respDesc = (r.description as string) ?? "";
        lines.push("");
        lines.push(`**${statusCode}:** ${respDesc}`);

        // OpenAPI 3.x content
        const respContent = r.content as Record<string, unknown> | undefined;
        if (respContent) {
          for (const [mediaType, mediaObj] of Object.entries(respContent)) {
            if (mediaObj && typeof mediaObj === "object") {
              const schema = (mediaObj as Record<string, unknown>).schema as
                | Record<string, unknown>
                | undefined;
              if (schema) {
                lines.push(`\nContent-Type: \`${mediaType}\``);
                lines.push("");
                lines.push("```json");
                lines.push(JSON.stringify(schema, null, 2));
                lines.push("```");
              }
            }
          }
        }

        // Swagger 2.0 schema
        const respSchema = r.schema as Record<string, unknown> | undefined;
        if (respSchema) {
          lines.push("");
          lines.push("```json");
          lines.push(JSON.stringify(respSchema, null, 2));
          lines.push("```");
        }
      }
    }

    // Build section path with meaningful metadata
    const sectionPath = ["openapi", "paths", path, method];
    if (operationId) {
      sectionPath.push(operationId);
    }

    return {
      types: ["text"],
      content: lines.join("\n"),
      section: { level: 2, path: sectionPath },
    };
  }

  private buildSchemaChunk(name: string, schema: Record<string, unknown>): Chunk {
    const lines: string[] = [];
    const description = schema.description as string | undefined;
    const type = schema.type as string | undefined;
    const required = schema.required as string[] | undefined;
    const enumValues = schema.enum as unknown[] | undefined;

    lines.push(`## Schema: ${name}`);

    if (description) {
      lines.push("");
      lines.push(description);
    }

    if (type) {
      lines.push("");
      lines.push(`**Type:** \`${type}\``);
    }

    if (enumValues) {
      lines.push(`**Enum:** ${enumValues.map((v) => `\`${String(v)}\``).join(", ")}`);
    }

    // Properties table
    const properties = schema.properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (properties && Object.keys(properties).length > 0) {
      lines.push("");
      lines.push("### Properties");
      lines.push("");
      lines.push("| Property | Type | Required | Description |");
      lines.push("|----------|------|----------|-------------|");
      for (const [propName, prop] of Object.entries(properties)) {
        if (!prop || typeof prop !== "object") continue;
        const propType = this.resolveSchemaType(prop);
        const isRequired = required?.includes(propName) ? "Yes" : "No";
        const propDesc = ((prop.description as string) ?? "").replace(/\n/g, " ");
        lines.push(`| \`${propName}\` | ${propType} | ${isRequired} | ${propDesc} |`);
      }
    }

    // allOf / oneOf / anyOf
    for (const combiner of ["allOf", "oneOf", "anyOf"] as const) {
      const items = schema[combiner] as unknown[] | undefined;
      if (items && items.length > 0) {
        lines.push("");
        lines.push(`**${combiner}:**`);
        lines.push("");
        lines.push("```json");
        lines.push(JSON.stringify(items, null, 2));
        lines.push("```");
      }
    }

    return {
      types: ["text"],
      content: lines.join("\n"),
      section: { level: 2, path: ["openapi", "schemas", name] },
    };
  }

  // ------------------------------------------------------------------
  // Type resolution helpers
  // ------------------------------------------------------------------

  private resolveParamType(param: Record<string, unknown>): string {
    // OpenAPI 3.x: schema.type
    const schema = param.schema as Record<string, unknown> | undefined;
    if (schema) {
      return this.resolveSchemaType(schema);
    }
    // Swagger 2.0: type directly on param
    return (param.type as string) ?? "any";
  }

  private resolveSchemaType(schema: Record<string, unknown>): string {
    if (schema.$ref) {
      const ref = schema.$ref as string;
      // Extract the last segment of #/components/schemas/Foo or #/definitions/Foo
      const parts = ref.split("/");
      return parts[parts.length - 1];
    }
    const type = schema.type as string | undefined;
    if (type === "array") {
      const items = schema.items as Record<string, unknown> | undefined;
      if (items) {
        return `${this.resolveSchemaType(items)}[]`;
      }
      return "array";
    }
    if (type === "object") {
      const additionalProperties = schema.additionalProperties as
        | Record<string, unknown>
        | boolean
        | undefined;
      if (additionalProperties && typeof additionalProperties === "object") {
        return `Map<string, ${this.resolveSchemaType(additionalProperties)}>`;
      }
      return "object";
    }
    if (schema.oneOf || schema.anyOf) {
      const items = (schema.oneOf ?? schema.anyOf) as
        | Array<Record<string, unknown>>
        | undefined;
      if (items) {
        return items.map((i) => this.resolveSchemaType(i)).join(" | ");
      }
    }
    const format = schema.format as string | undefined;
    if (type && format) {
      return `${type} (${format})`;
    }
    return type ?? "any";
  }
}
