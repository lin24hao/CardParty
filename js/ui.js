// 通用 UI 工具：卡牌渲染、提示、弹窗、头像
const UI = (() => {
  const AVATAR_COLORS = ['#5b5bd6', '#e5484d', '#18a058', '#f59e0b', '#0ea5e9', '#ec4899', '#14b8a6', '#8b5cf6'];

  function colorFor(id) {
    let h = 0;
    for (let i = 0; i < (id || '').length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
  }

  function avatarEl(id, name) {
    const div = document.createElement('div');
    div.className = 'avatar';
    div.style.background = colorFor(id);
    div.textContent = (name || '?').trim().charAt(0).toUpperCase() || '?';
    return div;
  }

  // 卡牌元素：card = {suit, rank}；opts.faceDown / opts.small / opts.selectable
  function cardEl(card, opts = {}) {
    const { faceDown = false, small = false, selectable = false } = opts;
    const el = document.createElement('div');
    let cls = 'card';
    if (small) cls += ' small';
    if (selectable) cls += ' selectable';
    if (faceDown) {
      cls += ' facedown';
      el.className = cls;
      return el;
    }
    if (card.joker) {
      cls += ' joker';
      el.className = cls;
      el.innerHTML =
        '<span class="corner tl"><b>王</b><i>🃏</i></span>' +
        '<span class="pip">🃏</span>' +
        '<span class="corner br"><b>王</b><i>🃏</i></span>';
      return el;
    }
    cls += Deck.isRed(card.suit) ? ' red' : ' black';
    el.className = cls;
    el.innerHTML =
      '<span class="corner tl"><b>' + card.rank + '</b><i>' + card.suit + '</i></span>' +
      '<span class="pip">' + card.suit + '</span>' +
      '<span class="corner br"><b>' + card.rank + '</b><i>' + card.suit + '</i></span>';
    return el;
  }

  function cardBackEl(small = false) {
    return cardEl(null, { faceDown: true, small });
  }

  function clear(el) { el.innerHTML = ''; }

  let toastTimer = null;
  function toast(msg, ms = 2400) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  // 弹窗
  function modal(title, bodyHTML, actions) {
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').innerHTML = bodyHTML;
    const box = document.getElementById('modal-actions');
    UI.clear(box);
    (actions || []).forEach(a => {
      const b = document.createElement('button');
      b.className = 'btn ' + (a.primary ? 'btn-primary' : 'btn-ghost');
      b.textContent = a.label;
      b.addEventListener('click', () => { closeModal(); a.onClick && a.onClick(); });
      box.appendChild(b);
    });
    document.getElementById('modal').classList.remove('hidden');
  }

  function closeModal() { document.getElementById('modal').classList.add('hidden'); }

  function banner(cls, text) {
    const d = document.createElement('div');
    d.className = 'banner ' + (cls || '');
    d.textContent = text;
    return d;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  return { avatarEl, cardEl, cardBackEl, clear, toast, modal, closeModal, banner, esc, colorFor };
})();
