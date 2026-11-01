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
import { readFile, writeFile, rm } from 'node:fs/promises';
/** Apply the meme engine component. Returns a disposer. */
export async function applyMemeEngine(ctx, config, client, out, log) {
    const meme = (config.memeEngine ?? { enabled: true, memeRoot: null, webRoutes: true });
    if (meme.enabled === false) {
        log('meme-engine: disabled by config');
        return () => { };
    }
    // Send adapter: route through channel-qq's own OneBot client with the same
    // window whitelist semantics as qq_send_text (group → primaryGroup/extraGroups,
    // DM → admins). Byte-magic/suffix correction stays upstream in qq_send_emoji's
    // pipeline; here we send by base64 like the emoji marker path does.
    const sendImage = async (filePath, caption, opts = {}) => {
        const buf = await readFile(filePath);
        const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50;
        const isGif = buf.length > 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46;
        const isJpg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8;
        const realExt = isPng ? '.png' : isGif ? '.gif' : isJpg ? '.jpg' : null;
        let sendPath = filePath;
        if (realExt !== null && !filePath.toLowerCase().endsWith(realExt)) {
            const tmpPath = filePath.replace(/\.[^.]+$/, '') + '_meme' + realExt;
            await writeFile(tmpPath, buf);
            sendPath = tmpPath;
            setTimeout(() => { rm(tmpPath).catch(() => { }); }, 30_000);
        }
        const b64 = (await readFile(sendPath)).toString('base64');
        const segs = [{ type: 'image', data: { file: `base64://${b64}` } }];
        if (caption)
            segs.push({ type: 'text', data: { text: caption.slice(0, 200) } });
        const groupsAllowed = [config.primaryGroup, ...(config.extraGroups ?? [])].filter((v) => v !== null);
        // 2026-10-31: 未带 target 的表情图默认发管理员私聊，禁止默认进群。
        // （meme-engine 的桥固定 (path, caption) => qq.sendImage(path, caption) 不传 opts，
        //   旧默认 primaryGroup 会把其他窗口的 send_meme 全部投进主群——跨窗口事故。）
        const target = Number(opts.target ?? config.admins[0] ?? 0);
        const isGroup = opts.isGroup ?? (groupsAllowed.includes(target) && target !== (config.admins[0] ?? 0));
        if (isGroup && !groupsAllowed.includes(target))
            throw new Error(`target ${target} 不在群白名单`);
        if (!isGroup && !config.admins.includes(target))
            throw new Error(`target ${target} 不在 admins`);
        await client.call(isGroup ? 'send_group_msg' : 'send_private_msg', isGroup ? { group_id: target, message: segs } : { user_id: target, message: segs });
    };
    globalThis.__channelQqMemeBridge = {
        sendImage: (path, caption, opts) => {
            void sendImage(path, caption, opts).catch((e) => log(`meme-engine send failed: ${e instanceof Error ? e.message : String(e).slice(0, 120)}`));
        },
    };
    const modUrl = new URL('./meme-engine.js', import.meta.url).href;
    // 后台挂载：meme 组件内有市场目录网络请求（jsdelivr 多级回退），可能长时间挂起——
    // 绝不让它阻塞 Service.init（历史事故：apply 卡在 catalog fetch，client.start()
    // 没跑，8082 不监听，NapCat 全链路掉线）。
    void (async () => {
        try {
            const { apply } = (await import(modUrl));
            apply(ctx, { memeRoot: meme.memeRoot ?? undefined });
            log('meme-engine: component attached (send_meme/learn_meme, admin panel, bundled pack)');
        }
        catch (e) {
            log(`meme-engine: attach failed — ${e instanceof Error ? e.message : String(e).slice(0, 160)}`);
        }
    })();
    log('meme-engine: attach dispatched (background)');
    // Send failures surface through the outbound queue logs; the component has
    // no disposer contract beyond ctx.effect routes (host-managed), so this is
    // a no-op kept for symmetry with applyLifeEngine.
    return () => { };
}
