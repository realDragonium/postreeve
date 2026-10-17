import type { MailServerCredential } from "../../shared/mail-server";

// Stalwart v0.16 replaced its REST management API with JMAP objects named `x:<Object>`.
export const STALWART_CAPABILITY = "urn:stalwart:jmap";
const USING = ["urn:ietf:params:jmap:core", STALWART_CAPABILITY];
const REQUEST_TIMEOUT_MS = 15_000;
// Stalwart's default `maxObjectsInGet` and `maxObjectsInSet`.
export const PAGE_SIZE = 500;

export type JmapFetch = (input: string, init: RequestInit) => Promise<Response>;
export type JmapObject = Record<string, unknown>;
type MethodCall = [string, JmapObject, string];

export class MailServerError extends Error {
  readonly status: 400 | 401 | 404 | 409 | 502;

  constructor(message: string, status: MailServerError["status"] = 400) {
    super(message);
    this.name = "MailServerError";
    this.status = status;
  }
}

export interface JmapConnection {
  readonly name: string;
  readonly baseUrl: string;
  readonly credential: MailServerCredential;
}

interface SetError { type?: string; description?: string; properties?: string[]; linkedObjects?: unknown[] }

export function authorization(credential: MailServerCredential): string {
  return credential.kind === "apiKey"
    ? `Bearer ${credential.apiKey}`
    : `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`;
}

/** One authenticated JMAP endpoint. Every error it raises is safe to show: none contains the credential. */
export class StalwartJmap {
  readonly #connection: JmapConnection;
  readonly #fetch: JmapFetch;
  #accountId: string | null = null;

  constructor(connection: JmapConnection, fetchImpl: JmapFetch = fetch) {
    this.#connection = connection;
    this.#fetch = fetchImpl;
  }

  /** Fetches the session and returns the admin's account id and the public mail hostname Stalwart announces. */
  async session(): Promise<{ accountId: string; publicHost: string | null }> {
    const body = await this.#request("/jmap/session", { method: "GET" });
    const session = typeof body === "object" && body !== null ? body as JmapObject : {};
    const primary = session.primaryAccounts as Record<string, unknown> | undefined;
    const accountId = primary?.[STALWART_CAPABILITY];
    if (typeof accountId !== "string") {
      throw new MailServerError("This server does not offer Stalwart's JMAP management API; Postreeve needs Stalwart v0.16 or later");
    }
    this.#accountId = accountId;
    let publicHost: string | null = null;
    try {
      if (typeof session.apiUrl === "string") publicHost = new URL(session.apiUrl).hostname;
    } catch { publicHost = null; }
    return { accountId, publicHost };
  }

  async call(calls: readonly [string, JmapObject][]): Promise<JmapObject[]> {
    const accountId = this.#accountId ?? (await this.session()).accountId;
    const methodCalls: MethodCall[] = calls.map(([name, args], index) => [name, { accountId, ...args }, String(index)]);
    const body = await this.#request("/jmap/", { method: "POST", body: JSON.stringify({ using: USING, methodCalls }) });
    const responses = (body as { methodResponses?: unknown }).methodResponses;
    if (!Array.isArray(responses)) throw new MailServerError(`${this.#connection.name} sent an invalid JMAP response`, 502);
    return responses.map((response: unknown) => {
      const [name, args] = response as [string, JmapObject];
      if (name === "error") {
        throw new MailServerError(`${this.#connection.name}: ${String(args.description ?? args.type ?? "request failed")}`);
      }
      return args;
    });
  }

  async get(object: string, ids: readonly string[] | null, properties?: readonly string[]): Promise<JmapObject[]> {
    const props = properties ? { properties } : {};
    if (ids === null) return (await this.call([[`x:${object}/get`, { ids: null, ...props }]]))[0]!.list as JmapObject[];
    const list: JmapObject[] = [];
    for (let index = 0; index < ids.length; index += PAGE_SIZE) {
      const [result] = await this.call([[`x:${object}/get`, { ids: ids.slice(index, index + PAGE_SIZE), ...props }]]);
      list.push(...result!.list as JmapObject[]);
    }
    return list;
  }

  /**
   * One query without `position`: Stalwart 0.16.26 returns overlapping pages when a filtered query is paged,
   * while an unpaged query returns every id (up to its query limit, 5000 by default).
   */
  async query(object: string, filter: JmapObject = {}, limit?: number): Promise<string[]> {
    const [result] = await this.call([[`x:${object}/query`, { filter, ...(limit === undefined ? {} : { limit }) }]]);
    return result!.ids as string[];
  }

  async queryAndGet(object: string, filter: JmapObject = {}, properties?: readonly string[], limit?: number): Promise<JmapObject[]> {
    const ids = await this.query(object, filter, limit);
    return ids.length ? this.get(object, ids, properties) : [];
  }

  async create(object: string, value: JmapObject, accountId?: string): Promise<JmapObject> {
    const [result] = await this.call([[`x:${object}/set`, { create: { new: value }, ...(accountId ? { accountId } : {}) }]]);
    const created = (result!.created as Record<string, JmapObject> | undefined)?.new;
    if (!created) throw this.#setError(object, "create", (result!.notCreated as Record<string, SetError> | undefined)?.new);
    return created;
  }

  async update(object: string, id: string, patch: JmapObject, accountId?: string): Promise<void> {
    const [result] = await this.call([[`x:${object}/set`, { update: { [id]: patch }, ...(accountId ? { accountId } : {}) }]]);
    const updated = result!.updated as Record<string, unknown> | undefined;
    if (!updated || !(id in updated)) throw this.#setError(object, "update", (result!.notUpdated as Record<string, SetError> | undefined)?.[id]);
  }

  async destroy(object: string, ids: readonly string[], accountId?: string): Promise<void> {
    if (ids.length === 0) return;
    const [result] = await this.call([[`x:${object}/set`, { destroy: ids, ...(accountId ? { accountId } : {}) }]]);
    const failed = Object.values((result!.notDestroyed as Record<string, SetError> | undefined) ?? {});
    if (failed.length > 0) throw this.#setError(object, "delete", failed[0]);
  }

  #setError(object: string, action: string, error: SetError | undefined): MailServerError {
    const detail = error?.description ?? (error?.properties?.length ? `invalid ${error.properties.join(", ")}` : error?.type);
    const status = error?.type === "notFound" ? 404 : error?.type === "primaryKeyViolation" || error?.type === "objectIsLinked" ? 409 : 400;
    const reason = error?.type === "primaryKeyViolation" ? "it already exists" : detail ?? "no reason given";
    return new MailServerError(`${this.#connection.name} could not ${action} the ${object.replace(/^x:/, "")}: ${reason}`, status);
  }

  async #request(path: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#connection.baseUrl}${path}`, {
        ...init,
        headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: authorization(this.#connection.credential) },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: "error",
      });
    } catch {
      throw new MailServerError(`Mail server is unreachable: ${this.#connection.name}`, 502);
    }
    if (response.status === 401 || response.status === 403) {
      throw new MailServerError("Stalwart rejected the admin credential", 401);
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = typeof body === "object" && body !== null && "detail" in body ? String(body.detail) : `HTTP ${response.status}`;
      throw new MailServerError(`${this.#connection.name}: ${detail}`, response.status === 404 ? 502 : 400);
    }
    if (body === null) throw new MailServerError(`${this.#connection.name} did not answer with JSON; check the admin URL`, 502);
    return body;
  }
}
