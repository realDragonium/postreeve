/**
 * Deterministic stand-ins for Cloudflare's v4 DNS API and GoDaddy's v1 DNS API, shaped after their public docs.
 * One `fetch` serves both hosts; each keeps its own zones and records.
 */

type Obj = Record<string, any>;

export class FakeCloudflare {
  readonly token: string;
  readonly zones = new Map<string, { id: string; name: string; records: Obj[] }>();
  readonly requests: { method: string; path: string; body: unknown }[] = [];
  #sequence = 1;

  constructor(token = "cf-test-token") {
    this.token = token;
  }

  addZone(name: string, records: Obj[] = []): void {
    const id = `zone${this.#sequence++}`;
    this.zones.set(id, { id, name, records: records.map((record) => ({ id: `rec${this.#sequence++}`, ttl: 1, ...record })) });
  }

  records(zoneName: string): Obj[] {
    return [...this.zones.values()].find(({ name }) => name === zoneName)!.records;
  }

  handle(url: URL, init: RequestInit): Response | null {
    if (url.hostname !== "api.cloudflare.com") return null;
    const path = url.pathname.replace("/client/v4", "");
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    this.requests.push({ method: init.method ?? "GET", path, body });
    if (new Headers(init.headers).get("Authorization") !== `Bearer ${this.token}`) {
      return Response.json({ success: false, errors: [{ code: 1000, message: "Invalid API Token" }], result: null }, { status: 403 });
    }
    const ok = (result: unknown, info?: Obj) => Response.json({ success: true, errors: [], result, ...(info ? { result_info: info } : {}) });
    const page = Number(url.searchParams.get("page") ?? 1);
    const perPage = Number(url.searchParams.get("per_page") ?? 100);
    const paged = (items: unknown[]) => ok(items.slice((page - 1) * perPage, page * perPage), { page, per_page: perPage, total_pages: Math.max(1, Math.ceil(items.length / perPage)) });
    if (path === "/zones") return paged([...this.zones.values()].map(({ id, name }) => ({ id, name })));
    const match = /^\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/.exec(path);
    const zone = match && this.zones.get(match[1]!);
    if (!zone) return Response.json({ success: false, errors: [{ code: 7003, message: "Could not route to /zones" }] }, { status: 404 });
    const recordId = match![2];
    switch (init.method) {
      case "GET": return paged(zone.records);
      case "POST": {
        const record = { id: `rec${this.#sequence++}`, ...this.#normalize(body) };
        zone.records.push(record);
        return ok(record);
      }
      case "PUT": {
        const index = zone.records.findIndex(({ id }) => id === recordId);
        if (index < 0) return Response.json({ success: false, errors: [{ code: 81044, message: "Record does not exist." }] }, { status: 404 });
        zone.records[index] = { id: recordId, ...this.#normalize(body) };
        return ok(zone.records[index]);
      }
      case "DELETE":
        zone.records = zone.records.filter(({ id }) => id !== recordId);
        return ok({ id: recordId });
      default: return Response.json({ success: false, errors: [{ message: "Method not allowed" }] }, { status: 405 });
    }
  }

  #normalize(body: Obj): Obj {
    // Cloudflare returns SRV content as "weight port target" next to the structured data.
    if (body.type === "SRV") return { ...body, content: `${body.data.weight} ${body.data.port} ${body.data.target}`, priority: body.data.priority };
    return body;
  }
}

export class FakeGoDaddy {
  readonly key: string;
  readonly secret: string;
  /** When true every DNS records call answers 403, like an account without production API access. */
  denyRecords = false;
  readonly domains = new Map<string, Obj[]>();
  readonly requests: { method: string; path: string; body: unknown }[] = [];

  constructor(key = "gd-key", secret = "gd-secret") {
    this.key = key;
    this.secret = secret;
  }

  handle(url: URL, init: RequestInit): Response | null {
    if (url.hostname !== "api.godaddy.com") return null;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    this.requests.push({ method: init.method ?? "GET", path: url.pathname, body });
    if (new Headers(init.headers).get("Authorization") !== `sso-key ${this.key}:${this.secret}`) {
      return Response.json({ code: "UNABLE_TO_AUTHENTICATE", message: "Unable to authenticate with the provided credentials" }, { status: 401 });
    }
    if (url.pathname === "/v1/domains") return Response.json([...this.domains.keys()].map((domain) => ({ domain, status: "ACTIVE" })));
    const match = /^\/v1\/domains\/([^/]+)\/records(?:\/([^/]+)\/([^/]+))?$/.exec(url.pathname);
    if (!match || !this.domains.has(match[1]!)) return Response.json({ code: "NOT_FOUND", message: "Domain not found" }, { status: 404 });
    if (this.denyRecords) return Response.json({ code: "ACCESS_DENIED", message: "Authenticated user is not allowed access" }, { status: 403 });
    const records = this.domains.get(match[1]!)!;
    const [type, name] = [match[2], match[3] ? decodeURIComponent(match[3]) : undefined];
    const inSet = (record: Obj) => record.type === type && record.name === name;
    switch (init.method) {
      case "GET": return Response.json(type ? records.filter(inSet) : records);
      case "PUT":
        this.domains.set(match[1]!, [...records.filter((record) => !inSet(record)), ...(body as Obj[]).map((record) => ({ ...record, type, name }))]);
        return new Response(null, { status: 200 });
      case "DELETE":
        this.domains.set(match[1]!, records.filter((record) => !inSet(record)));
        return new Response(null, { status: 204 });
      default: return Response.json({ code: "METHOD", message: "Not supported" }, { status: 405 });
    }
  }
}

export function fakeDnsFetch(...providers: { handle(url: URL, init: RequestInit): Response | null }[]) {
  return async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    for (const provider of providers) {
      const response = provider.handle(url, init);
      if (response) return response;
    }
    throw new TypeError(`No fake for ${url.hostname}`);
  };
}
