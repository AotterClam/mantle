import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  renderConnectedAppsFallbackHtml as renderConnectedAppsHtml,
  renderConsentFallbackHtml as renderConsentHtml,
} from "../src/oauthFallbackHtml.js";
import {
  handleMantleOAuth,
  mountMantleOAuth,
  type MantleOAuthAuth,
} from "../src/index.js";

const stubAuth: MantleOAuthAuth = {
  getSession: async () => null,
  getOAuthConsentRequest: async () => null,
  completeOAuthConsent: async () => {
    throw new Error("stub auth has no OAuth consent flow");
  },
};

describe("mountMantleOAuth", () => {
  it("serves the shared Admin SPA through the runtime-neutral handler", async () => {
    const assets = {
      fetch: async () => new Response('<div id="root"></div>', {
        headers: { "content-type": "text/html" },
      }),
    };
    const res = await handleMantleOAuth(
      new Request("https://example.test/oauth/consent?sig=signed"),
      {
        auth: stubAuth,
        assets,
      },
    );

    expect(res?.status).toBe(200);
    expect(await res?.text()).toContain('id="root"');
    expect(res?.headers.get("cache-control")).toBe("private, no-store");
    expect(res?.headers.get("referrer-policy")).toBe("same-origin");
    expect(res?.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(res?.headers.get("content-security-policy")).not.toContain("unsafe-inline");

    const connected = await handleMantleOAuth(
      new Request("https://example.test/oauth/consents"),
      {
        auth: {
          ...stubAuth,
          listOAuthConsents: async () => [],
          revokeOAuthConsent: async () => true,
        },
        assets,
      },
    );
    expect(connected?.status).toBe(302);
    expect(connected?.headers.get("location")).toBe("/admin/connected-apps");
  });

  it("projects consent and connected apps as secret-free SPA data", async () => {
    const app = new Hono();
    mountMantleOAuth(app, {
      auth: {
        ...stubAuth,
        getSession: async () => ({
          session: { id: "s1", userId: "u1", expiresAt: new Date(Date.now() + 60_000) },
          user: { id: "u1", email: "u1@example.test", name: "U", role: "owner" },
        }),
        getOAuthConsentRequest: async () => ({
          clientName: "Claude",
          redirectUri: "https://client.example/callback",
          scopes: ["mcp"],
          oauthQuery: "signed=query",
        }),
        listOAuthConsents: async () => [{
          id: "consent-1",
          clientId: "client-1",
          clientName: "Claude",
          scopes: ["mcp"],
        }],
        revokeOAuthConsent: async () => true,
      },
    });

    const consent = await app.request("https://example.test/oauth/consent/data?sig=signed");
    expect(consent.status).toBe(200);
    expect(await consent.json()).toEqual({ consent: {
      clientName: "Claude",
      redirectUri: "https://client.example/callback",
      scopes: ["mcp"],
      oauthQuery: "signed=query",
    } });

    const apps = await app.request("https://example.test/oauth/consents/data");
    expect(apps.status).toBe(200);
    expect(await apps.json()).toEqual({ consents: [{
      id: "consent-1",
      clientId: "client-1",
      clientName: "Claude",
      scopes: ["mcp"],
    }] });
  });

  it("renders consent with the shared admin system tokens", () => {
    const html = renderConsentHtml("en", null, "test-nonce");

    expect(html).toContain("--mantle-blue-deep");
    expect(html).toContain("background:var(--app-background)");
    expect(html).toContain("button:focus-visible");
    expect(html).not.toContain("--navy:");
  });

  it("renders the secret-free Better Auth consent projection", async () => {
    const app = new Hono();
    mountMantleOAuth(app, {
      auth: {
        ...stubAuth,
        getOAuthConsentRequest: async () => ({
          clientName: "Claude",
          redirectUri: "https://client.example/callback",
          scopes: ["mcp"],
          oauthQuery: "signed=query",
        }),
      },
    });

    const res = await app.request(
      "https://example.test/oauth/consent?client_id=claude&scope=mcp",
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(res.headers.get("content-security-policy")).toContain("script-src 'nonce-");
    const html = await res.text();
    expect(html).toContain("Claude");
    expect(html).toMatch(/<script nonce="[^"]+">/u);
  });

  it("locks both consent actions while preserving the submitted decision", () => {
    const html = renderConsentHtml("zh-TW", {
      clientName: "Claude",
      redirectUri: "https://client.example/callback",
      scopes: ["mcp"],
      oauthQuery: "signed=query",
    }, "test-nonce");

    expect(html).toContain('<input type="hidden" name="decision"/>');
    expect(html).toContain('data-loading-label="連結中…"');
    expect(html).toContain('data-loading-label="取消中…"');
    expect(html).toContain("仍會依照你的帳號權限決定");
    expect(html).not.toContain(">mcp<");
    expect(html).toContain('this.setAttribute("aria-busy","true")');
    expect(html).toContain('action.disabled=true');
    expect(html).toContain('<script nonce="test-nonce">');
  });

  it("renders connected apps with a locked revoke action", () => {
    const html = renderConnectedAppsHtml("en", [{
      id: "consent-1",
      clientId: "https://client.example/metadata",
      clientName: "Claude",
      scopes: ["mcp"],
    }], "test-nonce");

    expect(html).toContain("Connected apps");
    expect(html).toContain("Claude");
    expect(html).toContain('name="consent_id" value="consent-1"');
    expect(html).toContain('data-loading-label="Disconnecting…"');
    expect(html).not.toContain(">mcp<");
    expect(html).toContain('form[data-submit-lock]');
    expect(html).toContain('<script nonce="test-nonce">');
  });

  it("lists and revokes only the current user's connected app", async () => {
    const listOAuthConsents = vi.fn(async () => [{
      id: "consent-1",
      clientId: "client-1",
      clientName: "Claude",
      scopes: ["mcp"],
    }]);
    const revokeOAuthConsent = vi.fn(async () => true);
    const app = new Hono();
    mountMantleOAuth(app, {
      auth: {
        ...stubAuth,
        getSession: async () => ({
          session: { id: "s1", userId: "u1", expiresAt: new Date(Date.now() + 60_000) },
          user: { id: "u1", email: "u1@example.test", name: "U", role: "owner" },
        }),
        listOAuthConsents,
        revokeOAuthConsent,
      },
    });

    const page = await app.request("https://example.test/oauth/consents");
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("private, no-store");
    expect(page.headers.get("content-security-policy")).toContain("script-src 'nonce-");
    expect(await page.text()).toContain("Claude");
    expect(listOAuthConsents).toHaveBeenCalledWith("u1");

    const revoked = await app.request("https://example.test/oauth/consents/revoke", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
      body: new URLSearchParams({ consent_id: "consent-1" }),
    });
    expect(revoked.status).toBe(303);
    expect(revoked.headers.get("location")).toBe("/oauth/consents");
    expect(revokeOAuthConsent).toHaveBeenCalledWith("u1", "consent-1");
  });

  it("requires a session and same-origin mutation for connected apps", async () => {
    const app = new Hono();
    mountMantleOAuth(app, {
      auth: {
        ...stubAuth,
        listOAuthConsents: async () => [],
        revokeOAuthConsent: async () => true,
      },
    });

    const page = await app.request("https://example.test/oauth/consents");
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe(
      "/admin/sign-in?return=%2Foauth%2Fconsents",
    );
    const rejected = await app.request("https://example.test/oauth/consents/revoke", {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" },
      body: new URLSearchParams({ consent_id: "consent-1" }),
    });
    expect(rejected.status).toBe(403);
  });

  describe("consent POST CSRF defense (#389)", () => {
    const sessionAuth: MantleOAuthAuth = {
      ...stubAuth,
      getSession: async () => ({
        session: { id: "s1", userId: "u1", expiresAt: new Date(Date.now() + 60_000) },
        user: { id: "u1", email: "u1@example.test", name: "U", role: "owner" },
      }),
      completeOAuthConsent: async () => {
        throw new Error("invalid authorization request");
      },
    } as MantleOAuthAuth;

    function consentApp() {
      const app = new Hono();
      mountMantleOAuth(app, { auth: sessionAuth });
      return app;
    }

    async function post(headers: Record<string, string>): Promise<Response> {
      return consentApp().request(
        "https://example.test/oauth/consent",
        { method: "POST", headers, body: new URLSearchParams({ decision: "approve" }) },
      );
    }

    it("rejects a cross-site Sec-Fetch-Site POST with 403", async () => {
      const res = await post({ "sec-fetch-site": "cross-site" });
      expect(res.status).toBe(403);
    });

    it("rejects an Origin-mismatch POST with 403", async () => {
      const res = await post({ origin: "https://evil.test" });
      expect(res.status).toBe(403);
    });

    it("lets a same-origin POST past the CSRF guard", async () => {
      const res = await post({ "sec-fetch-site": "same-origin" });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("invalid authorization request");
    });
  });
});
