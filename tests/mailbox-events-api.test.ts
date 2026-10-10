import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createApi } from "../src/server/api";
import { desktopApiAuthentication } from "../src/server/security/desktop-auth";
import { createEmptyTestHarness } from "./support/test-mail";

describe("mailbox event stream", () => {
  test("streams published events after a connected comment", async () => {
    const { service, store } = await createEmptyTestHarness();
    const app = createApi(service);
    const response = await app.request("/api/events");
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const read = async () => decoder.decode((await reader.read()).value);
    expect(await read()).toBe(": connected\n\n");
    service.synchronization.events.publish({ type: "mailbox-changed", accountId: "account" });
    expect(await read()).toBe(`data: {"type":"mailbox-changed","accountId":"account"}\n\n`);
    await reader.cancel();
    store.close();
  });

  test("requires the desktop token", async () => {
    const { service, store } = await createEmptyTestHarness();
    const app = new Hono().use("/api/*", desktopApiAuthentication("secret")).route("/", createApi(service));
    expect((await app.request("/api/events")).status).toBe(401);
    store.close();
  });
});
