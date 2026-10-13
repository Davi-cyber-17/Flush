'use strict';
/* =====================================================================
   PIVE — jogo de cartas (2 a 6 jogadores)
   Modo Local : todos no mesmo aparelho
   Modo Online: salas via WebRTC (PeerJS). O criador da sala é o "anfitrião"
                e roda a partida; os outros jogadores se conectam a ele.
   ===================================================================== */

/* ===================== Utilidades ===================== */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
const val   = r => ({ A: 1, J: 11, Q: 12, K: 13 })[r] || +r;
const isJ   = c => c.r === 'JK';
const isRed = c => c.s === '♥' || c.s === '♦';

function makeDeck() {
  let id = 0; const d = [];
  for (let k = 0; k < 2; k++) for (const s of SUITS) for (const r of RANKS) d.push({ id: id++, r, s });
  for (let j = 0; j < 4; j++) d.push({ id: id++, r: 'JK', s: '' });
  return d;
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

/* ===================== Regras: validação de jogos ===================== */
// Um grupo é válido se for trinca/quadra (mesmo valor, naipes distintos)
// ou sequência (mesmo naipe, valores consecutivos). Coringas substituem qualquer carta.
function validGroup(cs) {
  if (cs.length < 3) return false;
  const n = cs.filter(c => !isJ(c));
  const jokers = cs.length - n.length;
  if (n.length === 0) return true;

  // trinca / quadra
  if (cs.length <= 4 && n.every(c => c.r === n[0].r) && new Set(n.map(c => c.s)).size === n.length) return true;

  // sequência
  if (n.every(c => c.s === n[0].s) && new Set(n.map(c => c.r)).size === n.length) {
    const hasAce = n.some(c => c.r === 'A');
    for (const aceHigh of hasAce ? [false, true] : [false]) {
      const vs = n.map(c => (c.r === 'A' && aceHigh) ? 14 : val(c.r)).sort((a, b) => a - b);
      const span = vs[vs.length - 1] - vs[0] + 1;
      const gaps = span - vs.length;
      if (gaps <= jokers && (jokers - gaps) <= 14 - span) return true;
    }
  }
  return false;
}

// Tenta dividir as cartas em grupos válidos. Retorna a lista de grupos ou null.
function partition(cards) {
  const cs = [...cards].sort((a, b) => isJ(a) - isJ(b));
  const rec = rem => {
    if (rem.length === 0) return [];
    if (rem.length < 3) return null;
    const first = rem[0], rest = rem.slice(1), m = rest.length;
    for (let mask = 0; mask < (1 << m); mask++) {
      const g = [first], others = [];
      for (let i = 0; i < m; i++) ((mask >> i) & 1 ? g : others).push(rest[i]);
      if (g.length < 3 || !validGroup(g)) continue;
      const r = rec(others);
      if (r) return [g, ...r];
    }
    return null;
  };
  return rec(cs);
}

/* ===================== Motor do jogo ===================== */
class Game {
  constructor(names) { this.names = names; this.deal(); }

  deal() {
    this.stock = shuffle(makeDeck());
    this.players = this.names.map(name => ({ name, hand: [], out: false }));
    for (let k = 0; k < 9; k++) this.players.forEach(p => p.hand.push(this.stock.pop()));
    this.discardPile = [this.stock.pop()];
    this.turn = 0; this.phase = 'draw';
    this.winner = null; this.groups = null; this.winDiscard = null;
    this.lastFromDiscard = null; this.reason = '';
  }

  active() { return this.players.filter(p => !p.out).length; }

  refill() {
    if (!this.stock.length && this.discardPile.length > 1) {
      const top = this.discardPile.pop();
      this.stock = shuffle(this.discardPile);
      this.discardPile = [top];
    }
  }

  check(pi, phase) {
    if (this.winner !== null) return 'A rodada já terminou.';
    if (pi !== this.turn) return 'Não é a sua vez.';
    if (this.phase !== phase) return phase === 'draw' ? 'Você já comprou. Agora descarte uma carta.' : 'Compre uma carta primeiro.';
    return null;
  }

  draw(pi, from) {
    const e = this.check(pi, 'draw'); if (e) return { error: e };
    let c;
    if (from === 'discard') {
      if (!this.discardPile.length) return { error: 'O lixo está vazio.' };
      c = this.discardPile.pop(); this.lastFromDiscard = c.id;
    } else {
      this.refill();
      if (!this.stock.length) return { error: 'Não há cartas no monte.' };
      c = this.stock.pop(); this.lastFromDiscard = null;
    }
    this.players[pi].hand.push(c);
    this.phase = 'discard';
    return {};
  }

  discard(pi, cardId) {
    const e = this.check(pi, 'discard'); if (e) return { error: e };
    const hand = this.players[pi].hand;
    const i = hand.findIndex(c => c.id === cardId);
    if (i < 0) return { error: 'Selecione uma carta para descartar.' };
    if (cardId === this.lastFromDiscard) return { error: 'Você não pode descartar a carta que acabou de pegar do lixo.' };
    this.discardPile.push(hand.splice(i, 1)[0]);
    this.next();
    return {};
  }

  bate(pi) {
    const e = this.check(pi, 'discard'); if (e) return { error: e };
    const hand = this.players[pi].hand;
    for (let i = 0; i < hand.length; i++) {
      const g = partition(hand.filter((_, k) => k !== i));
      if (g) {
        this.winDiscard = hand[i]; this.groups = g;
        this.players[pi].hand = [];
        this.winner = pi; this.reason = '';
        return {};
      }
    }
    return { error: 'Suas cartas ainda não formam jogos válidos para bater.' };
  }

  next() {
    if (this.active() <= 1) {
      const w = this.players.findIndex(p => !p.out);
      this.winner = w < 0 ? 0 : w; this.groups = null; this.winDiscard = null;
      this.reason = 'Todos os outros jogadores saíram.';
      return;
    }
    let t = this.turn;
    do { t = (t + 1) % this.players.length; } while (this.players[t].out);
    this.turn = t; this.phase = 'draw'; this.lastFromDiscard = null;
  }

  leave(pi) {
    const p = this.players[pi];
    if (!p || p.out) return;
    p.out = true;
    this.stock.unshift(...p.hand); p.hand = [];
    if (this.winner !== null) return;
    if (this.active() <= 1 || pi === this.turn) this.next();
  }

  // Visão da partida para o jogador "me" (esconde as mãos dos outros)
  view(me) {
    return {
      me, turn: this.turn, phase: this.phase,
      players: this.players.map(p => ({ name: p.name, count: p.hand.length, out: p.out, off: !!p.off })),
      hand: me >= 0 ? this.players[me].hand : [],
      top: this.discardPile[this.discardPile.length - 1] || null,
      stockCount: this.stock.length,
      winner: this.winner, groups: this.groups, winDiscard: this.winDiscard, reason: this.reason,
      last: this.lastFromDiscard
    };
  }
}

/* ===================== Estado da aplicação ===================== */
let mode = null;            // 'local' | 'online'
let game = null;            // instância do Game (local ou anfitrião)
let covered = false;        // modo local: tela de "passe o aparelho"
let selectedId = null;
const orders = {};          // ordem das cartas na mão (por jogador)

/* ===================== Navegação ===================== */
function showScreen(id) {
  $$('.screen').forEach(s => s.classList.toggle('active', s.id === 'screen-' + id));
  window.scrollTo(0, 0);
}
$$('[data-back]').forEach(b => b.addEventListener('click', () => showScreen('menu')));
$('#btnOnline').onclick = () => { $('#onlineMsg').textContent = ''; showScreen('online'); };
$('#btnLocal').onclick  = () => { renderLocalSetup(); showScreen('local'); };
['#btnRules', '#btnRules2'].forEach(s => $(s).onclick = () => $('#rules').classList.add('show'));
$('#btnCloseRules').onclick = () => $('#rules').classList.remove('show');
$('#rules').addEventListener('click', e => { if (e.target.id === 'rules') $('#rules').classList.remove('show'); });

/* ===================== MODO LOCAL ===================== */
let localCount = 2;
function renderLocalSetup() {
  $('#lpCount').textContent = localCount;
  const box = $('#localNames');
  const old = $$('input', box).map(i => i.value);
  box.innerHTML = '';
  for (let i = 0; i < localCount; i++) {
    const inp = document.createElement('input');
    inp.maxLength = 14; inp.placeholder = 'Jogador ' + (i + 1); inp.value = old[i] || '';
    box.appendChild(inp);
  }
}
$('#lpMinus').onclick = () => { if (localCount > 2) { localCount--; renderLocalSetup(); } };
$('#lpPlus').onclick  = () => { if (localCount < 6) { localCount++; renderLocalSetup(); } };
$('#btnStartLocal').onclick = () => {
  const names = $$('input', $('#localNames')).map((i, k) => i.value.trim() || 'Jogador ' + (k + 1));
  mode = 'local'; game = new Game(names); covered = true; selectedId = null;
  $('#roomTag').textContent = 'MODO LOCAL';
  showScreen('game'); renderGame();
};

/* ===================== Ações (comum aos modos) ===================== */
function doAction(a, arg) {
  if (mode === 'online' && !isHost) { hostConn && hostConn.open && hostConn.send({ t: 'act', a, arg }); return; }
  runAction(mode === 'local' ? game.turn : 0, a, arg, null);
}

function runAction(pi, a, arg, conn) {
  const prevTurn = game.turn;
  let r;
  if (a === 'draw') r = game.draw(pi, arg);
  else if (a === 'discard') r = game.discard(pi, arg);
  else if (a === 'bate') r = game.bate(pi);
  else return;
  if (r.error) { conn ? conn.send({ t: 'err', m: r.error }) : toast(r.error); return; }
  if (a !== 'draw' && (mode === 'local' || pi === 0)) selectedId = null;
  if (mode === 'local' && game.turn !== prevTurn && game.winner === null) covered = true;
  if (mode === 'online') broadcast();
  renderGame();
}

/* ===================== Renderização do jogo ===================== */
function currentView() {
  if (mode === 'local') return game ? game.view(game.turn) : null;
  if (mode === 'online') return isHost ? (game ? game.view(0) : null) : lastView;
  return null;
}
const myTurn = v => v && v.winner === null && v.me === v.turn && !(mode === 'local' && covered);

function cardEl(c, extra = '') {
  const d = document.createElement('div');
  d.className = 'card ' + (isJ(c) ? 'joker' : isRed(c) ? 'red' : '') + ' ' + extra;
  d.dataset.id = c.id;
  const r = isJ(c) ? '★' : c.r, s = isJ(c) ? 'JK' : c.s;
  d.innerHTML = `<div class="corner tl"><b>${r}</b><i>${s}</i></div><div class="pip">${isJ(c) ? '★' : c.s}</div><div class="corner br"><b>${r}</b><i>${s}</i></div>`;
  return d;
}
const backEl  = () => { const d = document.createElement('div'); d.className = 'card back'; return d; };
const emptyEl = () => { const d = document.createElement('div'); d.className = 'empty'; return d; };

function renderGame() {
  const v = currentView();
  if (!v || !$('#screen-game').classList.contains('active')) return;
  const n = v.players.length, mine = myTurn(v);

  // Adversários
  const opps = $('#opps'); opps.innerHTML = '';
  for (let k = 1; k < n; k++) {
    const i = (v.me + k) % n, p = v.players[i];
    const d = document.createElement('div');
    d.className = 'opp hud' + (v.turn === i && v.winner === null ? ' turn' : '') + (p.out ? ' out' : '') + (p.off ? ' off' : '');
    d.innerHTML = `<div class="oname">${esc(p.name)}</div><div class="ofan">${'<span class="mini"></span>'.repeat(Math.min(p.count, 10))}</div><div class="ocount">${p.out ? 'saiu' : p.off ? 'reconectando…' : p.count + ' cartas'}</div>`;
    opps.appendChild(d);
  }

  // Monte e lixo
  $('#stockCard').replaceChildren(backEl());
  $('#stockCount').textContent = v.stockCount;
  $('#discardCard').replaceChildren(v.top ? cardEl(v.top) : emptyEl());
  const canDraw = mine && v.phase === 'draw';
  $('#stockPile').classList.toggle('active', canDraw);
  $('#discardPile').classList.toggle('active', canDraw && !!v.top);

  // Status
  const cur = v.players[v.turn];
  $('#status').textContent = v.winner !== null ? '' :
    mine ? (v.phase === 'draw' ? 'Sua vez! Compre do monte ou pegue a carta do lixo.' : 'Escolha uma carta para descartar — ou bata!')
         : (mode === 'local' ? '' : `Vez de ${cur.name}…`);

  // Mão
  const ids = new Set(v.hand.map(c => c.id));
  if (!ids.has(selectedId)) selectedId = null;
  let ord = (orders[v.me] || []).filter(i => ids.has(i));
  v.hand.forEach(c => { if (!ord.includes(c.id)) ord.push(c.id); });
  orders[v.me] = ord;
  const byId = new Map(v.hand.map(c => [c.id, c]));
  const hand = $('#hand'); hand.innerHTML = '';
  ord.forEach(id => {
    const el = cardEl(byId.get(id));
    if (id === selectedId) el.classList.add('sel');
    el.onclick = () => { selectedId = selectedId === id ? null : id; renderGame(); };
    el.ondblclick = () => { selectedId = id; if (mine && v.phase === 'discard') doAction('discard', id); };
    hand.appendChild(el);
  });
  $('#handName').textContent = v.winner !== null ? '' : `Mão de ${v.players[v.me].name} (${v.hand.length} cartas)`;

  // Botões
  $('#btnDiscard').disabled = !(mine && v.phase === 'discard' && selectedId !== null);
  $('#btnBate').disabled = !(mine && v.phase === 'discard');

  renderOverlay(v);
  updateNet();
}

function renderOverlay(v) {
  const ov = $('#overlay');
  if (v.winner !== null) {
    const w = v.players[v.winner];
    const you = mode === 'online' && v.winner === v.me;
    ov.innerHTML = `<div class="obox hud"><h2>🏆 ${you ? 'Você bateu!' : esc(w.name) + ' bateu!'}</h2>
      ${v.reason ? `<p>${esc(v.reason)}</p>` : '<div class="groups" id="wgroups"></div>'}
      <div class="row" id="wbtns"></div></div>`;
    if (v.groups) {
      const box = $('#wgroups', ov);
      v.groups.forEach(g => {
        const row = document.createElement('div'); row.className = 'grow';
        g.forEach(c => row.appendChild(cardEl(c, 'small')));
        box.appendChild(row);
      });
      const cap = document.createElement('div'); cap.className = 'cap'; cap.textContent = 'Carta descartada:';
      const row = document.createElement('div'); row.className = 'grow';
      row.appendChild(cardEl(v.winDiscard, 'small'));
      box.append(cap, row);
    }
    const btns = $('#wbtns', ov);
    if (mode === 'local' || isHost) {
      const b = document.createElement('button'); b.className = 'btn'; b.textContent = 'Jogar novamente';
      b.onclick = playAgain; btns.appendChild(b);
    } else {
      const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'Aguardando o anfitrião iniciar outra rodada…';
      btns.appendChild(p);
    }
    const q = document.createElement('button'); q.className = 'btn ghost'; q.textContent = 'Sair';
    q.onclick = leaveGame; btns.appendChild(q);
    ov.classList.add('show');
  } else if (mode === 'local' && covered) {
    ov.innerHTML = `<div class="obox hud"><h2>Vez de ${esc(v.players[v.turn].name)}</h2>
      <p>Passe o aparelho para ${esc(v.players[v.turn].name)} e toque quando estiver pronto(a).</p>
      <button class="btn" id="btnReady">Estou pronto(a)</button></div>`;
    $('#btnReady', ov).onclick = () => { covered = false; renderGame(); };
    ov.classList.add('show');
  } else {
    ov.classList.remove('show'); ov.innerHTML = '';
  }
}

function playAgain() {
  selectedId = null;
  if (mode === 'local') { game = new Game(game.names); covered = true; renderGame(); return; }
  if (mode === 'online' && isHost) {
    lobby = lobby.filter(l => !l.gone);
    if (lobby.length < 2) { toast('Jogadores insuficientes para outra rodada.'); return; }
    game = new Game(lobby.map(l => l.name));
    game.players.forEach((p, i) => { p.off = !!lobby[i].dropped; });
    broadcast(); renderGame();
  }
}

/* ===================== Controles da mão ===================== */
$('#stockPile').onclick   = () => { if (myTurn(currentView()) && currentView().phase === 'draw') doAction('draw', 'stock'); };
$('#discardPile').onclick = () => { const v = currentView(); if (myTurn(v) && v.phase === 'draw' && v.top) doAction('draw', 'discard'); };
$('#btnDiscard').onclick  = () => { if (selectedId !== null) doAction('discard', selectedId); };
$('#btnBate').onclick     = () => doAction('bate');

function sortHand(by) {
  const v = currentView(); if (!v) return;
  const key = c => isJ(c) ? [9, 99] : by === 'suit' ? [SUITS.indexOf(c.s), val(c.r)] : [val(c.r), SUITS.indexOf(c.s)];
  orders[v.me] = v.hand.slice().sort((a, b) => { const x = key(a), y = key(b); return x[0] - y[0] || x[1] - y[1]; }).map(c => c.id);
  renderGame();
}
function moveSel(dir) {
  const v = currentView(); if (!v || selectedId === null) return;
  const o = orders[v.me], i = o.indexOf(selectedId), j = i + dir;
  if (j < 0 || j >= o.length) return;
  [o[i], o[j]] = [o[j], o[i]]; renderGame();
}
$('#btnSortSuit').onclick = () => sortHand('suit');
$('#btnSortRank').onclick = () => sortHand('rank');
$('#btnLeft').onclick  = () => moveSel(-1);
$('#btnRight').onclick = () => moveSel(1);

function leaveGame() {
  if (mode === 'online') leaveRoom();
  else { mode = null; game = null; showScreen('menu'); }
  $('#overlay').classList.remove('show');
}
$('#btnLeaveGame').onclick = () => {
  if (confirm('Deseja sair da partida?')) leaveGame();
};

/* ===================== MODO ONLINE (salas via PeerJS / WebRTC) ===================== */
// Funciona entre qualquer combinação de dispositivos (PC, celular, tablet): cada um só
// precisa abrir o mesmo site no navegador. Servidores STUN/TURN ajudam a atravessar
// redes móveis e Wi-Fi com NAT restrito.
const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const genCode = () => Array.from({ length: 5 }, () => ALPH[Math.floor(Math.random() * ALPH.length)]).join('');
const PREFIX = 'pive-sala-';
const GRACE_MS = 45000;   // tempo para um jogador desconectado voltar à partida
const TURN_CRED = { username: 'openrelayproject', credential: 'openrelayproject' };
const PEER_OPTS = {
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' },
      { urls: 'turn:openrelay.metered.ca:80', ...TURN_CRED },
      { urls: 'turn:openrelay.metered.ca:443', ...TURN_CRED },
      { urls: 'turn:openrelay.metered.ca:443?transport=tcp', ...TURN_CRED }
    ]
  }
};

let peer = null, isHost = false, roomCode = '', hostConn = null;
let lobby = [];        // anfitrião: [{name, conn, pid, dropped, gone, timer}]
let lastView = null;   // convidado: última visão recebida
let joined = false, myName = '';
let recon = false, reconTimer = null, reconTries = 0;

let pidMem = Math.random().toString(36).slice(2) + Date.now().toString(36);
function getPid() {
  try {
    let p = sessionStorage.getItem('pive-pid');
    if (!p) { p = pidMem; sessionStorage.setItem('pive-pid', p); }
    return p;
  } catch (e) { return pidMem; }
}

function mkPeer(id) { return id ? new Peer(id, PEER_OPTS) : new Peer(undefined, PEER_OPTS); }
function hookPeer(p) {   // mantém a conexão com o servidor de sinalização viva
  p.on('disconnected', () => { if (peer === p) { try { p.reconnect(); } catch (e) {} } });
}
function onlineMsg(m) { $('#onlineMsg').textContent = m; }
function getName() {
  const n = $('#nameIn').value.trim();
  if (!n) { onlineMsg('Digite seu nome primeiro.'); return null; }
  try { localStorage.setItem('pive-nome', n); } catch (e) {}
  return n;
}
try { $('#nameIn').value = localStorage.getItem('pive-nome') || ''; } catch (e) {}

function clearRecon() { clearTimeout(reconTimer); reconTimer = null; recon = false; }
function cleanup() {
  clearRecon();
  const p = peer, wasHost = isHost;
  if (wasHost) lobby.forEach(l => { try { l.conn && l.conn.open && l.conn.send({ t: 'bye' }); } catch (e) {} });
  lobby.forEach(l => clearTimeout(l.timer));
  peer = null; hostConn = null; lobby = []; game = null; lastView = null;
  isHost = false; joined = false; mode = null; roomCode = '';
  setTimeout(() => { try { p && p.destroy(); } catch (e) {} }, wasHost ? 300 : 0);
  updateNet();
}
function leaveRoom() { cleanup(); showScreen('menu'); }

function updateNet() {
  const el = $('#net'); if (!el) return;
  if (mode !== 'online') { el.textContent = ''; el.className = 'net'; return; }
  const ok = isHost ? !!(peer && !peer.disconnected) : !!(hostConn && hostConn.open);
  el.textContent = ok ? '● ONLINE' : '● RECONECTANDO';
  el.className = 'net ' + (ok ? 'ok' : 'bad');
}
setInterval(updateNet, 2000);

/* ---------- Anfitrião ---------- */
$('#btnCreate').onclick = () => {
  onlineMsg('');
  if (typeof Peer === 'undefined') return onlineMsg('Não foi possível carregar a biblioteca online. Verifique a internet.');
  const name = getName(); if (!name) return;
  cleanup(); myName = name; mode = 'online'; isHost = true;
  onlineMsg('Criando sala…');
  const attempt = n => {
    roomCode = genCode();
    const p = peer = mkPeer(PREFIX + roomCode);
    hookPeer(p);
    p.on('open', () => {
      if (peer !== p) return;
      onlineMsg('');
      lobby = [{ name: myName, conn: null }];
      p.on('connection', onGuest);
      showScreen('lobby'); renderLobby();
    });
    p.on('error', e => {
      if (peer !== p) return;
      if (e.type === 'unavailable-id' && n < 5) { try { p.destroy(); } catch (x) {} return attempt(n + 1); }
      if (!lobby.length) { onlineMsg('Erro ao criar sala (' + e.type + ').'); cleanup(); }
      else if (e.type !== 'peer-unavailable') toast('Instabilidade de rede: ' + e.type);
    });
  };
  attempt(0);
};

function onGuest(conn) {
  conn.on('data', m => hostReceive(conn, m));
  conn.on('close', () => hostDrop(conn));
  conn.on('error', () => hostDrop(conn));
}
function deny(conn, msg) {
  try { conn.send({ t: 'deny', m: msg }); } catch (e) {}
  setTimeout(() => { try { conn.close(); } catch (e) {} }, 400);
}
function hostReceive(conn, m) {
  if (!m || typeof m !== 'object') return;
  if (m.t === 'join') {
    const pid = String(m.pid || '');
    const ex = pid ? lobby.findIndex(l => l.pid === pid) : -1;
    if (ex > 0) {                       // jogador voltando (reconexão)
      const l = lobby[ex];
      if (l.gone) return deny(conn, 'Você foi removido desta partida.');
      const old = l.conn; l.conn = conn; l.dropped = false; clearTimeout(l.timer);
      try { old && old !== conn && old.close(); } catch (e) {}
      if (game) { game.players[ex].off = false; toast(l.name + ' reconectou.'); broadcast(); renderGame(); }
      else broadcastLobby();
      return;
    }
    if (lobby.some(l => l.conn === conn)) return;
    if (game || lobby.length >= 6) return deny(conn, game ? 'A partida já começou.' : 'A sala está cheia (máx. 6).');
    let name = String(m.name || 'Jogador').slice(0, 14), base = name, k = 2;
    while (lobby.some(l => l.name === name)) name = base + ' ' + k++;
    lobby.push({ name, conn, pid });
    broadcastLobby();
  } else if (m.t === 'act') {
    const i = lobby.findIndex(l => l.conn === conn);
    if (i < 0 || !game) return;
    runAction(i, m.a, m.arg, conn);
  }
}
function hostDrop(conn) {
  const i = lobby.findIndex(l => l.conn === conn);
  if (i < 0 || lobby[i].gone || lobby[i].dropped) return;
  if (!game) { lobby.splice(i, 1); broadcastLobby(); return; }
  const l = lobby[i];
  l.dropped = true; game.players[i].off = true;
  toast(l.name + ' desconectou. Aguardando…');
  l.timer = setTimeout(() => {
    if (!l.dropped || !game) return;
    l.gone = true; game.leave(i);
    toast(l.name + ' saiu da partida.');
    broadcast(); renderGame();
  }, GRACE_MS);
  broadcast(); renderGame();
}
function broadcastLobby() {
  const names = lobby.map(l => l.name);
  lobby.forEach((l, i) => l.conn && l.conn.open && l.conn.send({ t: 'lobby', names, code: roomCode, you: i }));
  renderLobby();
}
function broadcast() {
  lobby.forEach((l, i) => { if (l.conn && !l.gone && l.conn.open) l.conn.send({ t: 'state', v: game.view(i) }); });
}
$('#btnStartOnline').onclick = () => {
  if (!isHost || lobby.length < 2) return;
  game = new Game(lobby.map(l => l.name));
  selectedId = null;
  $('#roomTag').textContent = 'SALA ' + roomCode;
  showScreen('game'); broadcast(); renderGame();
};

/* ---------- Convidado ---------- */
function openHostConn() {
  const c = peer.connect(PREFIX + roomCode, { reliable: true });
  hostConn = c;
  c.on('open', () => { if (hostConn === c) { c.send({ t: 'join', name: myName, pid: getPid() }); updateNet(); } });
  c.on('data', m => { if (hostConn !== c) return; clearRecon(); guestReceive(m); updateNet(); });
  c.on('close', () => { if (hostConn === c) guestLost(); });
  c.on('error', () => { if (hostConn === c) guestLost(); });
}

$('#btnJoin').onclick = () => {
  onlineMsg('');
  if (typeof Peer === 'undefined') return onlineMsg('Não foi possível carregar a biblioteca online. Verifique a internet.');
  const name = getName(); if (!name) return;
  const code = $('#codeIn').value.trim().toUpperCase();
  if (code.length !== 5) return onlineMsg('O código da sala tem 5 caracteres.');
  cleanup(); myName = name; mode = 'online'; isHost = false; roomCode = code;
  onlineMsg('Conectando…');
  const p = peer = mkPeer();
  hookPeer(p);
  p.on('open', () => { if (peer === p) openHostConn(); });
  p.on('error', e => {
    if (peer !== p || joined) return;
    onlineMsg(e.type === 'peer-unavailable' ? 'Sala não encontrada. Confira o código.' : 'Erro de conexão (' + e.type + ').');
    cleanup();
  });
  setTimeout(() => {
    if (peer === p && !joined) { onlineMsg('Não foi possível conectar à sala. Verifique o código e sua rede.'); cleanup(); }
  }, 20000);
};

// Reconecta automaticamente (ex.: celular bloqueou a tela ou trocou de rede)
function guestLost() {
  if (mode !== 'online' || isHost || !joined || !peer || recon) return;
  recon = true; reconTries = 0; updateNet();
  toast('Conexão perdida. Reconectando…');
  const attempt = () => {
    if (!peer || isHost || mode !== 'online') return clearRecon();
    if (hostConn && hostConn.open) return clearRecon();
    if (++reconTries > 15) { clearRecon(); toast('Não foi possível reconectar à sala.'); leaveRoom(); return; }
    const connect = () => { try { hostConn && hostConn.close(); } catch (e) {} if (peer) openHostConn(); };
    if (peer.destroyed) {
      const p = peer = mkPeer(); hookPeer(p);
      p.on('open', () => { if (peer === p) connect(); });
    } else if (peer.disconnected) {
      try { peer.reconnect(); } catch (e) {}
      setTimeout(connect, 1200);
    } else connect();
    reconTimer = setTimeout(attempt, 4000);
  };
  attempt();
}
function checkNet() {
  if (mode !== 'online' || !peer) return;
  if (isHost) { if (peer.disconnected) { try { peer.reconnect(); } catch (e) {} } }
  else if (joined && !(hostConn && hostConn.open)) guestLost();
  updateNet();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkNet(); });
window.addEventListener('online', checkNet);

function guestReceive(m) {
  if (!m || typeof m !== 'object') return;
  if (m.t === 'lobby') {
    joined = true; roomCode = m.code; lobby = m.names.map(n => ({ name: n }));
    if (!$('#screen-lobby').classList.contains('active') && !$('#screen-game').classList.contains('active')) showScreen('lobby');
    renderLobby(m.you);
  } else if (m.t === 'state') {
    joined = true; lastView = m.v;
    if (!$('#screen-game').classList.contains('active')) { $('#roomTag').textContent = 'SALA ' + roomCode; showScreen('game'); }
    renderGame();
  } else if (m.t === 'err') {
    toast(m.m);
  } else if (m.t === 'bye') {
    toast('A sala foi encerrada pelo anfitrião.'); leaveRoom();
  } else if (m.t === 'deny') {
    onlineMsg(m.m); cleanup(); showScreen('online');
  }
}

/* ---------- Sala (lobby) ---------- */
function renderLobby(you = 0) {
  $('#lobbyCode').textContent = roomCode;
  const ul = $('#lobbyList'); ul.innerHTML = '';
  lobby.forEach((l, i) => {
    const li = document.createElement('li');
    const tags = [i === 0 ? '👑 anfitrião' : '', i === you ? 'você' : ''].filter(Boolean).join(' · ');
    li.innerHTML = `<span>${esc(l.name)}</span><span class="badge">${tags}</span>`;
    ul.appendChild(li);
  });
  $('#btnStartOnline').style.display = isHost ? '' : 'none';
  $('#btnStartOnline').disabled = lobby.length < 2;
  $('#lobbyHint').textContent = isHost
    ? (lobby.length < 2 ? `Aguardando jogadores… (${lobby.length}/6, mínimo 2)` : `${lobby.length}/6 jogadores. Inicie quando quiser!`)
    : 'Aguardando o anfitrião iniciar a partida…';
}
function copyText(t, okMsg) {
  const fallback = () => { prompt('Copie manualmente:', t); };
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(t).then(() => toast(okMsg), fallback);
  else fallback();
}
$('#btnCopyCode').onclick = () => copyText(roomCode, 'Código copiado!');
$('#btnCopyLink').onclick = () => {
  const url = location.href.split(/[?#]/)[0] + '?sala=' + roomCode;
  if (navigator.share) navigator.share({ title: 'Pive', text: 'Entre na minha sala do Pive! Código: ' + roomCode, url }).catch(() => {});
  else copyText(url, 'Link copiado!');
};
$('#btnLeaveLobby').onclick = leaveRoom;
$('#codeIn').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });

/* ---------- Entrar por link (?sala=XXXXX) ---------- */
(() => {
  const c = new URLSearchParams(location.search).get('sala');
  if (c) { $('#codeIn').value = c.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5); showScreen('online'); }
})();
