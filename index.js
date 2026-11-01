/**
 * ST Phone — 폰·SNS 시뮬레이터 (SillyTavern 확장) v1.0.0
 *
 * 구조: 코드가 앱 구조·저장·정보 차단을 맡고, AI는 "내용"(문자/게시글/댓글/뉴스)만 JSON으로 생성한다.
 * 데이터는 채팅(chat metadata)별로 저장되어 RP마다 폰이 분리된다.
 * 앱: 캐릭터 · 메시지 · SNS · Luna(생리 주기) · 임신 · 캘린더 · 월드(날씨/뉴스) · 계정 등록 · 설정
 */
(() => {
    'use strict';

    const MODULE = 'st_phone_sim';
    const ctx = () => SillyTavern.getContext();

    const DEFAULTS = {
        enabled: true,
        inject: true,          // 폰 활동을 메인 채팅 프롬프트에 주입
        injectCount: 8,        // 주입할 최근 활동 수
        injectCalendar: true,  // 오늘/내일 일정 주입
        injectTracker: true,   // 주기·임신 상태 주입 (추적을 켠 계정만)
        injectWorld: true,     // 월드 날씨/뉴스 주입
        autoReply: true,       // 내가 문자를 보내면 자동으로 답장 생성
        autoReact: true,       // 내가 글을 올리면 자동으로 반응 생성
        autoMode: false,       // 메인 채팅이 진행되면 캐릭터가 알아서 폰 활동
        autoEvery: 4,          // 캐릭터 메시지 N개마다 실행
        autoClock: 10,         // 캐릭터 메시지 1개당 폰 시간 진행(분)
        lang: '한국어',
        theme: 'teal',
        accent: '#9fdcc7',
        fontScale: 'normal',   // normal | large
        pos: null,             // 버블 위치 {x, y}
    };

    const THEMES = {
        teal: { label: '청록', a: '#0d2a2d', b: '#1f4d4f' },
        navy: { label: '밤하늘', a: '#0e1430', b: '#2a3566' },
        rose: { label: '로즈', a: '#2a1420', b: '#5c2c40' },
        graphite: { label: '먹색', a: '#101113', b: '#2c2f35' },
    };

    /* ───────────── 설정 ───────────── */

    function getSettings() {
        const { extensionSettings } = ctx();
        if (!extensionSettings[MODULE]) extensionSettings[MODULE] = {};
        const s = extensionSettings[MODULE];
        for (const k of Object.keys(DEFAULTS)) if (!(k in s)) s[k] = DEFAULTS[k];
        return s;
    }
    const saveSettings = () => ctx().saveSettingsDebounced();

    /* ───────────── 날짜 도우미 ───────────── */

    const DAY_KO = ['일', '월', '화', '수', '목', '금', '토'];
    const pad = n => String(n).padStart(2, '0');
    function fmtClock(d) {
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    function parseClock(s) {
        const m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})/.exec(s || '');
        return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
    }
    function shortTime(s) {
        const d = parseClock(s);
        return d ? `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}` : '';
    }
    const dkey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    function parseKey(k) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k || '');
        return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
    }
    const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
    const diffDays = (a, b) => Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86400000);
    const today = st => { const d = parseClock(st.clock) || new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); };
    function daypart(clock) {
        const h = (parseClock(clock) || new Date()).getHours();
        return h < 5 ? '새벽' : h < 11 ? '아침' : h < 14 ? '점심' : h < 18 ? '오후' : h < 22 ? '저녁' : '밤';
    }
    function timeLine(st) {
        const d = parseClock(st.clock) || new Date();
        return `${st.clock} (${DAY_KO[d.getDay()]}요일, ${daypart(st.clock)})`;
    }
    function advance(st, min) {
        const d = parseClock(st.clock) || new Date();
        d.setMinutes(d.getMinutes() + min);
        st.clock = fmtClock(d);
    }

    /* ───────────── 상태 ───────────── */

    function newState() {
        return {
            clock: fmtClock(new Date()), seq: 0,
            follows: {}, known: [], init: {},
            posts: [], threads: {}, unread: {}, autoCount: 0,
            profiles: {},   // { 이름: {bio, birthday:'MM-DD', note} }
            events: [],     // [{id, date:'YYYY-MM-DD', title}]
            cycle: {},      // { 이름: {on, shared, len, plen, starts:['YYYY-MM-DD']} }
            preg: {},       // { 이름: {on, shared, lmp, ended, notes:[{id,date,text}]} }
            world: { setting: '', weather: null, news: [] },
        };
    }

    const userName = () => ctx().name1 || 'User';

    function charNames() {
        const c = ctx();
        if (c.groupId) {
            const g = (c.groups || []).find(x => String(x.id) === String(c.groupId));
            const names = ((g && g.members) || [])
                .map(av => (c.characters || []).find(ch => ch.avatar === av))
                .filter(Boolean)
                .map(ch => ch.name);
            if (names.length) return names;
        }
        const ch = c.characters && c.characters[c.characterId];
        if (ch && ch.name) return [ch.name];
        return c.name2 && c.name2 !== 'System' ? [c.name2] : [];
    }

    function getState() {
        const meta = ctx().chatMetadata;
        if (!meta) return null;
        if (!meta[MODULE]) meta[MODULE] = newState();
        const st = meta[MODULE];
        const base = newState();
        for (const k of Object.keys(base)) if (st[k] === undefined) st[k] = base[k];
        ensureDefaults(st);
        return st;
    }

    function addTo(arr, v) { if (!arr.includes(v)) arr.push(v); }

    function registerAccount(st, name) {
        if (!name || name === userName()) return;
        addTo(st.known, name);
        if (!st.follows[name]) st.follows[name] = [];
    }

    // 캐릭터와 유저는 처음에 서로 팔로우한 상태로 시작 (이후 변경 가능)
    function ensureDefaults(st) {
        const u = userName();
        if (!st.follows[u]) st.follows[u] = [];
        for (const n of charNames()) {
            registerAccount(st, n);
            if (!st.init[n]) {
                st.init[n] = true;
                addTo(st.follows[n], u);
                addTo(st.follows[u], n);
            }
        }
    }

    function saveState() {
        const c = ctx();
        if (c.saveMetadataDebounced) c.saveMetadataDebounced();
        else if (c.saveMetadata) c.saveMetadata();
        refreshInjection();
    }

    const nid = st => ++st.seq;
    const accounts = st => [userName(), ...st.known.filter(n => n !== userName())];

    /* ───────────── 트래커 계산 ───────────── */

    function ensureCycle(st, who) {
        if (!st.cycle[who]) st.cycle[who] = { on: false, shared: false, len: 28, plen: 5, starts: [] };
        return st.cycle[who];
    }
    function ensurePreg(st, who) {
        if (!st.preg[who]) st.preg[who] = { on: false, shared: false, lmp: '', ended: null, notes: [] };
        return st.preg[who];
    }

    function pregInfo(st, who) {
        const p = st.preg[who];
        if (!p || !p.on || !parseKey(p.lmp)) return null;
        const t = today(st), lmp = parseKey(p.lmp);
        const d = Math.max(0, diffDays(lmp, t));
        const w = Math.floor(d / 7);
        const due = addDays(lmp, 280);
        return { weeks: w, days: d % 7, due, left: diffDays(t, due), tri: w < 14 ? 1 : w < 28 ? 2 : 3, pct: Math.min(100, Math.round(d / 280 * 100)) };
    }

    function cycleInfo(st, who) {
        const c = st.cycle[who];
        if (!c || !c.on) return null;
        if (pregInfo(st, who)) return { paused: true };
        const t = today(st);
        const starts = (c.starts || []).map(parseKey).filter(d => d && d <= t).sort((a, b) => a - b);
        if (!starts.length) return { empty: true };
        const last = starts[starts.length - 1];
        const day = diffDays(last, t) + 1;
        const len = c.len, plen = c.plen, ov = len - 14;
        let phase;
        if (day > len) phase = `예정일 ${day - len}일 경과`;
        else if (day <= plen) phase = `생리 ${day}일차`;
        else if (day === ov) phase = '배란 예정일';
        else if (day >= ov - 5 && day <= ov + 1) phase = '가임기';
        else if (day < ov) phase = '난포기';
        else phase = '황체기';
        const next = addDays(last, len);
        return { last, day, phase, next, daysToNext: diffDays(t, next), ovDate: addDays(last, ov - 1) };
    }

    const SIZES = [[4, '양귀비 씨앗'], [6, '렌틸콩'], [8, '산딸기'], [10, '금귤'], [12, '라임'], [14, '레몬'], [16, '아보카도'], [18, '피망'], [20, '바나나'], [22, '파파야'], [24, '옥수수'], [26, '대파 한 단'], [28, '가지'], [30, '양배추'], [32, '파인애플'], [34, '멜론'], [36, '로메인 상추'], [38, '리크'], [40, '수박']];
    function sizeFor(w) {
        let r = '';
        for (const [k, v] of SIZES) if (w >= k) r = v;
        return r;
    }

    /* ───────────── 캘린더 도우미 ───────────── */

    function markersFor(st, key) {
        const out = [];
        for (const e of st.events) if (e.date === key) out.push({ kind: 'event', label: e.title, id: e.id });
        for (const [n, p] of Object.entries(st.profiles)) {
            if (p.birthday && p.birthday === key.slice(5)) out.push({ kind: 'birth', label: `${n} 생일` });
        }
        const k = parseKey(key);
        for (const owner of accounts(st)) {
            const c = st.cycle[owner];
            if (c && c.on && !pregInfo(st, owner) && k) {
                const starts = (c.starts || []).map(parseKey).filter(Boolean).sort((a, b) => a - b);
                for (const s of starts) {
                    const d = diffDays(s, k);
                    if (d >= 0 && d < c.plen) out.push({ kind: 'period', label: `${owner} 생리` });
                }
                if (starts.length) {
                    const last = starts[starts.length - 1];
                    for (let i = 1; i <= 3; i++) {
                        const d = diffDays(addDays(last, c.len * i), k);
                        if (d >= 0 && d < c.plen) out.push({ kind: 'period', label: `${owner} 생리 예정` });
                    }
                }
            }
            const pi = pregInfo(st, owner);
            if (pi && dkey(pi.due) === key) out.push({ kind: 'due', label: `${owner} 출산 예정일` });
        }
        return out;
    }

    function upcomingEvents(st) {
        const t = today(st), out = [];
        for (const [off, label] of [[0, '오늘'], [1, '내일']]) {
            const k = dkey(addDays(t, off));
            for (const e of st.events) if (e.date === k) out.push(`${label} ${e.title}`);
            for (const [n, p] of Object.entries(st.profiles)) if (p.birthday && p.birthday === k.slice(5)) out.push(`${label} ${n} 생일`);
        }
        return out;
    }

    /* ───────────── 정보 차단(gating) ───────────── */

    const follows = (st, a, b) => (st.follows[a] || []).includes(b);
    const postVisibleTo = (st, p, name) => p.author === name || follows(st, name, p.author);

    function buildEvents(st) {
        const ev = [];
        for (const p of st.posts) {
            ev.push({ seq: p.id, time: p.time, text: `[SNS] ${p.author}: ${p.text}`, knows: n => postVisibleTo(st, p, n) });
            for (const cm of p.comments) {
                ev.push({ seq: cm.id, time: cm.time, text: `[SNS 댓글] ${cm.author} → ${p.author}의 글: ${cm.text}`, knows: n => cm.author === n || postVisibleTo(st, p, n) });
            }
        }
        for (const msgs of Object.values(st.threads)) {
            for (const m of msgs) {
                ev.push({ seq: m.id, time: m.time, text: `[문자] ${m.from} → ${m.to}: ${m.text}`, knows: n => m.from === n || m.to === n });
            }
        }
        return ev.sort((a, b) => a.seq - b.seq);
    }

    function knowledgeFor(st, names, limit = 6) {
        const ev = buildEvents(st);
        return names.map(n => {
            const mine = ev.filter(e => e.knows(n)).slice(-limit).map(e => `  (${shortTime(e.time)}) ${e.text}`);
            const fl = (st.follows[n] || []).join(', ') || '없음';
            return `- ${n} (팔로우: ${fl})\n${mine.join('\n') || '  (아직 아는 폰 활동 없음)'}`;
        }).join('\n');
    }

    // 모든 캐릭터가 공통으로 아는 정보(날씨·일정·세계관)
    function contextBlock(st) {
        const L = [], w = st.world;
        if (w.setting) L.push(`세계관·지역 설정: ${w.setting}`);
        if (w.weather) L.push(`오늘 날씨: ${w.weather.summary} ${w.weather.temp || ''}`.trim());
        const ev = upcomingEvents(st);
        if (ev.length) L.push(`일정: ${ev.join(' / ')}`);
        return L.length ? `공용 참고 정보:\n${L.join('\n')}\n` : '';
    }

    function trackerLines(st, names) {
        const out = [];
        for (const owner of accounts(st)) {
            const visible = share => names.includes(owner) || share;
            const pi = pregInfo(st, owner);
            if (pi && visible(st.preg[owner].shared)) {
                out.push(`${owner}: 임신 ${pi.weeks}주 ${pi.days}일 (출산 예정일 ${dkey(pi.due)})`);
            }
            const ci = cycleInfo(st, owner);
            if (ci && ci.phase && visible(st.cycle[owner].shared)) out.push(`${owner}: ${ci.phase}`);
        }
        return out;
    }

    /* ───────────── 메인 채팅 주입 ───────────── */

    function refreshInjection() {
        const c = ctx();
        if (!c.setExtensionPrompt) return;
        const s = getSettings();
        const pos = (c.extension_prompt_types && c.extension_prompt_types.IN_CHAT) ?? 1;
        const role = (c.extension_prompt_roles && c.extension_prompt_roles.SYSTEM) ?? 0;
        const clear = () => c.setExtensionPrompt(MODULE, '', pos, 1, false, role);
        const st = getState();
        if (!s.enabled || !s.inject || !st) { clear(); return; }
        const names = charNames();
        const parts = [];
        const lines = buildEvents(st)
            .filter(e => names.some(n => e.knows(n)))
            .slice(-Math.max(1, +s.injectCount || 8))
            .map(e => `(${shortTime(e.time)}) ${e.text}`);
        if (lines.length) parts.push(`[폰 활동 기록]\n${lines.join('\n')}`);
        if (s.injectCalendar) { const ev = upcomingEvents(st); if (ev.length) parts.push(`[일정] ${ev.join(', ')}`); }
        if (s.injectTracker) { const tl = trackerLines(st, names); if (tl.length) parts.push(`[상태]\n${tl.join('\n')}`); }
        if (s.injectWorld) {
            const w = st.world, bits = [];
            if (w.weather) bits.push(`날씨 ${w.weather.summary} ${w.weather.temp || ''}`.trim());
            if (w.news[0]) bits.push(`최근 뉴스 "${w.news[0].title}"`);
            if (bits.length) parts.push(`[월드] ${bits.join(', ')}`);
        }
        if (!parts.length) { clear(); return; }
        const text = `[폰 시간 ${timeLine(st)}]\n${parts.join('\n')}\n` +
            `(캐릭터는 자신이 보내거나 올렸거나 팔로우한 계정의 활동만 안다. 필요할 때만 자연스럽게 언급하고, 이 기록을 그대로 읊지 말 것.)`;
        c.setExtensionPrompt(MODULE, text, pos, 1, false, role);
    }

    /* ───────────── AI 호출 ───────────── */

    let busy = false;
    let typing = null;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const toast = (type, msg) => { try { window.toastr && window.toastr[type](msg, 'ST Phone'); } catch { /* noop */ } };

    async function ask(instruction) {
        const fn = ctx().generateQuietPrompt;
        if (typeof fn !== 'function') throw new Error('이 실리태번 버전은 generateQuietPrompt를 지원하지 않아요. 업데이트가 필요해요.');
        // 신버전(객체 인자)과 구버전(위치 인자)을 모두 지원
        const out = fn.length === 0
            ? await fn({ quietPrompt: instruction })
            : await fn(instruction, false, false);
        return String(out || '');
    }

    function parseJSON(text) {
        const t = String(text).replace(/```(?:json)?/gi, '').trim();
        const s = t.search(/[[{]/);
        if (s < 0) return null;
        const close = t[s] === '{' ? '}' : ']';
        const e = t.lastIndexOf(close);
        if (e < s) return null;
        try { return JSON.parse(t.slice(s, e + 1)); } catch { return null; }
    }

    function header() {
        return `[시스템 지시: 롤플레이 진행을 잠시 멈추고 아래 작업만 수행하라. 지정된 JSON 형식으로만 출력하고, 설명·코드블록·롤플레이 서술·사고과정은 절대 쓰지 마라. 출력 언어: ${getSettings().lang}]`;
    }

    async function withBusy(label, fn) {
        if (busy) { toast('info', '생성 중이에요. 잠시만 기다려 주세요.'); return; }
        busy = true;
        try { await fn(); }
        catch (e) { console.error('[ST Phone]', e); toast('error', `${label} 실패: ${e.message || e}`); }
        finally { busy = false; typing = null; render(); }
    }

    /* ── 문자 ── */

    function addMsg(st, partner, from, text) {
        registerAccount(st, partner);
        const u = userName();
        (st.threads[partner] = st.threads[partner] || []).push({
            id: nid(st), from, to: from === u ? partner : u, text, time: st.clock,
        });
        if (from !== u && !(phoneOpen && view === 'chat' && curPartner === partner)) {
            st.unread[partner] = (st.unread[partner] || 0) + 1;
        }
    }

    async function aiMessages(partner, kind) {
        const st = getState();
        const u = userName();
        const hist = (st.threads[partner] || []).slice(-14).map(m => `${m.from}: ${m.text}`).join('\n') || '(아직 대화 없음)';
        const task = kind === 'first'
            ? `${partner}가 ${u}에게 먼저 문자를 보낸다. 시간대·요일·날씨·일정과 최근 상황에 어울리는 자연스러운 이유로 연락한다.`
            : `${partner}가 ${u}의 마지막 문자에 답장한다.`;
        const prompt = `${header()}
작업: ${task}
현재 폰 시간: ${timeLine(st)}
${contextBlock(st)}지금까지의 문자 대화:
${hist}
규칙:
- 실제 문자처럼 짧게 1~3개의 메시지로 나눠 쓴다. (줄임말·이모티콘·오타는 캐릭터 성격에 맞을 때만)
- ${partner}는 메인 채팅에서 일어난 일과 자신이 겪은 폰 활동만 안다. ${u}의 행동·대사를 대신 쓰지 마라.
${partner}가 아는 폰 활동:
${knowledgeFor(st, [partner])}
형식: {"messages":["메시지1","메시지2"]}`;
        const data = parseJSON(await ask(prompt));
        const arr = data && Array.isArray(data.messages) ? data.messages.map(String).filter(Boolean) : null;
        if (!arr || !arr.length) throw new Error('AI 응답을 해석하지 못했어요. 다시 시도해 주세요.');
        return arr;
    }

    async function aiSend(partner, kind) {
        await withBusy('문자 생성', async () => {
            typing = partner; render();
            const arr = await aiMessages(partner, kind);
            for (const text of arr) {
                typing = partner; render();
                await sleep(500 + Math.min(1600, text.length * 45));
                const st = getState();
                advance(st, 1);
                addMsg(st, partner, partner, text);
                typing = null; saveState(); render();
            }
        });
    }

    /* ── SNS ── */

    function addPost(st, author, text, tags) {
        registerAccount(st, author);
        const p = {
            id: nid(st), author, text: String(text), time: st.clock,
            tags: Array.isArray(tags) ? tags.map(t => String(t).replace(/^#/, '')).filter(Boolean).slice(0, 5) : [],
            likes: [], extraLikes: 0, comments: [],
        };
        st.posts.unshift(p);
        return p;
    }

    async function aiPosts() {
        await withBusy('SNS 새로고침', async () => {
            const st = getState();
            const u = userName();
            const names = charNames();
            const recent = st.posts.slice(0, 6).map(p => `- ${p.author}: ${p.text}`).join('\n') || '(없음)';
            const prompt = `${header()}
작업: 캐릭터들의 SNS 새 게시글 3개를 작성한다.
현재 폰 시간: ${timeLine(st)}
${contextBlock(st)}작성자 후보: ${names.join(', ')} (분위기에 맞는 NPC 계정을 최대 1개 섞어도 된다)
${u}(유저) 계정의 글·댓글은 절대 대신 쓰지 마라.
각 작성자는 자신이 직접 겪은 일, 자신이 주고받은 문자, 메인 채팅에서 겪은 일, 팔로우한 계정의 글만 안다. 모르는 정보는 언급하지 마라.
시간대와 요일에 맞는 생활 리듬(자는 시간, 출근, 식사 등)을 지켜라.
작성자별로 아는 내용:
${knowledgeFor(st, names)}
최근 게시글(내용 반복 금지):
${recent}
형식: {"posts":[{"author":"이름","text":"본문","tags":["태그"]}]}`;
            const data = parseJSON(await ask(prompt));
            const arr = data && Array.isArray(data.posts) ? data.posts : null;
            if (!arr || !arr.length) throw new Error('AI 응답을 해석하지 못했어요. 다시 시도해 주세요.');
            for (const p of arr.slice(0, 5)) {
                if (!p || !p.author || !p.text || p.author === u) continue;
                advance(st, 7);
                addPost(st, String(p.author), p.text, p.tags);
            }
            saveState();
        });
    }

    async function aiReactions(postId) {
        await withBusy('반응 생성', async () => {
            const st = getState();
            const p = st.posts.find(x => x.id === postId);
            if (!p) return;
            const u = userName();
            const pool = charNames().filter(n => n !== p.author);
            const prompt = `${header()}
작업: 아래 SNS 게시글에 달릴 반응을 만든다.
현재 폰 시간: ${timeLine(st)}
게시글 작성자: ${p.author}
본문: ${p.text}
기존 댓글:
${p.comments.map(c => `${c.author}: ${c.text}`).join('\n') || '(없음)'}
댓글 작성자 후보: ${pool.join(', ') || '(없음)'} (필요하면 NPC 계정 가능)
규칙:
- ${u}(유저) 이름으로 댓글을 쓰지 마라.
- 글을 볼 수 있는 사람(작성자를 팔로우한 사람)만 반응한다. 작성자 본인은 자기 글에 달린 댓글에 답글을 달 수 있다.
- 댓글은 0~3개, 짧고 SNS답게.
형식: {"likes":0~30,"comments":[{"author":"이름","text":"댓글"}]}`;
            const data = parseJSON(await ask(prompt));
            if (!data) throw new Error('AI 응답을 해석하지 못했어요. 다시 시도해 주세요.');
            p.extraLikes += Math.max(0, Math.min(99, parseInt(data.likes, 10) || 0));
            for (const cm of (Array.isArray(data.comments) ? data.comments : []).slice(0, 4)) {
                if (!cm || !cm.author || !cm.text || cm.author === u) continue;
                advance(st, 2);
                registerAccount(st, String(cm.author));
                p.comments.push({ id: nid(st), author: String(cm.author), text: String(cm.text), time: st.clock });
            }
            saveState();
        });
    }

    /* ── 월드(날씨·뉴스) ── */

    async function aiWorld() {
        await withBusy('월드 새로고침', async () => {
            const st = getState();
            const w = st.world;
            const old = w.news.slice(0, 5).map(n => `- ${n.title}`).join('\n') || '(없음)';
            const prompt = `${header()}
작업: 이야기 세계의 오늘 날씨와 뉴스 헤드라인 3개를 만든다.
현재 폰 시간: ${timeLine(st)}
세계관·지역 설정: ${w.setting || '(메인 채팅과 캐릭터 카드의 세계관을 따른다)'}
규칙: 계절과 지역에 맞는 날씨. 뉴스는 세계관에 어울리고 이야기에 영향을 줄 만한 사건·소문·일상 소식을 섞는다. ${userName()}의 행동을 단정하지 마라.
최근 뉴스(반복 금지):
${old}
형식: {"weather":{"summary":"맑음","temp":"18°C","icon":"☀️"},"news":[{"title":"제목","body":"한두 문장 본문"}]}`;
            const data = parseJSON(await ask(prompt));
            if (!data || (!data.weather && !data.news)) throw new Error('AI 응답을 해석하지 못했어요. 다시 시도해 주세요.');
            if (data.weather && data.weather.summary) {
                w.weather = {
                    summary: String(data.weather.summary), temp: String(data.weather.temp || ''),
                    icon: String(data.weather.icon || '🌤️'), date: dkey(today(st)),
                };
            }
            for (const n of (Array.isArray(data.news) ? data.news : []).slice(0, 4).reverse()) {
                if (n && n.title) w.news.unshift({ id: nid(st), title: String(n.title), body: String(n.body || ''), time: st.clock });
            }
            w.news = w.news.slice(0, 12);
            saveState();
        });
    }

    /* ── 자동 모드 ── */

    function isGenerating() {
        const el = document.getElementById('mes_stop');
        return !!el && getComputedStyle(el).display !== 'none';
    }

    async function aiAuto(manual, tries = 0) {
        if (busy) { if (manual) toast('info', '생성 중이에요. 잠시만 기다려 주세요.'); return; }
        if (isGenerating() && tries < 5) { setTimeout(() => aiAuto(manual, tries + 1), 3000); return; }
        const st = getState();
        const names = charNames();
        if (!st || !names.length) { if (manual) toast('warning', '캐릭터 채팅을 먼저 열어 주세요.'); return; }
        busy = true;
        try {
            const u = userName();
            const list = st.posts.slice(0, 6).map(p => `- [id:${p.id}] ${p.author}: ${p.text}`).join('\n') || '(없음)';
            const prompt = `${header()}
작업: 시간이 흘러 캐릭터들이 폰으로 자발적으로 한 활동을 만든다. 억지로 만들지 말고, 지금 상황에 자연스러운 것만 쓴다. 활동이 없으면 빈 배열로 답해도 된다.
현재 폰 시간: ${timeLine(st)}
${contextBlock(st)}캐릭터: ${names.join(', ')}
가능한 활동:
- posts: 캐릭터가 SNS에 올리는 새 글 (0~2개)
- messages: 캐릭터가 ${u}에게 먼저 보내는 문자 (0~2개)
- comments: 아래 최근 게시글에 캐릭터가 다는 댓글 (0~2개)
규칙:
- ${u}(유저)의 글·문자·댓글은 절대 대신 쓰지 마라.
- 각 캐릭터는 자신이 직접 겪은 일, 자신이 주고받은 문자, 메인 채팅에서 겪은 일, 팔로우한 계정의 글만 안다. 모르는 정보는 언급하지 마라.
- 시간대·요일·날씨·일정에 맞는 활동만 한다. (예: 한밤중에 활발하게 외출하지 않는다)
- 댓글은 그 글을 볼 수 있는 캐릭터(작성자를 팔로우한 사람)만 쓴다.
캐릭터별로 아는 내용:
${knowledgeFor(st, names)}
최근 게시글:
${list}
형식: {"posts":[{"author":"이름","text":"본문","tags":["태그"]}],"messages":[{"from":"캐릭터","text":"문자 내용"}],"comments":[{"postId":번호,"author":"캐릭터","text":"댓글"}]}`;
            const data = parseJSON(await ask(prompt));
            if (!data || typeof data !== 'object') throw new Error('AI 응답을 해석하지 못했어요.');
            let np = 0, nm = 0, nc = 0;
            for (const p of (Array.isArray(data.posts) ? data.posts : []).slice(0, 2)) {
                if (!p || !p.author || !p.text || p.author === u) continue;
                advance(st, 3); addPost(st, String(p.author), p.text, p.tags); np++;
            }
            for (const m of (Array.isArray(data.messages) ? data.messages : []).slice(0, 2)) {
                if (!m || !m.text || !names.includes(m.from)) continue;
                advance(st, 2); addMsg(st, m.from, m.from, String(m.text)); nm++;
            }
            for (const c of (Array.isArray(data.comments) ? data.comments : []).slice(0, 2)) {
                const post = c && st.posts.find(x => x.id === +c.postId);
                if (!post || !c.text || !c.author || c.author === u || !postVisibleTo(st, post, c.author)) continue;
                advance(st, 2);
                registerAccount(st, String(c.author));
                post.comments.push({ id: nid(st), author: String(c.author), text: String(c.text), time: st.clock }); nc++;
            }
            saveState();
            if (np + nm + nc) toast('info', `📱 새 활동: 글 ${np}, 문자 ${nm}, 댓글 ${nc}`);
            else if (manual) toast('info', '이번에는 새 활동이 없었어요.');
        } catch (e) {
            console.error('[ST Phone] 자동 모드', e);
            if (manual) toast('error', `자동 활동 실패: ${e.message || e}`);
        } finally {
            busy = false;
            render();
        }
    }

    function onCharMessage() {
        const s = getSettings();
        if (!s.enabled || !s.autoMode) return;
        const st = getState();
        if (!st) return;
        if (s.autoClock > 0) advance(st, s.autoClock);
        st.autoCount = (st.autoCount || 0) + 1;
        const fire = st.autoCount >= Math.max(1, s.autoEvery);
        if (fire) st.autoCount = 0;
        saveState();
        render();
        if (fire) setTimeout(() => aiAuto(false), 2000);
    }

    /* ───────────── UI ───────────── */

    let view = 'home';      // home | characters | char | msgs | chat | feed | luna | preg | calendar | world | charreg | settings
    let curPartner = null;
    let curChar = null;
    let lunaWho = null;
    let pregWho = null;
    let calYM = null;
    let calSel = null;
    let phoneOpen = false;
    let feedFilter = 'all';
    const openComments = new Set();
    let bubbleEl, phoneEl;

    const PARENT = { chat: 'msgs', char: 'characters' };

    const ICONS = {
        characters: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
        msgs: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
        feed: '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r=".8"/>',
        luna: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
        preg: '<path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7Z"/>',
        calendar: '<rect x="3" y="4" width="18" height="18" rx="3"/><path d="M16 2v4M8 2v4M3 10h18"/>',
        world: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
        charreg: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>',
        settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
        home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
        back: '<path d="M15 18l-6-6 6-6"/>',
        x: '<path d="M18 6L6 18M6 6l12 12"/>',
        plus: '<path d="M12 5v14M5 12h14"/>',
    };
    const icon = n => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n] || ''}</svg>`;

    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    function hue(name) { let h = 0; for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; }
    const avatar = name => `<span class="stp-av" style="background:hsl(${hue(name)} 42% 36%)">${esc(String(name).trim().charAt(0).toUpperCase())}</span>`;
    const fmtMD = d => `${d.getMonth() + 1}/${d.getDate()}(${DAY_KO[d.getDay()]})`;
    const dLabel = n => n > 0 ? `D-${n}` : n === 0 ? 'D-day' : `D+${-n}`;
    const totalUnread = st => Object.values(st.unread).reduce((a, b) => a + b, 0);

    function inkFor(hex) {
        const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
        if (!m) return '#0c2627';
        const n = parseInt(m[1], 16);
        const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
        return lum > 0.55 ? '#0c2627' : '#ffffff';
    }

    function applyTheme(s) {
        const t = THEMES[s.theme] || THEMES.teal;
        const set = (el, k, v) => el.style.setProperty(k, v);
        set(phoneEl, '--stp-bg1', t.a);
        set(phoneEl, '--stp-bg2', t.b);
        set(phoneEl, '--stp-accent', s.accent);
        set(phoneEl, '--stp-ink', inkFor(s.accent));
        set(bubbleEl, '--stp-accent', s.accent);
        set(bubbleEl, '--stp-ink', inkFor(s.accent));
        phoneEl.style.fontSize = s.fontScale === 'large' ? '17px' : '15px';
    }

    function render() {
        if (!phoneEl) return;
        const s = getSettings();
        bubbleEl.style.display = s.enabled ? '' : 'none';
        applyTheme(s);
        const st = getState();
        const unread = st ? totalUnread(st) : 0;
        bubbleEl.querySelector('.stp-badge').textContent = unread ? String(unread) : '';
        if (!phoneOpen) return;

        // 입력값/스크롤 보존
        const keep = {};
        phoneEl.querySelectorAll('[data-keep]').forEach(el => { keep[el.dataset.keep] = el.value; });
        const oldContent = phoneEl.querySelector('.stp-content');
        const oldScroll = oldContent ? oldContent.scrollTop : 0;
        const wasView = phoneEl.dataset.view;

        phoneEl.innerHTML = st ? shell(st)
            : `<div class="stp-top"><span class="stp-pill"></span><button class="stp-x" data-act="close" aria-label="닫기">${icon('x')}</button></div><div class="stp-screen"><div class="stp-empty">캐릭터 채팅을 먼저 열어 주세요.</div></div>`;
        phoneEl.dataset.view = view;

        phoneEl.querySelectorAll('[data-keep]').forEach(el => { if (keep[el.dataset.keep] != null) el.value = keep[el.dataset.keep]; });
        const content = phoneEl.querySelector('.stp-content');
        if (content) content.scrollTop = (view === 'chat') ? content.scrollHeight : (wasView === view ? oldScroll : 0);
    }

    function shell(st) {
        return `<div class="stp-top"><span class="stp-pill"></span><span class="stp-tag">${esc(daypart(st.clock))}</span><button class="stp-x" data-act="close" aria-label="닫기">${icon('x')}</button></div>
<div class="stp-screen">${screen(st)}</div>
<nav class="stp-nav">
  <button data-act="back" ${view === 'home' ? 'disabled' : ''}>${icon('back')}<span>뒤로</span></button>
  <button data-act="home" class="${view === 'home' ? 'stp-cur' : ''}">${icon('home')}<span>홈</span></button>
</nav>`;
    }

    const head = (title, tools = '') => `<div class="stp-head"><h3>${esc(title)}</h3>${tools}</div>`;

    function screen(st) {
        switch (view) {
            case 'characters': return viewCharacters(st);
            case 'char': return viewChar(st);
            case 'msgs': return viewMsgs(st);
            case 'chat': return viewChat(st);
            case 'feed': return viewFeed(st);
            case 'luna': return viewLuna(st);
            case 'preg': return viewPreg(st);
            case 'calendar': return viewCalendar(st);
            case 'world': return viewWorld(st);
            case 'charreg': return viewCharReg(st);
            case 'settings': return viewSettings(st);
            default: return viewHome(st);
        }
    }

    /* ── 홈 ── */

    function viewHome(st) {
        const d = parseClock(st.clock) || new Date();
        const u = totalUnread(st);
        const app = (key, label, badge) =>
            `<button class="stp-app" data-act="open" data-app="${key}"><i>${icon(key)}</i><span>${label}</span>${badge ? `<b class="stp-badge">${badge}</b>` : ''}</button>`;
        return `<div class="stp-content stp-homewrap">
  <div class="stp-clock"><b>${pad(d.getHours())}:${pad(d.getMinutes())}</b>
    <span>${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} (${DAY_KO[d.getDay()]})</span>
    ${st.world.weather ? `<em>${esc(st.world.weather.icon)} ${esc(st.world.weather.summary)} ${esc(st.world.weather.temp)}</em>` : ''}</div>
  <div class="stp-grid">
    ${app('characters', '캐릭터')}${app('msgs', '메시지', u || '')}${app('feed', 'SNS')}
    ${app('luna', 'Luna')}${app('preg', '임신')}${app('calendar', '캘린더')}
    ${app('world', '월드')}${app('charreg', '계정 등록')}${app('settings', '설정')}
  </div>
</div>`;
    }

    /* ── 캐릭터 ── */

    function viewCharacters(st) {
        const u = userName();
        const rows = accounts(st).map(n => {
            const p = st.profiles[n] || {};
            return `<button class="stp-row" data-act="open-char" data-name="${esc(n)}">${avatar(n)}
  <div class="stp-meta"><b>${esc(n)}${n === u ? ' (나)' : ''}</b><span>${esc(p.bio || '소개를 추가해 보세요')}</span></div><i class="stp-chev">›</i></button>`;
        }).join('');
        return `${head('캐릭터')}<div class="stp-content">${rows}</div>`;
    }

    function viewChar(st) {
        const u = userName();
        const n = curChar;
        if (!n) return viewCharacters(st);
        const p = st.profiles[n] || {};
        const isMe = n === u;
        const isChar = charNames().includes(n);
        const fol = isMe ? '' : `<div class="stp-card"><h4>팔로우</h4>
  <div class="stp-line"><label for="stp-f1">내가 팔로우</label><input id="stp-f1" type="checkbox" data-act="follow" data-a="${esc(u)}" data-b="${esc(n)}" ${follows(st, u, n) ? 'checked' : ''}></div>
  <div class="stp-line"><label for="stp-f2">${esc(n)}이(가) 나를 팔로우</label><input id="stp-f2" type="checkbox" data-act="follow" data-a="${esc(n)}" data-b="${esc(u)}" ${follows(st, n, u) ? 'checked' : ''}></div>
  <p class="stp-hint">캐릭터는 자신이 팔로우한 계정의 글만 알 수 있어요.</p></div>`;
        return `${head(n)}<div class="stp-content">
  <div class="stp-card stp-prof">${avatar(n)}<div><b>${esc(n)}${isMe ? ' (나)' : ''}</b><span>${isChar ? '메인 캐릭터' : isMe ? '유저' : 'NPC 계정'}</span></div></div>
  <div class="stp-card"><h4>프로필</h4>
    <label class="stp-lab" for="stp-bio">한줄 소개</label><textarea id="stp-bio" rows="2" data-prof="bio" placeholder="예: 새벽에 글을 많이 올리는 사람">${esc(p.bio || '')}</textarea>
    <label class="stp-lab" for="stp-bd">생일 (월-일)</label><input id="stp-bd" data-prof="birthday" value="${esc(p.birthday || '')}" placeholder="예: 03-14" maxlength="5">
    <label class="stp-lab" for="stp-note">메모</label><textarea id="stp-note" rows="3" data-prof="note" placeholder="나만 보는 메모">${esc(p.note || '')}</textarea>
  </div>
  ${fol}
  <div class="stp-btnrow">
    ${isMe ? '' : `<button class="stp-btn stp-main" data-act="open-chat" data-name="${esc(n)}">문자 보내기</button>`}
    ${(!isMe && !isChar) ? `<button class="stp-btn stp-danger" data-act="del-account" data-name="${esc(n)}">계정 삭제</button>` : ''}
  </div>
</div>`;
    }

    /* ── 메시지 ── */

    function viewMsgs(st) {
        const names = [...new Set([...charNames(), ...Object.keys(st.threads)])];
        const rows = names.map(n => {
            const t = st.threads[n] || [];
            const last = t[t.length - 1];
            const un = st.unread[n] || 0;
            return `<button class="stp-row" data-act="open-chat" data-name="${esc(n)}">${avatar(n)}
  <div class="stp-meta"><b>${esc(n)}${un ? `<span class="stp-unread">${un}</span>` : ''}</b><span>${last ? esc(last.text) : '대화를 시작해 보세요'}</span></div>
  <span class="stp-t">${last ? esc(shortTime(last.time)) : ''}</span></button>`;
        }).join('');
        return `${head('메시지', '<button class="stp-tool" data-act="new-chat">+ 새 대화</button>')}
<div class="stp-content">${rows || '<div class="stp-empty">대화 상대가 없어요.</div>'}</div>`;
    }

    function viewChat(st) {
        const u = userName();
        const msgs = (st.threads[curPartner] || []).map(m =>
            `<div class="stp-msg ${m.from === u ? 'stp-me' : ''}">${esc(m.text)}<small>${esc(shortTime(m.time))}</small></div>`).join('');
        const dots = typing === curPartner ? '<div class="stp-typing"><span></span><span></span><span></span></div>' : '';
        return `${head(curPartner)}
<div class="stp-content"><div class="stp-chat">${msgs || '<div class="stp-empty">첫 메시지를 보내 보세요.</div>'}${dots}</div></div>
<div class="stp-chips">
  <button class="stp-chip" data-act="ai-first">먼저 연락 오게</button>
  <button class="stp-chip" data-act="ai-reply">답장 받기</button>
</div>
<div class="stp-compose">
  <textarea id="stp-chat-input" data-keep="chat" data-enter="send-msg" rows="1" placeholder="메시지 입력" aria-label="메시지 입력"></textarea>
  <button class="stp-send" data-act="send-msg">전송</button>
</div>`;
    }

    /* ── SNS ── */

    function viewFeed(st) {
        const u = userName();
        let posts = st.posts;
        if (feedFilter === 'following') posts = posts.filter(p => p.author === u || follows(st, u, p.author));
        const chip = (f, label) => `<button class="stp-chip ${feedFilter === f ? 'stp-on' : ''}" data-act="feed-filter" data-f="${f}">${label}</button>`;
        const list = posts.map(p => {
            const likeCount = p.likes.length + p.extraLikes;
            const liked = p.likes.includes(u);
            const open = openComments.has(p.id);
            const cms = open ? `<div class="stp-comments">${p.comments.map(c =>
                `<div class="stp-comment"><b>${esc(c.author)}</b> ${esc(c.text)}<span>${esc(shortTime(c.time))}</span></div>`).join('') || '<div class="stp-hint">아직 댓글이 없어요.</div>'}
  <div class="stp-cform"><input data-keep="c${p.id}" data-enter="comment-submit" data-id="${p.id}" placeholder="댓글 달기" aria-label="댓글 입력"><button class="stp-btn" data-act="comment-submit" data-id="${p.id}">등록</button></div>
  <div class="stp-acts"><button data-act="react" data-id="${p.id}">✨ AI 반응 받기</button></div></div>` : '';
            return `<div class="stp-post">${avatar(p.author)}<div class="stp-body">
  <div class="stp-who"><b>${esc(p.author)}</b><span>${esc(shortTime(p.time))}</span></div>
  <p>${esc(p.text)}</p>
  ${p.tags.length ? `<div class="stp-tags">${p.tags.map(t => '#' + esc(t)).join(' ')}</div>` : ''}
  <div class="stp-acts">
    <button class="${liked ? 'stp-on' : ''}" data-act="like" data-id="${p.id}">${liked ? '♥' : '♡'} ${likeCount}</button>
    <button data-act="toggle-comments" data-id="${p.id}">💬 ${p.comments.length}</button>
    ${p.author === u ? `<button data-act="del-post" data-id="${p.id}">삭제</button>` : ''}
  </div>${cms}</div></div>`;
        }).join('');
        return `${head('SNS', '<button class="stp-tool" data-act="feed-refresh">새로고침</button>')}
<div class="stp-content">
  <div class="stp-feedbox">
    <textarea data-keep="post" rows="2" placeholder="지금 무슨 생각을 하고 있나요?" aria-label="글 쓰기"></textarea>
    <div class="stp-spread"><div class="stp-switch">${chip('all', '전체')}${chip('following', '팔로잉')}</div><button class="stp-send" data-act="post-submit">게시</button></div>
  </div>
  ${list || '<div class="stp-empty">게시글이 없어요. 새로고침으로 캐릭터들의 글을 불러오세요.</div>'}
</div>`;
    }

    /* ── Luna(생리 주기) ── */

    const whoSelect = (st, sel, key) =>
        `<select class="stp-select" data-sel="${key}" aria-label="계정 선택">${accounts(st).map(n => `<option ${n === sel ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`;

    function viewLuna(st) {
        if (!lunaWho || !accounts(st).includes(lunaWho)) lunaWho = userName();
        const who = lunaWho;
        const c = st.cycle[who];
        const info = cycleInfo(st, who);
        let body;
        if (!c || !c.on) {
            body = `<div class="stp-card"><h4>${esc(who)}의 주기 추적</h4>
  <p class="stp-hint">추적을 켜면 폰 날짜에 맞춰 주기가 계산돼요. 추적을 켜지 않은 계정의 정보는 메인 채팅에 전달되지 않아요.</p>
  <button class="stp-btn stp-main" data-act="luna-on">추적 시작</button></div>`;
        } else {
            let status;
            if (info && info.paused) status = '<p class="stp-big">임신 중</p><p class="stp-hint">임신 중에는 주기 예측을 쉬어요.</p>';
            else if (info && info.empty) status = '<p class="stp-big">기록 없음</p><p class="stp-hint">생리 시작일을 기록하면 예측이 시작돼요.</p>';
            else status = `<p class="stp-big">${esc(info.phase)}</p>
  <div class="stp-kv"><span>주기</span><b>${info.day}일차</b></div>
  <div class="stp-kv"><span>다음 생리 예정</span><b>${fmtMD(info.next)} · ${dLabel(info.daysToNext)}</b></div>
  <div class="stp-kv"><span>배란 예정</span><b>${fmtMD(info.ovDate)}</b></div>`;
            const starts = [...(c.starts || [])].sort().reverse().slice(0, 6)
                .map(d => `<div class="stp-line"><span>${esc(d)}</span><button class="stp-btn" data-act="luna-del" data-date="${esc(d)}">삭제</button></div>`).join('');
            body = `<div class="stp-card">${status}</div>
<div class="stp-card"><h4>기록</h4>
  <div class="stp-btnrow"><button class="stp-btn stp-main" data-act="luna-start-today">오늘 생리 시작</button></div>
  <div class="stp-cform"><input type="date" data-keep="luna-date" aria-label="생리 시작일"><button class="stp-btn" data-act="luna-add">날짜 추가</button></div>
  ${starts || '<p class="stp-hint">아직 기록이 없어요.</p>'}
</div>
<div class="stp-card"><h4>설정</h4>
  <div class="stp-line"><label for="stp-len">주기 길이(일)</label><input id="stp-len" type="number" min="20" max="45" data-cyc="len" data-who="${esc(who)}" value="${c.len}"></div>
  <div class="stp-line"><label for="stp-plen">생리 기간(일)</label><input id="stp-plen" type="number" min="2" max="10" data-cyc="plen" data-who="${esc(who)}" value="${c.plen}"></div>
  <div class="stp-line"><label for="stp-cshare">모든 캐릭터에게 공유</label><input id="stp-cshare" type="checkbox" data-cyc="shared" data-who="${esc(who)}" ${c.shared ? 'checked' : ''}></div>
  <p class="stp-hint">공유를 끄면 ${esc(who)} 본인만 이 상태를 알아요.</p>
  <button class="stp-btn stp-danger" data-act="luna-off">추적 끄기</button>
</div>`;
        }
        return `${head('Luna', whoSelect(st, who, 'luna'))}<div class="stp-content">${body}</div>`;
    }

    /* ── 임신 ── */

    function viewPreg(st) {
        if (!pregWho || !accounts(st).includes(pregWho)) pregWho = userName();
        const who = pregWho;
        const p = st.preg[who];
        const pi = pregInfo(st, who);
        let body;
        if (!pi) {
            body = `<div class="stp-card"><h4>${esc(who)}의 임신 기록</h4>
  ${p && p.ended ? `<p class="stp-hint">지난 기록: ${esc(p.ended)} 종료</p>` : ''}
  <p class="stp-hint">시작하면 폰 날짜에 맞춰 주차와 출산 예정일이 계산돼요.</p>
  <label class="stp-lab" for="stp-lmp">마지막 생리 시작일</label>
  <div class="stp-cform"><input id="stp-lmp" type="date" data-keep="preg-lmp"><button class="stp-btn stp-main" data-act="preg-start">시작</button></div>
  <label class="stp-lab" for="stp-pw">또는 현재 주차로 시작</label>
  <div class="stp-cform"><input id="stp-pw" type="number" min="4" max="42" placeholder="예: 8" data-keep="preg-weeks"><button class="stp-btn" data-act="preg-start-weeks">주차로 시작</button></div>
</div>`;
        } else {
            const size = pi.weeks >= 4 ? sizeFor(pi.weeks) : '';
            const notes = (p.notes || []).slice().reverse().map(n =>
                `<div class="stp-line"><span><small>${esc(n.date)}</small><br>${esc(n.text)}</span><button class="stp-btn" data-act="preg-note-del" data-id="${n.id}">삭제</button></div>`).join('');
            body = `<div class="stp-card">
  <p class="stp-big">${pi.weeks}주 ${pi.days}일</p>
  <div class="stp-bar" role="progressbar" aria-valuenow="${pi.pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pi.pct}%"></i></div>
  <div class="stp-kv"><span>시기</span><b>${pi.tri}기 (${pi.pct}%)</b></div>
  <div class="stp-kv"><span>출산 예정일</span><b>${fmtMD(pi.due)} · ${dLabel(pi.left)}</b></div>
  ${size ? `<div class="stp-kv"><span>크기 비유(대략)</span><b>${esc(size)}</b></div>` : ''}
</div>
<div class="stp-card"><h4>메모</h4>
  <div class="stp-cform"><input data-keep="preg-note" data-enter="preg-note-add" placeholder="검진, 증상, 기념일 등" aria-label="메모 입력"><button class="stp-btn" data-act="preg-note-add">추가</button></div>
  ${notes || '<p class="stp-hint">아직 메모가 없어요.</p>'}
</div>
<div class="stp-card"><h4>설정</h4>
  <div class="stp-line"><label for="stp-pshare">모든 캐릭터에게 공유</label><input id="stp-pshare" type="checkbox" data-pshare data-who="${esc(who)}" ${p.shared ? 'checked' : ''}></div>
  <p class="stp-hint">공유를 끄면 ${esc(who)} 본인만 이 상태를 알아요.</p>
  <button class="stp-btn stp-danger" data-act="preg-end">기록 종료</button>
</div>`;
        }
        return `${head('임신', whoSelect(st, who, 'preg'))}<div class="stp-content">${body}</div>`;
    }

    /* ── 캘린더 ── */

    function viewCalendar(st) {
        const t = today(st);
        if (!calYM) calYM = { y: t.getFullYear(), m: t.getMonth() };
        if (!calSel) calSel = dkey(t);
        const first = new Date(calYM.y, calYM.m, 1);
        const dim = new Date(calYM.y, calYM.m + 1, 0).getDate();
        let cells = DAY_KO.map(d => `<span class="stp-dow">${d}</span>`).join('');
        for (let i = 0; i < first.getDay(); i++) cells += '<span></span>';
        for (let d = 1; d <= dim; d++) {
            const key = `${calYM.y}-${pad(calYM.m + 1)}-${pad(d)}`;
            const kinds = [...new Set(markersFor(st, key).map(m => m.kind))];
            cells += `<button class="stp-day ${key === dkey(t) ? 'stp-today' : ''} ${key === calSel ? 'stp-sel' : ''}" data-act="cal-pick" data-date="${key}" aria-label="${calYM.m + 1}월 ${d}일">${d}<span class="stp-dots">${kinds.map(k => `<i class="stp-d-${k}"></i>`).join('')}</span></button>`;
        }
        const sel = parseKey(calSel) || t;
        const items = markersFor(st, calSel).map(m =>
            `<div class="stp-line"><span><i class="stp-dot stp-d-${m.kind}"></i> ${esc(m.label)}</span>${m.kind === 'event' ? `<button class="stp-btn" data-act="ev-del" data-id="${m.id}">삭제</button>` : ''}</div>`).join('');
        return `${head('캘린더', '<button class="stp-tool" data-act="cal-today">오늘</button>')}
<div class="stp-content">
  <div class="stp-calnav"><button class="stp-btn" data-act="cal-prev" aria-label="이전 달">‹</button><b>${calYM.y}년 ${calYM.m + 1}월</b><button class="stp-btn" data-act="cal-next" aria-label="다음 달">›</button></div>
  <div class="stp-cal">${cells}</div>
  <div class="stp-legend"><span><i class="stp-dot stp-d-event"></i>일정</span><span><i class="stp-dot stp-d-birth"></i>생일</span><span><i class="stp-dot stp-d-period"></i>생리</span><span><i class="stp-dot stp-d-due"></i>출산</span></div>
  <div class="stp-card"><h4>${sel.getMonth() + 1}월 ${sel.getDate()}일 (${DAY_KO[sel.getDay()]})</h4>
    ${items || '<p class="stp-hint">이 날의 일정이 없어요.</p>'}
    <div class="stp-cform"><input data-keep="ev-title" data-enter="ev-add" placeholder="일정 추가" aria-label="일정 제목"><button class="stp-btn stp-main" data-act="ev-add">추가</button></div>
  </div>
</div>`;
    }

    /* ── 월드 ── */

    function viewWorld(st) {
        const w = st.world;
        const weather = w.weather
            ? `<div class="stp-card stp-weather"><span class="stp-wi">${esc(w.weather.icon)}</span><div><b>${esc(w.weather.summary)}</b><span>${esc(w.weather.temp)}</span><small>${esc(w.weather.date || '')}</small></div></div>`
            : '<div class="stp-card"><p class="stp-hint">아직 날씨 정보가 없어요. 새로고침을 눌러 보세요.</p></div>';
        const news = w.news.map(n => `<div class="stp-card"><b>${esc(n.title)}</b><p>${esc(n.body)}</p><small class="stp-hint">${esc(shortTime(n.time))}</small></div>`).join('');
        return `${head('월드', '<button class="stp-tool" data-act="world-refresh">새로고침</button>')}
<div class="stp-content">
  ${weather}
  <div class="stp-card"><h4>세계관·지역 설정</h4>
    <textarea rows="2" data-world="setting" placeholder="예: 근미래 서울, 겨울. 비워 두면 캐릭터 카드를 따라가요." aria-label="세계관 설정">${esc(w.setting || '')}</textarea>
    <p class="stp-hint">날씨와 뉴스를 만들 때 참고해요.</p></div>
  <h4 class="stp-sub">뉴스</h4>
  ${news || '<div class="stp-empty">뉴스가 없어요.</div>'}
</div>`;
    }

    /* ── 계정 등록 ── */

    function viewCharReg(st) {
        const npcs = st.known.filter(n => !charNames().includes(n));
        const list = npcs.map(n => `<div class="stp-line"><span>${esc(n)}</span><button class="stp-btn stp-danger" data-act="del-account" data-name="${esc(n)}">삭제</button></div>`).join('');
        return `${head('계정 등록')}<div class="stp-content">
  <div class="stp-card"><h4>새 계정</h4>
    <label class="stp-lab" for="stp-rn">이름</label><input id="stp-rn" data-keep="reg-name" data-enter="reg-add" placeholder="계정 이름">
    <label class="stp-lab" for="stp-rb">한줄 소개</label><input id="stp-rb" data-keep="reg-bio" data-enter="reg-add" placeholder="선택">
    <label class="stp-lab" for="stp-rd">생일 (월-일)</label><input id="stp-rd" data-keep="reg-bd" data-enter="reg-add" placeholder="예: 03-14" maxlength="5">
    <p class="stp-hint">등록한 계정은 서로 팔로우한 상태로 시작해요. 메인 캐릭터는 자동으로 등록돼요.</p>
    <button class="stp-btn stp-main" data-act="reg-add">등록</button>
  </div>
  <div class="stp-card"><h4>등록한 NPC 계정</h4>${list || '<p class="stp-hint">아직 없어요.</p>'}</div>
</div>`;
    }

    /* ── 설정 ── */

    function viewSettings(st) {
        const s = getSettings();
        const chk = (k, label) => `<div class="stp-line"><label for="stp-${k}">${label}</label><input id="stp-${k}" type="checkbox" data-set="${k}" ${s[k] ? 'checked' : ''}></div>`;
        const opts = (list, cur) => list.map(([v, l]) => `<option value="${esc(v)}" ${cur === v ? 'selected' : ''}>${esc(l)}</option>`).join('');
        return `${head('설정')}<div class="stp-content">
  <div class="stp-card"><h4>폰 시간</h4>
    <input data-clock value="${esc(st.clock)}" placeholder="YYYY-MM-DD HH:mm" aria-label="폰 시간">
    <div class="stp-btnrow">
      <button class="stp-btn" data-act="clock-adv" data-min="30">+30분</button>
      <button class="stp-btn" data-act="clock-adv" data-min="60">+1시간</button>
      <button class="stp-btn" data-act="clock-adv" data-min="480">+8시간</button>
      <button class="stp-btn" data-act="clock-adv" data-min="1440">+1일</button>
      <button class="stp-btn" data-act="clock-now">현재 시각</button>
    </div>
    <p class="stp-hint">문자·게시글·캘린더·트래커가 모두 이 시계를 따라가요.</p>
  </div>
  <div class="stp-card"><h4>자동 모드</h4>
    ${chk('autoMode', '캐릭터가 알아서 폰 활동')}
    <div class="stp-line"><label for="stp-autoEvery">캐릭터 메시지 N개마다 실행</label><input id="stp-autoEvery" type="number" min="1" max="50" data-set="autoEvery" value="${esc(s.autoEvery)}"></div>
    <div class="stp-line"><label for="stp-autoClock">메시지 1개당 폰 시간(분)</label><input id="stp-autoClock" type="number" min="0" max="1440" data-set="autoClock" value="${esc(s.autoClock)}"></div>
    <div class="stp-btnrow"><button class="stp-btn" data-act="auto-now">지금 한 번 실행</button></div>
    <p class="stp-hint">켜 두면 메인 채팅이 진행될 때 캐릭터가 글을 올리고, 먼저 문자를 보내고, 댓글을 달아요. 실행할 때마다 AI 호출이 1번 들어가요.</p>
  </div>
  <div class="stp-card"><h4>메인 채팅 연동</h4>
    ${chk('inject', '폰 활동을 메인 채팅에 반영')}
    <div class="stp-line"><label for="stp-injectCount">반영할 최근 활동 수</label><input id="stp-injectCount" type="number" min="1" max="30" data-set="injectCount" value="${esc(s.injectCount)}"></div>
    ${chk('injectCalendar', '오늘·내일 일정 반영')}
    ${chk('injectTracker', '주기·임신 상태 반영')}
    ${chk('injectWorld', '날씨·뉴스 반영')}
    ${chk('autoReply', '문자 보내면 자동 답장')}
    ${chk('autoReact', '글 올리면 자동 반응')}
  </div>
  <div class="stp-card"><h4>화면</h4>
    <div class="stp-line"><label for="stp-theme">테마</label><select id="stp-theme" data-set="theme">${opts(Object.entries(THEMES).map(([k, v]) => [k, v.label]), s.theme)}</select></div>
    <div class="stp-line"><label for="stp-accent">포인트 색</label><input id="stp-accent" type="color" data-set="accent" value="${esc(s.accent)}"></div>
    <div class="stp-line"><label for="stp-fontScale">글자 크기</label><select id="stp-fontScale" data-set="fontScale">${opts([['normal', '보통'], ['large', '크게']], s.fontScale)}</select></div>
    <div class="stp-line"><label for="stp-lang">생성 언어</label><select id="stp-lang" data-set="lang">${opts([['한국어', '한국어'], ['English', 'English'], ['日本語', '日本語']], s.lang)}</select></div>
  </div>
  <div class="stp-card"><h4>데이터</h4>
    <p class="stp-hint">폰 데이터는 채팅마다 따로 저장돼요.</p>
    <div class="stp-btnrow"><button class="stp-btn stp-danger" data-act="reset-all">이 채팅의 폰 초기화</button></div>
  </div>
</div>`;
    }

    /* ───────────── 이벤트 ───────────── */

    const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

    function take(sel) {
        const i = phoneEl.querySelector(sel);
        if (!i) return '';
        const v = i.value.trim();
        i.value = '';
        return v;
    }

    function removeAccount(st, name) {
        st.known = st.known.filter(n => n !== name);
        delete st.follows[name];
        for (const k of Object.keys(st.follows)) st.follows[k] = st.follows[k].filter(n => n !== name);
        delete st.profiles[name]; delete st.cycle[name]; delete st.preg[name];
        delete st.threads[name]; delete st.unread[name];
    }

    async function onAct(act, el) {
        if (act === 'close') { phoneOpen = false; phoneEl.classList.add('stp-hidden'); return; }
        const st = getState();
        if (!st) return;
        const u = userName();
        const ds = el.dataset || {};
        switch (act) {
            case 'home': view = 'home'; break;
            case 'back': view = PARENT[view] || 'home'; break;
            case 'open': view = ds.app; break;
            case 'open-char': curChar = ds.name; view = 'char'; break;
            case 'open-chat':
                curPartner = ds.name; view = 'chat'; st.unread[curPartner] = 0; saveState(); break;
            case 'new-chat': {
                const name = (window.prompt('문자를 보낼 상대 이름') || '').trim();
                if (!name || name === u) return;
                registerAccount(st, name);
                st.threads[name] = st.threads[name] || [];
                curPartner = name; view = 'chat'; saveState(); break;
            }
            case 'send-msg': {
                const text = take('#stp-chat-input');
                if (!text) return;
                advance(st, 1);
                addMsg(st, curPartner, u, text);
                saveState(); render();
                if (getSettings().autoReply) await aiSend(curPartner, 'reply');
                return;
            }
            case 'ai-first': await aiSend(curPartner, 'first'); return;
            case 'ai-reply': await aiSend(curPartner, 'reply'); return;

            case 'feed-refresh': await aiPosts(); return;
            case 'feed-filter': feedFilter = ds.f; break;
            case 'post-submit': {
                const text = take('[data-keep="post"]');
                if (!text) return;
                advance(st, 1);
                const p = addPost(st, u, text, []);
                saveState(); render();
                if (getSettings().autoReact) await aiReactions(p.id);
                return;
            }
            case 'like': {
                const p = st.posts.find(x => x.id === +ds.id);
                if (!p) return;
                const i = p.likes.indexOf(u);
                if (i >= 0) p.likes.splice(i, 1); else p.likes.push(u);
                saveState(); break;
            }
            case 'toggle-comments': {
                const id = +ds.id;
                if (openComments.has(id)) openComments.delete(id); else openComments.add(id);
                break;
            }
            case 'comment-submit': {
                const id = +ds.id;
                const text = take(`[data-keep="c${id}"]`);
                const p = st.posts.find(x => x.id === id);
                if (!text || !p) return;
                advance(st, 1);
                p.comments.push({ id: nid(st), author: u, text, time: st.clock });
                saveState(); break;
            }
            case 'react': await aiReactions(+ds.id); return;
            case 'del-post': st.posts = st.posts.filter(x => x.id !== +ds.id); saveState(); break;
            case 'follow': {
                const { a, b } = ds;
                st.follows[a] = st.follows[a] || [];
                if (el.checked) addTo(st.follows[a], b); else st.follows[a] = st.follows[a].filter(x => x !== b);
                saveState(); return;
            }

            case 'luna-on': ensureCycle(st, lunaWho).on = true; saveState(); break;
            case 'luna-off': ensureCycle(st, lunaWho).on = false; saveState(); break;
            case 'luna-start-today': addTo(ensureCycle(st, lunaWho).starts, dkey(today(st))); saveState(); break;
            case 'luna-add': {
                const v = take('[data-keep="luna-date"]');
                if (!parseKey(v)) { toast('warning', '날짜를 선택해 주세요.'); return; }
                addTo(ensureCycle(st, lunaWho).starts, v); saveState(); break;
            }
            case 'luna-del': {
                const c = ensureCycle(st, lunaWho);
                c.starts = c.starts.filter(d => d !== ds.date); saveState(); break;
            }

            case 'preg-start': {
                const v = take('[data-keep="preg-lmp"]');
                if (!parseKey(v)) { toast('warning', '마지막 생리 시작일을 선택해 주세요.'); return; }
                const p = ensurePreg(st, pregWho); p.on = true; p.lmp = v; p.ended = null; saveState(); break;
            }
            case 'preg-start-weeks': {
                const w = parseInt(take('[data-keep="preg-weeks"]'), 10);
                if (Number.isNaN(w) || w < 4 || w > 42) { toast('warning', '주차는 4~42 사이로 입력해 주세요.'); return; }
                const p = ensurePreg(st, pregWho); p.on = true; p.lmp = dkey(addDays(today(st), -w * 7)); p.ended = null; saveState(); break;
            }
            case 'preg-end': {
                if (!window.confirm('임신 기록을 종료할까요?')) return;
                const p = ensurePreg(st, pregWho); p.on = false; p.ended = dkey(today(st)); saveState(); break;
            }
            case 'preg-note-add': {
                const text = take('[data-keep="preg-note"]');
                if (!text) return;
                ensurePreg(st, pregWho).notes.push({ id: nid(st), date: dkey(today(st)), text }); saveState(); break;
            }
            case 'preg-note-del': {
                const p = ensurePreg(st, pregWho);
                p.notes = p.notes.filter(n => n.id !== +ds.id); saveState(); break;
            }

            case 'cal-prev': calYM = calYM.m === 0 ? { y: calYM.y - 1, m: 11 } : { y: calYM.y, m: calYM.m - 1 }; break;
            case 'cal-next': calYM = calYM.m === 11 ? { y: calYM.y + 1, m: 0 } : { y: calYM.y, m: calYM.m + 1 }; break;
            case 'cal-today': calYM = null; calSel = null; break;
            case 'cal-pick': calSel = ds.date; break;
            case 'ev-add': {
                const title = take('[data-keep="ev-title"]');
                if (!title) return;
                st.events.push({ id: nid(st), date: calSel || dkey(today(st)), title }); saveState(); break;
            }
            case 'ev-del': st.events = st.events.filter(e => e.id !== +ds.id); saveState(); break;

            case 'world-refresh': await aiWorld(); return;

            case 'reg-add': {
                const name = take('[data-keep="reg-name"]');
                const bio = take('[data-keep="reg-bio"]');
                let bd = take('[data-keep="reg-bd"]');
                if (!name) { toast('warning', '계정 이름을 입력해 주세요.'); return; }
                if (name === u || st.known.includes(name)) { toast('warning', '이미 있는 이름이에요.'); return; }
                registerAccount(st, name);
                addTo(st.follows[name], u); addTo(st.follows[u], name);
                const m = /^(0?[1-9]|1[0-2])-(0?[1-9]|[12]\d|3[01])$/.exec(bd);
                bd = m ? `${pad(+m[1])}-${pad(+m[2])}` : '';
                st.profiles[name] = { bio, birthday: bd, note: '' };
                toast('success', `${name} 계정을 등록했어요.`);
                saveState(); break;
            }
            case 'del-account': {
                if (!window.confirm(`${ds.name} 계정을 삭제할까요? (문자·프로필·트래커 기록이 지워져요)`)) return;
                removeAccount(st, ds.name);
                if (curChar === ds.name) { curChar = null; view = 'characters'; }
                saveState(); break;
            }

            case 'auto-now': await aiAuto(true); return;
            case 'clock-adv': advance(st, +ds.min); saveState(); break;
            case 'clock-now': st.clock = fmtClock(new Date()); saveState(); break;
            case 'reset-all':
                if (!window.confirm('이 채팅의 폰 데이터(문자·게시글·팔로우·트래커·일정)를 모두 지울까요?')) return;
                ctx().chatMetadata[MODULE] = newState();
                openComments.clear(); curPartner = null; curChar = null; calYM = null; calSel = null; view = 'home';
                saveState(); break;
            default: return;
        }
        render();
    }

    function onSet(el) {
        const s = getSettings();
        const k = el.dataset.set;
        if (el.type === 'number') {
            const n = parseInt(el.value, 10);
            s[k] = Number.isNaN(n) ? DEFAULTS[k] : clamp(n, +el.min || 0, +el.max || 9999);
        } else {
            s[k] = el.type === 'checkbox' ? el.checked : el.value;
        }
        saveSettings();
        refreshInjection();
        render();
    }

    function onChange(e) {
        const el = e.target, d = el.dataset;
        const st = getState();
        if (d.act === 'follow') { onAct('follow', el); return; }
        if (d.set) { onSet(el); return; }
        if (d.sel) { if (d.sel === 'luna') lunaWho = el.value; else pregWho = el.value; render(); return; }
        if (!st) return;
        if (d.cyc) {
            const c = ensureCycle(st, d.who);
            if (d.cyc === 'shared') c.shared = el.checked;
            else {
                const n = parseInt(el.value, 10);
                if (!Number.isNaN(n)) c[d.cyc] = d.cyc === 'len' ? clamp(n, 20, 45) : clamp(n, 2, 10);
            }
            saveState(); render(); return;
        }
        if (d.pshare !== undefined) { ensurePreg(st, d.who).shared = el.checked; saveState(); return; }
        if (d.prof && curChar) {
            const p = (st.profiles[curChar] = st.profiles[curChar] || {});
            let v = el.value.trim();
            if (d.prof === 'birthday' && v) {
                const m = /^(0?[1-9]|1[0-2])-(0?[1-9]|[12]\d|3[01])$/.exec(v);
                if (!m) { toast('warning', '생일은 월-일 형식으로 입력해 주세요. 예: 03-14'); el.value = p.birthday || ''; return; }
                v = `${pad(+m[1])}-${pad(+m[2])}`;
                el.value = v;
            }
            p[d.prof] = v; saveState(); return;
        }
        if (d.world) { st.world.setting = el.value.trim(); saveState(); return; }
        if (d.clock !== undefined) {
            if (parseClock(el.value)) { st.clock = fmtClock(parseClock(el.value)); saveState(); render(); }
            else toast('warning', '시간 형식은 YYYY-MM-DD HH:mm 이에요.');
        }
    }

    function bindPhone() {
        phoneEl.addEventListener('click', e => {
            const el = e.target.closest('[data-act]');
            if (!el || el.tagName === 'INPUT' || el.disabled) return;
            onAct(el.dataset.act, el);
        });
        phoneEl.addEventListener('change', onChange);
        phoneEl.addEventListener('keydown', e => {
            const act = e.target && e.target.dataset && e.target.dataset.enter;
            if (act && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                onAct(act, e.target);
            }
        });
    }

    /* ── 버블(드래그 + 클릭) ── */

    function clampPos(x, y) {
        return { x: clamp(x, 4, window.innerWidth - 56), y: clamp(y, 4, window.innerHeight - 56) };
    }
    function placeBubble() {
        const s = getSettings();
        const p = s.pos ? clampPos(s.pos.x, s.pos.y) : clampPos(window.innerWidth - 68, window.innerHeight - 150);
        bubbleEl.style.left = p.x + 'px';
        bubbleEl.style.top = p.y + 'px';
    }
    function bindBubble() {
        let sx, sy, ox, oy, moved = false, down = false;
        bubbleEl.addEventListener('pointerdown', e => {
            down = true; moved = false; sx = e.clientX; sy = e.clientY;
            ox = bubbleEl.offsetLeft; oy = bubbleEl.offsetTop;
            if (bubbleEl.setPointerCapture) { try { bubbleEl.setPointerCapture(e.pointerId); } catch { /* noop */ } }
        });
        bubbleEl.addEventListener('pointermove', e => {
            if (!down) return;
            const dx = e.clientX - sx, dy = e.clientY - sy;
            if (!moved && Math.hypot(dx, dy) < 6) return;
            moved = true; bubbleEl.classList.add('stp-dragging');
            const p = clampPos(ox + dx, oy + dy);
            bubbleEl.style.left = p.x + 'px'; bubbleEl.style.top = p.y + 'px';
        });
        bubbleEl.addEventListener('pointerup', () => {
            if (!down) return;
            down = false; bubbleEl.classList.remove('stp-dragging');
            if (moved) { getSettings().pos = { x: bubbleEl.offsetLeft, y: bubbleEl.offsetTop }; saveSettings(); }
            else togglePhone();
        });
        window.addEventListener('resize', placeBubble);
    }

    function togglePhone() {
        phoneOpen = !phoneOpen;
        phoneEl.classList.toggle('stp-hidden', !phoneOpen);
        if (phoneOpen) render();
    }

    /* ── 확장 설정 패널 ── */

    function mountSettingsPanel() {
        const host = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
        if (!host || document.getElementById('stp-drawer')) return;
        const s = getSettings();
        const wrap = document.createElement('div');
        wrap.id = 'stp-drawer';
        wrap.innerHTML = `<div class="inline-drawer">
  <div class="inline-drawer-toggle inline-drawer-header"><b>ST Phone</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
  <div class="inline-drawer-content">
    <label class="checkbox_label"><input id="stp_enabled" type="checkbox" ${s.enabled ? 'checked' : ''}><span>폰 버블 사용</span></label>
    <small>버블을 눌러 폰을 열고, 끌어서 위치를 옮길 수 있어요. 세부 설정은 폰의 설정 앱에 있어요.</small>
  </div></div>`;
        host.appendChild(wrap);
        wrap.querySelector('#stp_enabled').addEventListener('change', e => {
            getSettings().enabled = e.target.checked;
            saveSettings();
            if (!e.target.checked && phoneOpen) togglePhone();
            refreshInjection();
            render();
        });
    }

    /* ── 초기화 ── */

    function init() {
        if (document.getElementById('stp-bubble')) return;
        bubbleEl = document.createElement('div');
        bubbleEl.id = 'stp-bubble';
        bubbleEl.setAttribute('role', 'button');
        bubbleEl.setAttribute('aria-label', '폰 열기');
        bubbleEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/></svg><span class="stp-badge"></span>';
        phoneEl = document.createElement('div');
        phoneEl.id = 'stp-phone';
        phoneEl.className = 'stp-hidden';
        document.body.append(bubbleEl, phoneEl);
        placeBubble();
        bindBubble();
        bindPhone();
        mountSettingsPanel();

        const { eventSource, eventTypes } = ctx();
        eventSource.on(eventTypes.CHAT_CHANGED, () => {
            view = 'home'; curPartner = null; curChar = null; lunaWho = null; pregWho = null;
            calYM = null; calSel = null; typing = null; openComments.clear();
            getState();
            refreshInjection();
            render();
        });
        eventSource.on(eventTypes.MESSAGE_RECEIVED, onCharMessage);
        render();
        refreshInjection();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
