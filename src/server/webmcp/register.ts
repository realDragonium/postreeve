import { createPostreeveWebMcpTools } from "./tools.ts";
import type {
  WebMcpEnvironment,
  WebMcpModelContext,
  WebMcpRegistration,
  WebMcpServices,
} from "./types.ts";

function runtimeEnvironment(): WebMcpEnvironment {
  return {
    ...(typeof document === "undefined" ? {} : { document }),
    ...(typeof navigator === "undefined" ? {} : { navigator }),
  };
}

function isWebMcpModelContext(value: unknown): value is WebMcpModelContext {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "registerTool") === "function"
  );
}

function modelContextFrom(host: object | undefined): WebMcpModelContext | null {
  if (host === undefined || !("modelContext" in host)) {
    return null;
  }

  const { modelContext } = host;
  if (isWebMcpModelContext(modelContext)) {
    return modelContext;
  }

  return null;
}

export function resolveWebMcpModelContext(
  environment: WebMcpEnvironment = runtimeEnvironment(),
): WebMcpModelContext | null {
  return modelContextFrom(environment.document) ?? modelContextFrom(environment.navigator);
}

export interface WebMcpRegisterFilter {
  /** When given, only these tools are offered to the assistant. */
  readonly exposedToolNames?: readonly string[];
}

export async function registerPostreeveWebMcp(
  services: WebMcpServices,
  modelContext: WebMcpModelContext | null = resolveWebMcpModelContext(),
  filter: WebMcpRegisterFilter = {},
): Promise<WebMcpRegistration | null> {
  if (modelContext === null) {
    return null;
  }

  const controller = new AbortController();
  const exposed = filter.exposedToolNames;
  const tools = exposed === undefined
    ? createPostreeveWebMcpTools(services)
    : createPostreeveWebMcpTools(services).filter(({ name }) => exposed.includes(name));

  try {
    await Promise.all(
      tools.map((tool) => modelContext.registerTool(tool, { signal: controller.signal })),
    );
  } catch (error: unknown) {
    controller.abort(error);
    throw error;
  }

  return {
    toolNames: tools.map(({ name }) => name),
    dispose: () => controller.abort(),
  };
}
