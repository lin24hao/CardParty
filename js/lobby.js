// 大厅公共聊天室：基于公共 MQTT broker，无需加入房间即可聊天
//
// 为什么需要它：纯静态 + 无后端的架构下，浏览器无法在局域网内「广播」去发现
// 同样打开本页的陌生人（没有 UDP 广播、没有 mDNS 发现）。要让「还没进房间」的人
// 互相看到对方的消息，必须借助一个公共消息通道。这里选用免费的公共 MQTT broker
// （EMQX 官方 public broker），零注册、纯前端即可使用。
//
// 隐私提示：大厅消息会经第三方公共服务器中转，且「大厅」是全局公共频道，
// 请勿发送手机号、密码等敏感信息。加入房间后的聊天走 WebRTC 局域网直连（见 net.js），
// 不经公共服务器，更私密。
const Lobby = (() => {
  // 中国区优先，国际区兜底（GitHub Pages 可能被国内外玩家访问）
  const BROKERS = [
    'wss://broker-cn.emqx.io:8084/mqtt',
    'wss://broker.emqx.io:8084/mqtt',
  ];
  const CHANNEL = 'global'; // 大厅频道，预留可扩展为可自定义
  const handlers = {};

  let client = null;
  let connected = false;
  let connecting = false;
  let brokerIdx = 0;
  let manualClose = false;

  // 匿名 ID：用于区分「自己发的消息」，避免重复显示；跨会话稳定
  let myId = localStorage.getItem('wc_anon_id');
  if (!myId) {
    myId = 'u' + Math.random().toString(36).slice(2, 10);
    localStorage.setItem('wc_anon_id', myId);
  }

  function on(type, fn) { (handlers[type] = handlers[type] || []).push(fn); }
  function emit(type, data) { (handlers[type] || []).forEach(fn => fn(data)); }
  function topic() { return 'cardparty/lobby/' + CHANNEL; }
  function isAvailable() { return typeof mqtt !== 'undefined'; }

  function connect() {
    manualClose = false;
    if (!isAvailable()) { emit('status', { level: 'unavailable' }); return; }
    if (client || connecting) return;
    connecting = true;
    brokerIdx = 0;
    tryConnect();
  }

  function tryConnect() {
    if (!connecting) return;
    if (brokerIdx >= BROKERS.length) {
      connecting = false;
      emit('status', { level: 'error' });
      return;
    }
    const url = BROKERS[brokerIdx];
    let settled = false;
    let c = null;

    try {
      c = mqtt.connect(url, {
        clientId: 'cardparty_' + myId + '_' + Math.random().toString(36).slice(2, 6),
        keepalive: 60,
        clean: true,
        connectTimeout: 8000,
        reconnectPeriod: 0, // 手动控制回退与重连
        protocolVersion: 4,
      });
    } catch (e) {
      brokerIdx++;
      tryConnect();
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { c.end(true); } catch (e) {}
      brokerIdx++;
      tryConnect();
    }, 8000);

    c.on('connect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client = c;
      connected = true;
      connecting = false;
      c.subscribe(topic(), { qos: 0 });
      emit('status', { level: 'connected' });
    });

    c.on('message', (t, payload) => {
      let msg;
      try { msg = JSON.parse(payload.toString()); } catch (e) { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.id === myId) return; // 忽略自己（可能被 broker 回环）
      emit('message', msg);
    });

    c.on('close', () => {
      if (client !== c) return;
      client = null;
      connected = false;
      connecting = false;
      const wasManual = manualClose;
      manualClose = false;
      emit('status', { level: 'closed' });
      // 非主动关闭则自动重连（公共 broker 偶发断开很常见）
      if (!wasManual) {
        setTimeout(() => { if (!client && !connecting) connect(); }, 3000);
      }
    });

    c.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { c.end(true); } catch (e) {}
      brokerIdx++;
      tryConnect();
    });
  }

  function send(name, text) {
    if (!client || !connected) return false;
    const msg = {
      id: myId,
      name: String(name || '玩家').slice(0, 12),
      text: String(text).slice(0, 200),
      ts: Date.now(),
    };
    client.publish(topic(), JSON.stringify(msg), { qos: 0 });
    return true;
  }

  function disconnect() {
    manualClose = true;
    connecting = false;
    brokerIdx = 0;
    if (client) { try { client.end(true); } catch (e) {} client = null; }
    connected = false;
  }

  return {
    on, connect, send, disconnect,
    isAvailable,
    connected: () => connected,
    myId: () => myId,
    topic,
  };
})();
