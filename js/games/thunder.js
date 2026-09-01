// 雷霆战机 Thunder Strike —— 双人合作版
// 主机权威 · 实时动作射击（Canvas 渲染）
//
// 规则：两名玩家各驾驶一架战机，在屏幕底部移动、自动射击，
// 击落敌机、躲避弹幕、击破 Boss。每架战机只有 1 点生命，一碰即死；
// 死亡后读秒 10 秒复活（复活后短暂无敌）；仅当两架战机同时阵亡才判定全队失败。
// 小怪被击落有概率掉落道具，拾取后可临时强化火力 / 散射 / 无敌 / 射速 / 全屏清弹。
// 多种 Boss 拥有各异技能（激光炮带红线预警、扇形/螺旋弹幕、追踪弹、召唤、冲刺、扫射）。
// 击破 Boss 得高分；坚持 15 波并击破最终 Boss 即全队胜利。
//
// 架构：主机跑 requestAnimationFrame 游戏循环，维护 world 状态，把世界快照广播给客机；
// 客机只做输入上报（移动）与渲染，不做任何权威判定。
// 人机模式：主机=人类（左机），AI 队友（右机）由 bot 大脑驱动，同一条消息接口。
//
// 输入：桌面端 WASD/方向键移动；移动端虚拟摇杆移动；射击自动。
//
// 消息：
//   th_input   客机→主机：{ dir:{x,y} }
//   th_state   主机→客机：全量世界快照（广播）
//   th_assign  主机→客机：分配战机（左/右）
//   th_restart 主机/客机：重新开始
const Thunder = (() => {
  let ctx = null;
  let state = null;       // 主机世界状态
  let mirror = null;      // 客机：世界快照镜像
  let raf = null;
  let lastTick = 0;
  let lastBroadcast = 0;
  let canvas = null;
  let g2d = null;
  let myShip = null;      // 本机控制的战机 id（'left'|'right'）
  let keys = { left: false, right: false, up: false, down: false };
  let joy = { active: false, id: null, ox: 0, oy: 0, dx: 0, dy: 0 };
  let isTouch = false;

  // ---------- 常量 ----------
  const W = 720, H = 900;
  const SHIP_W = 40, SHIP_H = 44;
  const SHIP_SPEED = 320;
  const BULLET_SPEED = 680;
  const FIRE_COOLDOWN = 0.14;
  const ENEMY_SPAWN = 1.1;
  const MAX_WAVES = 15;
  const RESPAWN_TIME = 10;      // 复活读秒
  const RESPAWN_INVULN = 2.0;   // 复活后无敌时长
  const BROADCAST_MS = 50;

  const rnd = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ---------- 状态 ----------
  function makeShip(key) {
    return {
      id: key, x: key === 'left' ? W / 2 - 90 : W / 2 + 90, y: H - 120, cd: 0,
      alive: true, respawnT: 0, invulnT: 0,
      buffs: {},   // { power:剩余秒, spread:剩余秒, rapid:剩余秒, shield:剩余秒 }
    };
  }

  function makeState(players) {
    return {
      phase: 'playing',
      wave: 0,
      score: 0,
      time: 0,
      waveTime: 0,
      ships: { left: makeShip('left'), right: makeShip('right') },
      bullets: [],       // {x,y,vx,vy,owner}
      enemies: [],       // {x,y,hp,type,phase,cd,baseX,vy,split?}
      boss: null,
      enemyBullets: [],  // {x,y,vx,vy,kind}
      lasers: [],
      homing: [],        // {x,y,vx,vy,target}
      pickups: [],       // {x,y,vy,type}
      particles: [],
      texts: [],
      players,
      over: null,
      shake: 0,
      overTimer: 0,      // 全灭后短暂延迟再判负（让爆炸播完）
    };
  }

  function shipByPlayer(s, pid) {
    const p = s.players.find(x => x.id === pid);
    return p ? s.ships[p.ship] : null;
  }

  // ---------- 道具定义 ----------
  const PICKUPS = {
    power:  { name: '火力强化', icon: '⚡', color: '#f59e0b', dur: 8 },
    spread: { name: '散射',     icon: '🔱', color: '#22d3ee', dur: 8 },
    rapid:  { name: '急速射击', icon: '🔥', color: '#ef4444', dur: 8 },
    shield: { name: '无敌护盾', icon: '🛡', color: '#22c55e', dur: 5 },
    bomb:   { name: '全屏清弹', icon: '💥', color: '#a855f7', dur: 0 },
  };

  // ---------- Boss 种类定义 ----------
  const BOSS_KINDS = {
    dreadnought: { name: '雷霆战列舰', color: '#e5484d', scale: 1.0, hpMul: 1.0, skills: ['fan', 'spiral', 'laser'] },
    phantom:     { name: '幽灵巡洋舰', color: '#8b5cf6', scale: 0.82, hpMul: 0.72, skills: ['spiral', 'homing', 'dash', 'sweep'] },
    juggernaut:  { name: '堡垒要塞',   color: '#f59e0b', scale: 1.22, hpMul: 1.35, skills: ['fan', 'laser', 'summon', 'ring'] },
  };

  // ---------- 开局 ----------
  function hostStart() {
    const players = ctx.players.map((p, i) => ({
      id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot, ship: i === 0 ? 'left' : 'right',
    }));
    state = makeState(players);
    frameBuilt = false;
    hudRefs = null;
    for (const p of players) {
      Net.sendTo(p.id, { type: 'th_assign', ship: p.ship });
    }
    startWave(1);
    pushState();
    render();
    beginLoop();
  }

  function startWave(w) {
    state.wave = w;
    state.waveTime = 0;
    state.phase = 'playing';
    pushText(W / 2, H / 2 - 40, '第 ' + w + ' 波', 1.8, '#5b5bd6', 28);
    if (w % 5 === 0) spawnBoss();
  }

  // ---------- Boss ----------
  function spawnBoss() {
    // 根据波次挑选 Boss 种类
    let pool = ['dreadnought'];
    if (state.wave >= 10) pool.push('phantom');
    if (state.wave >= 15) pool.push('juggernaut');
    const kindKey = pool[Math.floor(Math.random() * pool.length)];
    const kind = BOSS_KINDS[kindKey];
    const hp = Math.round((80 + state.wave * 15) * kind.hpMul);
    state.boss = {
      x: W / 2, y: -90, hp, maxHp: hp,
      kind: kindKey,
      phase: 0, entering: true,
      skill: null, skillT: 0, skillDur: 0, cd: 2.0,
      curLaser: null,
      sweep: null,           // 扫射状态 {angle, dir, t}
      dashFrom: null, dashTo: null,
      hitFlash: 0, coreGlow: 0,
      _fanLock: false, _homingLock: false, _summonDone: false, _ringLock: false, _sweepLock: false,
    };
    pushText(W / 2, 150, '⚠ ' + kind.name + ' 来袭 ⚠', 2.2, kind.color, 34);
    state.shake = 8;
  }

  function bossStartSkill(b) {
    const kind = BOSS_KINDS[b.kind];
    const skills = kind.skills;
    const name = skills[Math.floor(Math.random() * skills.length)];
    b.skill = name;
    b.skillT = 0;
    b.curLaser = null;
    b.sweep = null;
    b.dashFrom = null; b.dashTo = null;
    b._fanLock = false; b._homingLock = false; b._summonDone = false; b._ringLock = false; b._sweepLock = false;
    switch (name) {
      case 'laser':   b.skillDur = 3.6; aimLaser(b); break;
      case 'fan':     b.skillDur = 1.6; break;
      case 'spiral':  b.skillDur = 3.0; break;
      case 'homing':  b.skillDur = 2.4; break;
      case 'summon':  b.skillDur = 1.2; break;
      case 'dash':    b.skillDur = 2.0; break;
      case 'ring':    b.skillDur = 2.4; break;
      case 'sweep':   b.skillDur = 3.2; b.sweep = { angle: -Math.PI / 3, dir: 1, t: 0 }; break;
    }
  }

  // 激光：瞄准某架战机，记录锁定角度；发射前最后一秒停止跟踪
  function aimLaser(b) {
    const target = pickAliveShip(b) || pickShip(b);
    const sx = b.x, sy = b.y + 40;
    const angle = Math.atan2(target.y - sy, target.x - sx);
    b.curLaser = { x: sx, y: sy, angle, width: 26, state: 'warn', t: 1.6, lockT: 0.6 };
  }

  function pickShip(b) {
    const ships = [state.ships.left, state.ships.right];
    return ships[Math.floor(Math.random() * ships.length)];
  }
  function pickAliveShip(b) {
    const alive = [state.ships.left, state.ships.right].filter(s => s.alive);
    if (!alive.length) return null;
    return alive[Math.floor(Math.random() * alive.length)];
  }

  function updateBoss(dt) {
    if (!state.boss) return;
    const b = state.boss;
    b.phase += dt;
    if (b.hitFlash > 0) b.hitFlash -= dt;
    b.coreGlow += dt;

    if (b.entering) {
      if (b.y < 130) b.y += 70 * dt;
      else b.entering = false;
      return;
    }

    // 浮动 + 移动
    b.y = 130 + Math.sin(b.phase * 0.6) * 16;
    if (!b.skill || ['fan', 'spiral', 'homing', 'ring'].includes(b.skill)) {
      b.x += Math.sin(b.phase * 0.8) * 60 * dt;
      b.x = clamp(b.x, 100, W - 100);
    }

    // 技能
    if (!b.skill) {
      b.cd -= dt;
      if (b.cd <= 0) bossStartSkill(b);
    } else {
      b.skillT += dt;
      runSkill(b, dt);
      if (b.skillT >= b.skillDur) {
        b.skill = null;
        b.curLaser = null;
        b.sweep = null;
        b.cd = rnd(1.0, 1.8);
      }
    }

    // Boss 撞玩家（仅存活）
    for (const k in state.ships) {
      const s = state.ships[k];
      if (!s.alive) continue;
      if (Math.abs(b.x - s.x) < 55 && Math.abs(b.y - s.y) < 58) {
        killShip(k, 'Boss 撞击');
      }
    }

    // 击破
    if (b.hp <= 0) {
      const bonus = 500 + state.wave * 50;
      state.score += bonus;
      pushText(b.x, b.y, '💥 +' + bonus, 1.6, '#f59e0b', 26);
      bigExplode(b.x, b.y);
      state.shake = 16;
      state.boss = null;
      // 击破 Boss 掉落两枚强力道具
      dropPickup(b.x - 30, b.y, 'power');
      dropPickup(b.x + 30, b.y, 'shield');
    }
  }

  function runSkill(b, dt) {
    const t = b.skillT;
    switch (b.skill) {
      case 'laser': {
        if (!b.curLaser) aimLaser(b);
        const L = b.curLaser;
        L.t -= dt;
        if (L.state === 'warn') {
          // 预警阶段：前段持续跟踪，最后 lockT 秒锁定方向不再跟踪
          L.x = b.x; L.y = b.y + 40;
          if (L.t > L.lockT) {
            const target = pickAliveShip(b) || pickShip(b);
            L.angle = Math.atan2(target.y - L.y, target.x - L.x);
          }
          // 最后 0.6 秒锁定，红线变实闪烁提示即将发射
          if (L.t <= 0) { L.state = 'fire'; L.t = 1.0; }
        } else {
          L.x = b.x; L.y = b.y + 40;
          for (const k in state.ships) {
            const s = state.ships[k];
            if (!s.alive) continue;
            const d = pointToLineDist(s.x, s.y, L.x, L.y, L.angle);
            if (d < L.width / 2 + 14 && alongRay(s.x, s.y, L.x, L.y, L.angle)) {
              if (!s.laserTick || state.time - s.laserTick > 0.3) {
                s.laserTick = state.time;
                killShip(k, '激光');
              }
            }
          }
          if (L.t <= 0) { L.state = 'warn'; L.t = 1.2; L.lockT = 0.5; }
        }
        break;
      }
      case 'fan': {
        if (t > 0.2 && !b._fanLock) {
          b._fanLock = true;
          const base = -Math.PI / 2;
          const n = 7;
          for (let i = 0; i < n; i++) {
            const a = base + (i - (n - 1) / 2) * 0.18;
            state.enemyBullets.push({ x: b.x, y: b.y + 40, vx: Math.cos(a) * 200, vy: Math.sin(a) * 200, kind: 'orb' });
          }
        }
        break;
      }
      case 'spiral': {
        const ang = b.phase * 2.2;
        if (Math.random() < dt * 12) {
          state.enemyBullets.push({ x: b.x, y: b.y + 40, vx: Math.cos(ang) * 150, vy: Math.sin(ang) * 150, kind: 'orb' });
          state.enemyBullets.push({ x: b.x, y: b.y + 40, vx: Math.cos(ang + Math.PI) * 150, vy: Math.sin(ang + Math.PI) * 150, kind: 'orb' });
        }
        break;
      }
      case 'homing': {
        if (t > 0.3 && !b._homingLock) {
          b._homingLock = true;
          const alive = [state.ships.left, state.ships.right].filter(s => s.alive);
          for (const s of alive) {
            state.homing.push({ x: b.x, y: b.y + 40, vx: 0, vy: 120, target: s.id, life: 5 });
          }
        }
        if (t > 1.2) b._homingLock = false;
        break;
      }
      case 'summon': {
        if (t < 0.2 && !b._summonDone) {
          b._summonDone = true;
          const n = 3 + Math.floor(state.wave / 5);
          for (let i = 0; i < n; i++) {
            spawnEnemyAt(rnd(60, W - 60), -20, 'zig');
          }
        }
        break;
      }
      case 'dash': {
        if (!b.dashFrom) {
          b.dashFrom = { x: b.x, y: b.y };
          b.dashTo = pickAliveShip(b) || pickShip(b);
        }
        const dur = b.skillDur;
        if (t < dur * 0.35) {
          b.x += (b.dashFrom.x - b.x) * dt * 2;
        } else if (t < dur * 0.6) {
          const prog = (t - dur * 0.35) / (dur * 0.25);
          b.x = lerp(b.dashFrom.x, b.dashTo.x, Math.min(1, prog * 2));
          b.y = lerp(b.dashFrom.y, b.dashTo.y, Math.min(1, prog * 2));
        } else {
          const prog = (t - dur * 0.6) / (dur * 0.4);
          b.x = lerp(b.dashTo.x, b.dashFrom.x, Math.min(1, prog));
          b.y = lerp(b.dashTo.y, b.dashFrom.y, Math.min(1, prog));
        }
        break;
      }
      case 'ring': {
        // 环形扩散弹：周期性向四周发射
        if (t > 0.3 && !b._ringLock) {
          b._ringLock = true;
          const n = 14;
          for (let i = 0; i < n; i++) {
            const a = (i / n) * Math.PI * 2 + b.phase;
            state.enemyBullets.push({ x: b.x, y: b.y + 20, vx: Math.cos(a) * 130, vy: Math.sin(a) * 130, kind: 'orb' });
          }
        }
        if (t > 1.2) b._ringLock = false;
        break;
      }
      case 'sweep': {
        // 扫射：炮口角度从一侧扫到另一侧，持续发射
        if (!b.sweep) b.sweep = { angle: -Math.PI / 3, dir: 1, t: 0 };
        const sw = b.sweep;
        sw.angle += sw.dir * dt * 0.9;
        if (sw.angle > Math.PI / 3) sw.dir = -1;
        if (sw.angle < -Math.PI / 3) sw.dir = 1;
        if (Math.random() < dt * 14) {
          state.enemyBullets.push({ x: b.x, y: b.y + 40, vx: Math.cos(sw.angle - Math.PI / 2) * 220, vy: Math.sin(sw.angle - Math.PI / 2) * 220, kind: 'orb' });
        }
        break;
      }
    }
  }

  function pointToLineDist(px, py, lx, ly, angle) {
    const dx = px - lx, dy = py - ly;
    return Math.abs(-dx * Math.sin(angle) + dy * Math.cos(angle));
  }
  function alongRay(px, py, lx, ly, angle) {
    const dx = px - lx, dy = py - ly;
    return dx * Math.cos(angle) + dy * Math.sin(angle) > 0;
  }
  function lerp(a, b, t) { return a + (b - a) * t; }

  // ---------- 敌机 ----------
  function spawnEnemy() {
    const t = state.wave;
    // 小怪种类随波次丰富
    let pool = ['small', 'small', 'small', 'zig', 'shooter'];
    if (t >= 3) pool.push('tank');
    if (t >= 5) pool.push('splitter', 'diver');
    if (t >= 7) pool.push('shooter', 'zig', 'tank');
    const type = pool[Math.floor(Math.random() * pool.length)];
    spawnEnemyAt(rnd(40, W - 40), -30, type);
  }

  function spawnEnemyAt(x, y, type) {
    const t = state.wave;
    const hpMap = { small: 1, zig: 2, shooter: 3, tank: 6, splitter: 3, diver: 2 };
    const hp = hpMap[type] || 1;
    state.enemies.push({
      x, y, hp, type,
      phase: Math.random() * Math.PI * 2,
      cd: rnd(1.0, 2.4),
      baseX: x,
      vy: type === 'diver' ? rnd(280, 360) : type === 'zig' ? rnd(150, 210) : rnd(130, 180 + t * 10),
    });
  }

  // ---------- 输入 ----------
  function hostInput(fromId, data) {
    if (!state || state.phase !== 'playing') return;
    const ship = shipByPlayer(state, fromId);
    if (!ship) return;
    if (data && data.dir) ship.inputDir = data.dir;
  }

  // ---------- 主循环 ----------
  function beginLoop() {
    if (raf) cancelAnimationFrame(raf);
    lastTick = performance.now();
    lastBroadcast = lastTick;
    const loop = (now) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - lastTick) / 1000);
      lastTick = now;
      tick(dt);
      render();
      if (now - lastBroadcast >= BROADCAST_MS) {
        lastBroadcast = now;
        pushState();
      }
    };
    raf = requestAnimationFrame(loop);
  }

  function tick(dt) {
    if (!state || state.phase !== 'playing') return;
    state.time += dt;
    state.waveTime += dt;
    if (state.shake > 0) state.shake = Math.max(0, state.shake - dt * 30);

    // 战机：复活倒计时 / 无敌 / buff 计时 / 移动 / 射击
    for (const k in state.ships) {
      const s = state.ships[k];
      // buff 计时
      for (const bKey in s.buffs) {
        s.buffs[bKey] -= dt;
        if (s.buffs[bKey] <= 0) delete s.buffs[bKey];
      }
      if (s.invulnT > 0) s.invulnT -= dt;

      if (!s.alive) {
        // 读秒复活
        s.respawnT -= dt;
        if (s.respawnT <= 0) {
          s.alive = true;
          s.respawnT = 0;
          s.invulnT = RESPAWN_INVULN;
          s.x = k === 'left' ? W / 2 - 90 : W / 2 + 90;
          s.y = H - 120;
          pushText(s.x, s.y - 40, '复活！', 1.0, '#22c55e', 20);
          explode(s.x, s.y, '#22c55e', 12);
        }
        continue; // 死亡战机不移动不射击
      }

      const dir = s.inputDir || { x: 0, y: 0 };
      const len = Math.hypot(dir.x, dir.y);
      if (len > 1) { dir.x /= len; dir.y /= len; }
      s.x += dir.x * SHIP_SPEED * dt;
      s.y += dir.y * SHIP_SPEED * dt;
      s.x = clamp(s.x, 20, W - 20);
      s.y = clamp(s.y, H * 0.45, H - 30);
      s.cd -= dt;
      if (s.cd < 0) s.cd = 0;

      // 引擎尾焰
      if (Math.random() < dt * 40) {
        state.particles.push({ x: s.x + rnd(-4, 4), y: s.y + SHIP_H / 2, vx: rnd(-12, 12), vy: rnd(60, 120), life: rnd(0.2, 0.4), color: s.id === 'left' ? '#6fa8ff' : '#5eead4', size: rnd(2, 4) });
      }

      // 自动射击（受 buff 影响）
      if (s.cd <= 0) {
        const rapid = s.buffs.rapid ? 0.5 : 1;
        s.cd = FIRE_COOLDOWN * rapid;
        const p = state.players.find(x => x.ship === k);
        fireShip(k, p ? p.id : null);
      }
    }

    // 敌机生成
    const spawnInterval = Math.max(0.22, ENEMY_SPAWN - state.wave * 0.06);
    const waveCap = 8 + state.wave * 3;
    if (!state.boss && state.waveTime < 12 && state.enemies.length < waveCap && Math.random() < dt / spawnInterval) {
      spawnEnemy();
    }

    updateEnemies(dt);
    updateBoss(dt);
    updateBullets(dt);
    updateEnemyBullets(dt);
    updateHoming(dt);
    updatePickups(dt);
    updateParticles(dt);
    updateTexts(dt);

    // 全灭判定
    if (!state.boss) {
      if (state.enemies.length === 0 && state.waveTime > 2.5) {
        if (state.wave >= MAX_WAVES) { winGame(); return; }
        startWave(state.wave + 1);
      }
    }
    checkAllDead();
  }

  // 发射子弹（根据 buff 改变火力）
  function fireShip(shipKey, pid) {
    const s = state.ships[shipKey];
    const spread = s.buffs.spread;
    const power = s.buffs.power;
    const mx = s.x, my = s.y - SHIP_H / 2;
    if (power) {
      // 火力强化：三连发（竖直 + 略斜）
      state.bullets.push({ x: mx, y: my, vx: 0, vy: -BULLET_SPEED, owner: pid });
      state.bullets.push({ x: mx - 14, y: my + 8, vx: -60, vy: -BULLET_SPEED, owner: pid });
      state.bullets.push({ x: mx + 14, y: my + 8, vx: 60, vy: -BULLET_SPEED, owner: pid });
    } else if (spread) {
      // 散射：5 发散弹
      for (let i = -2; i <= 2; i++) {
        state.bullets.push({ x: mx, y: my, vx: i * 90, vy: -BULLET_SPEED, owner: pid });
      }
    } else {
      state.bullets.push({ x: mx, y: my, vx: 0, vy: -BULLET_SPEED, owner: pid });
    }
  }

  function updateEnemies(dt) {
    for (const e of state.enemies) {
      e.phase += dt;
      if (e.type === 'zig') {
        e.x = e.baseX + Math.sin(e.phase * 2.5) * 60;
        e.y += e.vy * dt;
      } else if (e.type === 'diver') {
        // 俯冲：快速下坠并朝玩家方向倾斜
        e.y += e.vy * dt;
        e.x += Math.sin(e.phase) * 30 * dt;
      } else {
        e.y += e.vy * dt;
      }
      if (e.type === 'shooter') {
        e.cd -= dt;
        if (e.cd <= 0) {
          e.cd = rnd(1.8, 3.0);
          state.enemyBullets.push({ x: e.x, y: e.y + 10, vx: 0, vy: 220, kind: 'orb' });
        }
      }
      if (e.type === 'tank') {
        e.cd -= dt;
        if (e.cd <= 0) {
          e.cd = rnd(2.2, 3.4);
          // 三发散射
          for (let i = -1; i <= 1; i++) {
            state.enemyBullets.push({ x: e.x, y: e.y + 10, vx: i * 70, vy: 200, kind: 'orb' });
          }
        }
      }
      // 撞机
      if (e.y > H * 0.4) {
        for (const k in state.ships) {
          const s = state.ships[k];
          if (!s.alive) continue;
          if (Math.abs(e.x - s.x) < 32 && Math.abs(e.y - s.y) < 36) {
            killShip(k, '撞击');
            e.hp = 0;
            explode(e.x, e.y, '#f59e0b');
          }
        }
      }
    }
    state.enemies = state.enemies.filter(e => e.y < H + 40 && e.hp > 0);
  }

  function updateBullets(dt) {
    for (const b of state.bullets) { b.y += b.vy * dt; b.x += b.vx * dt; }
    state.bullets = state.bullets.filter(b => b.y > -20 && b.y < H + 20);

    const hitEnemies = new Set();
    const hitBoss = new Set();
    state.bullets = state.bullets.filter(b => {
      if (state.boss && !state.boss.entering && Math.abs(b.x - state.boss.x) < 58 && Math.abs(b.y - state.boss.y) < 58) {
        hitBoss.add(b); return false;
      }
      for (const e of state.enemies) {
        if (Math.abs(b.x - e.x) < 22 && Math.abs(b.y - e.y) < 24) {
          hitEnemies.add(e); return false;
        }
      }
      return true;
    });

    hitEnemies.forEach(e => {
      e.hp -= 1;
      if (e.hp <= 0) {
        const pts = { small: 10, zig: 25, shooter: 40, tank: 60, splitter: 35, diver: 30 }[e.type] || 10;
        state.score += pts;
        pushText(e.x, e.y, '+' + pts, 0.9, '#5b5bd6', 16);
        explode(e.x, e.y, '#5b5bd6');
        // 分裂怪：死亡分裂成两只 small
        if (e.type === 'splitter') {
          spawnEnemyAt(e.x - 20, e.y, 'small');
          spawnEnemyAt(e.x + 20, e.y, 'small');
        }
        // 概率掉落道具
        maybeDrop(e);
      } else {
        spark(e.x, e.y, '#a5b4fc');
      }
    });
    state.enemies = state.enemies.filter(e => e.hp > 0);

    hitBoss.forEach(b => {
      if (state.boss) {
        state.boss.hp -= 1;
        state.boss.hitFlash = 0.08;
        if (Math.random() < 0.5) spark(state.boss.x + rnd(-40, 40), state.boss.y + rnd(-40, 40), '#fbbf24');
      }
    });
  }

  // 道具掉落
  function maybeDrop(e) {
    // 不同小怪掉落概率不同
    const rate = { small: 0.06, zig: 0.10, shooter: 0.12, tank: 0.30, splitter: 0.18, diver: 0.15 }[e.type] || 0.08;
    if (Math.random() < rate) {
      const types = ['power', 'spread', 'rapid', 'shield', 'bomb'];
      const weights = [0.22, 0.22, 0.18, 0.28, 0.10];
      let r = Math.random(), acc = 0, chosen = 'power';
      for (let i = 0; i < types.length; i++) { acc += weights[i]; if (r < acc) { chosen = types[i]; break; } }
      dropPickup(e.x, e.y, chosen);
    }
  }

  function dropPickup(x, y, type) {
    state.pickups.push({ x, y, vy: 70, type });
  }

  function updatePickups(dt) {
    for (const p of state.pickups) { p.y += p.vy * dt; }
    state.pickups = state.pickups.filter(p => p.y < H + 20);
    // 拾取判定
    for (const k in state.ships) {
      const s = state.ships[k];
      if (!s.alive) continue;
      for (const p of state.pickups) {
        if (Math.abs(p.x - s.x) < 28 && Math.abs(p.y - s.y) < 28) {
          applyPickup(k, p);
          p.y = H + 999; // 标记删除
        }
      }
    }
    state.pickups = state.pickups.filter(p => p.y < H + 100);
  }

  function applyPickup(shipKey, p) {
    const s = state.ships[shipKey];
    const def = PICKUPS[p.type];
    if (p.type === 'bomb') {
      // 全屏清弹
      state.enemyBullets = [];
      state.homing = [];
      pushText(W / 2, H / 2, '💥 全屏清弹！', 1.2, '#a855f7', 26);
      bigExplode(W / 2, H / 2);
    } else {
      s.buffs[p.type] = def.dur;
      pushText(s.x, s.y - 40, def.icon + ' ' + def.name, 1.0, def.color, 18);
      spark(s.x, s.y, def.color, 8);
    }
  }

  function updateEnemyBullets(dt) {
    for (const b of state.enemyBullets) { b.x += b.vx * dt; b.y += b.vy * dt; }
    state.enemyBullets = state.enemyBullets.filter(b => b.y > -30 && b.y < H + 30 && b.x > -30 && b.x < W + 30);

    for (const k in state.ships) {
      const s = state.ships[k];
      if (!s.alive) continue;
      for (const b of state.enemyBullets) {
        if (Math.abs(b.x - s.x) < 16 && Math.abs(b.y - s.y) < 18) {
          killShip(k, '弹幕');
          b.y = H + 999;
          explode(s.x, s.y, '#e5484d', 6);
        }
      }
    }
    state.enemyBullets = state.enemyBullets.filter(b => b.y < H + 100);
  }

  function updateHoming(dt) {
    for (const h of state.homing) {
      h.life -= dt;
      const target = state.ships[h.target];
      if (target && target.alive) {
        const dx = target.x - h.x, dy = target.y - h.y;
        const len = Math.hypot(dx, dy) || 1;
        h.vx = lerp(h.vx, dx / len * 200, 0.06);
        h.vy = lerp(h.vy, dy / len * 200, 0.06);
      }
      h.x += h.vx * dt;
      h.y += h.vy * dt;
      for (const k in state.ships) {
        const s = state.ships[k];
        if (!s.alive) continue;
        if (Math.abs(h.x - s.x) < 18 && Math.abs(h.y - s.y) < 20) {
          killShip(k, '追踪弹');
          h.life = -1;
          explode(h.x, h.y, '#e5484d', 8);
        }
      }
    }
    state.homing = state.homing.filter(h => h.life > 0);
  }

  // 击杀战机（1 血即死；无敌则无视）
  function killShip(shipKey, src) {
    const s = state.ships[shipKey];
    if (!s.alive) return;
    if (s.invulnT > 0) {
      pushText(s.x, s.y - 30, '🛡 无敌', 0.8, '#22c55e', 14);
      return;
    }
    s.alive = false;
    s.respawnT = RESPAWN_TIME;
    s.buffs = {};  // 死亡清空 buff
    pushText(s.x, s.y, '💀 ' + src, 1.0, '#e5484d', 20);
    bigExplode(s.x, s.y);
    state.shake = Math.max(state.shake, 10);
    // 检查是否全灭
    checkAllDead();
  }

  function checkAllDead() {
    const anyAlive = state.ships.left.alive || state.ships.right.alive;
    // 两机同时阵亡 → 立即判负（复活读秒只适用于「一机存活、另一机等待复活」的场景；
    // 一旦两机都处于死亡状态就直接结束，否则会陷入「各自读秒复活→永远打下去」的死循环）。
    if (!anyAlive && state.phase === 'playing') {
      state.overTimer += 0.016;
      if (state.overTimer > 0.5) loseGame();
    } else {
      state.overTimer = 0;
    }
  }

  function spark(x, y, color, count = 4) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rnd(30, 120);
      state.particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rnd(0.15, 0.35), color, size: rnd(1, 3) });
    }
  }

  function explode(x, y, color, count = 14) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rnd(40, 200);
      state.particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rnd(0.3, 0.7), color, size: rnd(2, 5) });
    }
    state.particles.push({ x, y, vx: 0, vy: 0, life: 0.35, color: '#ffffff', size: 4, ring: true });
  }

  function bigExplode(x, y) {
    for (let i = 0; i < 50; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rnd(60, 380);
      const colors = ['#f59e0b', '#e5484d', '#fbbf24', '#ffffff'];
      state.particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rnd(0.4, 1.0), color: colors[i % colors.length], size: rnd(2, 7) });
    }
    for (let i = 0; i < 3; i++) {
      state.particles.push({ x, y, vx: 0, vy: 0, life: 0.5 + i * 0.15, color: '#ffffff', size: 8 + i * 6, ring: true });
    }
  }

  function updateParticles(dt) {
    for (const p of state.particles) {
      p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt;
      if (!p.ring) p.vy += 60 * dt;
    }
    state.particles = state.particles.filter(p => p.life > 0);
  }

  function updateTexts(dt) {
    for (const t of state.texts) { t.life -= dt; t.y -= 24 * dt; }
    state.texts = state.texts.filter(t => t.life > 0);
  }

  function pushText(x, y, text, life, color, size = 16) {
    state.texts.push({ x, y, text, life, color, size });
  }

  function winGame() {
    state.phase = 'won';
    state.over = '🎉 全队合作通关！最终得分 ' + state.score + ' 分';
    stopLoop();
    pushState();
    render();
  }

  function loseGame() {
    state.phase = 'lost';
    state.over = '💥 双机同时阵亡。坚持到了第 ' + state.wave + ' 波，得分 ' + state.score;
    stopLoop();
    pushState();
    render();
  }

  function stopLoop() {
    if (raf) { cancelAnimationFrame(raf); raf = null; }
  }

  function hostRestart() {
    stopLoop();
    hostStart();
  }

  // ---------- 广播 ----------
  function pushState() {
    if (!state) return;
    Net.broadcast({
      type: 'th_state',
      phase: state.phase,
      wave: state.wave,
      maxWaves: MAX_WAVES,
      score: state.score,
      ships: {
        left: shipPub(state.ships.left),
        right: shipPub(state.ships.right),
      },
      bullets: state.bullets.map(b => ({ x: b.x, y: b.y })),
      enemies: state.enemies.map(e => ({ x: e.x, y: e.y, type: e.type })),
      boss: state.boss ? bossPub(state.boss) : null,
      enemyBullets: state.enemyBullets.map(b => ({ x: b.x, y: b.y })),
      lasers: laserPub(),
      homing: state.homing.map(h => ({ x: h.x, y: h.y })),
      pickups: state.pickups.map(p => ({ x: p.x, y: p.y, type: p.type })),
      particles: state.particles.map(p => ({ x: p.x, y: p.y, color: p.color, size: p.size, ring: p.ring })),
      texts: state.texts.map(t => ({ x: t.x, y: t.y, text: t.text, color: t.color, size: t.size })),
      over: state.over,
      shake: state.shake,
    });
  }

  function shipPub(s) {
    return { x: s.x, y: s.y, alive: s.alive, respawnT: s.respawnT, invulnT: s.invulnT, buffs: s.buffs };
  }
  function bossPub(b) {
    return {
      x: b.x, y: b.y, hp: b.hp, maxHp: b.maxHp, kind: b.kind,
      entering: b.entering, phase: b.phase, hitFlash: b.hitFlash > 0, skill: b.skill,
    };
  }
  function laserPub() {
    if (!state.boss || !state.boss.curLaser) return [];
    const L = state.boss.curLaser;
    return [{ x: L.x, y: L.y, angle: L.angle, width: L.width, state: L.state }];
  }

  // ---------- 消息处理 ----------
  function handleMessage(from, data) {
    if (!ctx || !data || !data.type) return;
    if (ctx.isHost) {
      if (data.type === 'th_input') hostInput(from, data);
      else if (data.type === 'th_restart') hostRestart();
    } else {
      if (data.type === 'th_state') { mirror = data; render(); }
      else if (data.type === 'th_assign') { myShip = data.ship; render(); }
    }
  }

  // ---------- 视图数据 ----------
  function view() {
    if (ctx.isHost) {
      if (!state) return null;
      return {
        phase: state.phase, wave: state.wave, maxWaves: MAX_WAVES, score: state.score,
        ships: state.ships, bullets: state.bullets, enemies: state.enemies,
        boss: state.boss, enemyBullets: state.enemyBullets,
        lasers: laserPub(), homing: state.homing, pickups: state.pickups,
        particles: state.particles, texts: state.texts,
        over: state.over, shake: state.shake,
      };
    }
    return mirror;
  }

  // ---------- 初始化 ----------
  function init(c) {
    ctx = c;
    state = null; mirror = null; myShip = null;
    keys = { left: false, right: false, up: false, down: false };
    joy = { active: false, id: null, ox: 0, oy: 0, dx: 0, dy: 0 };
    isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    if (ctx.isHost) hostStart();
    else render();
  }

  // ---------- 输入 ----------
  let inputBound = false;
  function bindInput() {
    if (inputBound) return;
    inputBound = true;
    const onKey = (e, down) => {
      const k = e.key.toLowerCase();
      if (k === 'arrowleft' || k === 'a') keys.left = down;
      else if (k === 'arrowright' || k === 'd') keys.right = down;
      else if (k === 'arrowup' || k === 'w') keys.up = down;
      else if (k === 'arrowdown' || k === 's') keys.down = down;
      if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(e.key.toLowerCase())) e.preventDefault();
      sendInput();
    };
    window.addEventListener('keydown', e => onKey(e, true));
    window.addEventListener('keyup', e => onKey(e, false));
  }

  let touchBound = false;
  function bindTouch() {
    if (touchBound) return;
    const zone = canvas;
    if (!zone) return;
    touchBound = true;

    const start = (e) => {
      e.preventDefault();
      const t = e.touches && e.touches[0] ? e.touches[0] : e;
      const rect = canvas.getBoundingClientRect();
      const scaleX = W / rect.width, scaleY = H / rect.height;
      joy.active = true;
      joy.id = (e.touches && e.touches[0]) ? e.touches[0].identifier : 0;
      joy.ox = (t.clientX - rect.left) * scaleX;
      joy.oy = (t.clientY - rect.top) * scaleY;
      joy.dx = 0; joy.dy = 0;
      updateJoy();
    };
    const move = (e) => {
      e.preventDefault();
      if (!joy.active) return;
      let t = null;
      if (e.touches) {
        for (let i = 0; i < e.touches.length; i++) {
          if (e.touches[i].identifier === joy.id) { t = e.touches[i]; break; }
        }
      } else t = e;
      if (!t) return;
      const rect = canvas.getBoundingClientRect();
      const scaleX = W / rect.width, scaleY = H / rect.height;
      joy.dx = (t.clientX - rect.left) * scaleX - joy.ox;
      joy.dy = (t.clientY - rect.top) * scaleY - joy.oy;
      updateJoy();
    };
    const end = (e) => {
      e.preventDefault();
      joy.active = false;
      joy.dx = 0; joy.dy = 0;
      updateJoy();
    };
    zone.addEventListener('touchstart', start, { passive: false });
    zone.addEventListener('touchmove', move, { passive: false });
    zone.addEventListener('touchend', end, { passive: false });
    zone.addEventListener('touchcancel', end, { passive: false });
  }

  function updateJoy() {
    let dx = joy.dx, dy = joy.dy;
    const dead = 12;
    const len = Math.hypot(dx, dy);
    if (len < dead) { dx = 0; dy = 0; }
    else {
      const clampV = 60;
      if (len > clampV) { dx = dx / len * clampV; dy = dy / len * clampV; }
      dx /= clampV; dy /= clampV;
    }
    joy.nx = dx; joy.ny = dy;
    sendInput();
  }

  function sendInput() {
    let dir;
    if (isTouch && joy.active) dir = { x: joy.nx || 0, y: joy.ny || 0 };
    else dir = { x: (keys.right ? 1 : 0) - (keys.left ? 1 : 0), y: (keys.down ? 1 : 0) - (keys.up ? 1 : 0) };
    const msg = { type: 'th_input', dir };
    if (ctx.isHost) hostInput(Net.myId(), msg);
    else Net.sendToHost(msg);
  }

  // ---------- 渲染 ----------
  let hudRefs = null;
  let frameBuilt = false;

  function render() {
    if (!ctx) return;
    const c = ctx.container;
    if (!frameBuilt) { buildFrame(c); frameBuilt = true; }
    const v = view();
    if (!v) return;
    updateHud(v);
    drawScene(v);
  }

  function buildFrame(c) {
    UI.clear(c);
    bindInput();

    const frame = document.createElement('div');
    frame.className = 'game-frame';

    const tb = document.createElement('div');
    tb.className = 'game-topbar';
    const title = document.createElement('span');
    title.className = 'game-title';
    title.textContent = '⚡ 雷霆战机 · 双人合作';
    tb.appendChild(title);
    const right = document.createElement('div');
    right.style.cssText = 'display:flex;gap:8px;align-items:center;';
    if (ctx.solo) {
      const soloPill = document.createElement('span');
      soloPill.className = 'phase-pill solo';
      soloPill.textContent = '🤖 人机';
      right.appendChild(soloPill);
    }
    const pill = document.createElement('span');
    pill.className = 'phase-pill';
    pill.textContent = '准备中';
    right.appendChild(pill);
    const leaveBtn = document.createElement('button');
    leaveBtn.className = 'btn btn-ghost btn-sm';
    leaveBtn.textContent = '离开';
    leaveBtn.addEventListener('click', () => ctx.leave());
    right.appendChild(leaveBtn);
    tb.appendChild(right);
    frame.appendChild(tb);

    // HUD：分数 + 双机状态
    const hud = document.createElement('div');
    hud.style.cssText = 'display:flex;gap:14px;align-items:center;margin-bottom:10px;font-size:13px;';
    const shipStatus = document.createElement('div');
    shipStatus.style.cssText = 'display:flex;gap:10px;flex:1;';
    hud.appendChild(shipStatus);
    const scoreText = document.createElement('span');
    scoreText.style.cssText = 'font-weight:800;color:var(--brand);white-space:nowrap;';
    hud.appendChild(scoreText);
    frame.appendChild(hud);

    // Boss 血条（整行，默认隐藏）
    const bossBar = document.createElement('div');
    bossBar.style.cssText = 'display:none;margin-bottom:10px;';
    const bossName = document.createElement('div');
    bossName.style.cssText = 'font-size:12px;font-weight:700;color:var(--ink-2);margin-bottom:3px;text-align:center;letter-spacing:1px;';
    const bossTrack = document.createElement('div');
    bossTrack.style.cssText = 'height:14px;background:var(--bg);border:1px solid var(--line);border-radius:999px;overflow:hidden;';
    const bossFill = document.createElement('div');
    bossFill.style.cssText = 'height:100%;width:100%;background:linear-gradient(90deg,#f59e0b,#e5484d);transition:width .2s;';
    bossTrack.appendChild(bossFill);
    bossBar.appendChild(bossName);
    bossBar.appendChild(bossTrack);
    frame.appendChild(bossBar);

    // 画布
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;width:100%;';
    canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    canvas.style.cssText = 'width:100%;height:auto;border-radius:12px;background:linear-gradient(180deg,#0b1030 0%,#141a3c 60%,#1a2150 100%);display:block;touch-action:none;-webkit-user-select:none;user-select:none;';
    wrap.appendChild(canvas);
    frame.appendChild(wrap);
    g2d = canvas.getContext('2d');
    if (isTouch) bindTouch();

    // 提示
    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:12px;color:var(--ink-2);margin-top:10px;text-align:center;';
    hint.textContent = isTouch ? '拖动屏幕任意位置移动 · 自动射击' : '移动：WASD / 方向键 · 自动射击 · 1 血即死，10 秒复活';
    frame.appendChild(hint);

    // 结束区
    const overBox = document.createElement('div');
    overBox.style.cssText = 'display:none;';
    frame.appendChild(overBox);

    c.appendChild(frame);
    hudRefs = { pill, scoreText, shipStatus, bossBar, bossName, bossFill, overBox };
  }

  function updateHud(v) {
    if (!hudRefs) return;
    const { pill, scoreText, shipStatus, bossBar, bossName, bossFill, overBox } = hudRefs;

    pill.className = 'phase-pill' + (v.phase === 'lost' ? ' warn' : v.phase === 'won' ? ' ok' : '');
    pill.textContent = v.phase === 'playing' ? ('第 ' + v.wave + '/' + v.maxWaves + ' 波') : (v.phase === 'won' ? '胜利' : '失败');
    scoreText.textContent = '⭐ ' + v.score;

    // 双机状态
    UI.clear(shipStatus);
    for (const k of ['left', 'right']) {
      const s = v.ships[k];
      const chip = document.createElement('span');
      chip.style.cssText = 'padding:4px 10px;border-radius:999px;font-weight:700;font-size:12px;';
      if (s.alive) {
        chip.style.background = '#eefaf2'; chip.style.color = '#18a058';
        let label = k === 'left' ? '🟦 左机' : '🟩 右机';
        const buffIcons = [];
        if (s.buffs && s.buffs.power) buffIcons.push('⚡');
        if (s.buffs && s.buffs.spread) buffIcons.push('🔱');
        if (s.buffs && s.buffs.rapid) buffIcons.push('🔥');
        if (s.buffs && s.buffs.shield) buffIcons.push('🛡');
        chip.textContent = label + (buffIcons.length ? ' ' + buffIcons.join('') : '');
      } else {
        chip.style.background = '#fdecec'; chip.style.color = '#e5484d';
        chip.textContent = (k === 'left' ? '🟦 左机' : '🟩 右机') + ' 💀 复活 ' + Math.ceil(s.respawnT) + 's';
      }
      shipStatus.appendChild(chip);
    }

    // Boss 血条
    if (v.boss) {
      bossBar.style.display = '';
      const kind = BOSS_KINDS[v.boss.kind] || BOSS_KINDS.dreadnought;
      bossName.textContent = '☠ ' + kind.name + ' · ' + Math.max(0, v.boss.hp) + '/' + v.boss.maxHp;
      bossName.style.color = kind.color;
      bossFill.style.width = Math.max(0, (v.boss.hp / v.boss.maxHp) * 100) + '%';
      bossFill.style.background = 'linear-gradient(90deg,' + kind.color + ',#e5484d)';
    } else {
      bossBar.style.display = 'none';
    }

    // 结束
    if (v.phase !== 'playing' && !overBox.dataset.filled) {
      overBox.dataset.filled = '1';
      overBox.style.display = '';
      UI.clear(overBox);
      overBox.appendChild(UI.banner(v.phase === 'won' ? 'ok' : 'danger', v.over || '对局结束'));
      const bar = document.createElement('div');
      bar.className = 'actionbar';
      const restart = document.createElement('button');
      restart.className = 'btn btn-primary';
      restart.textContent = '再来一局';
      restart.addEventListener('click', () => {
        if (ctx.isHost) hostRestart();
        else Net.sendToHost({ type: 'th_restart' });
      });
      bar.appendChild(restart);
      const back = document.createElement('button');
      back.className = 'btn btn-ghost';
      back.textContent = '返回房间';
      back.addEventListener('click', () => ctx.leave());
      bar.appendChild(back);
      overBox.appendChild(bar);
    }
  }

  // ---------- 绘制 ----------
  function drawScene(v) {
    if (!g2d) return;
    g2d.clearRect(0, 0, W, H);
    let ox = 0, oy = 0;
    if (v.shake > 0) { ox = rnd(-v.shake, v.shake); oy = rnd(-v.shake, v.shake); }
    g2d.save();
    g2d.translate(ox, oy);

    drawBackground(v);

    for (const L of v.lasers) drawLaser(L);

    drawShip(v.ships.left, '#4f8cff');
    drawShip(v.ships.right, '#34d399');

    drawBullets(v.bullets);
    for (const e of v.enemies) drawEnemy(e);
    if (v.boss) drawBoss(v.boss);
    drawEnemyBullets(v.enemyBullets);
    drawHoming(v.homing);
    drawPickups(v.pickups);
    drawParticles(v.particles);
    drawTexts(v.texts);

    g2d.restore();
    if (isTouch && joy.active) drawJoystick();
  }

  function drawBackground(v) {
    for (let layer = 0; layer < 3; layer++) {
      const n = 40 - layer * 10;
      const speed = 0.5 + layer * 0.7;
      for (let i = 0; i < n; i++) {
        const sx = (i * 173 + layer * 97) % W;
        const sy = (i * 211 + Math.floor(v.score * speed * 2 + layer * 300) % H) % H;
        g2d.globalAlpha = 0.15 + layer * 0.18 + (i % 3) * 0.08;
        g2d.fillStyle = '#ffffff';
        const sz = layer === 0 ? 1 : layer === 1 ? 2 : 3;
        g2d.fillRect(sx, sy, sz, sz);
      }
    }
    g2d.globalAlpha = 1;
  }

  function drawBullets(bullets) {
    for (const b of bullets) {
      g2d.save();
      const grad = g2d.createLinearGradient(b.x, b.y, b.x, b.y + 20);
      grad.addColorStop(0, 'rgba(255,224,138,0)');
      grad.addColorStop(1, 'rgba(255,224,138,0.8)');
      g2d.fillStyle = grad;
      g2d.fillRect(b.x - 2, b.y + 4, 4, 16);
      g2d.fillStyle = '#fff7e0';
      g2d.beginPath(); g2d.arc(b.x, b.y, 3, 0, Math.PI * 2); g2d.fill();
      g2d.fillStyle = '#ffc94d';
      g2d.beginPath(); g2d.arc(b.x, b.y + 3, 2, 0, Math.PI * 2); g2d.fill();
      g2d.restore();
    }
  }

  function drawEnemyBullets(bullets) {
    for (const b of bullets) {
      g2d.save();
      const grad = g2d.createRadialGradient(b.x, b.y, 0, b.x, b.y, 8);
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.4, '#ff6b6b');
      grad.addColorStop(1, 'rgba(255,107,107,0)');
      g2d.fillStyle = grad;
      g2d.beginPath(); g2d.arc(b.x, b.y, 8, 0, Math.PI * 2); g2d.fill();
      g2d.restore();
    }
  }

  function drawHoming(homing) {
    for (const h of homing) {
      g2d.save();
      g2d.translate(h.x, h.y);
      g2d.rotate(Math.atan2(h.vy, h.vx));
      const grad = g2d.createRadialGradient(0, 0, 0, 0, 0, 10);
      grad.addColorStop(0, '#fff'); grad.addColorStop(0.4, '#ff6b6b'); grad.addColorStop(1, 'rgba(255,107,107,0)');
      g2d.fillStyle = grad;
      g2d.beginPath(); g2d.arc(0, 0, 10, 0, Math.PI * 2); g2d.fill();
      g2d.fillStyle = 'rgba(255,160,60,0.7)';
      g2d.beginPath(); g2d.moveTo(-6, -3); g2d.lineTo(-16, 0); g2d.lineTo(-6, 3);
      g2d.closePath(); g2d.fill();
      g2d.restore();
    }
  }

  function drawPickups(pickups) {
    for (const p of pickups) {
      const def = PICKUPS[p.type];
      if (!def) continue;
      const pulse = Math.sin(Date.now() / 120 + p.x) * 3;
      g2d.save();
      g2d.translate(p.x, p.y + pulse);
      g2d.globalAlpha = 0.25;
      g2d.fillStyle = def.color;
      g2d.beginPath(); g2d.arc(0, 0, 18, 0, Math.PI * 2); g2d.fill();
      g2d.globalAlpha = 1;
      g2d.fillStyle = def.color;
      g2d.beginPath(); g2d.arc(0, 0, 13, 0, Math.PI * 2); g2d.fill();
      g2d.fillStyle = '#fff';
      g2d.font = 'bold 16px sans-serif';
      g2d.textAlign = 'center';
      g2d.textBaseline = 'middle';
      g2d.fillText(def.icon, 0, 1);
      g2d.textBaseline = 'alphabetic';
      g2d.restore();
    }
  }

  function drawParticles(particles) {
    for (const p of particles) {
      const alpha = Math.max(0, Math.min(1, p.life * 2));
      g2d.globalAlpha = alpha;
      if (p.ring) {
        const r = (0.35 - p.life) * 240 + 8;
        g2d.strokeStyle = p.color;
        g2d.lineWidth = 3 * (p.life / 0.5);
        g2d.beginPath(); g2d.arc(p.x, p.y, r, 0, Math.PI * 2); g2d.stroke();
      } else {
        g2d.fillStyle = p.color;
        g2d.beginPath(); g2d.arc(p.x, p.y, p.size, 0, Math.PI * 2); g2d.fill();
      }
    }
    g2d.globalAlpha = 1;
  }

  function drawTexts(texts) {
    for (const t of texts) {
      g2d.globalAlpha = Math.max(0, Math.min(1, t.life));
      g2d.fillStyle = t.color;
      g2d.font = 'bold ' + (t.size || 18) + 'px sans-serif';
      g2d.textAlign = 'center';
      g2d.fillText(t.text, t.x, t.y);
    }
    g2d.globalAlpha = 1;
  }

  function drawLaser(L) {
    const { x, y, angle, width, state } = L;
    g2d.save();
    if (state === 'warn') {
      // 预警红线：前段虚线，锁定阶段变实线闪烁
      const locked = L.lockT !== undefined && L.t <= L.lockT;
      const blink = locked ? (Math.sin(Date.now() / 50) > 0 ? 1 : 0.7) : (Math.sin(Date.now() / 60) > 0 ? 1 : 0.35);
      g2d.globalAlpha = blink;
      g2d.strokeStyle = locked ? '#ff2222' : '#ff6666';
      g2d.lineWidth = width * 0.6;
      g2d.setLineDash(locked ? [] : [12, 8]);
      drawRay(x, y, angle, H);
      g2d.setLineDash([]);
    } else {
      g2d.globalAlpha = 0.5;
      g2d.strokeStyle = '#ff6b6b';
      g2d.lineWidth = width * 2.2;
      drawRay(x, y, angle, H);
      g2d.globalAlpha = 1;
      g2d.strokeStyle = '#fff';
      g2d.lineWidth = width;
      drawRay(x, y, angle, H);
      g2d.strokeStyle = '#ffd0d0';
      g2d.lineWidth = width * 0.4;
      drawRay(x, y, angle, H);
    }
    g2d.restore();
  }

  function drawRay(x, y, angle, len) {
    g2d.beginPath();
    g2d.moveTo(x, y);
    g2d.lineTo(x + Math.cos(angle) * len, y + Math.sin(angle) * len);
    g2d.stroke();
  }

  // 战机：存活绘制，死亡不绘制（爆炸已由粒子呈现）
  function drawShip(s, color) {
    if (!s || !s.alive) return;
    const x = s.x, y = s.y;
    const invulnBlink = s.invulnT > 0 && Math.sin(Date.now() / 40) > 0;
    if (invulnBlink) g2d.globalAlpha = 0.4;
    g2d.save();
    g2d.translate(x, y);

    // 无敌护盾 / 复活无敌光环
    if (s.buffs && s.buffs.shield) {
      g2d.globalAlpha = 0.5 + Math.sin(Date.now() / 120) * 0.2;
      g2d.strokeStyle = '#22c55e';
      g2d.lineWidth = 3;
      g2d.beginPath(); g2d.arc(0, 0, SHIP_H * 0.75, 0, Math.PI * 2); g2d.stroke();
      g2d.globalAlpha = 0.2;
      g2d.fillStyle = '#22c55e';
      g2d.beginPath(); g2d.arc(0, 0, SHIP_H * 0.75, 0, Math.PI * 2); g2d.fill();
    } else if (s.invulnT > 0) {
      g2d.globalAlpha = 0.4 + Math.sin(Date.now() / 80) * 0.2;
      g2d.strokeStyle = '#22d3ee';
      g2d.lineWidth = 3;
      g2d.beginPath(); g2d.arc(0, 0, SHIP_H * 0.75, 0, Math.PI * 2); g2d.stroke();
    }
    g2d.globalAlpha = 1;

    // 尾焰
    const flick = Math.sin(Date.now() / 40) * 5;
    g2d.fillStyle = 'rgba(251,191,36,0.9)';
    g2d.beginPath();
    g2d.moveTo(-7, SHIP_H / 2 - 8);
    g2d.lineTo(0, SHIP_H / 2 + 12 + flick);
    g2d.lineTo(7, SHIP_H / 2 - 8);
    g2d.closePath(); g2d.fill();
    g2d.fillStyle = '#fff';
    g2d.beginPath();
    g2d.moveTo(-3, SHIP_H / 2 - 6);
    g2d.lineTo(0, SHIP_H / 2 + 4 + flick * 0.6);
    g2d.lineTo(3, SHIP_H / 2 - 6);
    g2d.closePath(); g2d.fill();

    // 主机身
    g2d.fillStyle = color;
    g2d.beginPath();
    g2d.moveTo(0, -SHIP_H / 2);
    g2d.lineTo(SHIP_W / 2, SHIP_H / 2 - 6);
    g2d.lineTo(6, SHIP_H / 2 - 10);
    g2d.lineTo(0, SHIP_H / 2 - 4);
    g2d.lineTo(-6, SHIP_H / 2 - 10);
    g2d.lineTo(-SHIP_W / 2, SHIP_H / 2 - 6);
    g2d.closePath(); g2d.fill();

    // 侧翼
    g2d.fillStyle = 'rgba(0,0,0,0.25)';
    g2d.beginPath();
    g2d.moveTo(-SHIP_W / 2, SHIP_H / 2 - 6);
    g2d.lineTo(-SHIP_W / 2 - 6, SHIP_H / 2 + 2);
    g2d.lineTo(-6, SHIP_H / 2 - 8);
    g2d.closePath(); g2d.fill();
    g2d.beginPath();
    g2d.moveTo(SHIP_W / 2, SHIP_H / 2 - 6);
    g2d.lineTo(SHIP_W / 2 + 6, SHIP_H / 2 + 2);
    g2d.lineTo(6, SHIP_H / 2 - 8);
    g2d.closePath(); g2d.fill();

    // 座舱
    g2d.fillStyle = '#e0f2fe';
    g2d.beginPath(); g2d.ellipse(0, -4, 6, 12, 0, 0, Math.PI * 2); g2d.fill();

    // 高光
    g2d.fillStyle = 'rgba(255,255,255,0.35)';
    g2d.beginPath();
    g2d.moveTo(-3, -SHIP_H / 2 + 4); g2d.lineTo(0, -SHIP_H / 2 + 8); g2d.lineTo(3, -SHIP_H / 2 + 4); g2d.lineTo(0, -SHIP_H / 2 + 14);
    g2d.closePath(); g2d.fill();

    g2d.restore();
    g2d.globalAlpha = 1;
  }

  function drawEnemy(e) {
    const x = e.x, y = e.y;
    g2d.save();
    g2d.translate(x, y);
    switch (e.type) {
      case 'small':
        g2d.fillStyle = '#f87171';
        g2d.beginPath(); g2d.moveTo(0, 16); g2d.lineTo(14, -12); g2d.lineTo(0, -4); g2d.lineTo(-14, -12);
        g2d.closePath(); g2d.fill();
        g2d.fillStyle = '#fff';
        g2d.beginPath(); g2d.arc(-4, -2, 3, 0, Math.PI * 2); g2d.fill();
        g2d.beginPath(); g2d.arc(4, -2, 3, 0, Math.PI * 2); g2d.fill();
        g2d.fillStyle = '#000';
        g2d.beginPath(); g2d.arc(-4, -2, 1.5, 0, Math.PI * 2); g2d.fill();
        g2d.beginPath(); g2d.arc(4, -2, 1.5, 0, Math.PI * 2); g2d.fill();
        break;
      case 'zig':
        g2d.fillStyle = '#fbbf24';
        g2d.beginPath(); g2d.moveTo(0, 14); g2d.lineTo(16, 6); g2d.lineTo(8, -12); g2d.lineTo(-8, -12); g2d.lineTo(-16, 6);
        g2d.closePath(); g2d.fill();
        g2d.fillStyle = '#fff';
        g2d.beginPath(); g2d.arc(0, 0, 4, 0, Math.PI * 2); g2d.fill();
        break;
      case 'shooter':
        g2d.fillStyle = '#c084fc';
        g2d.beginPath(); g2d.arc(0, 0, 16, 0, Math.PI * 2); g2d.fill();
        g2d.fillStyle = '#7c3aed';
        g2d.beginPath(); g2d.arc(0, 0, 10, 0, Math.PI * 2); g2d.fill();
        g2d.fillStyle = '#e9d5ff';
        g2d.beginPath(); g2d.arc(0, 0, 4, 0, Math.PI * 2); g2d.fill();
        g2d.fillStyle = '#6b21a8';
        g2d.fillRect(-3, 10, 6, 12);
        break;
      case 'tank':
        g2d.fillStyle = '#94a3b8';
        g2d.beginPath(); g2d.arc(0, 0, 22, 0, Math.PI * 2); g2d.fill();
        g2d.fillStyle = '#64748b';
        g2d.beginPath(); g2d.arc(0, 0, 14, 0, Math.PI * 2); g2d.fill();
        g2d.fillStyle = '#e2e8f0';
        g2d.beginPath(); g2d.arc(0, -2, 6, 0, Math.PI * 2); g2d.fill();
        g2d.fillStyle = '#475569';
        g2d.fillRect(-3, 12, 6, 14);
        break;
      case 'splitter':
        g2d.fillStyle = '#34d399';
        g2d.beginPath(); g2d.arc(0, 0, 15, 0, Math.PI * 2); g2d.fill();
        g2d.fillStyle = '#065f46';
        g2d.beginPath(); g2d.arc(0, 0, 8, 0, Math.PI * 2); g2d.fill();
        g2d.fillStyle = '#fff';
        g2d.beginPath(); g2d.arc(0, 0, 3, 0, Math.PI * 2); g2d.fill();
        break;
      case 'diver':
        g2d.fillStyle = '#fb7185';
        g2d.beginPath(); g2d.moveTo(0, -16); g2d.lineTo(16, 8); g2d.lineTo(0, 2); g2d.lineTo(-16, 8);
        g2d.closePath(); g2d.fill();
        g2d.fillStyle = '#fff';
        g2d.beginPath(); g2d.arc(0, -4, 4, 0, Math.PI * 2); g2d.fill();
        break;
    }
    g2d.restore();
  }

  // Boss：按种类绘制不同造型
  function drawBoss(b) {
    const x = b.x, y = b.y;
    const kind = BOSS_KINDS[b.kind] || BOSS_KINDS.dreadnought;
    const s = kind.scale;
    const flash = b.hitFlash ? 1 : 0;
    g2d.save();
    g2d.translate(x, y);
    g2d.scale(s, s);

    const bodyColor = flash ? '#ffffff' : kind.color;

    // 护盾光环
    const glow = Math.sin(b.phase * 2) * 0.2 + 0.4;
    g2d.globalAlpha = glow;
    g2d.strokeStyle = kind.color;
    g2d.lineWidth = 4;
    g2d.beginPath(); g2d.arc(0, 0, 78, 0, Math.PI * 2); g2d.stroke();
    g2d.globalAlpha = 0.12;
    g2d.fillStyle = kind.color;
    g2d.beginPath(); g2d.arc(0, 0, 78, 0, Math.PI * 2); g2d.fill();
    g2d.globalAlpha = 1;

    if (b.kind === 'phantom') {
      drawPhantom(flash);
    } else if (b.kind === 'juggernaut') {
      drawJuggernaut(flash);
    } else {
      drawDreadnought(flash);
    }

    g2d.restore();
  }

  function drawDreadnought(flash) {
    const bodyColor = flash ? '#fecaca' : '#e5484d';
    // 尾翼
    g2d.fillStyle = flash ? '#fecaca' : '#9f1239';
    g2d.beginPath(); g2d.moveTo(-30, 40); g2d.lineTo(-58, 70); g2d.lineTo(-18, 52); g2d.closePath(); g2d.fill();
    g2d.beginPath(); g2d.moveTo(30, 40); g2d.lineTo(58, 70); g2d.lineTo(18, 52); g2d.closePath(); g2d.fill();
    // 主舰体
    g2d.fillStyle = bodyColor;
    g2d.beginPath(); g2d.moveTo(0, -52); g2d.lineTo(52, -12); g2d.lineTo(44, 42); g2d.lineTo(-44, 42); g2d.lineTo(-52, -12);
    g2d.closePath(); g2d.fill();
    g2d.fillStyle = flash ? '#fecaca' : '#7f1d1d';
    g2d.beginPath(); g2d.moveTo(-40, 8); g2d.lineTo(40, 8); g2d.lineTo(36, 30); g2d.lineTo(-36, 30); g2d.closePath(); g2d.fill();
    // 机翼
    g2d.fillStyle = flash ? '#fecaca' : '#b91c1c';
    g2d.beginPath(); g2d.moveTo(-52, -12); g2d.lineTo(-78, -30); g2d.lineTo(-44, -4); g2d.closePath(); g2d.fill();
    g2d.beginPath(); g2d.moveTo(52, -12); g2d.lineTo(78, -30); g2d.lineTo(44, -4); g2d.closePath(); g2d.fill();
    // 炮口
    g2d.fillStyle = flash ? '#fff' : '#450a0a';
    g2d.fillRect(-44, -20, 10, 22);
    g2d.fillRect(34, -20, 10, 22);
    // 核心
    g2d.globalAlpha = Math.sin(state ? state.time * 4 : 0) * 0.3 + 0.7;
    g2d.fillStyle = '#fbbf24';
    g2d.beginPath(); g2d.arc(0, -6, 16, 0, Math.PI * 2); g2d.fill();
    g2d.globalAlpha = 1;
    g2d.fillStyle = '#fff7e0';
    g2d.beginPath(); g2d.arc(0, -6, 8, 0, Math.PI * 2); g2d.fill();
    // 引擎
    g2d.fillStyle = '#450a0a';
    g2d.fillRect(-16, 40, 12, 10);
    g2d.fillRect(4, 40, 12, 10);
  }

  function drawPhantom(flash) {
    const bodyColor = flash ? '#ede9fe' : '#8b5cf6';
    // 幽灵般修长的机身 + 多条触手
    g2d.fillStyle = bodyColor;
    g2d.beginPath();
    g2d.moveTo(0, -56);
    g2d.lineTo(34, -10);
    g2d.lineTo(22, 44);
    g2d.lineTo(-22, 44);
    g2d.lineTo(-34, -10);
    g2d.closePath(); g2d.fill();
    // 触手
    g2d.strokeStyle = flash ? '#ede9fe' : '#6d28d9';
    g2d.lineWidth = 5;
    for (let i = -2; i <= 2; i++) {
      g2d.beginPath();
      g2d.moveTo(i * 12, 40);
      g2d.quadraticCurveTo(i * 30, 70, i * 40 + Math.sin(state ? state.time * 3 : 0) * 10, 90);
      g2d.stroke();
    }
    // 单眼核心
    g2d.fillStyle = '#f0abfc';
    g2d.beginPath(); g2d.arc(0, -8, 18, 0, Math.PI * 2); g2d.fill();
    g2d.fillStyle = '#fff';
    g2d.beginPath(); g2d.arc(0, -8, 9, 0, Math.PI * 2); g2d.fill();
    g2d.fillStyle = '#4c1d95';
    g2d.beginPath(); g2d.arc(0, -8, 4, 0, Math.PI * 2); g2d.fill();
  }

  function drawJuggernaut(flash) {
    const bodyColor = flash ? '#fef3c7' : '#f59e0b';
    // 厚重堡垒型
    g2d.fillStyle = bodyColor;
    g2d.beginPath();
    g2d.moveTo(0, -44);
    g2d.lineTo(60, -20);
    g2d.lineTo(60, 40);
    g2d.lineTo(-60, 40);
    g2d.lineTo(-60, -20);
    g2d.closePath(); g2d.fill();
    // 装甲层
    g2d.fillStyle = flash ? '#fef3c7' : '#b45309';
    g2d.fillRect(-60, 6, 120, 12);
    g2d.fillRect(-60, 24, 120, 12);
    // 三连炮
    g2d.fillStyle = flash ? '#fff' : '#78350f';
    for (let i = -1; i <= 1; i++) {
      g2d.fillRect(i * 28 - 6, -30, 12, 20);
    }
    // 核心（方形反应堆）
    g2d.fillStyle = '#fef08a';
    g2d.beginPath(); g2d.rect(-14, -10, 28, 28); g2d.fill();
    g2d.fillStyle = '#fff';
    g2d.beginPath(); g2d.rect(-6, -2, 12, 12); g2d.fill();
    // 底部炮台
    g2d.fillStyle = '#78350f';
    g2d.fillRect(-8, 38, 16, 10);
  }

  function drawJoystick() {
    const cx = joy.ox, cy = joy.oy;
    const dx = clamp(joy.dx, -60, 60);
    const dy = clamp(joy.dy, -60, 60);
    g2d.save();
    g2d.globalAlpha = 0.35;
    g2d.fillStyle = '#ffffff';
    g2d.beginPath(); g2d.arc(cx, cy, 60, 0, Math.PI * 2); g2d.fill();
    g2d.globalAlpha = 0.5;
    g2d.strokeStyle = '#5b5bd6';
    g2d.lineWidth = 3;
    g2d.beginPath(); g2d.arc(cx, cy, 60, 0, Math.PI * 2); g2d.stroke();
    g2d.globalAlpha = 0.8;
    g2d.fillStyle = '#5b5bd6';
    g2d.beginPath(); g2d.arc(cx + dx, cy + dy, 26, 0, Math.PI * 2); g2d.fill();
    g2d.globalAlpha = 1;
    g2d.fillStyle = '#fff';
    g2d.beginPath(); g2d.arc(cx + dx, cy + dy, 14, 0, Math.PI * 2); g2d.fill();
    g2d.restore();
  }

  return { init, handleMessage };
})();
