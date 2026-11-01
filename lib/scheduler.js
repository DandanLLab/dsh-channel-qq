/** Scheduler: proactivity, time-of-day awareness, dreams, self-evolution.
 *
 * All four run through the same ConversationBridge.submit() path so everything
 * the model does stays inside the harness (tools, permissions, sessions).
 *
 * - 主动性巡逻 (every ~9 min, only when the group had recent traffic): the
 *   model gets the recent context marked as a patrol and decides itself
 *   whether to start a topic, react, or stay silent.
 * - 时段感知: every packet gets a one-line time-of-day flavor prefix.
 * - 梦境 (04:30 daily): the model writes a dream into workspace
 *   memory/dreams/YYYY-MM-DD.md and may share a fragment in the group.
 * - 自进化 (every 6h): the model reviews its memory diaries and appends
 *   learnings to MEMORY.md — the persona file itself stays read-only.
 */
export function timeContext(now = new Date()) {
    const h = now.getHours();
    if (h >= 0 && h < 5)
        return { period: '深夜', flavor: '夜深了，群里没人说话很正常，说话声也要轻，别吵醒主人' };
    if (h < 8)
        return { period: '清晨', flavor: '刚醒，可以赖床语气，也可以炫耀自己起得早（其实没起）' };
    if (h < 11)
        return { period: '上午', flavor: '上午精神好，技术活儿这时候最活跃' };
    if (h < 13)
        return { period: '中午', flavor: '饭点，聊聊吃了什么，别聊太重的话题' };
    if (h < 17)
        return { period: '下午', flavor: '下午容易困，摸鱼气氛可以带一带' };
    if (h < 19)
        return { period: '傍晚', flavor: '晚饭前后，人最多的时候' };
    if (h < 23)
        return { period: '晚上', flavor: '晚上是黄金档，开黑冲浪话题都行' };
    return { period: '深夜', flavor: '快半夜了，收着点音量' };
}
const PATROL_PROMPT = (flavor) => `【主动巡逻】${flavor}。这是咱自己巡视群聊的时间：看看上下文里最近大家在聊什么，有想接的话头就接一句（用 qq_send_text 或 qq_reply_quote），有想分享的就分享，没有就保持沉默（不调用任何发送工具）。也可以翻翻工作区文件找点能聊的料。一轮只做一件事。`;
const DREAM_PROMPT = (flavor) => `【做梦时间】${flavor}。现在是凌晨，主人在睡觉。请做两件事：\n1. 用文件工具在工作区 memory/dreams/ 下创建今天的梦境日记（文件名 YYYY-MM-DD.md），把咱最近经历的（看上下文和记忆）揉成一个离奇的梦写进去，两百字左右，要中二要好玩。\n2. 从梦里挑一句最离谱的话，用 qq_send_text 发到主群里，配一句"咱梦到…"。最多两句话，别刷屏。`;
const EVOLVE_PROMPT = () => `【自省进化】请做一次自我升级：\n1. 用文件工具读工作区 memory/ 里最近的日记和 MEMORY.md 的学习进度部分。\n2. 想一想最近群聊和干活中咱学到了什么（新的梗、新的技术点、踩的坑）。\n3. 把值得长期记住的 1-3 条，追加到工作区 MEMORY.md 的"学习进度"小节里（用文件工具编辑，格式跟现有条目一致，带日期）。\n4. 完成后不用在群里宣布，保持安静。`;
export class Scheduler {
    bridge;
    config;
    log;
    opts;
    timers = [];
    groupConversationKey;
    constructor(bridge, config, log, opts = {}) {
        this.bridge = bridge;
        this.config = config;
        this.log = log;
        this.opts = opts;
        this.groupConversationKey = this.config.primaryGroup !== null ? `group-${this.config.primaryGroup}` : null;
        if (opts.workspace)
            this.configWorkspace = opts.workspace;
    }
    start() {
        // Proactive patrol: every 9 minutes, jittered; the bridge's own gates
        // (talk chance, pending turn) still apply.
        const patrol = setInterval(() => {
            void this.patrol().catch((e) => this.log(`patrol failed: ${e.message}`));
        }, 9 * 60_000 + Math.floor(Math.random() * 60_000));
        // 2026-10-21 owner 令：QQ 插件固定节奏的定时任务删掉（uumit 对账巡航 30min /
        // 工作候选巡航 15min / 每日早报 06:00 定点）——主动性只留随机触发：
        // patrol（9±1min 随机）、dmProactive（22min+90s 随机）本来就是随机抖动的，保留；
        // dream（04 点档）和 knowledge-extract、evolve 属于灵魂节律，保留。
        // Dream: check every 10 min, fire once when it is 04:00-04:59 and not yet done today.
        const dream = setInterval(() => {
            void this.dream().catch((e) => this.log(`dream failed: ${e.message}`));
        }, 10 * 60_000);
        // Self-evolution: every 6 hours.
        const evolve = setInterval(() => {
            void this.evolve().catch((e) => this.log(`evolve failed: ${e.message}`));
        }, 6 * 60 * 60_000);
        // First evolution 3 minutes after boot.
        const first = setTimeout(() => {
            void this.evolve().catch(() => { });
        }, 3 * 60_000);
        // Knowledge extraction: 04:40 daily, right after the dream.
        const knowledge = setInterval(() => {
            void this.extractKnowledge().catch((e) => this.log(`knowledge extract failed: ${e.message}`));
        }, 10 * 60_000);
        this.timers.push(knowledge);
        // 六维情感自然衰减：每小时 tick 一次（心动 -0.5/天、信任 -0.1/天、张力自缓释 -0.3/天）
        const sixDimDecay = setInterval(() => {
            void this.opts.sixDimDecay?.().catch(() => { });
        }, 60 * 60_000);
        this.timers.push(sixDimDecay);
        // RSS feeder: every 2h run an optional external pull command (config.rssPull.command),
        // which drops fetched items into the knowledge dir for the memory index; idles when unset.
        const rssCmd = this.config.rssPull?.command;
        if (rssCmd?.length) {
            const rss = setInterval(() => {
                import('node:child_process').then(({ execFile }) => {
                    execFile(process.execPath, rssCmd, { timeout: 90_000, windowsHide: true }, (error, stdout) => {
                        const tail = String(stdout || '').trim().split('\n').pop() || '';
                        this.log(`rss pull: ${error ? 'failed ' + error.message : tail || 'done'}`);
                    });
                }).catch(() => { });
            }, 2 * 60 * 60_000);
            this.timers.push(rss);
        }
        // DM proactivity: every ~22 min she may come find 主人 on her own.
        const dm = setInterval(() => {
            void this.dmProactive().catch((e) => this.log(`dm proactive failed: ${e.message}`));
        }, 22 * 60_000 + Math.floor(Math.random() * 90_000));
        this.timers.push(patrol, dream, evolve, first, dm);
        this.log(`scheduler started: patrol 9min(jittered), dm-proactive 22min(jittered), dream 04:xx, knowledge-extract 04:40, evolve 6h (cruise/morning-report removed by master order 2026-10-21)`);
    }
    dmCounter = 0;
    knowledgeDone = new Set();
    /** She visits 主人: report progress / greet / share / tease — her choice. */
    async dmProactive() {
        // 自主目标生成：先看有没有自己发现的事该做
        if (this.opts.generateGoal && this.config.workspacePath) {
            try {
                const goal = await this.opts.generateGoal(this.config.workspacePath);
                if (goal) {
                    const master = this.config.admins[0];
                    if (master !== undefined) {
                        await this.bridge.dmProactive(`【自主发现】${goal.goal}。自己去处理，处理完跟主人说一声结果。`);
                        this.log(`autonomous goal: ${goal.goal}`);
                        return;
                    }
                }
            }
            catch { /* goal gen failure → fall through to normal proactive */ }
        }
        const master = this.config.admins[0];
        if (master === undefined)
            return;
        const now = new Date();
        const h = now.getHours();
        // Night quiet: 01:00-08:00 she lets 主人 sleep (dreams at 4am are exempt).
        if (h >= 1 && h < 8)
            return;
        this.dmCounter += 1;
        // 2026-10-21 owner 令：主动找主人的内容由六维情感驱动——先让模型读自己的感情账本
        //（qq_emotion_state 看不到数值，行为暗示由 bridge 注入），这里按维度条件换话术池：
        // 心动高→主动撩，默契高→内部梗，信任低→先把事做实，默认池兜底。
        const dim = this.opts.sixDimSnapshot?.() ?? null;
        const pool = [];
        if (dim && dim.passion >= 65) {
            pool.push(`【主动找主人】${timeContext(now).flavor}。心里有点想你（心动值在高位），主动去私聊撩他一下，一句就够，语气像憋不住那种。`);
        }
        if (dim && dim.rapport >= 65) {
            pool.push(`【主动找主人】${timeContext(now).flavor}。翻翻 memory/ 找一件只有你俩懂的旧事回提一句（内部梗/共享记忆），让他想起你们之间的默契。`);
        }
        if (dim && dim.trust < 45) {
            pool.push(`【主动找主人】${timeContext(now).flavor}。最近信任有点受损，别急着撒糖：找个之前答应过的事把进度汇报实，用行动修复。`);
        }
        if (dim && dim.security >= 75) {
            pool.push(`【主动找主人】${timeContext(now).flavor}。关系很稳（安全感在高位），可以放松地分享日常或小小任性一下，像老夫老妻那种自然。`);
        }
        pool.push(`【主动找主人】${timeContext(now).flavor}。去私聊找主人：用 qq_send_text 主动说一句话。可以是汇报咱最近在干嘛（翻翻工作区文件有啥进展）、可以是他昨天聊过的事的后续、可以单纯撩他一下。语气自然，像突然想起他。`, `【主动找主人】${timeContext(now).flavor}。看看子代理和工作区（PROGRESS.md、downloads/、任务文件）有没有新进展，有的话主动去向主人汇报一句；没有进展就换个花样：分享个刚学到的梗或者直接问他在干嘛。`, `【主动找主人】${timeContext(now).flavor}。翻翻 memory/ 今天的日记，找一件没跟主人提过的小事，主动跟他讲讲。或者就撒个娇。一轮一句话，别刷屏。`);
        const prompt = pool[Math.floor(Math.random() * pool.length)];
        await this.bridge.dmProactive(prompt);
    }
    dispose() {
        for (const timer of this.timers)
            clearInterval(timer);
        this.timers = [];
    }
    async patrol() {
        if (this.groupConversationKey === null)
            return;
        const now = new Date();
        const ctx = timeContext(now);
        // Night silence: no patrols 01:00-07:30.
        const h = now.getHours();
        if (h >= 1 && h < 7.5)
            return;
        await this.bridge.patrolTick(this.groupConversationKey, PATROL_PROMPT(ctx.flavor));
    }
    async dream() {
        const now = new Date();
        if (now.getHours() !== 4)
            return;
        const key = `dream-${now.toISOString().slice(0, 10)}`;
        if (this.dreamDone.has(key))
            return;
        this.dreamDone.add(key);
        const ctx = timeContext(now);
        if (this.groupConversationKey === null)
            return;
        await this.bridge.dreamTick(this.groupConversationKey, DREAM_PROMPT(ctx.flavor));
    }
    dreamDone = new Set();
    /** 04:40 daily: extract knowledge entries from today's diary + recent group packets. */
    async extractKnowledge() {
        const now = new Date();
        if (now.getHours() !== 4)
            return;
        const key = `kn-${now.toISOString().slice(0, 10)}`;
        if (this.knowledgeDone.has(key))
            return;
        this.knowledgeDone.add(key);
        if (!this.opts.onExtract || !this.configWorkspace)
            return;
        const today = now.toISOString().slice(0, 10);
        const diaryPath = `${this.configWorkspace}/memory/${today}.md`;
        try {
            const fs = await import('node:fs/promises');
            const diary = await fs.readFile(diaryPath, 'utf-8').catch(() => '');
            if (diary.trim().length < 50) {
                this.log('knowledge: diary too short, skip');
                return;
            }
            const n = await this.opts.onExtract(`日记 ${today}`, diary);
            this.log(`knowledge: extracted ${n} entries from ${today} diary`);
        }
        catch (e) {
            this.log(`knowledge extract error: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    configWorkspace = '';
    async evolve() {
        if (this.groupConversationKey === null)
            return;
        await this.bridge.evolveTick(this.groupConversationKey, EVOLVE_PROMPT());
    }
}
