/** Minimal functional OAuth fallback for deployments without Admin assets. */

import type { OAuthConsentInfo } from "./mountMantleOAuth.js";

export interface ConsentModel {
  readonly clientName: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly oauthQuery: string;
}

/** Detect consent UI locale from Accept-Language header. */
export function detectOAuthFallbackLocale(acceptLanguage: string | null): "zh-TW" | "en" {
  if (!acceptLanguage) return "en";
  const lower = acceptLanguage.toLowerCase();
  if (lower.includes("zh-tw") || lower.includes("zh_tw")) return "zh-TW";
  return "en";
}

const STRINGS = {
  en: {
    title: "Authorize · mantle",
    eyebrow: "Connect an app",
    heading: (client: string) => `Connect ${client}?`,
    body: (client: string) => `${client} will be able to use this site's management tools. What it can view or change is still limited by your account permissions.`,
    approve: "Connect",
    approving: "Connecting…",
    deny: "Cancel",
    denying: "Cancelling…",
    invalidTitle: "Invalid authorization request",
    invalidBody: "Missing or malformed consent payload. Return to your MCP client and try again.",
    appsTitle: "Connected apps · mantle",
    appsEyebrow: "Your account",
    appsHeading: "Connected apps",
    appsBody: "These AI assistants and apps can use the site's management tools. Every action is still checked against your current account permissions.",
    appsEmpty: "No connected apps.",
    revoke: "Disconnect",
    revoking: "Disconnecting…",
    back: "Back to admin",
  },
  "zh-TW": {
    title: "授權 · mantle",
    eyebrow: "連結應用程式",
    heading: (client: string) => `要連結 ${client} 嗎？`,
    body: (client: string) => `${client} 將能使用這個網站提供的管理工具；它能查看或變更哪些內容，仍會依照你的帳號權限決定。`,
    approve: "連結",
    approving: "連結中…",
    deny: "取消",
    denying: "取消中…",
    invalidTitle: "無效的授權請求",
    invalidBody: "缺少或格式錯誤的授權資訊，請返回 MCP 客戶端重試。",
    appsTitle: "已連結應用程式 · mantle",
    appsEyebrow: "你的帳號",
    appsHeading: "已連結應用程式",
    appsBody: "這些 AI 助手或應用程式可以使用網站提供的管理工具；每次操作仍會依照你當下的帳號權限檢查。",
    appsEmpty: "目前沒有已連結的應用程式。",
    revoke: "中斷連線",
    revoking: "中斷中…",
    back: "返回管理後台",
  },
} as const;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const CSS = `
  :root{--mantle-blue-deep:#1a3062;--app-background:#f6f8fc;--foreground:#172033;--card:#fff;--card-foreground:#172033;--border:#d7dce7;--muted:#f1f3f8;--muted-foreground:#596579;--primary:#1a3062;--primary-foreground:#fff;--secondary:#edf1fa;--secondary-foreground:#1a3062;--accent:#e2e8f5;--ring:#4d6aac;--radius:.625rem}
  *{box-sizing:border-box}
  body{margin:0;min-height:100svh;display:flex;align-items:center;justify-content:center;padding:1rem;font-family:ui-sans-serif,system-ui,sans-serif;color:var(--foreground);background:var(--app-background)}
  .card{max-width:32rem;width:100%;padding:2rem;border-radius:calc(var(--radius) + .125rem);color:var(--card-foreground);background:var(--card);border:1px solid var(--border);box-shadow:0 12px 36px color-mix(in srgb,var(--mantle-blue-deep) 8%,transparent);backdrop-filter:blur(48px) saturate(135%)}
  .eyebrow{font-size:.7rem;text-transform:uppercase;letter-spacing:.18em;font-weight:500;color:var(--muted-foreground);margin:0 0 .5rem}
  h1{font-size:1.5rem;line-height:1.3;font-weight:500;margin:0 0 .75rem;letter-spacing:-.02em}
  p{margin:0 0 1rem;font-size:.95rem;line-height:1.55}
  .muted{color:var(--muted-foreground);font-size:.875rem}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.8rem;padding:.125rem .4rem;border-radius:.25rem;background:var(--muted);overflow-wrap:anywhere}
  .actions{display:flex;gap:.75rem}
  button{flex:1;display:flex;align-items:center;justify-content:center;gap:.5rem;padding:.625rem 1rem;border:0;border-radius:.5rem;font:inherit;font-weight:500;cursor:pointer;transition:opacity .15s,background .15s}
  button:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
  button:disabled{cursor:not-allowed;opacity:.65}
  button[data-loading="true"]::before{content:"";width:.875rem;height:.875rem;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .65s linear infinite}
  button[value="approve"]{background:var(--primary);color:var(--primary-foreground)}
  button[value="approve"]:not(:disabled):hover{opacity:.9}
  button[value="deny"]{background:var(--secondary);color:var(--secondary-foreground)}
  button[value="deny"]:not(:disabled):hover{background:var(--accent)}
  .apps{display:grid;gap:.75rem;margin:1.5rem 0}
  .app{padding:1rem;border:1px solid var(--border);border-radius:.5rem}
  .app h2{font-size:1rem;margin:0 0 .25rem}
  .app form{display:flex;justify-content:flex-end}
  .app button{flex:0 0 auto;background:var(--secondary);color:var(--secondary-foreground)}
  .app button:not(:disabled):hover{background:var(--accent)}
  .back{color:var(--primary);font-size:.875rem}
  @keyframes spin{to{transform:rotate(360deg)}}
  @media(prefers-reduced-motion:reduce){button[data-loading="true"]::before{animation-duration:1.5s}}
  @media(max-width:30rem){.actions{flex-direction:column}}
`.trim();

function submitScript(nonce: string): string {
  return `<script nonce="${escapeHtml(nonce)}">for(const form of document.querySelectorAll("form[data-submit-lock]"))form.addEventListener("submit",function(event){const button=event.submitter;if(!button)return;const decision=this.elements.namedItem("decision");if(decision)decision.value=button.value;this.setAttribute("aria-busy","true");button.dataset.loading="true";button.textContent=button.dataset.loadingLabel;for(const action of this.querySelectorAll("button"))action.disabled=true;});</script>`;
}

export function renderConsentFallbackHtml(
  locale: "zh-TW" | "en",
  model: ConsentModel | null,
  nonce: string,
): string {
  const t = STRINGS[locale];
  const lang = locale === "zh-TW" ? "zh-Hant-TW" : "en";
  const head = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${t.title}</title><style>${CSS}</style></head><body><main class="card">`;
  const tail = `</main></body></html>`;

  if (!model) {
    return `${head}<p class="eyebrow">${t.eyebrow}</p><h1>${t.invalidTitle}</h1><p class="muted">${t.invalidBody}</p>${tail}`;
  }

  return (
    `${head}` +
    `<p class="eyebrow">${t.eyebrow}</p>` +
    `<h1>${t.heading(escapeHtml(model.clientName))}</h1>` +
    `<p class="muted">${t.body(escapeHtml(model.clientName))}</p>` +
    `<form class="actions" method="post" action="/oauth/consent" data-submit-lock>` +
    `<input type="hidden" name="oauth_query" value="${escapeHtml(model.oauthQuery)}"/>` +
    `<input type="hidden" name="decision"/>` +
    `<button type="submit" value="approve" data-loading-label="${t.approving}">${t.approve}</button>` +
    `<button type="submit" value="deny" data-loading-label="${t.denying}">${t.deny}</button>` +
    `</form>` +
    `${submitScript(nonce)}` +
    `${tail}`
  );
}

export function renderConnectedAppsFallbackHtml(
  locale: "zh-TW" | "en",
  consents: readonly OAuthConsentInfo[],
  nonce: string,
): string {
  const t = STRINGS[locale];
  const lang = locale === "zh-TW" ? "zh-Hant-TW" : "en";
  const apps = consents.length === 0
    ? `<p class="muted">${t.appsEmpty}</p>`
    : `<div class="apps">${consents.map((consent) => (
        `<section class="app"><h2>${escapeHtml(consent.clientName)}</h2>` +
        `<code>${escapeHtml(consent.clientId)}</code>` +
        `<form method="post" action="/oauth/consents/revoke" data-submit-lock>` +
        `<input type="hidden" name="consent_id" value="${escapeHtml(consent.id)}"/>` +
        `<button type="submit" data-loading-label="${t.revoking}">${t.revoke}</button>` +
        `</form></section>`
      )).join("")}</div>`;
  return (
    `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"/>` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"/>` +
    `<title>${t.appsTitle}</title><style>${CSS}</style></head><body><main class="card">` +
    `<p class="eyebrow">${t.appsEyebrow}</p><h1>${t.appsHeading}</h1>` +
    `<p class="muted">${t.appsBody}</p>${apps}<a class="back" href="/admin">${t.back}</a>` +
    `${submitScript(nonce)}</main></body></html>`
  );
}
