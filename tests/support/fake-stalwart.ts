import { createPublicKey } from "node:crypto";

/**
 * A deterministic stand-in for Stalwart v0.16's JMAP management API, covering the objects Postreeve uses.
 * Its wire encoding (`@type` variants, index-keyed object lists, `{value: true}` sets, JSON-pointer patches),
 * ids, error types and zone output follow what a real v0.16.26 server answers.
 */

type Obj = Record<string, unknown>;
type SetError = { type: string; description?: string; properties?: string[]; linkedObjects?: unknown[] };

export interface FakeStalwartOptions {
  readonly apiKey?: string;
  readonly hostname?: string;
  readonly adminAccountId?: string;
  readonly capability?: boolean;
  readonly date?: string;
}

const alphabet = "abcdefghijklmnopqrstuvwxyz792013";
const encodeId = (n: number) => { let s = ""; do { s = alphabet[n % 32] + s; n = Math.floor(n / 32); } while (n); return s; };

export class FakeStalwart {
  readonly apiKey: string;
  readonly hostname: string;
  readonly adminAccountId: string;
  readonly capability: boolean;
  readonly date: string;
  readonly objects = new Map<string, Map<string, Obj>>();
  readonly requests: { method: string; args: Obj }[] = [];
  readonly appPasswords = new Map<string, Map<string, Obj>>();
  readonly authorizations: string[] = [];
  /** Methods that fail on their next call, for error-path tests. */
  readonly failNext = new Map<string, SetError>();
  #sequence = 1;
  #now = Date.parse("2026-10-17T12:00:00Z");

  constructor(options: FakeStalwartOptions = {}) {
    this.apiKey = options.apiKey ?? "API_test-admin-key";
    this.hostname = options.hostname ?? "mail.example.org";
    this.adminAccountId = options.adminAccountId ?? "b";
    this.capability = options.capability ?? true;
    this.date = options.date ?? "20261017";
    this.#put("SpamSettings", "singleton", {
      enable: true, scoreSpam: 5, scoreReject: 0, scoreDiscard: 0, greylistFor: null, trustContacts: true, trustReplies: true,
    });
    for (const key of ["gmail.com", "outlook.com"]) this.#create("MemoryLookupKey", { namespace: "trusted-domains", key, isGlobPattern: false });
  }

  /** A `fetch` that serves this fake at any origin. */
  readonly fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const auth = new Headers(init.headers).get("Authorization") ?? "";
    this.authorizations.push(auth);
    if (auth !== `Bearer ${this.apiKey}` && auth !== `Basic ${Buffer.from(`admin@example.org:admin-password`).toString("base64")}`) {
      return Response.json({ type: "about:blank", status: 401, title: "Unauthorized", detail: "You have to authenticate first." }, { status: 401 });
    }
    if (url.pathname.endsWith("/jmap/session") && init.method === "GET") {
      return Response.json({
        capabilities: { "urn:ietf:params:jmap:core": { maxObjectsInGet: 500, maxObjectsInSet: 500, maxCallsInRequest: 16 } },
        accounts: { [this.adminAccountId]: { name: "admin@example.org", isPersonal: true } },
        primaryAccounts: this.capability ? { "urn:ietf:params:jmap:mail": this.adminAccountId, "urn:stalwart:jmap": this.adminAccountId } : { "urn:ietf:params:jmap:mail": this.adminAccountId },
        username: "admin@example.org",
        apiUrl: `https://${this.hostname}/jmap/`,
        state: "fake",
      });
    }
    if (url.pathname.endsWith("/jmap/") && init.method === "POST") {
      const body = JSON.parse(String(init.body)) as { using: string[]; methodCalls: [string, Obj, string][] };
      if (!body.using.includes("urn:stalwart:jmap")) {
        return Response.json({ type: "urn:ietf:params:jmap:error:unknownCapability", status: 400, detail: "Missing capability" }, { status: 400 });
      }
      const methodResponses = body.methodCalls.map(([method, args, callId]) => {
        this.requests.push({ method, args });
        try {
          return [method, this.#call(method, args), callId];
        } catch (error) {
          const detail = error as SetError;
          return ["error", { type: detail.type ?? "serverFail", description: detail.description }, callId];
        }
      });
      return Response.json({ methodResponses, sessionState: "fake" });
    }
    return Response.json({ status: 404, detail: "Not found" }, { status: 404 });
  };

  // Seeding helpers

  addDomain(name: string, extra: Obj = {}): string {
    return this.#createDomain({ name, ...extra });
  }

  addMailbox(name: string, domainId: string, extra: Obj = {}): string {
    return this.#create("Account", { "@type": "User", name, domainId, description: null, aliases: {}, quotas: {}, credentials: { 0: { "@type": "Password", secret: "seed-password" } }, ...extra });
  }

  addQueuedMessage(id: string, value: Obj): void {
    this.#put("QueuedMessage", id, value);
  }

  addReport(kind: "DmarcExternalReport" | "TlsExternalReport", value: Obj): string {
    return this.#create(kind, value);
  }

  list(type: string): Obj[] {
    return [...this.#table(type).values()].map((value) => this.#view(type, value));
  }

  find(type: string, predicate: (value: Obj) => boolean): Obj | undefined {
    return this.list(type).find(predicate);
  }

  // JMAP dispatch

  #call(method: string, args: Obj): Obj {
    const [object, fn] = method.replace(/^x:/, "").split("/") as [string, string];
    const injected = this.failNext.get(method);
    if (injected) {
      this.failNext.delete(method);
      throw injected;
    }
    const accountId = String(args.accountId ?? this.adminAccountId);
    if (object === "AppPassword") return this.#appPasswordSet(accountId, args);
    switch (fn) {
      case "query": return this.#query(object, (args.filter ?? {}) as Obj, Number(args.position ?? 0), args.limit === undefined ? Number.POSITIVE_INFINITY : Number(args.limit), accountId);
      case "get": return this.#get(object, args.ids as string[] | null, args.properties as string[] | undefined, accountId);
      case "set": return this.#set(object, args, accountId);
      default: throw { type: "unknownMethod", description: `Unknown method ${method}` };
    }
  }

  #query(object: string, filter: Obj, position: number, limit: number, accountId: string): Obj {
    if (object === "MemoryLookupKey" && Object.keys(filter).some((key) => key !== "namespace")) {
      throw { type: "unsupportedFilter", description: `Filter on property ${Object.keys(filter).find((key) => key !== "namespace")} is not supported or invalid` };
    }
    const ids = [...this.#table(object).entries()]
      .filter(([, value]) => Object.entries(filter).every(([key, wanted]) => value[key] === wanted))
      .map(([id]) => id);
    // Like v0.16.26, a filtered query ignores `position` and returns as many ids as remain, from the start.
    const page = Object.keys(filter).length && position > 0
      ? ids.slice(0, Math.min(limit, ids.length - position)) : ids.slice(position, position + limit);
    return { accountId, queryState: "n", position, ids: page, total: ids.length };
  }

  #get(object: string, ids: string[] | null, properties: string[] | undefined, accountId: string): Obj {
    const table = this.#table(object);
    if (ids && ids.length > 500) throw { type: "requestTooLarge", description: "Too many ids" };
    const wanted = ids ?? [...table.keys()];
    const list: Obj[] = [];
    const notFound: string[] = [];
    for (const id of wanted) {
      const value = table.get(id);
      if (!value) { notFound.push(id); continue; }
      const view = this.#view(object, value, id);
      list.push(properties ? Object.fromEntries([["id", id], ...properties.filter((key) => key in view).map((key) => [key, view[key]])]) : view);
    }
    return { accountId, list, notFound };
  }

  #set(object: string, args: Obj, accountId: string): Obj {
    const response: Obj = { accountId };
    const created: Obj = {}; const notCreated: Obj = {};
    for (const [key, value] of Object.entries((args.create ?? {}) as Record<string, Obj>)) {
      try { created[key] = this.#createChecked(object, value); } catch (error) { notCreated[key] = error; }
    }
    const updated: Obj = {}; const notUpdated: Obj = {};
    for (const [id, patch] of Object.entries((args.update ?? {}) as Record<string, Obj>)) {
      try { this.#update(object, id, patch); updated[id] = null; } catch (error) { notUpdated[id] = error; }
    }
    const destroyed: string[] = []; const notDestroyed: Obj = {};
    for (const id of (args.destroy ?? []) as string[]) {
      try { this.#destroy(object, id); destroyed.push(id); } catch (error) { notDestroyed[id] = error; }
    }
    if (Object.keys(created).length) response.created = created;
    if (Object.keys(notCreated).length) response.notCreated = notCreated;
    if (Object.keys(updated).length) response.updated = updated;
    if (Object.keys(notUpdated).length) response.notUpdated = notUpdated;
    if (destroyed.length) response.destroyed = destroyed;
    if (Object.keys(notDestroyed).length) response.notDestroyed = notDestroyed;
    return response;
  }

  #createChecked(object: string, value: Obj): Obj {
    switch (object) {
      case "Domain": {
        const name = String(value.name ?? "");
        if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name) || name.endsWith(".example")) throw { type: "invalidProperties", description: "Invalid domain name" };
        const existing = [...this.#table("Domain").entries()].find(([, domain]) => domain.name === name || Object.hasOwn(domain.aliases as Obj ?? {}, name));
        if (existing) throw { type: "primaryKeyViolation", properties: ["name"], objectId: { object: "Domain", id: existing[0] } };
        return { id: this.#createDomain(value) };
      }
      case "Account": {
        const secret = Object.values((value.credentials ?? {}) as Record<string, Obj>).find((credential) => credential["@type"] === "Password")?.secret;
        if (typeof secret === "string") this.#checkPassword(secret);
        if (!this.#table("Domain").has(String(value.domainId))) throw { type: "invalidForeignKey", properties: ["domainId"] };
        if (this.list("Account").some((account) => account.name === value.name && account.domainId === value.domainId)) {
          throw { type: "primaryKeyViolation", properties: ["name"] };
        }
        return { id: this.#create("Account", { description: null, aliases: {}, quotas: {}, credentials: {}, ...value }) };
      }
      case "DkimSignature": {
        const pem = ((value.privateKey ?? {}) as Obj).secret;
        if (typeof pem !== "string") throw { type: "invalidProperties", description: "Failed to validate DKIM signature: DKIM build error (dkim.build-error): reason = DKIM signature validation failed, details = [Property 'secret' is required]" };
        const publicKey = createPublicKey(pem);
        const der = publicKey.export({ type: "spki", format: "der" });
        const encoded = value["@type"] === "Dkim1Ed25519Sha256" ? der.subarray(-32).toString("base64") : der.toString("base64");
        return { id: this.#create("DkimSignature", { stage: "active", createdAt: this.#timestamp(), ...value, privateKey: { "@type": "Text", secret: "****" }, publicKey: encoded }) };
      }
      case "MemoryLookupKey": {
        if (this.list("MemoryLookupKey").some((entry) => entry.namespace === value.namespace && entry.key === value.key)) {
          throw { type: "primaryKeyViolation", properties: ["namespace"] };
        }
        return { id: this.#create("MemoryLookupKey", value) };
      }
      case "QueuedMessage":
        throw { type: "forbidden", description: "Queued messages cannot be created" };
      default:
        return { id: this.#create(object, value) };
    }
  }

  #update(object: string, id: string, patch: Obj): void {
    const value = this.#table(object).get(id);
    if (!value) throw { type: "notFound" };
    const next = structuredClone(value);
    for (const [key, change] of Object.entries(patch)) {
      const path = key.split("/");
      let target = next;
      for (const segment of path.slice(0, -1)) {
        target[segment] ??= {};
        target = target[segment] as Obj;
      }
      const last = path.at(-1)!;
      if (change === null && path.length > 1) delete target[last];
      else target[last] = change;
      if (object === "Account" && path[0] === "credentials" && last === "secret" && typeof change === "string") this.#checkPassword(change);
    }
    this.#table(object).set(id, next);
  }

  #destroy(object: string, id: string): void {
    const table = this.#table(object);
    if (!table.has(id)) throw { type: "notFound" };
    if (object === "Domain") {
      const linked = [
        ...this.list("DkimSignature").filter((key) => key.domainId === id).map((key) => ({ object: "DkimSignature", id: key.id })),
        ...this.list("Account").filter((account) => account.domainId === id).map((account) => ({ object: "Account", id: account.id })),
        ...this.list("MailingList").filter((list) => list.domainId === id).map((list) => ({ object: "MailingList", id: list.id })),
      ];
      if (linked.length) throw { type: "objectIsLinked", objectId: { object: "Domain", id }, linkedObjects: linked };
    }
    table.delete(id);
    if (object === "Account") this.appPasswords.delete(id);
  }

  #appPasswordSet(accountId: string, args: Obj): Obj {
    if (!this.#table("Account").has(accountId)) throw { type: "accountNotFound", description: "Account not found" };
    const passwords = this.appPasswords.get(accountId) ?? new Map<string, Obj>();
    this.appPasswords.set(accountId, passwords);
    const response: Obj = { accountId };
    if (args.create) {
      response.created = Object.fromEntries(Object.entries(args.create as Record<string, Obj>).map(([key, value]) => {
        const id = encodeId(passwords.size + 1);
        const secret = `app_fake${accountId}${id}secret`;
        passwords.set(id, { ...value, secret });
        return [key, { id, secret }];
      }));
    }
    if (args.destroy) {
      for (const id of args.destroy as string[]) passwords.delete(id);
      response.destroyed = args.destroy;
    }
    return response;
  }

  #checkPassword(secret: string): void {
    if (secret.length < 8 || /^password/i.test(secret)) {
      throw { type: "invalidProperties", properties: ["secret"], description: "Password is too weak" };
    }
  }

  #createDomain(value: Obj): string {
    const id = this.#create("Domain", {
      aliases: {}, isEnabled: true, catchAllAddress: null, dkimManagement: { "@type": "Automatic" },
      dnsManagement: { "@type": "Manual" }, reportAddressUri: "mailto:postmaster", ...value,
    });
    // Automatic DKIM management generates one key per default algorithm.
    if (((value.dkimManagement ?? { "@type": "Automatic" }) as Obj)["@type"] === "Automatic") {
      for (const [type, label, key] of [["Dkim1Ed25519Sha256", "ed25519", "FAKEed25519publickey="], ["Dkim1RsaSha256", "rsa", "FAKErsapublickey"]] as const) {
        this.#create("DkimSignature", { "@type": type, domainId: id, selector: `v1-${label}-${this.date}`, stage: "active", publicKey: key, createdAt: this.#timestamp() });
      }
    }
    return id;
  }

  #view(object: string, value: Obj, id?: string): Obj {
    const view: Obj = { ...structuredClone(value) };
    if (id) view.id = id;
    const domainName = (domainId: unknown) => String(this.#table("Domain").get(String(domainId))?.name ?? "");
    if (object === "Account" || object === "MailingList") view.emailAddress = `${value.name}@${domainName(value.domainId)}`;
    if (object === "Account") {
      view.usedDiskQuota = 0;
      view.credentials = Object.fromEntries(Object.entries((value.credentials ?? {}) as Record<string, Obj>).map(([key, credential]) => [key, { ...credential, secret: "****" }]));
    }
    if (object === "Domain") view.dnsZoneFile = this.#zone(id ?? String(value.id), String(value.name));
    return view;
  }

  #zone(domainId: string, name: string): string {
    const host = this.hostname;
    const keys = this.list("DkimSignature").filter((key) => key.domainId === domainId);
    return [
      ...keys.map((key) => `${key.selector}._domainkey.${name}. IN TXT "v=DKIM1; k=${key["@type"] === "Dkim1RsaSha256" ? "rsa" : "ed25519"}; h=sha256; p=${key.publicKey}"`),
      `${host}. IN TXT "v=spf1 a -all"`,
      `${name}. IN TXT "v=spf1 mx -all"`,
      `${name}. IN MX 10 ${host}.`,
      `_dmarc.${name}. IN TXT "v=DMARC1; p=reject; rua=mailto:postmaster@${name}"`,
      `_imaps._tcp.${name}. IN SRV 0 1 993 ${host}.`,
      `_submissions._tcp.${name}. IN SRV 0 1 465 ${host}.`,
      `mta-sts.${name}. IN CNAME ${host}.`,
      `_mta-sts.${name}. IN TXT "v=STSv1; id=1234567890"`,
      `_smtp._tls.${name}. IN TXT "v=TLSRPTv1; rua=mailto:postmaster@${name}"`,
      `autoconfig.${name}. IN CNAME ${host}.`,
      `autodiscover.${name}. IN CNAME ${host}.`,
      "",
    ].join("\n");
  }

  #table(object: string): Map<string, Obj> {
    let table = this.objects.get(object);
    if (!table) { table = new Map(); this.objects.set(object, table); }
    return table;
  }

  #create(object: string, value: Obj): string {
    const id = encodeId(this.#sequence++);
    this.#table(object).set(id, structuredClone(value));
    return id;
  }

  #put(object: string, id: string, value: Obj): void {
    this.#table(object).set(id, structuredClone(value));
  }

  #timestamp(): string {
    this.#now += 1000;
    return new Date(this.#now).toISOString().replace(/\.\d+Z$/, "Z");
  }
}
