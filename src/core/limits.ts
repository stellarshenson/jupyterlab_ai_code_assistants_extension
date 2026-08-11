/** The ONE home for the Recent section's size bounds. `src/core/panel.ts`
 * clamps with them, `src/index.ts` defaults with them, and
 * `scripts/generate-schema.mjs` writes them into `schema/plugin.json`, so a
 * change here is the only change needed.
 *
 * Keep this module import-free. The schema generator loads the compiled
 * `lib/core/limits.js` under plain Node, exactly as it loads the provider
 * barrel; a single browser-only import would break that.
 */
export const DEFAULT_RECENT_LIMIT = 10;
export const MIN_RECENT_LIMIT = 1;
export const MAX_RECENT_LIMIT = 100;
