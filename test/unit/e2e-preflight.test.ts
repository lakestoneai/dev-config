import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import {
  commands,
  custom,
  httpOk,
  localSupabase,
  loopbackOnly,
  preflight,
} from '@lakestoneai/dev-config/playwright/preflight'
import { cleanup, listed, playwright, project, setupSpec } from './e2e-harness'

setDefaultTimeout(60_000)
afterAll(cleanup)

const run = (
  checks: Parameters<typeof preflight>[0],
  o?: { timeoutMs: number }
) => preflight(checks, o)()
const message = async (p: Promise<void>) =>
  p.then(
    () => '',
    (e: Error) => e.message
  )

const server = Bun.serve({
  port: 0,
  fetch: (r) =>
    new Response(new URL(r.url).pathname === '/bad' ? 'no' : 'ok', {
      status: new URL(r.url).pathname === '/bad' ? 503 : 200,
    }),
})
afterAll(() => server.stop(true))
const base = `http://127.0.0.1:${server.port}`

test('all green: resolves', async () => {
  await run([
    loopbackOnly(base),
    httpOk(base),
    localSupabase('http://localhost:54321'),
    commands(['sh']),
    custom('anything', async () => {}),
  ])
})
test('one error lists EVERY failed check, passing ones are not named', async () => {
  const m = await message(
    run([
      loopbackOnly('https://app.example.com'),
      httpOk(`${base}/bad`),
      localSupabase('https://abc.supabase.co'),
      commands(['sh', 'no-such-binary-xyz']),
      custom('fine', () => {}),
      custom('boom', () => {
        throw new Error('seed row missing')
      }),
    ])
  )
  expect(m).toContain('Preflight failed (5 of 6 checks)')
  expect(m).toContain(
    'loopbackOnly(https://app.example.com): host app.example.com is not loopback'
  )
  expect(m).toContain('answered HTTP 503')
  expect(m).toContain('host abc.supabase.co is not a local Supabase stack')
  expect(m).toContain('not on PATH: no-such-binary-xyz')
  expect(m).toContain('boom: seed row missing')
  expect(m).not.toContain('fine')
})
test('localSupabase accepts the box IP when given', async () => {
  await run([
    localSupabase('http://100.111.54.29:54321', { boxHost: '100.111.54.29' }),
  ])
  expect(
    await message(
      run([
        localSupabase('http://100.111.54.30:54321', {
          boxHost: '100.111.54.29',
        }),
      ])
    )
  ).toContain('not a local Supabase')
})
test('a custom check can run a shell script', async () => {
  const sh = (code: string) =>
    custom(`sh ${code}`, async () => {
      const r = Bun.spawnSync(['sh', '-c', code])
      if (r.exitCode)
        throw new Error(r.stderr.toString().trim() || `exit ${r.exitCode}`)
    })
  await run([sh('true')])
  expect(
    await message(run([sh('echo not-live-guard-tripped >&2; exit 3')]))
  ).toContain('not-live-guard-tripped')
})
test('bounded: every hung check is reported at the one deadline, quick ones are not named', async () => {
  const started = Date.now()
  const m = await message(
    run(
      [
        custom('hangs one', () => new Promise(() => {})),
        custom('hangs two', () => new Promise(() => {})),
        custom('quick', () => {}),
      ],
      { timeoutMs: 300 }
    )
  )
  expect(Date.now() - started).toBeLessThan(1_500) // one deadline, not one per check
  expect(m).toContain('Preflight failed (2 of 3 checks)')
  expect(m).toContain('hangs one: timed out')
  expect(m).toContain('hangs two: timed out')
  expect(m).not.toContain('quick')
})
test('checks run side by side: three 400 ms checks fit a 1 s budget', async () => {
  const slow = (n: number) =>
    custom(`slow ${n}`, () => new Promise<void>((r) => setTimeout(r, 400)))
  await run([slow(1), slow(2), slow(3)], { timeoutMs: 1_000 })
})

// through the real Playwright CLI: globalSetup only, never at --list
const cfg =
  () => `import { defineE2EConfig } from '@lakestoneai/dev-config/playwright'
export default defineE2EConfig({ globalSetup: './preflight.ts' })
`
const files = {
  'playwright.config.ts': cfg(),
  'preflight.ts': `import { preflight, custom, loopbackOnly } from '@lakestoneai/dev-config/playwright/preflight'
export default preflight([loopbackOnly('https://app.example.com'), custom('second', () => { throw new Error('nope') })])
`,
  'auth.setup.ts': setupSpec,
  'a.spec.ts': `import { test } from '@playwright/test'\ntest('plain', async () => {})\n`,
}
test('Playwright: failing preflight stops the run with one error', () => {
  const d = project(files)
  const r = playwright(d, ['--project=chromium'])
  expect(r.code).not.toBe(0)
  expect(r.out).toContain('Preflight failed (2 of 2 checks)')
  expect(r.out).toContain('second: nope')
})
test('Playwright: --list does not run preflight', () => {
  expect(listed(project(files)).length).toBeGreaterThan(0)
})
test('Playwright: passing preflight lets the run through', () => {
  const d = project({
    ...files,
    'preflight.ts': `import { preflight, commands } from '@lakestoneai/dev-config/playwright/preflight'
export default preflight([commands(['sh'])])
`,
  })
  expect(playwright(d, ['--project=chromium']).code).toBe(0)
})

test('the default bound is 20 s', async () => {
  const delays: number[] = []
  const real = globalThis.setTimeout
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...a: unknown[]) => {
    delays.push(ms ?? 0)
    return real(fn, ms, ...a)
  }) as typeof setTimeout
  try {
    await preflight([custom('quick', () => {})])()
  } finally {
    globalThis.setTimeout = real
  }
  expect(Math.max(...delays)).toBeLessThanOrEqual(20_000)
  expect(Math.max(...delays)).toBeGreaterThan(19_000)
})

// -- 0.7.0: every probe is bounded, and a bound names what it waited for
const flaky = (fail: number, status = 503) => {
  let n = 0
  const s = Bun.serve({
    port: 0,
    fetch: () =>
      ++n <= fail ? new Response('no', { status }) : new Response('ok'),
  })
  afterAll(() => s.stop(true))
  return { url: `http://127.0.0.1:${s.port}`, hits: () => n }
}
test('httpOk retries a stack that is still booting (5xx), then passes', async () => {
  const s = flaky(2)
  await run([httpOk(s.url, { retryDelayMs: 20 })])
  expect(s.hits()).toBe(3)
})
test('httpOk gives up after its retries, naming the answer and the attempts', async () => {
  const s = flaky(99)
  const m = await message(
    run([httpOk(s.url, { retries: 1, retryDelayMs: 20 })])
  )
  expect(m).toContain('answered HTTP 503 (2 attempts)')
  expect(s.hits()).toBe(2)
})
test('httpOk does not retry a 4xx: it will not fix itself', async () => {
  const s = flaky(99, 404)
  const m = await message(run([httpOk(s.url, { retryDelayMs: 20 })]))
  expect(m).toContain('answered HTTP 404')
  expect(s.hits()).toBe(1)
})
test('httpOk: a server that never answers fails after timeoutMs per attempt, naming the wait', async () => {
  const hung = Bun.serve({ port: 0, fetch: () => new Promise(() => {}) })
  afterAll(() => hung.stop(true))
  const t = Date.now()
  const m = await message(
    run([
      httpOk(`http://127.0.0.1:${hung.port}`, {
        timeoutMs: 300,
        retries: 1,
        retryDelayMs: 20,
      }),
    ])
  )
  expect(m).toContain('no answer within 300 ms (2 attempts)')
  expect(Date.now() - t).toBeLessThan(3_000)
})
test('httpOk: a refused connection is retried and named by its cause', async () => {
  const s = Bun.serve({ port: 0, fetch: () => new Response('x') })
  const url = `http://127.0.0.1:${s.port}`
  s.stop(true)
  const m = await message(
    run([httpOk(url, { retries: 1, retryDelayMs: 20, timeoutMs: 2_000 })])
  )
  expect(m).toMatch(/\(2 attempts\)/)
  expect(m).not.toContain('did not finish')
})
