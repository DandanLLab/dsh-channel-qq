/** Meme Engine component: vendored from yyh-001/dsh-meme v0.1.61 (MIT, © 2026 Selfloom contributors).
 *
 * Ships as sibling plain-JS modules (`src/meme/index.js|memes.js|anim.js|panel.html`
 * + `bundled-pack/`), copied verbatim into `lib/meme/` at build time. The
 * component keeps dsh-meme's own host contract: `send_meme` / `learn_meme`
 * tools, `/dsh-memes` image route, `/dsh-memes-api` + `/memes-panel` admin,
 * companion-prompt injection via `system-prompt/assemble`.
 *
 * Component adaptation (the only code change vs upstream): the QQ send
 * channel no longer requires the separate dsh-companion plugin — this
 * wrapper injects `ctx.qqChannel = { sendImage }` backed by channel-qq's
 * own OutboundQueue (group/DM window whitelist + strict-suffix pipeline
 * shared with qq_send_emoji). Independent dsh-meme installs keep working
 * (the adapter falls back to `companionQq`).
 */
import type { Context } from '@deepseek-ai/cordis';
import type { QQChannelConfig } from '../config.js';
import type { OneBotClient } from '../onebot.js';
import type { OutboundQueue } from '../outbound.js';
export interface MemeEngineComponentConfig {
    /** Master switch; default true. */
    enabled: boolean;
    /** Optional meme pack root override (defaults to the bundled pack + ~/.dsh/meme-packs scan). */
    memeRoot: string | null;
    /** Admin panel + image routes (needs the host webServer service). */
    webRoutes: boolean;
}
/** Apply the meme engine component. Returns a disposer. */
export declare function applyMemeEngine(ctx: Context, config: QQChannelConfig, client: OneBotClient, out: OutboundQueue, log: (line: string) => void): Promise<() => void>;
