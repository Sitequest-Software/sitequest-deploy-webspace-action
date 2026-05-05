/**
 * Sitequest Deploy — GitHub Action entry point.
 *
 * Pipeline:
 *   1. Validate inputs and resolve the source directory.
 *   2. Tar+gzip the source into a temp file.
 *   3. Split the archive into <=24 MB chunks and PUT each one to
 *      /api/v1/webspaces/:id/sftp/write (octet-stream). Each part lands as
 *      `_sitequest-deploy-<runId>.tar.gz.partNN` so we stay below the 32 MB
 *      per-request cap without needing a new server endpoint.
 *   4. POST an extract-and-swap script to /api/v1/webspaces/:id/exec which
 *      first reassembles the tarball with `cat *.partNN > tarball`.
 *   5. Emit outputs and a job summary.
 *
 * Errors are mapped to actionable messages — most failures (auth, scope,
 * payload-too-large, target-not-writable) come back from the Sitequest
 * API as structured JSON `{ error, code, status }`, which we surface verbatim.
 */

import * as core from "@actions/core"
import { spawn } from "node:child_process"
import { open, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Per-request payload cap. Kept well under the 32 MB server cap because
// large single-shot PUTs from GitHub runners over slow uplinks frequently
// hit socket-level resets ("fetch failed"). 8 MB is a sweet spot: small
// enough to upload reliably, big enough that a 2 GB deploy is still under
// 256 sequential PUTs.
const CHUNK_BYTES = 32 * 1024 * 1024
// Hard upper bound on a single deploy. Each chunk is one HTTP request, so a
// 2 GB deploy is ~85 sequential PUTs. Above that, users should split the
// deploy or upload via SFTP directly.
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024 // 2 GB
const USER_AGENT = "sitequest-deploy-action/1.0.0"

interface Inputs {
  apiKey: string
  webspaceId: string
  source: string
  target: string
  stripComponents: number
  keepOld: boolean
  apiBase: string
}

interface ApiError {
  error: string
  code: string
  status: number
}

function readInputs(): Inputs {
  const apiKey = core.getInput("api-key", { required: true })
  const webspaceId = core.getInput("webspace-id", { required: true })
  const source = core.getInput("source") || "dist"
  const target = (core.getInput("target") || "public_html").replace(/\/+$/, "")
  const strip = Number.parseInt(core.getInput("strip-components") || "0", 10)
  const keepOld = (core.getInput("keep-old") || "false").toLowerCase() === "true"
  const apiBase = (core.getInput("api-base") || "https://hosting.site.quest").replace(/\/+$/, "")

  if (!/^[A-Za-z0-9_-]+$/.test(webspaceId)) {
    throw new Error(`Invalid webspace-id: ${webspaceId}`)
  }
  if (!/^[A-Za-z0-9._\-/]+$/.test(target) || target.includes("..")) {
    throw new Error(`Invalid target path: ${target}`)
  }
  if (!Number.isFinite(strip) || strip < 0 || strip > 10) {
    throw new Error(`strip-components must be 0..10`)
  }
  return { apiKey, webspaceId, source, target, stripComponents: strip, keepOld, apiBase }
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`))
    })
  })
}

async function tarArchive(sourceDir: string, outFile: string): Promise<void> {
  const s = await stat(sourceDir).catch(() => null)
  if (!s || !s.isDirectory()) {
    throw new Error(`Source directory not found: ${sourceDir}`)
  }
  // -C cd into source, "." packs contents (not the directory itself), so the
  // archive expands flat into <target>/ without an extra wrapper folder.
  await run("tar", ["-czf", outFile, "-C", sourceDir, "."])
}

function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const parts: string[] = [err.message]
  // undici wraps the real reason in `cause` (often an AggregateError of
  // socket-level errors). Surface as much as possible — "fetch failed" alone
  // is unactionable.
  let cause: unknown = (err as { cause?: unknown }).cause
  while (cause) {
    if (cause instanceof Error) {
      const code = (cause as { code?: string }).code
      parts.push(code ? `${cause.message} [${code}]` : cause.message)
      // AggregateError exposes `errors`; flatten the first one.
      const errors = (cause as { errors?: unknown[] }).errors
      if (Array.isArray(errors) && errors.length > 0) {
        for (const e of errors) {
          if (e instanceof Error) {
            const ec = (e as { code?: string }).code
            parts.push(ec ? `${e.message} [${ec}]` : e.message)
          }
        }
      }
      cause = (cause as { cause?: unknown }).cause
    } else {
      parts.push(String(cause))
      break
    }
  }
  return parts.join(" → ")
}

async function apiCall<T = unknown>(
  url: string,
  init: RequestInit,
  apiKey: string,
  opts: { retries?: number } = {},
): Promise<T> {
  const retries = opts.retries ?? 0
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "User-Agent": USER_AGENT,
          ...(init.headers ?? {}),
        },
      })
      const text = await res.text()
      if (!res.ok) {
        let parsed: ApiError | undefined
        try { parsed = JSON.parse(text) as ApiError } catch { /* not JSON */ }
        const code = parsed?.code ?? `HTTP_${res.status}`
        const msg = parsed?.error ?? (text.slice(0, 500) || res.statusText)
        // 4xx (except 429) are not transient — fail fast.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          throw new Error(`[${code}] ${msg}`)
        }
        lastErr = new Error(`[${code}] ${msg}`)
      } else {
        if (!text) return {} as T
        const parsedBody = JSON.parse(text) as { data?: T } & T
        // Sitequest API wraps successful payloads in `{ data: ... }`. Unwrap
        // so callers can read fields directly. Fall back to the raw body for
        // legacy endpoints that don't wrap.
        return (parsedBody && typeof parsedBody === "object" && "data" in parsedBody
          ? (parsedBody.data as T)
          : (parsedBody as T))
      }
    } catch (err) {
      // Network-level failure (TypeError: fetch failed). These are usually
      // transient — connection reset, DNS hiccup, slow uplink timing out.
      lastErr = err instanceof Error && err.message === "fetch failed"
        ? new Error(`fetch failed: ${describeFetchError(err)}`)
        : err
      // Re-throw immediately for our own [CODE] errors (already final).
      if (err instanceof Error && err.message.startsWith("[")) throw err
    }
    if (attempt < retries) {
      const delay = Math.min(30_000, 1000 * 2 ** attempt)
      core.warning(
        `Request failed (attempt ${attempt + 1}/${retries + 1}): ` +
          `${lastErr instanceof Error ? lastErr.message : String(lastErr)}. ` +
          `Retrying in ${delay}ms…`,
      )
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/**
 * Upload the archive in <=CHUNK_BYTES parts. Each chunk is PUT as a separate
 * file `<remoteName>.partNN` (zero-padded). The remote extract script will
 * `cat *.partNN > <remoteName>` before untarring.
 *
 * Returns total bytes uploaded and the number of parts.
 */
async function uploadArchive(
  inputs: Inputs,
  archivePath: string,
  remoteName: string,
): Promise<{ bytes: number; parts: number }> {
  const s = await stat(archivePath)
  const total = s.size
  if (total > MAX_ARCHIVE_BYTES) {
    throw new Error(
      `Archive is ${(total / 1024 / 1024).toFixed(2)} MB, exceeds ` +
        `the ${MAX_ARCHIVE_BYTES / 1024 / 1024 / 1024} GB upload limit. ` +
        `Reduce the build output, upload via SFTP directly, or open an issue.`,
    )
  }
  if (total === 0) {
    throw new Error(`Archive is empty (0 bytes) — nothing to deploy.`)
  }

  const parts = Math.ceil(total / CHUNK_BYTES)
  const padWidth = Math.max(2, String(parts - 1).length)
  core.info(
    `Archive ${(total / 1024 / 1024).toFixed(2)} MB → ${parts} part(s) of up to ` +
      `${CHUNK_BYTES / 1024 / 1024} MB`,
  )

  const fh = await open(archivePath, "r")
  try {
    for (let i = 0; i < parts; i++) {
      const offset = i * CHUNK_BYTES
      const size = Math.min(CHUNK_BYTES, total - offset)
      const buf = Buffer.allocUnsafe(size)
      const { bytesRead } = await fh.read(buf, 0, size, offset)
      if (bytesRead !== size) {
        throw new Error(
          `Short read at offset ${offset}: expected ${size}, got ${bytesRead}`,
        )
      }
      const partName = `${remoteName}.part${String(i).padStart(padWidth, "0")}`
      const url = `${inputs.apiBase}/api/v1/webspaces/${inputs.webspaceId}/sftp/write` +
        `?path=${encodeURIComponent(partName)}`
      core.info(
        `  part ${i + 1}/${parts}: ${(size / 1024 / 1024).toFixed(2)} MB → ${partName}`,
      )
      const body = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
      await apiCall<{ path: string; size: number }>(
        url,
        {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body,
        },
        inputs.apiKey,
        { retries: 3 },
      )
    }
  } finally {
    await fh.close()
  }
  return { bytes: total, parts }
}

/**
 * Build a defensive shell pipeline that:
 *   - extracts into <target>.next.<runId>/
 *   - atomically swaps it with <target>/ via two `mv` calls
 *   - removes the previous release (or keeps it as <target>.old/ if keep-old)
 *   - cleans up the uploaded tarball
 *
 * Each value is single-quoted with embedded-quote escaping so user-controlled
 * inputs cannot break out into the surrounding shell.
 */
function buildExtractScript(
  remoteArchive: string,
  target: string,
  stripComponents: number,
  keepOld: boolean,
  runId: string,
): string {
  const sh = (s: string) => `'${s.replace(/'/g, "'\\''")}'`
  const archive = sh(remoteArchive)
  // The wildcard MUST stay outside the single quotes so the shell expands
  // it. Quoting `'foo.part*'` would have the shell look for a literal file
  // with `*` in its name. Only the user-controlled prefix needs escaping.
  const partsGlob = `${sh(`${remoteArchive}.part`)}*`
  const tgt = sh(target)
  const next = sh(`${target}.next.${runId}`)
  const old = sh(`${target}.old.${runId}`)
  const oldKeep = sh(`${target}.old`)

  const cleanup = keepOld
    ? `rm -rf ${oldKeep} && mv ${old} ${oldKeep} 2>/dev/null || true`
    : `rm -rf ${old} 2>/dev/null || true`

  // `cat <file>.part*` relies on shell glob ordering being lexicographic,
  // which matches the zero-padded part suffix produced by uploadArchive().
  return [
    `set -eu`,
    `cat ${partsGlob} > ${archive}`,
    `rm -f ${partsGlob}`,
    `mkdir -p ${next}`,
    `tar -xzf ${archive} -C ${next} --strip-components=${stripComponents}`,
    `if [ -d ${tgt} ]; then mv ${tgt} ${old}; fi`,
    `mv ${next} ${tgt}`,
    cleanup,
    `rm -f ${archive}`,
    `find ${tgt} -type f | wc -l`, // last line of stdout = file count
  ].join(" && ")
}

interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number | null
}

async function extractRemote(
  inputs: Inputs,
  remoteArchive: string,
  runId: string,
): Promise<number> {
  const script = buildExtractScript(
    remoteArchive,
    inputs.target,
    inputs.stripComponents,
    inputs.keepOld,
    runId,
  )
  const url = `${inputs.apiBase}/api/v1/webspaces/${inputs.webspaceId}/exec`
  core.info(`Extracting on remote into ${inputs.target}/ (atomic swap)`)
  const result = await apiCall<ExecResult>(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: script, timeoutSeconds: 180 }),
    },
    inputs.apiKey,
  )
  if (result.exitCode !== 0) {
    core.error(`Remote extract failed (exit ${result.exitCode})`)
    if (result.stderr) core.error(result.stderr.slice(-2000))
    throw new Error(`Extract exited with code ${result.exitCode}`)
  }
  const lastLine = result.stdout.trim().split(/\r?\n/).pop() ?? "0"
  const fileCount = Number.parseInt(lastLine, 10)
  return Number.isFinite(fileCount) ? fileCount : 0
}

/**
 * Best-effort cleanup of the uploaded tarball if the deploy aborted before
 * the extract step had a chance to delete it. Failures are swallowed.
 */
async function cleanupRemoteArchive(inputs: Inputs, remoteArchive: string): Promise<void> {
  const sh = (s: string) => `'${s.replace(/'/g, "'\\''")}'`
  const url = `${inputs.apiBase}/api/v1/webspaces/${inputs.webspaceId}/exec`
  await apiCall(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // Remove both the assembled archive and any orphaned chunk parts.
        // Wildcard stays outside the single quotes so the shell expands it.
        command: `rm -f ${sh(remoteArchive)} ${sh(`${remoteArchive}.part`)}*`,
        timeoutSeconds: 30,
      }),
    },
    inputs.apiKey,
  ).catch(() => undefined)
}

async function main(): Promise<void> {
  const startedAt = Date.now()
  let inputs: Inputs
  try {
    inputs = readInputs()
  } catch (err) {
    core.setFailed((err as Error).message)
    return
  }

  // Mask the API key in logs even though @actions/core does this for `required` inputs.
  core.setSecret(inputs.apiKey)

  const runId = process.env.GITHUB_RUN_ID ?? `${Date.now()}`
  const remoteArchive = `_sitequest-deploy-${runId}.tar.gz`
  let workDir: string | null = null
  let uploaded = false

  try {
    workDir = await mkdtemp(join(tmpdir(), "sitequest-deploy-"))
    const archivePath = join(workDir, "deploy.tar.gz")

    await core.group("Pack source directory", async () => {
      await tarArchive(inputs.source, archivePath)
      const s = await stat(archivePath)
      core.info(`Archive size: ${(s.size / 1024).toFixed(1)} KB`)
    })

    let bytes = 0
    let parts = 0
    await core.group("Upload archive", async () => {
      const r = await uploadArchive(inputs, archivePath, remoteArchive)
      bytes = r.bytes
      parts = r.parts
      uploaded = true
    })

    let files = 0
    await core.group("Extract on webspace", async () => {
      files = await extractRemote(inputs, remoteArchive, runId)
      uploaded = false // server-side script removes the archive
    })

    const duration = Date.now() - startedAt
    core.setOutput("bytes-uploaded", bytes)
    core.setOutput("files-deployed", files)
    core.setOutput("duration-ms", duration)

    const mb = (bytes / 1024 / 1024).toFixed(2)
    const secs = (duration / 1000).toFixed(2)
    await core.summary
      .addRaw(`Deployed **${files} files** (${mb} MB, ${parts} chunk${parts === 1 ? "" : "s"}) to \`${inputs.target}\` in ${secs}s.`)
      .write()

    core.info(`✓ Deployed ${files} files in ${secs}s`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    core.setFailed(message)
    if (uploaded) {
      core.warning(`Cleaning up orphaned remote archive ${remoteArchive}`)
      await cleanupRemoteArchive(inputs, remoteArchive)
    }
  } finally {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

void main()
