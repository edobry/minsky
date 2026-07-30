# minsky-infra

Pulumi program declaring the Railway services (`minsky-mcp`, `minsky-ops`,
`minsky-reviewer-webhook`, `site`, cockpit) and their environment variables.

## Bootstrap on a fresh checkout

`sdks/railway/` is a **locally generated** Pulumi SDK (bridged from the
`terraform-community-providers/railway` Terraform provider) and is
deliberately gitignored (~67 MB, includes a provider binary). The generation
recipe lives in `Pulumi.yaml` under `packages.railway`.

Do NOT run a bare `npm install` / `bun install` first — the
`"@pulumi/railway": "file:sdks/railway"` dependency will fail while the SDK
is absent. Instead:

```bash
cd infra
pulumi install   # regenerates sdks/railway from Pulumi.yaml, then installs deps
```

After that, normal installs work because `sdks/railway` exists.

## Applying changes

Always preview with an explicit target; never blanket-`pulumi up` the prod
stack (2026-07-23 incident: unrelated resource changes, including a duplicate
service create, showed up in a blanket plan):

```bash
pulumi preview --target '<urn>'
pulumi up --target '<urn>'
```

URN shapes:
`urn:pulumi:prod::minsky-infra::railway:index/service:Service::<name>` and
`urn:pulumi:prod::minsky-infra::railway:index/variable:Variable::<svc>-var-<KEY>`.
