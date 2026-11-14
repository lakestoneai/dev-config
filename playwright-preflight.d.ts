export interface Check {
  name: string
  fn: () => void | Promise<void>
}
export declare function custom(
  name: string,
  fn: () => void | Promise<void>
): Check
export declare function loopbackOnly(url: string): Check
export declare function httpOk(
  url: string,
  opts?: { timeoutMs?: number }
): Check
export declare function localSupabase(
  url: string,
  opts?: { boxHost?: string }
): Check
export declare function commands(bins: string[]): Check
/** Returns a Playwright `globalSetup` function; one error lists every failed check. */
export declare function preflight(
  checks: Check[],
  opts?: { timeoutMs?: number }
): () => Promise<void>
