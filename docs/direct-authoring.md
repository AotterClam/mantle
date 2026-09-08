# Author an application directly

Core supplies the manifest compiler and runtime, not a project generator.
The owner or agent writes the project's package.json, business manifests,
entry, TypeScript and provider configuration. See the executable
[minimal Worker reference](examples/minimal-worker/README.md) for Cloudflare;
use the corresponding adapter guide for another runtime. Do not adopt the
reference's notes model, provider names or auth intent without a product need.

Pin selected SDK packages to one exact release and install the required peers.
For this Cloudflare reference, `@aotter/mantle` and
`@aotter/mantle-cloudflare` use the same version. Check that version's package
peer requirements, install the graph, retain its lockfile, and use frozen
installs afterward. No Starter repository, bundle URL or launch metadata is
required. Read the installed package's docs rather than a floating branch.

`mantle generate` reads the configured manifest directory (default
`manifests/`) and emits `.mantle/generated/mantle.ts`. Missing or invalid
manifests fail; generation never creates a missing project or default business
model. `--check` detects stale output without writing.

When the optional Admin UI package is installed, generation also synchronizes
its static assets into `public/_mantle/admin/`. This is the Admin interface,
not a visitor homepage. `mantle skills` separately projects the installed
project-scoped instructions; generation does not overwrite instructions.

`mantle-web` composes runtime HTML, SEO, sitemap and Markdown with supplied
content/templates. It does not participate in manifest generation and owns
no implicit `/` route. A project may use a custom frontend or stay API-only.

Before calling a new project done: generate/check, validate, typecheck, start
the chosen runtime and probe a declared route. Keep normal authorization
failures visible until auth is configured. Do not claim an Admin/MCP login or
visitor homepage merely because a public data endpoint works.

For existing projects use [the 0.1.2 migration notes](migration-0.1.2.md).
For application patterns see [transaction coordination](transaction-patterns.md).

## npm optional peer resolution

The reference and SDK checks use pnpm 9+. With npm 11.16.0, a cold Cloudflare
install can fail with `ERESOLVE`: Better Auth/Drizzle selects optional
`@libsql/client@0.18.0`, while this SDK declares the tested `^0.17.4` peer.
If that exact conflict occurs, merge this into the application's package.json
and rerun `npm install`:

```json
{ "overrides": { "@libsql/client": "0.17.4" } }
```

Preserve other overrides and the selected exact Mantle versions. This only
constrains npm's optional peer resolution; Cloudflare does not need a new
libSQL dependency. For a Vercel/libSQL application, select the client according
to the installed adapter's peer contract and keep any direct dependency and
override consistent. Do not use `--force` or `--legacy-peer-deps` to hide an
incompatible graph. Commit the resulting lockfile and use `npm ci` afterward.
Recheck the installed package's peer range when upgrading; this workaround is
specific to the dependency versions above.
