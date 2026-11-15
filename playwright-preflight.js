// Preflight for Playwright's globalSetup: run every check, fail ONCE listing every failed check.
//   // e2e/preflight.ts
//   import { preflight, loopbackOnly, httpOk, localSupabase, commands } from '@lakestoneai/dev-config/playwright/preflight'
//   export default preflight([loopbackOnly(url), httpOk(url), localSupabase(supabaseUrl), commands(['bun'])])
// The whole run is bounded (default 20 s): checks still running at the deadline are reported as timed out. Each
// probe has its own bound too (httpOk: per attempt, `commands`: 5 s per lookup).
import { execFileSync } from 'node:child_process'

const LOOPBACK = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'])

/** A named check: `fn` resolves when fine, throws (or rejects) with the reason when not. */
export const custom = (name, fn) => ({ name, fn })

/** The URL points at this machine, so a run can never hit a shared or hosted environment. */
export const loopbackOnly = (url) =>
  custom(`loopbackOnly(${url})`, () => {
    const host = new URL(url).hostname
    if (!LOOPBACK.has(host)) throw new Error(`host ${host} is not loopback`)
  })

/**
 * The URL answers with a 2xx/3xx. Each attempt is bounded by `timeoutMs` (default 5 s); a refused connection, a
 * timeout or a 5xx (a stack still booting) is retried `retries` more times (default 2) after `retryDelayMs`
 * (default 500). A 4xx fails at once. With the defaults the check needs at most ~16 s, inside the 20 s preflight budget:
 * raise the budget with `preflight(checks, { timeoutMs })` if you raise these.
 */
export const httpOk = (
  url,
  { timeoutMs = 5_000, retries = 2, retryDelayMs = 500 } = {}
) =>
  custom(`httpOk(${url})`, async () => {
    let last = ''
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      let res
      try {
        res = await fetch(url, {
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (e) {
        last =
          e.name === 'TimeoutError'
            ? `no answer within ${timeoutMs} ms`
            : `${e.cause?.code ?? e.cause?.message ?? e.message}`
      }
      if (res) {
        if (res.status < 400) return
        last = `answered HTTP ${res.status}`
        if (res.status < 500) throw new Error(last) // a client error will not fix itself
      }
      if (attempt <= retries)
        await new Promise((r) => setTimeout(r, retryDelayMs))
    }
    throw new Error(`${last} (${retries + 1} attempts)`)
  })

/** The Supabase URL is a local stack: loopback host, or `boxHost` (the testing box's IP) when given. */
export const localSupabase = (url, { boxHost } = {}) =>
  custom(`localSupabase(${url})`, () => {
    const host = new URL(url).hostname
    if (!LOOPBACK.has(host) && host !== boxHost) {
      throw new Error(`host ${host} is not a local Supabase stack`)
    }
  })

/** Every binary is on PATH. */
export const commands = (bins) =>
  custom(`commands(${bins.join(', ')})`, () => {
    const lookup = process.platform === 'win32' ? 'where' : 'which'
    const missing = bins.filter((bin) => {
      try {
        execFileSync(lookup, [bin], { stdio: 'ignore', timeout: 5_000 }) // a hung lookup counts as missing
        return false
      } catch {
        return true
      }
    })
    if (missing.length) throw new Error(`not on PATH: ${missing.join(', ')}`)
  })

/**
 * Returns a `globalSetup` function. All checks start together under one deadline; one error lists every
 * failure (in check order). A check still running at the deadline is reported as timed out.
 * (A synchronous check blocks the event loop and cannot be interrupted.)
 */
export function preflight(checks, { timeoutMs = 20_000 } = {}) {
  return async function globalSetup() {
    let timer
    const deadline = new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    })
    const results = await Promise.all(
      checks.map(({ fn }) =>
        Promise.race([
          Promise.resolve()
            .then(fn)
            .then(
              () => null,
              (e) => (e instanceof Error ? e.message : String(e))
            ),
          deadline.then(() => `timed out (preflight budget ${timeoutMs} ms)`),
        ])
      )
    )
    clearTimeout(timer)
    const failed = checks
      .map(({ name }, i) =>
        results[i] === null ? null : `  - ${name}: ${results[i]}`
      )
      .filter(Boolean)
    if (failed.length) {
      throw new Error(
        `Preflight failed (${failed.length} of ${checks.length} checks):\n${failed.join('\n')}`
      )
    }
  }
}
