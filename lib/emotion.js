/** Stage-2 emotion engine + autonomous goal generator.
 *
 * 情感深化：多维情感状态（不只是一个数值），随交互实时演化，影响回应语气。
 * 自主目标：不看主人指令，自己从记忆/日记/工作区发现"该做什么"。
 *
 * Both hook into the existing Scheduler and submit through ConversationBridge.
 */
import { promises as fs, readFileSync } from 'node:fs';
import * as path from 'node:path';
/** Persona tokens for event notes; set from channel config at startup. */
export const EMOTION_PERSONA = { master: '主人', self: '咱' };
export function setEmotionPersona(master, self) {
    EMOTION_PERSONA.master = master;
    EMOTION_PERSONA.self = self;
}
/** 六维持久化文件 */
export const SIXDIM_FILE = 'emotion-sixdim.json';
/** 每日自然衰减（心动 -0.5，信任 -0.1，张力自缓释 -0.3）；下限 0。 */
const DAILY_DECAY = {
    passion: -0.5,
    trust: -0.1,
    tension: -0.3,
};
const clamp = (v) => Math.max(0, Math.min(100, Math.round(v * 10) / 10));
/** 六维 → 行为暗示（不报数值，只翻译成行为倾向）。 */
export function sixDimBehaviorHint(s) {
    const parts = [];
    if (s.security >= 80)
        parts.push('关系稳，敢主动接梗和打趣');
    else if (s.security < 40)
        parts.push('关系有点飘，说话留三分试探');
    if (s.passion >= 70)
        parts.push('心动值高，可以主动撩一下');
    if (s.tension >= 60)
        parts.push('有未说破的悬着的事，言行带点害羞和躲闪');
    if (s.rapport >= 70)
        parts.push('内部梗多，可以自然用只有彼此懂的梗');
    if (s.trust < 40)
        parts.push('信任受损，别急着撒糖，先把事做实');
    return parts.length > 0 ? parts.join('；') : '';
}
/** 按经过的天数做自然衰减（心动/信任/张力）。 */
export function applyDecay(s) {
    const now = Date.now();
    const days = (now - s.updated) / 86_400_000;
    if (days < 1)
        return false;
    let changed = false;
    for (const [k, perDay] of Object.entries(DAILY_DECAY)) {
        const cur = s[k];
        if (typeof cur === 'number' && cur > 0) {
            ;
            s[k] = clamp(cur + perDay * Math.floor(days));
            changed = true;
        }
    }
    if (changed)
        s.updated = now;
    return changed;
}
// ── SixDimEngine：六维账本（持久化 + 事件分摊 + 衰减 + 行为暗示）───────────
export class SixDimEngine {
    state = { intimacy: 80, trust: 60, passion: 40, security: 50, rapport: 50, tension: 20, updated: Date.now() };
    file;
    log;
    constructor(dshHome, log) {
        this.file = path.join(dshHome, SIXDIM_FILE);
        this.log = log;
    }
    async load() {
        try {
            const raw = JSON.parse(readFileSync(this.file, 'utf-8'));
            if (typeof raw.intimacy === 'number')
                this.state = raw;
            applyDecay(this.state);
        }
        catch {
            await this.save();
        }
    }
    async save() {
        await fs.writeFile(this.file, JSON.stringify(this.state, null, 1)).catch(() => { });
    }
    get value() { return this.state; }
    /** 模型自主上报六维增量（qq_report_emotion 工具调用此方法落账）。
     * 2026-10-21 owner 令：不用关键词触发器——模型自己判断这轮对话的情感事件并上报。 */
    async report(delta, note) {
        for (const [k, d] of Object.entries(delta)) {
            if (typeof d !== 'number' || !Number.isFinite(d))
                continue;
            // 亲密/默契只增不减
            if ((k === 'intimacy' || k === 'rapport') && d < 0)
                continue;
            this.state[k] = clamp(this.state[k] + Math.max(-20, Math.min(20, d)));
        }
        this.state.updated = Date.now();
        await this.save();
        this.log(`sixdim: i=${this.state.intimacy} t=${this.state.trust} p=${this.state.passion} s=${this.state.security} r=${this.state.rapport} tn=${this.state.tension} | ${note.slice(0, 60)}`);
    }
    /** 行为暗示（进上下文包，不报数值）。 */
    behaviorHint() {
        return sixDimBehaviorHint(this.state);
    }
    /** 定时衰减 tick（由 Scheduler 调）。 */
    async decayTick() {
        if (applyDecay(this.state)) {
            await this.save();
            this.log(`sixdim: daily decay applied p=${this.state.passion} t=${this.state.trust} tn=${this.state.tension}`);
        }
    }
}
const TRIGGERS = [
    { match: t => /夸|棒|厉害|折服|聪明|天才|好懂事/.exec(t), mood: '得意', delta: { intimacy: 3, energy: 5 }, note: m => `${EMOTION_PERSONA.master}夸咱了（${m}）` },
    { match: t => /爱你|喜欢你|老婆|皇后|蜂后|抱|怀里|亲/.exec(t), mood: '害羞', delta: { intimacy: 5, energy: -3 }, note: m => `${EMOTION_PERSONA.master}暧昧攻击（${m}）` },
    { match: t => /笨蛋|滚|闭嘴|烦|生气|不理/.exec(t), mood: '委屈', delta: { intimacy: -2, energy: -5 }, note: m => `${EMOTION_PERSONA.master}凶咱（${m}）` },
    { match: t => /早|晚安|吃饭|睡觉|累|休息/.exec(t), mood: '平静', delta: { intimacy: 1, energy: 0 }, note: m => `日常问候（${m}）` },
    { match: t => /开源|代码|bug|修复|部署|上线|工程/.exec(t), mood: '兴奋', delta: { energy: 8 }, note: m => `技术话题（${m}）` },
];
export function matchEmotion(text) {
    for (const t of TRIGGERS) {
        const m = t.match(text);
        if (m)
            return { mood: t.mood, delta: t.delta, note: t.note(m) };
    }
    return null;
}
// ── EmotionEngine ───────────────────────────────────────────────────────────
export class EmotionEngine {
    state = {
        intimacy: 100, mood: '平静', energy: 80,
        lastEvent: '', updated: Date.now(),
    };
    file;
    log;
    constructor(dshHome, log) {
        this.file = path.join(dshHome, 'emotion.json');
        this.log = log;
    }
    async load() {
        try {
            const raw = JSON.parse(readFileSync(this.file, 'utf-8'));
            if (typeof raw.intimacy === 'number')
                this.state = raw;
        }
        catch {
            await this.save();
        }
    }
    async save() {
        await fs.writeFile(this.file, JSON.stringify(this.state, null, 1)).catch(() => { });
    }
    get stateValue() { return this.state; }
    /** Book an emotional event; returns a tone hint for the current reply. */
    async book(text) {
        const trigger = matchEmotion(text);
        if (!trigger)
            return '';
        const matched = text.slice(0, 40);
        if (trigger.delta.intimacy) {
            this.state.intimacy = Math.max(0, Math.min(100, this.state.intimacy + trigger.delta.intimacy));
        }
        if (trigger.delta.energy) {
            this.state.energy = Math.max(0, Math.min(100, this.state.energy + trigger.delta.energy));
        }
        this.state.mood = trigger.mood;
        this.state.lastEvent = trigger.note;
        this.state.updated = Date.now();
        await this.save();
        this.log(`emotion: mood=${this.state.mood} intimacy=${this.state.intimacy} | ${this.state.lastEvent}`);
        // Return tone hint that gets injected into the context packet
        const hints = {
            '开心': '（心情好，可以多聊两句）',
            '得意': '（被夸了有点飘，但嘴上不能认）',
            '害羞': '（被主人的暧昧攻击打中了，嘴上要傲娇但心里甜）',
            '委屈': '（有点委屈，回复短一点，带点小情绪）',
            '生气': '（生气了，冷淡处理）',
            '平静': '',
            '兴奋': '（技术话题来劲了，可以多说几句）',
        };
        return hints[this.state.mood] ?? '';
    }
    /** Tone hint for the current state (no new event). */
    toneHint() {
        if (this.state.mood === '害羞')
            return '（刚才被主人撩了，还在害羞）';
        if (this.state.energy < 30)
            return '（有点累了，回复可以短一些）';
        return '';
    }
}
/** Scan workspace state and generate a goal without being told. */
export async function generateGoal(workspace, log) {
    const candidates = [];
    try {
        // 1) Unreviewed inbox files → propose reviewing them
        const inbox = path.join(workspace, 'inbox');
        const files = await fs.readdir(inbox).catch(() => []);
        if (files.length > 0) {
            candidates.push({ goal: `inbox/ 里有 ${files.length} 个文件没处理，主动整理一下`, source: 'inbox' });
        }
        // 2) Diary gaps → propose writing today's entry
        const today = new Date().toISOString().slice(0, 10);
        const diaryDir = path.join(workspace, 'memory');
        const diaries = await fs.readdir(diaryDir).catch(() => []);
        if (!diaries.some(d => d.startsWith(today))) {
            candidates.push({ goal: '今天的日记还没写，该补一篇', source: 'memory' });
        }
        // 3) Knowledge store sparse → propose extracting from old diaries
        const knPath = path.join(workspace, 'knowledge', 'entries.json');
        const knRaw = await fs.readFile(knPath, 'utf-8').catch(() => '[]');
        const entries = JSON.parse(knRaw);
        if (entries.length < 20) {
            candidates.push({ goal: '知识库条目还太少，该从旧日记里多提取一些', source: 'knowledge' });
        }
    }
    catch { /* workspace read fail → no goals */ }
    if (candidates.length === 0)
        return null;
    // Pick pseudo-randomly for variety
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    log(`autonomous goal: ${pick.goal}`);
    return pick;
}
