import { expect, test } from '@playwright/test'

const expected: Record<
  string,
  { action: number; nav: number; toPass: number }
> = {
  defaults: { action: 10_000, nav: 30_000, toPass: 20_000 },
  'project-override': { action: 2_000, nav: 30_000, toPass: 2_000 },
  'repo-override': { action: 3_000, nav: 30_000, toPass: 3_000 },
}

test('resolved config carries the right timeouts', () => {
  const { name, use } = test.info().project
  expect(use.actionTimeout).toBe(expected[name].action)
  expect(use.navigationTimeout).toBe(expected[name].nav)
  expect(use.trace).toBe('retain-on-failure')
  expect(use.screenshot).toBe('only-on-failure')
  expect(test.info().config.forbidOnly).toBe(!!process.env.CI)
})

test('a click on a missing element fails at actionTimeout, not after the test timeout', async ({
  page,
}) => {
  const want = expected[test.info().project.name].action
  await page.setContent('<p>nothing to click</p>')
  const started = Date.now()
  const err = await page
    .locator('#missing')
    .click()
    .catch((e: Error) => e)
  const took = Date.now() - started
  expect(err).toBeInstanceOf(Error)
  expect((err as Error).message).toContain(`Timeout ${want}ms exceeded`)
  expect(took).toBeLessThan(want + 3_000)
})

test('expect.toPass fails at its own bound (Playwright: 0 = forever), not at the test timeout', async () => {
  const want = expected[test.info().project.name].toPass
  const started = Date.now()
  const err = await expect(async () => {
    expect(1).toBe(2)
  })
    .toPass()
    .catch((e: Error) => e)
  const took = Date.now() - started
  expect(err).toBeInstanceOf(Error)
  expect((err as Error).message).toContain(`Timeout ${want}ms exceeded`)
  expect(took).toBeGreaterThanOrEqual(want - 500)
  expect(took).toBeLessThan(want + 3_000)
})

test('expect.poll keeps its 5 s bound (the default is documented; 0 would disable it)', async () => {
  const started = Date.now()
  const err = await expect
    .poll(() => 1)
    .toBe(2)
    .catch((e: Error) => e)
  const took = Date.now() - started
  expect((err as Error).message).toContain('Timeout 5000ms exceeded')
  expect(took).toBeLessThan(8_000)
})
