// 染·钟楼谜团 Blood on the Clocktower — 说书人自动调度 · 精简剧本 Trouble Brewing
// 规则：5-12 人。善良（镇民）vs 邪恶（爪牙+恶魔）。
// 夜晚：说书人(主机)按角色顺序私下调度——下毒者下毒 → 小恶魔杀人 → 占卜师占卜；
//       间谍看全部角色、共情者看邻居邪恶数（被动结算）；被毒玩家当晚信息能力失效。
// 白天：全员公开聊天（死亡玩家仍可发言）、提名、投票处决；死亡不退出但失去投票权。
// 胜负：恶魔死亡 → 善良胜；存活 ≤ 2 且恶魔在 → 邪恶胜；圣徒被处决 → 邪恶胜。
// 消息：botc_state(公开)/botc_role(私发身份)/botc_info(私发首夜信息)/botc_night(夜警)/
// botc_whisper(私发结果)/botc_spy(间谍全角色)/botc_chat(公开聊天)/
// botc_nominate(提名)/botc_vote(投票)/botc_action(夜晚动作)。
const BotC = (() => {
  let ctx = null;
  let state = null;
  let mirror = null;
  let myRole = null;
  let myAlign = null;
  let myInfo = [];
  let myNight = null;
  let fortuneSel = [];

  const TOWN_ROLES = ['洗牌人', '图书馆员', '调查员', '厨子', '共情者', '占卜师', '酒鬼', '圣徒', '士兵', '守夜人', '处女', '猎人', '市长'];
  const MINION_ROLES = ['下毒者', '男爵', '间谍'];
  const DEMON_ROLE = '小恶魔';
  const EVIL_ROLES = ['下毒者', '男爵', '间谍', '小恶魔'];

  function shuffle(a) {
    const b = a.slice();
    for (let i = b.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [b[i], b[j]] = [b[j], b[i]];
    }
    return b;
  }
  function randOf(a) { return a[Math.floor(Math.random() * a.length)]; }
  function isEvil(p) { return EVIL_ROLES.indexOf(p.role) >= 0; }

  // ---------- 主机：开局 ----------
  function hostStart() {
    const n = ctx.players.length;
    const minions = n <= 6 ? 1 : n <= 8 ? 2 : 3;
    const townCount = n - 1 - minions;
    const roles = shuffle(TOWN_ROLES).slice(0, townCount)
      .concat(shuffle(MINION_ROLES).slice(0, minions))
      .concat([DEMON_ROLE]);
    const assign = shuffle(roles);
    state = {
      players: ctx.players.map((p, i) => ({
        id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot,
        role: assign[i], alignment: isEvil({ role: assign[i] }) ? 'evil' : 'good',
        alive: true, poisoned: false, voted: false,
      })),
      phase: 'night', day: 1, nightQueue: [], nightIdx: 0,
      currentNom: null, votes: {}, voteCount: 0,
      chat: [], log: [], winner: null,
    };
    // 私发身份
    for (const p of state.players) {
      if (p.id === Net.myId()) { myRole = p.role; myAlign = p.alignment; }
      else Net.sendTo(p.id, { type: 'botc_role', role: p.role, alignment: p.alignment });
    }
    state.log.push('游戏开始！共 ' + n + ' 人：恶魔 1 · 爪牙 ' + minions + ' · 镇民 ' + townCount);
    state.log.push('—— 首夜 ——（说书人调度中，请勿偷看他人屏幕）');
    buildFirstNightInfo();
    pushState();
    startNight();
    render();
  }

  function sendInfo(playerId, text) {
    if (playerId === Net.myId()) myInfo.push(text);
    else Net.sendTo(playerId, { type: 'botc_info', text });
  }
  function whisper(playerId, text) {
    if (playerId === Net.myId()) myInfo.push(text);
    else Net.sendTo(playerId, { type: 'botc_whisper', text });
  }

  // 首夜信息角色（被动，无需等待动作）
  function buildFirstNightInfo() {
    const ps = state.players;
    const good = ps.filter(p => p.alignment === 'good');
    const evil = ps.filter(p => p.alignment === 'evil');
    const demon = evil.find(p => p.role === DEMON_ROLE);
    const minions = evil.filter(p => p.role !== DEMON_ROLE);

    // 洗牌人：两名玩家中有一名是随机镇民角色
    const washer = ps.find(p => p.role === '洗牌人');
    if (washer) {
      const pool = shuffle(ps.filter(p => p.id !== washer.id)).slice(0, 2);
      const real = good.find(p => p.id !== washer.id && TOWN_ROLES.indexOf(p.role) >= 0);
      const shownRole = real ? real.role : '酒鬼';
      sendInfo(washer.id, '洗牌人：『' + pool.map(p => p.name).join('、') + '』中有一名是【' + shownRole + '】');
    }
    // 图书馆员：两名玩家中有一名是酒鬼（无酒鬼则随机镇民）
    const lib = ps.find(p => p.role === '图书馆员');
    if (lib) {
      const drunk = ps.find(p => p.role === '酒鬼');
      const pool = shuffle(ps.filter(p => p.id !== lib.id)).slice(0, 2);
      sendInfo(lib.id, '图书馆员：『' + pool.map(p => p.name).join('、') + '』中有一名是【' + (drunk ? '酒鬼' : '外来者') + '】');
    }
    // 调查员：两名玩家中有一名是爪牙
    const inv = ps.find(p => p.role === '调查员');
    if (inv) {
      const pool = shuffle(ps.filter(p => p.id !== inv.id)).slice(0, 2);
      const shown = minions.length ? minions[0].role : '下毒者';
      sendInfo(inv.id, '调查员：『' + pool.map(p => p.name).join('、') + '』中有一名是【' + shown + '】');
    }
    // 厨子：恶魔与爪牙相邻对数
    const chef = ps.find(p => p.role === '厨子');
    if (chef) {
      let pairs = 0;
      const len = ps.length;
      const evilIds = evil.map(p => p.id);
      ps.forEach((p, i) => {
        if (p.id === demon.id && evilIds.indexOf(ps[(i + 1) % len].id) >= 0) pairs++;
        if (evilIds.indexOf(p.id) >= 0 && p.id !== demon.id && ps[(i + 1) % len].id === demon.id) pairs++;
      });
      sendInfo(chef.id, '厨子：恶魔与爪牙相邻的对数为【' + pairs + '】');
    }
    // 间谍：查看全部角色
    const spy = ps.find(p => p.role === '间谍');
    if (spy) {
      const list = ps.map(p => p.name + '：' + p.role).join('，');
      if (spy.id === Net.myId()) myInfo.push('间谍之眼：本局全部身份——' + list);
      else Net.sendTo(spy.id, { type: 'botc_spy', text: '间谍之眼：本局全部身份——' + list });
    }
  }

  // ---------- 夜晚调度 ----------
  function buildNightQueue() {
    const alive = state.players.filter(p => p.alive);
    const q = [];
    alive.filter(p => p.role === '下毒者').forEach(p => q.push({ playerId: p.id, action: 'poison' }));
    alive.filter(p => p.role === DEMON_ROLE).forEach(p => q.push({ playerId: p.id, action: 'kill' }));
    alive.filter(p => p.role === '占卜师').forEach(p => q.push({ playerId: p.id, action: 'fortune' }));
    return q;
  }
  function nightOptions(step) {
    const me = state.players.find(p => p.id === step.playerId);
    let list;
    if (step.action === 'fortune') list = state.players.filter(p => p.alive);
    else list = state.players.filter(p => p.alive && p.id !== step.playerId);
    return list.map(p => ({ id: p.id, name: p.name }));
  }
  function startNight() {
    state.phase = 'night';
    state.nightQueue = buildNightQueue();
    state.nightIdx = 0;
    state.currentNom = null;
    state.votes = {};
    state.voteCount = 0;
    state.players.forEach(p => { p.voted = false; });
    myNight = null;
    fortuneSel = [];
    state.log.push('—— 第 ' + state.day + ' 夜 ——（夜晚进行中）');
    pushState();
    dispatchNightStep();
  }
  function dispatchNightStep() {
    while (state.nightIdx < state.nightQueue.length) {
      const step = state.nightQueue[state.nightIdx];
      const pl = state.players.find(p => p.id === step.playerId);
      if (!pl || !pl.alive) { state.nightIdx++; continue; }
      // 被毒占卜师：当晚信息失效，随机给结果
      if (pl.poisoned && step.action === 'fortune') {
        const demon = state.players.find(p => p.role === DEMON_ROLE && p.alive);
        const opts = nightOptions(step);
        const a = randOf(opts); const b = randOf(opts);
        const res = demon && Math.random() < 0.5;
        whisper(pl.id, '占卜师结果：『' + a.name + '』与『' + b.name + '』中' + (res ? '有' : '没有') + '恶魔（信息受扰，可能不准）');
        state.nightIdx++;
        continue;
      }
      const payload = { type: 'botc_night', step: { action: step.action, options: nightOptions(step) } };
      if (pl.id === Net.myId()) { myNight = payload.step; render(); }
      else Net.sendTo(pl.id, payload);
      return;
    }
    finishNight();
  }
  function handleNightAction(from, data) {
    if (state.phase !== 'night') return;
    const step = state.nightQueue[state.nightIdx];
    if (!step || step.playerId !== from) return;
    const pl = state.players.find(p => p.id === from);
    if (!pl || !pl.alive) { state.nightIdx++; dispatchNightStep(); return; }
    if (step.action === 'poison') {
      const t = state.players.find(p => p.id === data.target);
      if (!t || t.id === pl.id || !t.alive) return;
      t.poisoned = true;
      state.log.push(pl.name + '（下毒者）对 ' + t.name + ' 下毒');
      state.nightIdx++;
      dispatchNightStep();
      return;
    }
    if (step.action === 'kill') {
      const t = state.players.find(p => p.id === data.target);
      if (!t || t.id === pl.id || !t.alive) return;
      if (t.role === '士兵') {
        state.log.push(pl.name + '（小恶魔）袭击 ' + t.name + '，但士兵免疫了！');
        whisper(t.id, '你在睡梦中被恶魔袭击，但你的士兵体质让你安然无恙');
      } else {
        t.alive = false;
        state.log.push(pl.name + '（小恶魔）杀死了 ' + t.name + '');
        whisper(t.id, '你在睡梦中被恶魔杀害……你已死亡，但仍可发言（失去投票权）');
      }
      state.nightIdx++;
      pushState();
      checkWin();
      if (state.winner) { render(); return; }
      dispatchNightStep();
      return;
    }
    if (step.action === 'fortune') {
      const a = state.players.find(p => p.id === data.a);
      const b = state.players.find(p => p.id === data.b);
      if (!a || !b) return;
      const demon = state.players.find(p => p.role === DEMON_ROLE && p.alive);
      const real = !!(demon && (demon.id === a.id || demon.id === b.id));
      const res = pl.poisoned ? Math.random() < 0.5 : real;
      whisper(pl.id, '占卜师结果：『' + a.name + '』与『' + b.name + '』中' + (res ? '有' : '没有') + '恶魔（红/蓝）');
      state.log.push(pl.name + '（占卜师）占卜了 ' + a.name + ' 与 ' + b.name);
      state.nightIdx++;
      dispatchNightStep();
      return;
    }
    state.nightIdx++;
    dispatchNightStep();
  }
  function finishNight() {
    // 共情者被动信息（每夜）
    const em = state.players.find(p => p.role === '共情者' && p.alive);
    if (em) {
      const idx = state.players.findIndex(p => p.id === em.id);
      const len = state.players.length;
      const left = state.players[(idx - 1 + len) % len];
      const right = state.players[(idx + 1) % len];
      let evil = (isEvil(left) ? 1 : 0) + (isEvil(right) ? 1 : 0);
      if (em.poisoned) evil = Math.floor(Math.random() * 3);
      whisper(em.id, '共情者：你左右邻居中共有 ' + evil + ' 名邪恶阵营');
    }
    state.players.forEach(p => { p.poisoned = false; });
    state.phase = 'day';
    state.currentNom = null;
    state.votes = {};
    state.voteCount = 0;
    state.nightQueue = [];
    state.nightIdx = 0;
    myNight = null;
    state.log.push('—— 第 ' + state.day + ' 天白天 ——（公开讨论，可提名处决）');
    pushState();
    checkWin();
    if (state.winner) { render(); return; }
    render();
  }

  // ---------- 白天：聊天 / 提名 / 投票 ----------
  function handleChat(from, text) {
    if (state.phase !== 'day' && state.phase !== 'ended') return;
    const p = state.players.find(x => x.id === from);
    if (!p) return;
    text = String(text || '').slice(0, 200).trim();
    if (!text) return;
    state.chat.push({ id: p.id, name: p.name, text, alive: p.alive });
    if (state.chat.length > 80) state.chat.splice(0, state.chat.length - 80);
    state.log.push(p.name + '：' + text);
    pushState();
    render();
  }
  function handleNominate(from, targetId) {
    if (state.phase !== 'day' || state.currentNom) return;
    const p = state.players.find(x => x.id === from);
    if (!p || !p.alive) return;
    const t = state.players.find(x => x.id === targetId);
    if (!t) return;
    state.currentNom = { nominator: from, target: targetId };
    state.votes = {};
    state.voteCount = 0;
    state.players.forEach(x => { x.voted = false; });
    state.log.push(p.name + ' 提名了 ' + t.name + '，全体存活玩家投票（赞成/反对）');
    pushState();
    render();
  }
  function handleVote(from, yes) {
    if (state.phase !== 'day' || !state.currentNom) return;
    const p = state.players.find(x => x.id === from);
    if (!p || !p.alive || p.voted) return;
    p.voted = true;
    state.votes[from] = !!yes;
    state.voteCount++;
    state.log.push(p.name + ' 投出了' + (yes ? '赞成' : '反对') + '票');
    const aliveCount = state.players.filter(x => x.alive).length;
    if (state.voteCount >= aliveCount) finishVote();
    else { pushState(); render(); }
  }
  function finishVote() {
    const aliveCount = state.players.filter(x => x.alive).length;
    const yes = Object.keys(state.votes).filter(k => state.votes[k]).length;
    const nom = state.currentNom;
    const t = state.players.find(x => x.id === nom.target);
    if (yes > aliveCount / 2 && t) {
      if (t.role === '圣徒') {
        state.log.push(t.name + '（圣徒）被处决——善良方立即失败！');
        state.winner = 'evil';
      } else {
        t.alive = false;
        state.log.push(t.name + ' 被处决死亡（可继续发言，失去投票权）');
        if (t.role === DEMON_ROLE) state.log.push('恶魔被处决！');
      }
      state.currentNom = null;
      pushState();
      checkWin();
      if (state.winner) { render(); return; }
      setTimeout(() => { startNight(); }, 600);
      return;
    }
    state.log.push('投票未过半数（' + yes + '/' + aliveCount + '），无人被处决');
    state.currentNom = null;
    state.players.forEach(x => { x.voted = false; });
    pushState();
    setTimeout(() => { startNight(); }, 600);
  }

  // ---------- 胜负判定 ----------
  function checkWin() {
    if (state.winner) return;
    const demon = state.players.find(p => p.role === DEMON_ROLE);
    if (!demon || !demon.alive) {
      state.winner = 'good';
      state.log.push('恶魔已死亡，善良方胜利！');
    } else {
      const alive = state.players.filter(p => p.alive);
      if (alive.length <= 2) {
        state.winner = 'evil';
        state.log.push('存活仅剩 ' + alive.length + ' 人且恶魔仍在，邪恶方胜利！');
      }
    }
    if (state.winner) {
      state.phase = 'ended';
      state.log.push(state.winner === 'good' ? '🎉 善良方获胜' : '☠️ 邪恶方获胜');
      pushState();
      render();
    }
  }

  // ---------- 消息 ----------
  function pushState() {
    Net.broadcast({ type: 'botc_state', ...view() });
  }
  function view() {
    const me = state.players.find(p => p.id === Net.myId());
    return {
      phase: state.phase,
      day: state.day,
      winner: state.winner,
      currentNom: state.currentNom,
      players: state.players.map(p => {
        const o = { id: p.id, name: p.name, alive: p.alive, voted: p.voted, isHost: p.isHost };
        if (state.winner) { o.role = p.role; o.alignment = p.alignment; }
        else if (me && p.id === me.id) { o.role = p.role; o.alignment = p.alignment; }
        return o;
      }),
      chat: state.chat,
      log: state.log,
    };
  }

  function handleMessage(from, data) {
    if (!data || !data.type) return;
    if (ctx.isHost) {
      if (data.type === 'botc_action') handleNightAction(from, data);
      else if (data.type === 'botc_chat') handleChat(from, data.text);
      else if (data.type === 'botc_nominate') handleNominate(from, data.target);
      else if (data.type === 'botc_vote') handleVote(from, data.yes);
      return;
    }
    if (data.type === 'botc_state') {
      mirror = data;
      if (data.phase !== 'night') myNight = null;
      render();
      return;
    }
    if (data.type === 'botc_role') { myRole = data.role; myAlign = data.alignment; render(); return; }
    if (data.type === 'botc_info') { myInfo.push(data.text); render(); return; }
    if (data.type === 'botc_whisper') { myInfo.push(data.text); render(); return; }
    if (data.type === 'botc_spy') { myInfo.push(data.text); render(); return; }
    if (data.type === 'botc_night') { myNight = data.step; fortuneSel = []; render(); }
  }

  // ---------- 视图 ----------
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function sendAction(payload) {
    if (ctx.isHost) handleMessage(Net.myId(), payload);
    else Net.sendToHost(payload);
  }

  function render() {
    if (!ctx) return;
    const c = ctx.container;
    UI.clear(c);
    const v = ctx.isHost ? (state ? view() : null) : mirror;
    if (!v) return;
    const me = (v.players || []).find(p => p.id === Net.myId());

    // 标题
    const title = el('div', 'botc-title', '染·钟楼谜团 Blood on the Clocktower');
    c.appendChild(title);
    const sub = el('div', 'botc-sub',
      v.winner ? (v.winner === 'good' ? '🎉 善良方胜利' : '☠️ 邪恶方胜利')
        : (v.phase === 'night' ? '🌙 夜晚 · 说书人调度中' : '☀️ 白天 · 第 ' + v.day + ' 天'));
    c.appendChild(sub);

    // 我的角色
    if (me && me.role) {
      const roleBox = el('div', 'botc-rolebox',
        '我的身份：' + me.role + '（' + (me.alignment === 'evil' ? '邪恶阵营' : '善良阵营') + '）' + (me.alive ? '' : ' · 💀已死亡'));
      c.appendChild(roleBox);
    } else if (myRole) {
      const roleBox = el('div', 'botc-rolebox', '我的身份：' + myRole + '（' + (myAlign === 'evil' ? '邪恶阵营' : '善良阵营') + '）');
      c.appendChild(roleBox);
    }
    // 我的信息
    if (myInfo.length) {
      const ib = el('div', 'botc-info');
      ib.appendChild(el('div', 'botc-info-title', '📜 我的信息'));
      myInfo.forEach(t => ib.appendChild(el('div', 'botc-info-line', t)));
      c.appendChild(ib);
    }

    // 玩家列表
    const pbox = el('div', 'botc-players');
    (v.players || []).forEach(p => {
      const row = el('div', 'botc-player' + (p.alive ? '' : ' dead'));
      const av = UI.avatarEl(p.id, p.name);
      row.appendChild(av);
      const nm = el('div', 'botc-pname', p.name + (p.alive ? '' : ' 💀') + (p.id === Net.myId() ? '（我）' : ''));
      row.appendChild(nm);
      if (v.phase === 'day' && v.currentNom && p.id === v.currentNom.target) {
        row.appendChild(el('span', 'botc-tag', '被提名'));
      }
      if (v.winner) row.appendChild(el('span', 'botc-tag', p.role + '·' + (p.alignment === 'evil' ? '恶' : '善')));
      pbox.appendChild(row);
    });
    c.appendChild(pbox);

    // 日志
    const logBox = el('div', 'botc-log');
    (v.log || []).slice(-40).forEach(t => logBox.appendChild(el('div', 'botc-log-line', t)));
    c.appendChild(logBox);

    // 夜警
    if (myNight && v.phase === 'night' && !v.winner) {
      const nb = el('div', 'botc-night');
      const what = myNight.action === 'poison' ? '选择一名玩家下毒' :
        myNight.action === 'kill' ? '选择一名玩家杀害' :
        '选择两名玩家占卜（可包含自己）';
      nb.appendChild(el('div', 'botc-night-title', '🌙 你的夜晚行动：' + what));
      if (myNight.action === 'fortune') {
        const selBox = el('div', 'botc-selbox');
        (myNight.options || []).forEach(o => {
          const b = el('button', 'botc-btn', o.name + (fortuneSel.indexOf(o.id) >= 0 ? ' ✓' : ''));
          b.onclick = () => {
            if (fortuneSel.indexOf(o.id) >= 0) fortuneSel = fortuneSel.filter(x => x !== o.id);
            else if (fortuneSel.length < 2) fortuneSel.push(o.id);
            render();
          };
          selBox.appendChild(b);
        });
        nb.appendChild(selBox);
        const ok = el('button', 'botc-btn ok', '确认占卜');
        ok.onclick = () => {
          if (fortuneSel.length === 2) {
            sendAction({ type: 'botc_action', action: 'fortune', a: fortuneSel[0], b: fortuneSel[1] });
            myNight = null; fortuneSel = [];
            render();
          }
        };
        nb.appendChild(ok);
      } else {
        const selBox = el('div', 'botc-selbox');
        (myNight.options || []).forEach(o => {
          const b = el('button', 'botc-btn', o.name);
          b.onclick = () => {
            sendAction({ type: 'botc_action', action: myNight.action, target: o.id });
            myNight = null;
            render();
          };
          selBox.appendChild(b);
        });
        nb.appendChild(selBox);
      }
      c.appendChild(nb);
    }

    // 白天：聊天 + 提名 + 投票
    if (v.phase === 'day' && !v.winner) {
      // 聊天流
      const chatBox = el('div', 'botc-chat');
      (v.chat || []).forEach(ch => chatBox.appendChild(el('div', 'botc-chat-line', (ch.alive ? '' : '💀') + ch.name + '：' + ch.text)));
      c.appendChild(chatBox);
      // 输入
      const inputRow = el('div', 'botc-inputrow');
      const input = document.createElement('input');
      input.className = 'botc-input';
      input.placeholder = '公开发言…（死亡玩家也可发言）';
      const sendBtn = el('button', 'botc-btn', '发言');
      sendBtn.onclick = () => {
        const t = input.value.trim();
        if (!t) return;
        sendAction({ type: 'botc_chat', text: t });
        input.value = '';
      };
      inputRow.appendChild(input);
      inputRow.appendChild(sendBtn);
      c.appendChild(inputRow);
      // 提名 / 投票
      if (me && me.alive) {
        if (!v.currentNom) {
          const nomRow = el('div', 'botc-nomrow');
          nomRow.appendChild(el('span', 'botc-hint', '提名：'));
          const sel = document.createElement('select');
          sel.className = 'botc-select';
          (v.players || []).filter(p => p.alive).forEach(p => {
            const op = document.createElement('option');
            op.value = p.id;
            op.textContent = p.name;
            sel.appendChild(op);
          });
          const nomBtn = el('button', 'botc-btn', '提名处决');
          nomBtn.onclick = () => sendAction({ type: 'botc_nominate', target: sel.value });
          nomRow.appendChild(sel);
          nomRow.appendChild(nomBtn);
          c.appendChild(nomRow);
        } else if (!me.voted) {
          const voteRow = el('div', 'botc-voterow');
          voteRow.appendChild(el('span', 'botc-hint', '是否处决 ' + ((v.players || []).find(p => p.id === v.currentNom.target) || {}).name + '？'));
          const y = el('button', 'botc-btn ok', '赞成处决');
          y.onclick = () => sendAction({ type: 'botc_vote', yes: true });
          const n = el('button', 'botc-btn no', '反对');
          n.onclick = () => sendAction({ type: 'botc_vote', yes: false });
          voteRow.appendChild(y);
          voteRow.appendChild(n);
          c.appendChild(voteRow);
        } else {
          c.appendChild(el('div', 'botc-hint', '你已投票，等待其他玩家…'));
        }
      } else if (me && !me.alive) {
        c.appendChild(el('div', 'botc-dead-hint', '💀 你已死亡：可继续发言，但失去提名与投票权'));
      }
    }
    if (v.winner) {
      const endBox = el('div', 'botc-end', v.winner === 'good' ? '🎉 善良方胜利！恶魔已被消灭' : '☠️ 邪恶方胜利！');
      c.appendChild(endBox);
    }
  }

  function init(c) {
    ctx = c;
    state = null; mirror = null;
    myRole = null; myAlign = null; myInfo = []; myNight = null; fortuneSel = [];
    if (ctx.isHost) hostStart();
    else render();
  }

  return { init, handleMessage };
})();
