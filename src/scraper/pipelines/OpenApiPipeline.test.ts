import { describe, expect, it } from "vitest";
import { loadConfig } from "../../utils/config";
import { FetchStatus, type RawContent } from "../fetcher/types";
import { OpenApiPipeline } from "./OpenApiPipeline";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PETSTORE_OPENAPI_3: Record<string, unknown> = {
  openapi: "3.0.3",
  info: {
    title: "Petstore API",
    version: "1.0.0",
    description: "A sample API for managing pets.",
    contact: { name: "API Support", email: "support@petstore.example" },
    license: { name: "Apache 2.0", url: "https://www.apache.org/licenses/LICENSE-2.0" },
  },
  servers: [
    { url: "https://api.petstore.example/v1", description: "Production" },
    { url: "https://staging.petstore.example/v1", description: "Staging" },
  ],
  tags: [{ name: "pets", description: "Everything about your Pets" }],
  paths: {
    "/pets": {
      get: {
        operationId: "listPets",
        summary: "List all pets",
        tags: ["pets"],
        parameters: [
          {
            name: "limit",
            in: "query",
            required: false,
            description: "How many items to return",
            schema: { type: "integer", format: "int32" },
          },
        ],
        responses: {
          "200": {
            description: "A list of pets",
            content: {
              "application/json": {
                schema: { type: "array", items: { $ref: "#/components/schemas/Pet" } },
              },
            },
          },
        },
      },
      post: {
        operationId: "createPet",
        summary: "Create a pet",
        tags: ["pets"],
        requestBody: {
          required: true,
          description: "Pet to create",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Pet" },
            },
          },
        },
        responses: {
          "201": { description: "Pet created" },
        },
      },
    },
    "/pets/{petId}": {
      get: {
        operationId: "showPetById",
        summary: "Info for a specific pet",
        tags: ["pets"],
        deprecated: true,
        parameters: [
          {
            name: "petId",
            in: "path",
            required: true,
            description: "The id of the pet to retrieve",
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Expected response to a valid request",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Pet" },
              },
            },
          },
          "404": { description: "Pet not found" },
        },
      },
    },
  },
  components: {
    schemas: {
      Pet: {
        type: "object",
        description: "A pet in the store",
        required: ["id", "name"],
        properties: {
          id: { type: "integer", format: "int64", description: "Unique identifier" },
          name: { type: "string", description: "Name of the pet" },
          tag: { type: "string", description: "Optional tag" },
        },
      },
      Error: {
        type: "object",
        properties: {
          code: { type: "integer", format: "int32" },
          message: { type: "string" },
        },
      },
    },
    securitySchemes: {
      bearerAuth: {
        type: "http",
        description: "JWT Bearer token",
      },
    },
  },
};

const SWAGGER_2_SPEC: Record<string, unknown> = {
  swagger: "2.0",
  info: {
    title: "Legacy API",
    version: "0.9.0",
    description: "A Swagger 2.0 spec.",
  },
  host: "api.legacy.example",
  basePath: "/v1",
  schemes: ["https"],
  paths: {
    "/users": {
      get: {
        operationId: "getUsers",
        summary: "Get all users",
        parameters: [
          {
            name: "page",
            in: "query",
            type: "integer",
            required: false,
            description: "Page number",
          },
        ],
        responses: {
          "200": {
            description: "Success",
            schema: { type: "array", items: { $ref: "#/definitions/User" } },
          },
        },
      },
    },
  },
  definitions: {
    User: {
      type: "object",
      properties: {
        id: { type: "integer" },
        email: { type: "string", format: "email" },
      },
    },
  },
  securityDefinitions: {
    apiKey: { type: "apiKey", description: "API Key header" },
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpenApiPipeline", () => {
  const config = loadConfig();
  const pipeline = new OpenApiPipeline(config);
  const baseOptions = {
    url: "test.json",
    library: "test-lib",
    version: "1.0.0",
    maxPages: 10,
    maxDepth: 3,
    includePatterns: [],
    excludePatterns: [],
  };

  // -----------------------------------------------------------------------
  // canProcess
  // -----------------------------------------------------------------------

  describe("canProcess", () => {
    it("should accept JSON content with top-level openapi key", () => {
      const content = JSON.stringify(PETSTORE_OPENAPI_3);
      expect(pipeline.canProcess("application/json", Buffer.from(content))).toBe(true);
    });

    it("should accept JSON content with top-level swagger key", () => {
      const content = JSON.stringify(SWAGGER_2_SPEC);
      expect(pipeline.canProcess("application/json", Buffer.from(content))).toBe(true);
    });

    it("should accept YAML content with top-level openapi key", () => {
      const content = "openapi: 3.0.3\ninfo:\n  title: Test\n";
      expect(pipeline.canProcess("text/yaml", Buffer.from(content))).toBe(true);
      expect(pipeline.canProcess("application/yaml", Buffer.from(content))).toBe(true);
      expect(pipeline.canProcess("text/x-yaml", Buffer.from(content))).toBe(true);
      expect(pipeline.canProcess("application/x-yaml", Buffer.from(content))).toBe(true);
    });

    it("should accept YAML content with top-level swagger key", () => {
      const content = 'swagger: "2.0"\ninfo:\n  title: Test\n';
      expect(pipeline.canProcess("text/yaml", Buffer.from(content))).toBe(true);
    });

    it("should reject plain JSON without openapi/swagger key", () => {
      const content = JSON.stringify({ name: "not an api spec" });
      expect(pipeline.canProcess("application/json", Buffer.from(content))).toBe(false);
    });

    it("should reject YAML without openapi/swagger key", () => {
      const content = "name: not an api spec\nversion: 1.0\n";
      expect(pipeline.canProcess("text/yaml", Buffer.from(content))).toBe(false);
    });

    it("should reject non-JSON/YAML MIME types", () => {
      expect(pipeline.canProcess("text/html")).toBe(false);
      expect(pipeline.canProcess("text/plain")).toBe(false);
      expect(pipeline.canProcess("application/pdf")).toBe(false);
    });

    it("should reject when no content is provided", () => {
      expect(pipeline.canProcess("application/json")).toBe(false);
    });

    it("should reject empty MIME type", () => {
      expect(pipeline.canProcess("")).toBe(false);
    });

    it("should accept string content (not just Buffer)", () => {
      const content = JSON.stringify(PETSTORE_OPENAPI_3);
      expect(pipeline.canProcess("application/json", content)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // process — OpenAPI 3.x
  // -----------------------------------------------------------------------

  describe("process — OpenAPI 3.x", () => {
    const makeRawContent = (
      spec: Record<string, unknown>,
      mime = "application/json",
    ): RawContent => ({
      content: JSON.stringify(spec, null, 2),
      mimeType: mime,
      charset: "utf-8",
      source: "openapi.json",
      status: FetchStatus.SUCCESS,
    });

    it("should return title from spec info", async () => {
      const result = await pipeline.process(
        makeRawContent(PETSTORE_OPENAPI_3),
        baseOptions,
      );
      expect(result.title).toBe("Petstore API");
    });

    it("should set contentType to text/markdown", async () => {
      const result = await pipeline.process(
        makeRawContent(PETSTORE_OPENAPI_3),
        baseOptions,
      );
      expect(result.contentType).toBe("text/markdown");
    });

    it("should produce overview + endpoint + schema chunks", async () => {
      const result = await pipeline.process(
        makeRawContent(PETSTORE_OPENAPI_3),
        baseOptions,
      );
      expect(result.chunks).toBeDefined();
      const chunks = result.chunks!;

      // Overview
      const overviewChunks = chunks.filter((c) => c.section.path.includes("overview"));
      expect(overviewChunks).toHaveLength(1);
      expect(overviewChunks[0].content).toContain("# Petstore API");
      expect(overviewChunks[0].content).toContain("**Version:** 1.0.0");
      expect(overviewChunks[0].content).toContain("A sample API for managing pets.");

      // Servers
      expect(overviewChunks[0].content).toContain("`https://api.petstore.example/v1`");

      // Auth
      expect(overviewChunks[0].content).toContain("bearerAuth");

      // Tags
      expect(overviewChunks[0].content).toContain("**pets**");
    });

    it("should produce one chunk per path+method", async () => {
      const result = await pipeline.process(
        makeRawContent(PETSTORE_OPENAPI_3),
        baseOptions,
      );
      const endpointChunks = result.chunks!.filter((c) =>
        c.section.path.includes("paths"),
      );

      // /pets GET, /pets POST, /pets/{petId} GET = 3
      expect(endpointChunks).toHaveLength(3);

      // Check GET /pets
      const listPets = endpointChunks.find(
        (c) => c.section.path.includes("/pets") && c.section.path.includes("GET"),
      );
      expect(listPets).toBeDefined();
      expect(listPets!.content).toContain("## GET /pets");
      expect(listPets!.content).toContain("`listPets`");
      expect(listPets!.content).toContain("List all pets");
      expect(listPets!.content).toContain("| `limit` | query |");
    });

    it("should include operationId in endpoint chunk section path", async () => {
      const result = await pipeline.process(
        makeRawContent(PETSTORE_OPENAPI_3),
        baseOptions,
      );
      const listPets = result.chunks!.find((c) => c.section.path.includes("listPets"));
      expect(listPets).toBeDefined();
      expect(listPets!.section.path).toEqual([
        "openapi",
        "paths",
        "/pets",
        "GET",
        "listPets",
      ]);
    });

    it("should mark deprecated endpoints", async () => {
      const result = await pipeline.process(
        makeRawContent(PETSTORE_OPENAPI_3),
        baseOptions,
      );
      const showPet = result.chunks!.find((c) => c.section.path.includes("showPetById"));
      expect(showPet).toBeDefined();
      expect(showPet!.content).toContain("**DEPRECATED**");
    });

    it("should include request body documentation", async () => {
      const result = await pipeline.process(
        makeRawContent(PETSTORE_OPENAPI_3),
        baseOptions,
      );
      const createPet = result.chunks!.find((c) => c.section.path.includes("createPet"));
      expect(createPet).toBeDefined();
      expect(createPet!.content).toContain("### Request Body");
      expect(createPet!.content).toContain("Pet to create");
      expect(createPet!.content).toContain("`application/json`");
    });

    it("should produce one chunk per schema", async () => {
      const result = await pipeline.process(
        makeRawContent(PETSTORE_OPENAPI_3),
        baseOptions,
      );
      const schemaChunks = result.chunks!.filter((c) =>
        c.section.path.includes("schemas"),
      );

      expect(schemaChunks).toHaveLength(2); // Pet, Error

      const petSchema = schemaChunks.find((c) => c.section.path.includes("Pet"));
      expect(petSchema).toBeDefined();
      expect(petSchema!.content).toContain("## Schema: Pet");
      expect(petSchema!.content).toContain("A pet in the store");
      expect(petSchema!.content).toContain("| `id` |");
      expect(petSchema!.content).toContain("| `name` |");
      expect(petSchema!.content).toContain("| Yes |"); // required field
      expect(petSchema!.section.path).toEqual(["openapi", "schemas", "Pet"]);
    });

    it("should have no errors for valid spec", async () => {
      const result = await pipeline.process(
        makeRawContent(PETSTORE_OPENAPI_3),
        baseOptions,
      );
      expect(result.errors).toHaveLength(0);
    });

    it("should produce textContent as joined markdown", async () => {
      const result = await pipeline.process(
        makeRawContent(PETSTORE_OPENAPI_3),
        baseOptions,
      );
      expect(result.textContent).toBeDefined();
      expect(result.textContent).toContain("# Petstore API");
      expect(result.textContent).toContain("## GET /pets");
      expect(result.textContent).toContain("## Schema: Pet");
    });

    it("should handle responses with content types", async () => {
      const result = await pipeline.process(
        makeRawContent(PETSTORE_OPENAPI_3),
        baseOptions,
      );
      const listPets = result.chunks!.find((c) => c.section.path.includes("listPets"));
      expect(listPets!.content).toContain("### Responses");
      expect(listPets!.content).toContain("**200:**");
    });
  });

  // -----------------------------------------------------------------------
  // process — Swagger 2.0
  // -----------------------------------------------------------------------

  describe("process — Swagger 2.0", () => {
    const rawContent: RawContent = {
      content: JSON.stringify(SWAGGER_2_SPEC, null, 2),
      mimeType: "application/json",
      charset: "utf-8",
      source: "swagger.json",
      status: FetchStatus.SUCCESS,
    };

    it("should extract title from Swagger 2.0 spec", async () => {
      const result = await pipeline.process(rawContent, baseOptions);
      expect(result.title).toBe("Legacy API");
    });

    it("should render base URL from host/basePath/schemes", async () => {
      const result = await pipeline.process(rawContent, baseOptions);
      const overview = result.chunks!.find((c) => c.section.path.includes("overview"));
      expect(overview!.content).toContain("`https://api.legacy.example/v1`");
    });

    it("should render securityDefinitions", async () => {
      const result = await pipeline.process(rawContent, baseOptions);
      const overview = result.chunks!.find((c) => c.section.path.includes("overview"));
      expect(overview!.content).toContain("**apiKey**");
    });

    it("should handle Swagger 2.0 definitions as schemas", async () => {
      const result = await pipeline.process(rawContent, baseOptions);
      const schemaChunks = result.chunks!.filter((c) =>
        c.section.path.includes("schemas"),
      );
      expect(schemaChunks).toHaveLength(1);
      expect(schemaChunks[0].content).toContain("## Schema: User");
    });

    it("should handle Swagger 2.0 param type (no schema wrapper)", async () => {
      const result = await pipeline.process(rawContent, baseOptions);
      const getUsers = result.chunks!.find((c) => c.section.path.includes("getUsers"));
      expect(getUsers!.content).toContain("| `page` | query | integer |");
    });

    it("should render Swagger 2.0 response schema", async () => {
      const result = await pipeline.process(rawContent, baseOptions);
      const getUsers = result.chunks!.find((c) => c.section.path.includes("getUsers"));
      expect(getUsers!.content).toContain("### Responses");
      expect(getUsers!.content).toContain("**200:**");
    });
  });

  // -----------------------------------------------------------------------
  // process — YAML
  // -----------------------------------------------------------------------

  describe("process — YAML", () => {
    it("should process YAML OpenAPI spec", async () => {
      const yamlContent = `openapi: "3.0.0"
info:
  title: YAML API
  version: "2.0.0"
  description: A YAML-based spec
paths:
  /items:
    get:
      operationId: listItems
      summary: List items
      responses:
        "200":
          description: Success
components:
  schemas:
    Item:
      type: object
      properties:
        id:
          type: integer
`;
      const rawContent: RawContent = {
        content: yamlContent,
        mimeType: "text/yaml",
        charset: "utf-8",
        source: "openapi.yaml",
        status: FetchStatus.SUCCESS,
      };

      const result = await pipeline.process(rawContent, baseOptions);

      expect(result.title).toBe("YAML API");
      expect(result.chunks).toBeDefined();

      const overview = result.chunks!.find((c) => c.section.path.includes("overview"));
      expect(overview!.content).toContain("# YAML API");
      expect(overview!.content).toContain("**Version:** 2.0.0");

      const endpoint = result.chunks!.find((c) => c.section.path.includes("listItems"));
      expect(endpoint).toBeDefined();
      expect(endpoint!.content).toContain("## GET /items");

      const schema = result.chunks!.find((c) => c.section.path.includes("Item"));
      expect(schema).toBeDefined();
      expect(schema!.content).toContain("## Schema: Item");
    });
  });

  // -----------------------------------------------------------------------
  // process — edge cases
  // -----------------------------------------------------------------------

  describe("edge cases", () => {
    it("should handle spec with no paths", async () => {
      const spec = {
        openapi: "3.0.0",
        info: { title: "Empty API", version: "0.0.1" },
      };
      const rawContent: RawContent = {
        content: JSON.stringify(spec),
        mimeType: "application/json",
        charset: "utf-8",
        source: "empty.json",
        status: FetchStatus.SUCCESS,
      };

      const result = await pipeline.process(rawContent, baseOptions);
      expect(result.chunks).toHaveLength(1); // overview only
      expect(result.title).toBe("Empty API");
    });

    it("should handle spec with no schemas", async () => {
      const spec = {
        openapi: "3.0.0",
        info: { title: "No Schemas", version: "1.0.0" },
        paths: {
          "/health": {
            get: {
              summary: "Health check",
              responses: { "200": { description: "OK" } },
            },
          },
        },
      };
      const rawContent: RawContent = {
        content: JSON.stringify(spec),
        mimeType: "application/json",
        charset: "utf-8",
        source: "health.json",
        status: FetchStatus.SUCCESS,
      };

      const result = await pipeline.process(rawContent, baseOptions);
      // 1 overview + 1 endpoint, no schemas
      expect(result.chunks).toHaveLength(2);
    });

    it("should handle invalid JSON gracefully", async () => {
      const rawContent: RawContent = {
        content: "{ not valid json at all",
        mimeType: "application/json",
        charset: "utf-8",
        source: "bad.json",
        status: FetchStatus.SUCCESS,
      };

      const result = await pipeline.process(rawContent, baseOptions);
      expect(result.errors!.length).toBeGreaterThan(0);
      expect(result.chunks).toHaveLength(1);
      expect(result.textContent).toBe("{ not valid json at all");
    });

    it("should handle $ref types in schema properties", async () => {
      const spec = {
        openapi: "3.0.0",
        info: { title: "Ref Test", version: "1.0.0" },
        components: {
          schemas: {
            Order: {
              type: "object",
              properties: {
                pet: { $ref: "#/components/schemas/Pet" },
                items: { type: "array", items: { $ref: "#/components/schemas/Pet" } },
              },
            },
          },
        },
      };
      const rawContent: RawContent = {
        content: JSON.stringify(spec),
        mimeType: "application/json",
        charset: "utf-8",
        source: "refs.json",
        status: FetchStatus.SUCCESS,
      };

      const result = await pipeline.process(rawContent, baseOptions);
      const orderSchema = result.chunks!.find((c) => c.section.path.includes("Order"));
      expect(orderSchema).toBeDefined();
      expect(orderSchema!.content).toContain("| `pet` | Pet |");
      expect(orderSchema!.content).toContain("| `items` | Pet[] |");
    });

    it("should handle enum values in schemas", async () => {
      const spec = {
        openapi: "3.0.0",
        info: { title: "Enum Test", version: "1.0.0" },
        components: {
          schemas: {
            Status: {
              type: "string",
              enum: ["active", "inactive", "pending"],
              description: "Account status",
            },
          },
        },
      };
      const rawContent: RawContent = {
        content: JSON.stringify(spec),
        mimeType: "application/json",
        charset: "utf-8",
        source: "enum.json",
        status: FetchStatus.SUCCESS,
      };

      const result = await pipeline.process(rawContent, baseOptions);
      const statusSchema = result.chunks!.find((c) => c.section.path.includes("Status"));
      expect(statusSchema).toBeDefined();
      expect(statusSchema!.content).toContain("`active`");
      expect(statusSchema!.content).toContain("`inactive`");
      expect(statusSchema!.content).toContain("`pending`");
    });

    it("should handle Buffer content", async () => {
      const jsonString = JSON.stringify(PETSTORE_OPENAPI_3);
      const rawContent: RawContent = {
        content: Buffer.from(jsonString, "utf-8"),
        mimeType: "application/json",
        charset: "utf-8",
        source: "buffer-openapi.json",
        status: FetchStatus.SUCCESS,
      };

      const result = await pipeline.process(rawContent, baseOptions);
      expect(result.title).toBe("Petstore API");
      expect(result.chunks!.length).toBeGreaterThan(0);
    });

    it("should handle spec with no info block", async () => {
      const spec = {
        openapi: "3.0.0",
        paths: {},
      };
      const rawContent: RawContent = {
        content: JSON.stringify(spec),
        mimeType: "application/json",
        charset: "utf-8",
        source: "minimal.json",
        status: FetchStatus.SUCCESS,
      };

      const result = await pipeline.process(rawContent, baseOptions);
      expect(result.title).toBe("API Specification");
      expect(result.chunks![0].content).toContain("# API Specification");
    });

    it("should include contact and license info", async () => {
      const result = await pipeline.process(
        {
          content: JSON.stringify(PETSTORE_OPENAPI_3),
          mimeType: "application/json",
          charset: "utf-8",
          source: "petstore.json",
          status: FetchStatus.SUCCESS,
        },
        baseOptions,
      );
      const overview = result.chunks![0];
      expect(overview.content).toContain("API Support");
      expect(overview.content).toContain("support@petstore.example");
      expect(overview.content).toContain("Apache 2.0");
    });
  });
});
