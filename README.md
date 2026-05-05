# Sitequest Deploy

Deploy a static site to a [Sitequest](https://site.quest) webspace from a GitHub Actions workflow. No SSH keys, no rsync, no infrastructure — just an API key.

## Quick start

1. Create an API key in your Sitequest dashboard with the `webspace:manage` scope, optionally restricted to a single webspace.
2. Add it as a repository secret named `SITEQUEST_API_KEY`.
3. Add a workflow:

```yaml
name: Deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci && npm run build
      - uses: sitequest/deploy-action@v1
        with:
          api-key:     ${{ secrets.SITEQUEST_API_KEY }}
          webspace-id: ${{ vars.SITEQUEST_WEBSPACE_ID }}
          source:      dist
          target:      public_html
```

## Inputs

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `api-key` | yes | — | API key with `webspace:manage` scope. |
| `webspace-id` | yes | — | Target webspace ID (visible in the dashboard URL). |
| `source` | no | `dist` | Local directory to deploy. |
| `target` | no | `public_html` | Remote directory under the webspace home. |
| `strip-components` | no | `0` | Strip N leading path components on extract. |
| `keep-old` | no | `false` | Keep the previous release in `<target>.old/` for rollback. |
| `api-base` | no | `https://hosting.site.quest` | Override for staging or self-hosted. |

## Outputs

| Name | Description |
|------|-------------|
| `bytes-uploaded` | Size of the uploaded `.tar.gz` archive. |
| `files-deployed` | Number of files in the deployed target. |
| `duration-ms` | End-to-end deploy duration. |

## How it works

1. Pack `source/` into a gzipped tarball (`tar -czf`).
2. `PUT /api/v1/webspaces/:id/sftp/write` with `Content-Type: application/octet-stream` — uploads raw bytes (no base64 inflation).
3. `POST /api/v1/webspaces/:id/exec` runs an atomic-swap script:
   - Extract into `<target>.next.<run-id>/`
   - `mv <target> <target>.old.<run-id>`
   - `mv <target>.next.<run-id> <target>`
   - Clean up old release and uploaded tarball

Visitors never see a half-deployed site — the swap is two filesystem renames.

## Limits

- Maximum archive size: **2 GB** (compressed). Larger archives are split client-side into 24 MB chunks and reassembled on the server, so the per-request 32 MB API cap is never an issue.
- For larger sites use SFTP directly with an SSH key — see the Sitequest docs.

## Common errors

| Code | Meaning | Fix |
|------|---------|-----|
| `INSUFFICIENT_SCOPE` | API key lacks `webspace:manage`. | Recreate the key with the right scope. |
| `NOT_FOUND` | Webspace ID is wrong, or the key is restricted to other resources. | Check `webspace-id` and key restrictions. |
| `PAYLOAD_TOO_LARGE` | A single chunk exceeds the 32 MB API cap. Should not happen — file an issue. | — |
| `EISDIR` | A file in the archive collides with an existing directory. | Adjust `strip-components` or clean the target manually. |

## License

MIT
