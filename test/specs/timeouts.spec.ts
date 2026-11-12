import { expect, test } from '@playwright/test'

const expected: Record<string, { action: number; nav: number }> = {
  defaults: { action: 10_000, nav: 30_000 },
  'project-override': { action: 2_000, nav: 30_000 },
  'repo-override': { action: 3_000, nav: 30_000 },
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
