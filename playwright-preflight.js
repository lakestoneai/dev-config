// Preflight for Playwright's globalSetup: run every check, fail ONCE listing every failed check.
//   // e2e/preflight.ts
//   import { preflight, loopbackOnly, httpOk, localSupabase, commands } from '@lakestoneai/dev-config/playwright/preflight'
//   export default preflight([loopbackOnly(url), httpOk(url), localSupabase(supabaseUrl), commands(['bun'])])
// The whole run is bounded (default 20 s): checks still running at the deadline are reported as timed out.
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

/** The URL answers with a 2xx/3xx within `timeoutMs` (default 5 s). */
export const httpOk = (url, { timeoutMs = 5_000 } = {}) =>
  custom(`httpOk(${url})`, async () => {
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.status >= 400) throw new Error(`answered HTTP ${res.status}`)
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
        execFileSync(lookup, [bin], { stdio: 'ignore' })
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
