import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI browser preview URLs" });

function browserHistory(urls: string[]) {
  return urls.flatMap((url, index) => {
    const id = `open-${index}`;
    const browserTab = { target: "host", profile: "managed", targetId: `tab-${index}`, url };
    return [
      {
        role: "assistant",
        timestamp: 2000 + index * 1000,
        content: [
          {
            type: "toolCall",
            id,
            name: "browser",
            arguments: { action: "open", url },
          },
        ],
      },
      {
        role: "toolResult",
        timestamp: 2500 + index * 1000,
        toolCallId: id,
        toolName: "browser",
        content: [{ type: "text", text: `Opened ${url} in tab-${index}` }],
        details: { browserTab },
      },
    ];
  });
}

suite.define(() => {
  it("loads favicon and social image through the Gateway and keeps missing metadata usable", async () => {
    const image = `data:image/png;base64,${readFileSync("ui/public/favicon-32.png").toString("base64")}`;
    await suite.withPage(
      { viewport: { width: 390, height: 844 }, colorScheme: "light", serviceWorkers: "block" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          automaticallyFetchFavicons: true,
          featureMethods: [],
          methodResponses: {
            "controlUi.linkPreview": {
              cases: [
                {
                  match: { url: "https://example.com/page" },
                  response: { title: "Example page", imageDataUrl: image, faviconDataUrl: image },
                },
                { match: { url: "https://example.org/no-metadata" }, response: {} },
              ],
            },
          },
          historyMessages: [
            { role: "user", content: "Open these pages.", timestamp: 1000 },
            ...browserHistory(["https://example.com/page", "https://example.org/no-metadata"]),
            { role: "assistant", content: "Both pages are ready.", timestamp: 5000 },
          ],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await page.getByText("Both pages are ready.", { exact: true }).waitFor();
        const cards = page.locator("openclaw-browser-tab-card");
        await expect.poll(() => cards.count()).toBe(2);
        const preview = cards.filter({ hasText: "Example page" });
        await preview.locator(".shot.social img").waitFor();
        await preview.locator(".icon img").waitFor();
        expect(
          await preview
            .locator(".shot img")
            .evaluate((img: HTMLImageElement) => img.decode().then(() => img.naturalWidth)),
        ).toBeGreaterThan(0);
        const missing = cards.filter({ hasText: "example.org" });
        expect(await missing.locator("img").count()).toBe(0);
        expect(await missing.locator(".icon svg").count()).toBe(1);
        expect(await missing.locator(".url").textContent()).toBe("https://example.org/no-metadata");
        await preview.scrollIntoViewIfNeeded();
        const bounds = await preview.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
        const request = await gateway.waitForRequest("controlUi.linkPreview", {
          match: { url: "https://example.com/page" },
        });
        expect(request.params).toMatchObject({ url: "https://example.com/page" });
      },
    );
  });

  it("never asks for a preview of a local tab while a public tab still previews", async () => {
    const local = "http://127.0.0.1:8080/";
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, colorScheme: "light", serviceWorkers: "block" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          automaticallyFetchFavicons: true,
          featureMethods: [],
          methodResponses: {
            "controlUi.linkPreview": {
              cases: [
                {
                  match: { url: "https://example.com/page" },
                  response: { title: "Example page" },
                },
              ],
            },
          },
          historyMessages: [
            { role: "user", content: "Open both pages.", timestamp: 1000 },
            ...browserHistory([local, "https://example.com/page"]),
            { role: "assistant", content: "Both pages are ready.", timestamp: 5000 },
          ],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await page.getByText("Both pages are ready.", { exact: true }).waitFor();
        const cards = page.locator("openclaw-browser-tab-card");
        await expect.poll(() => cards.count()).toBe(2);
        const localCard = cards.filter({ hasText: "127.0.0.1" });
        await expect.poll(() => localCard.locator(".url").textContent()).toBe(local);
        expect(await cards.filter({ hasText: "Example page" }).count()).toBe(1);

        await evaluateControlUiContext(page, (app) => app.navigate("about"));
        await page.waitForURL((url) => url.pathname.endsWith("/about"));
        await evaluateControlUiContext(page, (app) => app.navigate("chat"));
        await expect.poll(() => cards.count()).toBe(2);
        await expect.poll(() => localCard.locator(".url").textContent()).toBe(local);

        expect(await gateway.getRequests("controlUi.linkPreview", { url: local })).toEqual([]);
        expect(
          await gateway.getRequests("controlUi.linkPreview", { url: "https://example.com/page" }),
        ).toHaveLength(1);
        expect(await cards.filter({ hasText: "Example page" }).count()).toBe(1);
      },
    );
  });

  it.each([
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ])("collapses repeated page opens while retaining tool results ($width px)", async (viewport) => {
    await suite.withPage(
      { viewport, colorScheme: "dark", serviceWorkers: "block" },
      async ({ page }) => {
        await installMockGateway(page, {
          historyMessages: [
            { role: "user", content: "Preview both sizes.", timestamp: 1_000 },
            ...browserHistory([
              "about:blank",
              ...Array<string>(4).fill("https://example.com/blog"),
            ]),
            {
              role: "assistant",
              content: "Ready. A plain link: https://example.org",
              timestamp: 8_000,
            },
          ],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await page.getByText("Ready. A plain link:", { exact: false }).waitFor();
        const cards = page.locator("openclaw-browser-tab-card");
        await expect.poll(() => cards.count()).toBe(1);
        expect(await cards.locator(".url").textContent()).toBe("https://example.com/blog");
        for (const selector of [".chat-activity-group__summary", ".chat-tool-msg-summary"]) {
          for (const summary of await page.locator(selector).all()) {
            if ((await summary.getAttribute("aria-expanded")) !== "true") {
              await summary.click();
            }
          }
        }
        await page.getByText("Opened about:blank in tab-0", { exact: true }).waitFor();
        for (let index = 1; index <= 4; index++) {
          await page
            .getByText(`Opened https://example.com/blog in tab-${index}`, { exact: true })
            .waitFor();
        }
        expect(await cards.count()).toBe(1);
      },
    );
  });
});
