# @aotter/mantle-admin

Optional Admin composition for Mantle. It owns Admin routes, API projections,
staff gates, and the static asset contract while reusing the same Core runtime
operations and authorization policy as programmatic callers.

Platform adapters supply identity/session resolution, request context, and an
`AdminAssetServer`. Omitting this package mounts no Admin routes and requires
no static assets.

OAuth consent and connected-app surfaces live here too. Adapters implement the
platform-neutral `MantleOAuthAuth` contract and may call `handleMantleOAuth`
directly; `mountMantleOAuth` is the existing thin Hono bridge. Admin assets use
the shared React/shadcn UI, while no-assets deployments receive only a minimal
functional HTML fallback.
