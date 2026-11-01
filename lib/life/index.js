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
/** Apply the life engine to the harness context. Returns a disposer. */
export async function applyLifeEngine(ctx, config, log) {
    const life = (config.lifeEngine ?? { enabled: true });
    if (life.enabled === false) {
        log('life-engine: disabled by config');
        return () => { };
    }
    const modUrl = new URL('./life-engine.js', import.meta.url).href;
    let apply;
    try {
        ;
        ({ apply } = (await import(modUrl)));
    }
    catch (e) {
        log(`life-engine: load failed — ${e instanceof Error ? e.message : String(e)}`);
        return () => { };
    }
    const disposers = [];
    const attach = async () => {
        // 1) sections + tools + timers on the plugin context (upstream contract)
        const off = await apply(ctx);
        if (typeof off === 'function')
            disposers.push(off);
        log('life-engine: component attached (sections 10240+, tools, 30s life loop)');
    };
    try {
        // 超时保护：组件 attach 永不阻塞主链路（8082 监听/QQ 连接优先）
        await Promise.race([
            attach(),
            new Promise((resolve) => setTimeout(resolve, 3000).unref?.()),
        ]);
    }
    catch (e) {
        log(`life-engine: attach failed — ${e instanceof Error ? e.message : String(e).slice(0, 160)}`);
    }
    return () => { for (const off of disposers) {
        try {
            off?.();
        }
        catch { /* ignore */ }
    } };
}
