/** Life Engine component: ported from DandanLLab/dsh-life-engine (MIT).
 *
 * Ships as a bundled sibling module (`src/life/life-engine.js` + `kb.cjs`,
 * copied verbatim into `lib/life/` at build time by the copy step). The
 * component keeps the upstream plugin's own host contract: systemPrompt
 * sections (order 10240+), tools registry entries, and the optional
 * subagents bridge. Everything identity-specific from the deployment the
 * engine was extracted from is now configuration: agentName, familyPeers,
 * familyMap all live in `<dshHome>/tongling-life/config.json` (hot-read).
 *
 * This wrapper is deliberately thin: it defers to the module's own apply()
 * and only guards against the services being absent, so channel-qq keeps
 * working in minimal installs without the life component enabled.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { QQChannelConfig } from '../config.js';
/** Apply the life engine to the harness context. Returns a disposer. */
export declare function applyLifeEngine(ctx: Context, config: QQChannelConfig, log: (line: string) => void): Promise<() => void>;
