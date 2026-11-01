(()=> {
  'use strict';
  // Memory Lab arayüzü. Yalnızca root'lu ZYRON Android uygulamasında (window.ZyronMem köprüsü) çalışır.
  const $ = id => document.getElementById(id);
  if (!$('memlab')) return;
  const overlayMode = /[?&]overlay=1/.test(location.search);
  if (overlayMode) document.documentElement.classList.add('overlay');
  const bridge = window.ZyronMem || null;
  const PAGE = 50;
  const TYPES = ['i8', 'i16', 'i32', 'i64', 'f32', 'f64', 'xor'];
  const esc = v => String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const clean = v => String(v == null ? '' : v).trim().replace(/\s+/g, '');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const store = {
    get(k, f) { try { const r = localStorage.getItem(k); return r === null ? f : JSON.parse(r); } catch (_) { return f; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }
  };
  let toastTimer = null;
  const toast = message => {
    const t = $('toast'); if (!t) return;
    t.textContent = message; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
  };

  const ERR = {
    no_bridge: 'Memory Lab yalnızca ZYRON Android uygulamasında çalışır.',
    no_root: 'Root izni alınamadı. Root yöneticisinde ZYRON için izin ver ve tekrar dene.',
    no_binary: 'Yerel çekirdek bu cihaz mimarisi için pakette yok.',
    blocked: 'Bu süreç korumalı (sistem veya korumalı uygulama). Bağlanılamaz.',
    not_attached: 'Önce listeden bir uygulama seç.',
    process_gone: 'Hedef uygulama kapanmış. Yeniden aç ve tekrar seç.',
    no_results: 'Önce bir tarama yap.',
    too_many: 'Toplu yazma için önce sonuçları 2000 veya daha aza indir.',
    not_writable: 'Bu adrese yazılamıyor.',
    read_only: 'Bu süreç salt okunur açıldı, yazılamaz.',
    write_failed: 'Yazma başarısız oldu.',
    read_failed: 'Bu adres okunamadı.',
    freeze_limit: 'En fazla 256 adres dondurulabilir.',
    bad_arg: 'Değer, tür veya biçim geçersiz.',
    bad_command: 'Geçersiz komut.',
    bad_pointer: 'Bu değer geçerli bir işaretçi değil.',
    core_exited: 'Çekirdek kapandı. "Root\'u kontrol et" ile yeniden başlat.',
    open_failed: 'Süreç belleği açılamadı (root gerekli).',
    no_process: 'Süreç bulunamadı.',
    tmp_failed: 'Geçici anlık görüntü dosyası oluşturulamadı.',
    no_datadir: 'Döküm klasörü ayarlanmamış.',
    pause_failed: 'Süreç duraklatılamadı.',
    timeout: 'Çekirdek yanıt vermedi.'
  };
  const errText = r => (r && (ERR[r.err] || r.msg)) || 'İşlem başarısız.';

  // ---- köprü ----
  const pending = new Map(); let seq = 0;
  window.zyronMemResult = (id, text) => {
    const done = pending.get(id); if (!done) return;
    pending.delete(id);
    let data; try { data = JSON.parse(text); } catch (_) { data = {ok:false, err:'bad_response', msg:'Çekirdekten geçersiz yanıt geldi.'}; }
    done(data);
  };
  const viaBridge = fn => new Promise(resolve => {
    if (!bridge) { resolve({ok:false, err:'no_bridge'}); return; }
    const id = ++seq;
    const timer = setTimeout(() => { if (pending.delete(id)) resolve({ok:false, err:'timeout'}); }, 300000);
    pending.set(id, r => { clearTimeout(timer); resolve(r); });
    try { fn(id); } catch (e) { clearTimeout(timer); pending.delete(id); resolve({ok:false, err:'bridge', msg:String(e)}); }
  });
  const call = command => viaBridge(id => bridge.send(id, command));

  // ---- durum ----
  const st = {
    root:false, pid:0, name:'', ptr:8, total:0, page:0, type:'i32', fuzzy:false, fzBytes:0, busy:false,
    procs:[], frozen:new Set(), frozenInfo:[], saved:[], savedMeta:{pid:0,name:''}, paused:false,
    scriptRunning:false, scriptStop:false, scriptRegions:null,
    hex:null, hexSel:-1, maps:[], mapsOff:0, mapsTotal:0
  };
  const BUSY_BTNS = ['ml-scan','ml-next','ml-reset','ml-proc-refresh','ml-setall-btn','ml-shift-btn','ml-saveall','ml-hex-go','ml-dump-btn','ml-maps-refresh','ml-script-run'];
  const needsRoot = () => document.querySelectorAll('#memlab [data-needs-root]');
  const setBusy = on => {
    st.busy = on;
    BUSY_BTNS.forEach(id => { const el = $(id); if (el) el.disabled = on || !st.root; });
  };
  const setStatus = (text, ok) => { const el = $('ml-status'); el.textContent = text; el.classList.toggle('ml-ok', !!ok); };
  const step = (n, done) => { const el = $('ml-step-' + n); if (el) el.classList.toggle('done', !!done); };
  async function run(label, fn) {
    if (st.busy) { toast('Önceki işlem sürüyor…'); return; }
    setBusy(true); $('ml-busy').textContent = label;
    try { return await fn(); } finally { setBusy(false); $('ml-busy').textContent = ''; }
  }
  const lost = r => { if (r && (r.err === 'process_gone' || r.err === 'not_attached')) resetAttach(); };
  const addrOk = a => /^0x[0-9a-fA-F]{1,16}$/.test(a);
  const hexOf = (v, t) => {
    try {
      const bits = {i8:8, i16:16, i32:32, i64:64, xor:32}[t]; if (!bits || !/^-?\d+$/.test(v)) return '';
      return '0x' + BigInt.asUintN(bits, BigInt(v)).toString(16).toUpperCase();
    } catch (_) { return ''; }
  };

  // ---- sekmeler ----
  function showTab(name) {
    document.querySelectorAll('#memlab .ml-tab').forEach(b => b.classList.toggle('active', b.dataset.mltab === name));
    document.querySelectorAll('#memlab .ml-panel').forEach(p => p.classList.toggle('active', p.id === 'ml-p-' + name));
    if (name === 'saved') renderSaved();
    if (name === 'maps' && st.pid && !st.maps.length) loadMaps(true);
  }
  document.querySelectorAll('#memlab .ml-tab').forEach(b => b.addEventListener('click', () => showTab(b.dataset.mltab)));

  // ---- 1) root ----
  function enableControls(on) { needsRoot().forEach(el => { el.disabled = !on; }); }
  $('ml-root').addEventListener('click', async () => {
    $('ml-root').disabled = true; setStatus('Root kontrol ediliyor…');
    const r = await viaBridge(id => bridge.checkRoot(id));
    $('ml-root').disabled = !bridge;
    if (r.ok && r.euid === 0) {
      st.root = true; setStatus('Root hazır · çekirdek çalışıyor', true); step(1, true); enableControls(true);
      refreshProcs();
    } else { st.root = false; setStatus(errText(r)); step(1, false); }
  });

  // ---- 2) uygulama seçimi ----
  function renderProcs() {
    const q = $('ml-proc-q').value.trim().toLowerCase();
    const list = st.procs.filter(p => !q || p.name.toLowerCase().includes(q)).slice(0, 80);
    $('ml-procs').innerHTML = list.map(p =>
      '<button type="button" class="ml-proc" data-pid="' + p.pid + '"><strong>' + esc(p.name) + '</strong><small>PID ' + p.pid + '</small></button>'
    ).join('') || '<p class="fine">Eşleşen uygulama yok. Oyunu açıp listeyi yenile.</p>';
  }
  async function refreshProcs() {
    if (!st.root) { toast('Önce root izni ver.'); return; }
    await run('Uygulamalar listeleniyor…', async () => {
      const r = await call('ps');
      if (!r.ok) { toast(errText(r)); return; }
      st.procs = r.procs.sort((a, b) => a.name.localeCompare(b.name));
      renderProcs();
    });
  }
  $('ml-proc-refresh').addEventListener('click', refreshProcs);
  $('ml-proc-q').addEventListener('input', renderProcs);
  function setAttached(pid, name, ro, ptr) {
    st.pid = pid; st.name = name; st.ptr = ptr || 8; st.total = 0; st.page = 0; st.fuzzy = false; st.maps = []; st.hex = null; st.hexSel = -1;
    $('ml-attached').innerHTML = '<span class="ml-dot"></span> Bağlı: <strong>' + esc(name) + '</strong> <small>PID ' + pid + (ro ? ' · salt okunur' : '') + ' · ' + (st.ptr * 8) + ' bit</small>';
    $('ml-detach').hidden = false; step(2, true);
    if (st.savedMeta.pid && st.savedMeta.pid !== pid && st.saved.length) {
      $('ml-saved-note').textContent = 'Bu liste önceki bir oturumdan (' + (st.savedMeta.name || '?') + '). Adresler artık geçersiz olabilir; yeniden arayıp ekle.';
    }
    renderResults(); renderSaved(); refreshFrozen();
  }
  $('ml-procs').addEventListener('click', async event => {
    const b = event.target.closest('[data-pid]'); if (!b) return;
    await run('Bağlanılıyor…', async () => {
      const r = await call('attach ' + Number(b.dataset.pid));
      if (!r.ok) { toast(errText(r)); return; }
      st.paused = false; syncPauseBtn();
      setAttached(r.pid, r.name, r.ro, r.ptr);
      toast('Bağlandı: ' + r.name);
    });
  });
  function resetAttach() {
    st.pid = 0; st.name = ''; st.total = 0; st.page = 0; st.fuzzy = false; st.paused = false; st.hex = null; st.maps = [];
    $('ml-attached').textContent = 'Henüz uygulama seçilmedi.';
    $('ml-detach').hidden = true; step(2, false); step(3, false); syncPauseBtn();
    st.frozen = new Set(); st.frozenInfo = [];
    renderResults(); renderFrozen(); renderSaved(); renderHex(); renderMaps();
  }
  $('ml-detach').addEventListener('click', async () => { await call('detach'); resetAttach(); });
  function syncPauseBtn() {
    const b = $('ml-pause'); b.textContent = st.paused ? '▶ Oyunu sürdür' : '⏸ Oyunu duraklat'; b.classList.toggle('ml-on', st.paused);
  }
  $('ml-pause').addEventListener('click', async () => {
    if (!st.pid) { toast(ERR.not_attached); return; }
    const r = await call(st.paused ? 'resume' : 'pause');
    if (!r.ok) { toast(errText(r)); lost(r); return; }
    st.paused = !st.paused; syncPauseBtn();
    toast(st.paused ? 'Oyun duraklatıldı (en fazla 5 dk, sonra otomatik sürer).' : 'Oyun sürüyor.');
  });
  if (bridge && typeof bridge.openOverlay === 'function' && !overlayMode) {
    $('ml-float').hidden = false;
    $('ml-float').addEventListener('click', () => { try { bridge.openOverlay(); } catch (e) { toast('Yüzen pencere açılamadı.'); } });
  }

  // ---- bölge seçimi ----
  const RC = [
    ['anon','A','Anonim',1],['jheap','Ja','Java yığını',1],['java','Jh','Java',1],['cheap','Ch','C++ yığını',1],['calloc','Ca','C++ ayrılan',1],
    ['cdata','Cd','C++ .data',1],['cbss','Cb','C++ .bss',1],['stack','S','Stack',1],['ashmem','As','Ashmem',1],['video','V','Video',0],
    ['codeapp','Xa','Kod (uyg.)',0],['codesys','Xs','Kod (sis.)',0],['other','O','Diğer',1]
  ];
  $('ml-regions').innerHTML = RC.map(([n, c, label, on]) =>
    '<label class="ml-chip"><input type="checkbox" data-r="' + n + '"' + (on ? ' checked' : '') + ' data-needs-root><b>' + c + '</b> ' + label + '</label>').join('');
  const defaultRegions = RC.filter(x => x[3]).map(x => x[0]);
  function regionsArg() {
    const sel = [...document.querySelectorAll('#ml-regions [data-r]')].filter(i => i.checked).map(i => i.dataset.r);
    if (!sel.length) { toast('En az bir bellek bölgesi seç.'); return null; }
    const same = sel.length === defaultRegions.length && defaultRegions.every(r => sel.includes(r));
    return same ? 'all' : sel.join(',');
  }
  $('ml-regions').addEventListener('change', () => {
    const a = regionsArg(); $('ml-regions-sum').textContent = a === 'all' ? '(varsayılan)' : a ? '(' + a.split(',').length + ' seçili)' : '';
  });

  // ---- arama kipi ----
  const HINTS = {
    exact: 'Ekranda gördüğün sayıyı yaz (örn. altın 1000). Oyunda değiştir, sonra aşağıdan "Daralt" ile yeni değeri yaz; birkaç turda tek adres kalır. Ondalık sayılar için Float/Double dene, emin değilsen Auto.',
    fuzzy: 'Değeri bilmiyorsan: önce "Tara"ya bas (anlık görüntü alınır), oyunda değeri değiştir, sonra Daralt: Arttı / Azaldı / Değişti / Değişmedi veya "Şu kadar arttı". Çok bellek kullanır, önce bölgeleri daralt.',
    group: 'Yan yana duran değerleri birlikte ara: 100;200;300::512 (değerler en fazla 512 bayt içinde). Tür eki: D=dword F=float E=double Q=qword W=word B=byte (örn. 100D;1.5F).',
    text: 'Aranacak metni yaz (en fazla 64 bayt). UTF-8 ya da UTF-16 seç.',
    bytes: 'Hex bayt dizisi yaz: "90 90 FF" veya "h9090FF". En fazla 64 bayt.'
  };
  function syncMode() {
    const m = $('ml-smode').value;
    $('ml-hint').textContent = HINTS[m];
    $('ml-value2-wrap').hidden = m !== 'exact';
    $('ml-enc-wrap').hidden = m !== 'text';
    $('ml-type').disabled = !st.root || m === 'text' || m === 'bytes';
    $('ml-value').disabled = !st.root || m === 'fuzzy';
    $('ml-value-label').textContent = {exact:'DEĞER', fuzzy:'DEĞER (gerekmez)', group:'GRUP', text:'METİN', bytes:'HEX BAYTLAR'}[m];
    $('ml-value').placeholder = {exact:'örn. 1000', fuzzy:'—', group:'100;200;300::512', text:'örn. ZYRON', bytes:'örn. 90 90 FF'}[m];
  }
  $('ml-smode').addEventListener('change', syncMode);

  const LETTER = {B:'i8', W:'i16', D:'i32', Q:'i64', F:'f32', E:'f64'};
  // "100;200D;1.5F::512" -> [{tokens, window}]
  function parseGroup(text, defType) {
    const [list, win] = String(text).split('::');
    const window = win === undefined || win.trim() === '' ? 512 : Number(win);
    if (!Number.isInteger(window) || window < 1 || window > 65536) return null;
    const parts = list.split(';').map(s => s.trim()).filter(Boolean);
    if (parts.length < 2 || parts.length > 8) return null;
    const def = (defType === 'auto' || defType === 'xor') ? 'i32' : defType;
    const tokens = [];
    for (const p of parts) {
      let m = /^(-?[0-9][0-9.eE+\-]*(?:(?:\.\.|~)-?[0-9][0-9.eE+\-]*)?)([BWDQFEbwdqfe])$/.exec(p);
      if (m) { tokens.push(m[1].replace('~', '..') + ':' + LETTER[m[2].toUpperCase()]); continue; }
      m = /^(-?[0-9][0-9.eE+\-]*(?:(?:\.\.|~)-?[0-9][0-9.eE+\-]*)?)(?::(i8|i16|i32|i64|f32|f64))?$/.exec(p);
      if (!m) return null;
      tokens.push(m[1].replace('~', '..') + (m[2] ? ':' + m[2] : ''));
    }
    return {def, window, tokens};
  }
  const toHexStr = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  function textToHex(text, enc) {
    if (!text) return null;
    let bytes;
    if (enc === 'utf16') { bytes = []; for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); bytes.push(c & 255, c >> 8); } }
    else bytes = new TextEncoder().encode(text);
    return bytes.length && bytes.length <= 64 ? toHexStr(bytes) : null;
  }
  function normHex(s) {
    let h = String(s).replace(/0x/gi, '').replace(/[\s,]/g, '');
    if (/^h/i.test(h)) h = h.slice(1);
    return /^[0-9a-fA-F]+$/.test(h) && h.length % 2 === 0 && h.length <= 128 ? h.toUpperCase() : null;
  }

  // ---- 3) tarama ve daraltma ----
  function applyResult(r) {
    if (r.fuzzy) { st.fuzzy = true; st.fzBytes = r.bytes || 0; st.total = 0; st.type = r.type; }
    else { st.fuzzy = false; st.total = r.hits; st.type = r.type; }
    st.page = 0;
  }
  async function doScan() {
    if (!st.pid) { toast(ERR.not_attached); return; }
    const mode = $('ml-smode').value, type = $('ml-type').value, v1 = clean($('ml-value').value), v2 = clean($('ml-value2').value);
    const regions = regionsArg(); if (!regions) return;
    let cmd;
    if (mode === 'exact') {
      if (!v1) { toast('Aranacak değeri yaz.'); return; }
      cmd = (type === 'auto' ? 'scan auto ' : 'scan ' + type + ' ') + v1.replace('~', '..').split('..')[0] + (v1.includes('..') || v1.includes('~') ? ' ' + v1.replace('~', '..').split('..')[1] : (v2 ? ' ' + v2 : ''));
    } else if (mode === 'fuzzy') {
      cmd = 'fuzzy ' + ((type === 'auto' || type === 'xor') ? 'i32' : type);
    } else if (mode === 'group') {
      const g = parseGroup($('ml-value').value, type);
      if (!g) { toast('Grup biçimi geçersiz. Örnek: 100;200;300::512'); return; }
      cmd = 'gscan ' + g.def + ' ' + g.window + ' ' + g.tokens.join(' ');
    } else if (mode === 'text') {
      const h = textToHex($('ml-value').value, $('ml-enc').value);
      if (!h) { toast('Metin boş ya da 64 bayttan uzun.'); return; }
      cmd = 'scan bytes ' + h;
    } else {
      const h = normHex($('ml-value').value);
      if (!h) { toast('Geçersiz hex. Örnek: 90 90 FF'); return; }
      cmd = 'scan bytes ' + h;
    }
    await run(mode === 'fuzzy' ? 'Anlık görüntü alınıyor…' : 'Taranıyor… (büyük oyunlarda biraz sürebilir)', async () => {
      let r = await call('region ' + regions);
      if (r.ok) r = await call(cmd);
      if (!r.ok) { toast(errText(r)); lost(r); return; }
      applyResult(r); step(3, true);
      if (r.truncated) toast('Çok fazla sonuç: ilk 3 milyon tutuldu. Değeri değiştirip daralt.');
      if (st.fuzzy) { renderResults(); toast('Anlık görüntü hazır. Oyunda değeri değiştir, sonra Daralt.'); }
      else await loadPage();
    });
  }
  $('ml-scan').addEventListener('click', doScan);
  $('ml-value').addEventListener('keydown', e => { if (e.key === 'Enter') doScan(); });
  $('ml-reset').addEventListener('click', () => run('Sıfırlanıyor…', async () => {
    await call('reset'); st.total = 0; st.page = 0; st.fuzzy = false; step(3, false); renderResults();
  }));
  async function doNext() {
    if (!st.pid) { toast(ERR.not_attached); return; }
    const mode = $('ml-rmode').value;
    const needs = ['eq', 'ne', 'gt', 'lt', 'incby', 'decby'].includes(mode);
    let v1 = clean($('ml-nvalue').value), v2 = clean($('ml-nvalue2').value);
    if (needs && st.type === 'bytes' && mode === 'eq') v1 = v1 || '0';
    if (needs && !v1) { toast('Yeni değeri yaz.'); return; }
    await run('Daraltılıyor…', async () => {
      const r = await call('next ' + mode + (needs ? ' ' + v1 + (mode === 'eq' && v2 ? ' ' + v2 : '') : ''));
      if (!r.ok) { toast(errText(r)); lost(r); return; }
      applyResult(r); await loadPage();
      if (r.hits === 0) toast('Sonuç kalmadı. Sıfırlayıp yeniden tara.');
    });
  }
  $('ml-next').addEventListener('click', doNext);
  $('ml-nvalue').addEventListener('keydown', e => { if (e.key === 'Enter') doNext(); });

  // ---- 4) sonuçlar ----
  function renderResults(items) {
    const pages = Math.max(1, Math.ceil(st.total / PAGE));
    $('ml-count').textContent = st.fuzzy ? 'Bulanık anlık görüntü' : st.total ? st.total.toLocaleString('tr-TR') + ' sonuç · ' + st.type : 'Sonuç yok';
    $('ml-page').textContent = (st.page + 1) + ' / ' + pages;
    $('ml-prev').disabled = !st.root || st.page <= 0; $('ml-nextpage').disabled = !st.root || st.page + 1 >= pages;
    $('ml-bulk').hidden = !(st.total > 0);
    if (st.fuzzy) { $('ml-results').innerHTML = '<p class="fine">Bulanık arama hazır (' + (st.fzBytes / 1048576).toFixed(1) + ' MB anlık görüntü). Oyunda değeri değiştir, sonra "Daralt"a bas.</p>'; return; }
    if (!items) { $('ml-results').innerHTML = '<p class="fine">Tarama yaptığında adresler burada görünür.</p>'; return; }
    const showHex = $('ml-hexdisp').checked;
    $('ml-results').innerHTML = items.map((i, idx) => {
      const fr = st.frozen.has(i.a.toLowerCase());
      return '<div class="ml-row" data-a="' + esc(i.a) + '" data-t="' + esc(i.t) + '" data-i="' + (st.page * PAGE + idx) + '"><code>' + esc(i.a) + '</code>' +
        '<input class="ml-val" value="' + esc(i.v) + '" inputmode="text" aria-label="Değer ' + esc(i.a) + '"><span class="ml-ty">' + esc(i.t) + '</span>' +
        (showHex ? '<span class="ml-hexv">' + esc(hexOf(i.v, i.t)) + '</span>' : '') +
        '<div class="ml-acts"><button type="button" class="secondary" data-act="set">Yaz</button><button type="button" class="secondary' + (fr ? ' ml-on' : '') + '" data-act="freeze" title="Dondur">❄</button>' +
        '<button type="button" class="secondary" data-act="save" title="Kayıtlı listeye ekle">＋</button><button type="button" class="secondary" data-act="more" title="Diğer">⋯</button></div>' +
        '<div class="ml-more" hidden><button type="button" class="secondary" data-act="hex">Hex</button><button type="button" class="secondary" data-act="ptr">İşaretçi ara</button><button type="button" class="secondary" data-act="jump">İşaretçiye git</button><button type="button" class="secondary danger" data-act="drop">Listeden çıkar</button></div></div>';
    }).join('') || '<p class="fine">Sonuç kalmadı.</p>';
  }
  async function loadPage() {
    const r = await call('list ' + (st.page * PAGE) + ' ' + PAGE);
    if (!r.ok) { toast(errText(r)); lost(r); return; }
    st.total = r.total; st.type = r.type; st.fuzzy = !!r.fuzzy;
    if (st.fuzzy) { renderResults(); return; }
    renderResults(r.items);
  }
  $('ml-prev').addEventListener('click', () => run('Yükleniyor…', async () => { st.page = Math.max(0, st.page - 1); await loadPage(); }));
  $('ml-nextpage').addEventListener('click', () => run('Yükleniyor…', async () => { st.page++; await loadPage(); }));
  $('ml-hexdisp').addEventListener('change', () => { if (st.total) run('Yükleniyor…', loadPage); });

  async function writeValue(addr, type, val) {
    if (type === 'bytes') {
      const h = normHex(val); if (!h) return {ok:false, err:'bad_arg'};
      return call('setbytes ' + addr + ' ' + h);
    }
    return call('set ' + addr + ' ' + type + ' ' + val);
  }
  $('ml-results').addEventListener('click', async event => {
    const b = event.target.closest('[data-act]'); if (!b) return;
    const row = b.closest('.ml-row'), addr = row.dataset.a, type = row.dataset.t, act = b.dataset.act;
    const input = row.querySelector('.ml-val'), val = clean(input.value);
    if (act === 'more') { row.querySelector('.ml-more').hidden = !row.querySelector('.ml-more').hidden; return; }
    if (act === 'hex') { showTab('hex'); hexGo(addr); return; }
    if (act === 'save') { addSaved(addr, type); return; }
    if (act === 'set' || act === 'freeze') {
      if (!val && type !== 'bytes') { toast('Bir değer yaz.'); return; }
      if (act === 'freeze' && st.frozen.has(addr.toLowerCase())) { await call('unfreeze ' + addr); await refreshFrozen(); return; }
      if (act === 'freeze' && type === 'bytes') { toast('Bayt dizileri dondurulamaz.'); return; }
      await run('Yazılıyor…', async () => {
        const r = act === 'set' ? await writeValue(addr, type, val) : await call('freeze ' + addr + ' ' + type + ' ' + val + ' ' + $('ml-fmode').value);
        if (!r.ok) { toast(errText(r)); lost(r); return; }
        toast(act === 'set' ? 'Yazıldı: ' + addr : 'Donduruldu: ' + addr);
        if (act === 'freeze') await refreshFrozen();
      });
      return;
    }
    if (act === 'ptr') {
      const off = clean($('ml-ptr-off').value);
      if (!/^(0x[0-9a-fA-F]+|\d+)$/.test(off)) { toast('Ofset 0x100 veya 256 biçiminde olmalı.'); return; }
      await run('İşaretçiler aranıyor…', async () => {
        const r = await call('ptrscan ' + addr + ' ' + off);
        if (!r.ok) { toast(errText(r)); lost(r); return; }
        applyResult(r); await loadPage(); toast(r.hits + ' işaretçi bulundu.');
      });
      return;
    }
    if (act === 'jump') {
      await run('İşaretçi izleniyor…', async () => {
        const r = await call('jump ' + addr);
        if (!r.ok) { toast(errText(r)); lost(r); return; }
        st.page = 0; await loadPage(); toast('Gidilen adres: ' + r.to);
      });
      return;
    }
    if (act === 'drop') {
      await run('Çıkarılıyor…', async () => {
        const r = await call('drop ' + row.dataset.i);
        if (!r.ok) { toast(errText(r)); return; }
        const pages = Math.max(1, Math.ceil((st.total - 1) / PAGE)); if (st.page >= pages) st.page = pages - 1;
        await loadPage();
      });
    }
  });

  // toplu işlemler: iki adımlı onay
  let armTimer = null;
  $('ml-setall-btn').addEventListener('click', async () => {
    const btn = $('ml-setall-btn'), v = clean($('ml-setall-value').value);
    if (!v) { toast('Yazılacak değeri gir.'); return; }
    if (st.total > 2000) { toast(ERR.too_many); return; }
    if (btn.dataset.armed !== '1') {
      btn.dataset.armed = '1'; btn.textContent = st.total + ' adrese yaz — Onayla';
      clearTimeout(armTimer); armTimer = setTimeout(() => { btn.dataset.armed = ''; btn.textContent = 'Hepsine yaz'; }, 4000);
      return;
    }
    btn.dataset.armed = ''; btn.textContent = 'Hepsine yaz'; clearTimeout(armTimer);
    await run('Yazılıyor…', async () => {
      const r = await call('setall ' + v);
      if (!r.ok) { toast(errText(r)); lost(r); return; }
      toast(r.written + ' / ' + r.total + ' adrese yazıldı' + (r.skipped ? ' (' + r.skipped + ' atlandı)' : '') + '.'); await loadPage();
    });
  });
  $('ml-shift-btn').addEventListener('click', () => {
    const d = clean($('ml-shift').value);
    if (!/^[+-]?\d+$/.test(d)) { toast('Ofset bir tam sayı olmalı (örn. 4 veya -8).'); return; }
    run('Ofset uygulanıyor…', async () => {
      const r = await call('shift ' + d + ($('ml-shift-type').value ? ' ' + $('ml-shift-type').value : ''));
      if (!r.ok) { toast(errText(r)); lost(r); return; }
      applyResult(r); await loadPage();
    });
  });
  $('ml-saveall').addEventListener('click', () => {
    const rows = [...document.querySelectorAll('#ml-results .ml-row')];
    rows.forEach(r => addSaved(r.dataset.a, r.dataset.t, true));
    toast(rows.length + ' adres kayıtlı listeye eklendi.');
  });

  // ---- dondurulanlar ----
  async function refreshFrozen() {
    if (!st.pid) { st.frozen = new Set(); st.frozenInfo = []; renderFrozen(); return; }
    const r = await call('frozen'); if (!r.ok) return;
    st.frozenInfo = r.items; st.frozen = new Set(r.items.map(i => i.a.toLowerCase()));
    renderFrozen();
    document.querySelectorAll('#ml-results .ml-row').forEach(row => row.querySelector('[data-act=freeze]').classList.toggle('ml-on', st.frozen.has(row.dataset.a.toLowerCase())));
    document.querySelectorAll('#ml-saved .ml-row').forEach(row => row.querySelector('[data-act=freeze]').classList.toggle('ml-on', st.frozen.has(row.dataset.a.toLowerCase())));
  }
  function renderFrozen() {
    const mode = ['', ' ↑', ' ↓'];
    $('ml-frozen').innerHTML = st.frozenInfo.map(i =>
      '<span class="profile-chip"><code>' + esc(i.a) + '</code> = ' + esc(i.v) + ' <small>' + esc(i.t) + mode[i.m] + '</small> <button type="button" data-unfreeze="' + esc(i.a) + '">Çöz</button></span>'
    ).join('') || '<span class="fine">Dondurulmuş değer yok.</span>';
  }
  $('ml-frozen').addEventListener('click', async event => {
    const b = event.target.closest('[data-unfreeze]'); if (!b) return;
    await call('unfreeze ' + b.dataset.unfreeze); refreshFrozen();
  });
  $('ml-unfreeze-all').addEventListener('click', async () => { if (!st.pid) return; await call('unfreeze all'); refreshFrozen(); });

  // ---- kayıtlı liste ----
  const SAVED_KEY = 'zyron_ml_saved_v1';
  function persistSaved() { store.set(SAVED_KEY, {pid: st.savedMeta.pid, name: st.savedMeta.name, items: st.saved}); }
  function addSaved(addr, type, silent) {
    if (!addrOk(addr) || !TYPES.concat(['bytes']).includes(type)) return;
    if (!st.saved.some(s => s.addr.toLowerCase() === addr.toLowerCase())) {
      if (st.saved.length >= 500) { toast('Kayıtlı liste dolu (500).'); return; }
      if (!st.saved.length || st.savedMeta.pid !== st.pid) { st.savedMeta = {pid: st.pid, name: st.name}; if (st.savedMeta.pid !== st.pid) st.saved = []; }
      st.saved.push({id: Date.now() + Math.random(), label: addr, addr, type});
      persistSaved();
    }
    renderSaved();
    if (!silent) toast('Kayıtlı listeye eklendi.');
  }
  function renderSaved() {
    $('ml-saved-badge').textContent = st.saved.length;
    $('ml-saved').innerHTML = st.saved.map(s =>
      '<div class="ml-row" data-id="' + s.id + '" data-a="' + esc(s.addr) + '" data-t="' + esc(s.type) + '"><input class="ml-label" value="' + esc(s.label) + '" maxlength="40" aria-label="Ad">' +
      '<code>' + esc(s.addr) + '</code><input class="ml-val" value="" placeholder="…" aria-label="Değer"><span class="ml-ty">' + esc(s.type) + '</span>' +
      '<div class="ml-acts"><button type="button" class="secondary" data-act="set">Yaz</button><button type="button" class="secondary' + (st.frozen.has(s.addr.toLowerCase()) ? ' ml-on' : '') + '" data-act="freeze">❄</button>' +
      '<button type="button" class="secondary" data-act="hex">Hex</button><button type="button" class="secondary danger" data-act="del">✕</button></div></div>'
    ).join('') || '<p class="fine">Liste boş. Sonuçlarda ＋ düğmesine bas.</p>';
    refreshSaved();
  }
  async function refreshSaved() {
    if (!st.pid || !st.saved.length || !$('ml-p-saved').classList.contains('active')) return;
    const rows = [...document.querySelectorAll('#ml-saved .ml-row')].filter(r => r.dataset.t !== 'bytes');
    for (let i = 0; i < rows.length; i += 40) {
      const chunk = rows.slice(i, i + 40);
      const r = await call('getm ' + chunk.map(x => x.dataset.a + ':' + x.dataset.t).join(' '));
      if (!r.ok) return;
      chunk.forEach((row, k) => { const inp = row.querySelector('.ml-val'); if (document.activeElement !== inp) inp.value = r.v[k]; });
    }
  }
  $('ml-saved').addEventListener('change', event => {
    if (!event.target.classList.contains('ml-label')) return;
    const row = event.target.closest('.ml-row'), s = st.saved.find(x => String(x.id) === row.dataset.id);
    if (s) { s.label = event.target.value.trim().slice(0, 40) || s.addr; persistSaved(); }
  });
  $('ml-saved').addEventListener('click', async event => {
    const b = event.target.closest('[data-act]'); if (!b) return;
    const row = b.closest('.ml-row'), addr = row.dataset.a, type = row.dataset.t, act = b.dataset.act, val = clean(row.querySelector('.ml-val').value);
    if (act === 'del') { st.saved = st.saved.filter(x => String(x.id) !== row.dataset.id); persistSaved(); renderSaved(); return; }
    if (act === 'hex') { showTab('hex'); hexGo(addr); return; }
    if (!st.pid) { toast(ERR.not_attached); return; }
    if (!val) { toast('Bir değer yaz.'); return; }
    if (act === 'freeze' && st.frozen.has(addr.toLowerCase())) { await call('unfreeze ' + addr); await refreshFrozen(); return; }
    if (act === 'freeze' && type === 'bytes') { toast('Bayt dizileri dondurulamaz.'); return; }
    const r = act === 'set' ? await writeValue(addr, type, val) : await call('freeze ' + addr + ' ' + type + ' ' + val + ' ' + $('ml-fmode').value);
    if (!r.ok) { toast(errText(r)); lost(r); return; }
    toast(act === 'set' ? 'Yazıldı.' : 'Donduruldu.'); if (act === 'freeze') refreshFrozen();
  });
  async function bulkFreeze(on) {
    if (!st.pid) { toast(ERR.not_attached); return; }
    let n = 0;
    for (const row of document.querySelectorAll('#ml-saved .ml-row')) {
      const type = row.dataset.t, addr = row.dataset.a, val = clean(row.querySelector('.ml-val').value);
      if (type === 'bytes') continue;
      if (on) { if (!val) continue; const r = await call('freeze ' + addr + ' ' + type + ' ' + val + ' ' + $('ml-fmode').value); if (r.ok) n++; }
      else { await call('unfreeze ' + addr); n++; }
    }
    await refreshFrozen(); toast(n + ' adres ' + (on ? 'donduruldu' : 'çözüldü') + '.');
  }
  $('ml-saved-freezeall').addEventListener('click', () => bulkFreeze(true));
  $('ml-saved-unfreezeall').addEventListener('click', () => bulkFreeze(false));
  $('ml-saved-clear').addEventListener('click', () => { if (!st.saved.length || confirm('Kayıtlı liste temizlensin mi?')) { st.saved = []; persistSaved(); renderSaved(); } });
  $('ml-saved-export').addEventListener('click', () => {
    try {
      const blob = new Blob([JSON.stringify({app: st.savedMeta.name || st.name, items: st.saved.map(({label, addr, type}) => ({label, addr, type}))}, null, 2)], {type:'application/json'});
      const url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = 'zyron-saved-list.json'; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (_) { toast('Dışa aktarma başarısız.'); }
  });
  $('ml-saved-import').addEventListener('change', async event => {
    const f = event.target.files && event.target.files[0]; event.target.value = '';
    if (!f) return;
    try {
      if (f.size > 512 * 1024) throw Error('Dosya çok büyük.');
      const data = JSON.parse(await f.text()), items = Array.isArray(data) ? data : data.items;
      if (!Array.isArray(items) || items.length > 500) throw Error('Geçersiz liste.');
      let n = 0;
      for (const it of items) {
        if (!it || !addrOk(String(it.addr)) || !TYPES.concat(['bytes']).includes(it.type)) continue;
        addSaved(String(it.addr), it.type, true);
        const s = st.saved.find(x => x.addr.toLowerCase() === String(it.addr).toLowerCase());
        if (s && typeof it.label === 'string') s.label = it.label.slice(0, 40);
        n++;
      }
      persistSaved(); renderSaved(); toast(n + ' kayıt içe aktarıldı.');
    } catch (e) { toast('İçe aktarma başarısız: ' + e.message); }
  });
  (() => {
    const d = store.get(SAVED_KEY, null);
    if (d && Array.isArray(d.items)) {
      st.savedMeta = {pid: Number(d.pid) || 0, name: String(d.name || '')};
      st.saved = d.items.filter(s => s && addrOk(String(s.addr)) && TYPES.concat(['bytes']).includes(s.type)).slice(0, 500)
        .map(s => ({id: s.id || Date.now() + Math.random(), label: String(s.label || s.addr).slice(0, 40), addr: String(s.addr), type: s.type}));
    }
  })();

  // ---- hex görüntüleyici ----
  const toBytes = h => { const a = []; for (let i = 0; i + 1 < h.length; i += 2) a.push(parseInt(h.substr(i, 2), 16)); return a; };
  const fmtAddr = a => '0x' + a.toString(16);
  async function hexGo(addrText, lenOverride) {
    if (!st.pid) { toast(ERR.not_attached); return; }
    let t = clean(addrText); if (!/^0x/i.test(t)) t = '0x' + t;
    if (!addrOk(t)) { toast('Adres 0x… biçiminde olmalı.'); return; }
    const len = lenOverride || Number($('ml-hex-len').value);
    const addr = BigInt(t);
    $('ml-hex-addr').value = fmtAddr(addr);
    const r = await call('hex ' + fmtAddr(addr) + ' ' + len);
    if (!r.ok) { toast(errText(r)); lost(r); st.hex = null; renderHex(); return; }
    st.hex = {addr, bytes: toBytes(r.h)}; st.hexSel = -1; renderHex();
  }
  function renderHex() {
    const box = $('ml-hexview');
    if (!st.hex) { box.innerHTML = '<p class="fine">Bir adres yazıp "Git"e bas, ya da sonuçlardan "Hex" seç.</p>'; $('ml-hex-sel').textContent = 'Seçili bayt yok. Bir baytın üstüne dokun.'; $('ml-hex-vals').innerHTML = ''; return; }
    const {addr, bytes} = st.hex; let html = '';
    for (let o = 0; o < bytes.length; o += 16) {
      const row = bytes.slice(o, o + 16);
      html += '<div class="ml-hrow"><code>' + fmtAddr(addr + BigInt(o)) + '</code>' +
        row.map((b, k) => '<span class="hb' + (o + k === st.hexSel ? ' sel' : '') + '" data-o="' + (o + k) + '">' + b.toString(16).padStart(2, '0').toUpperCase() + '</span>').join('') +
        '<span class="hasc">' + esc(row.map(b => b >= 32 && b < 127 ? String.fromCharCode(b) : '·').join('')) + '</span></div>';
    }
    box.innerHTML = html;
  }
  async function selectHexByte(o) {
    if (!st.hex || o >= st.hex.bytes.length) return;
    st.hexSel = o; renderHex();
    const a = fmtAddr(st.hex.addr + BigInt(o));
    $('ml-hex-sel').textContent = 'Seçili: ' + a + ' (+' + o + ')';
    $('ml-hex-write').value = st.hex.bytes[o].toString(16).padStart(2, '0').toUpperCase();
    const r = await call('getm ' + TYPES.map(t => a + ':' + t).join(' '));
    if (r.ok) $('ml-hex-vals').innerHTML = TYPES.map((t, i) => '<span class="ml-hv"><b>' + t + '</b> ' + esc(r.v[i]) + '</span>').join('');
  }
  $('ml-hexview').addEventListener('click', e => { const b = e.target.closest('.hb'); if (b) selectHexByte(Number(b.dataset.o)); });
  $('ml-hex-go').addEventListener('click', () => hexGo($('ml-hex-addr').value));
  $('ml-hex-addr').addEventListener('keydown', e => { if (e.key === 'Enter') hexGo($('ml-hex-addr').value); });
  const hexStep = dir => { if (!st.hex) return; const len = Number($('ml-hex-len').value); hexGo(fmtAddr(st.hex.addr + BigInt(dir * len))); };
  $('ml-hex-prev').addEventListener('click', () => hexStep(-1));
  $('ml-hex-next').addEventListener('click', () => hexStep(1));
  $('ml-hex-write-btn').addEventListener('click', async () => {
    if (!st.hex || st.hexSel < 0) { toast('Önce bir bayt seç.'); return; }
    const h = normHex($('ml-hex-write').value); if (!h || h.length > 128) { toast('Geçersiz hex (en fazla 64 bayt).'); return; }
    const a = fmtAddr(st.hex.addr + BigInt(st.hexSel));
    const r = await call('setbytes ' + a + ' ' + h);
    if (!r.ok) { toast(errText(r)); lost(r); return; }
    toast('Yazıldı: ' + a); const keep = st.hexSel; await hexGo(fmtAddr(st.hex.addr)); selectHexByte(keep);
  });
  $('ml-dump-btn').addEventListener('click', () => {
    if (!st.hex) { toast('Önce bir adres göster.'); return; }
    const name = $('ml-dump-name').value.trim() || 'dump-' + st.pid + '-' + st.hex.addr.toString(16) + '.bin';
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.\-]{0,59}$/.test(name)) { toast('Dosya adı yalnızca harf, rakam, _ . - içerebilir.'); return; }
    const start = st.hex.addr, end = start + BigInt($('ml-dump-len').value);
    run('Döküm alınıyor…', async () => {
      const r = await call('dump ' + fmtAddr(start) + ' ' + fmtAddr(end) + ' ' + name);
      if (!r.ok) { toast(errText(r)); lost(r); return; }
      $('ml-dump-result').textContent = r.bytes.toLocaleString('tr-TR') + ' bayt yazıldı: ' + r.path;
    });
  });

  // ---- harita ----
  const CLASS_NAMES = {A:'Anonim',Ja:'Java yığını',Jh:'Java',Ch:'C++ yığını',Ca:'C++ ayrılan',Cd:'C++ .data',Cb:'C++ .bss',S:'Stack',As:'Ashmem',V:'Video',Xa:'Kod (uyg.)',Xs:'Kod (sis.)',O:'Diğer'};
  $('ml-maps-filter').innerHTML = '<option value="">Tüm bölgeler</option>' + Object.keys(CLASS_NAMES).map(c => '<option value="' + c + '">' + c + ' · ' + CLASS_NAMES[c] + '</option>').join('');
  async function loadMaps(reset) {
    if (!st.pid) { toast(ERR.not_attached); return; }
    if (reset) { st.maps = []; st.mapsOff = 0; }
    await run('Harita okunuyor…', async () => {
      const r = await call('maps ' + st.mapsOff + ' 200');
      if (!r.ok) { toast(errText(r)); lost(r); return; }
      st.maps = st.maps.concat(r.items); st.mapsOff += r.items.length; st.mapsTotal = r.total; renderMaps();
    });
  }
  function renderMaps() {
    const f = $('ml-maps-filter').value;
    const list = st.maps.filter(m => !f || m.c === f);
    $('ml-maps').innerHTML = list.map(m => {
      const size = Number(BigInt(m.e) - BigInt(m.s));
      return '<button type="button" class="ml-map" data-s="' + esc(m.s) + '"><span class="ml-cls">' + esc(m.c) + '</span><code>' + esc(m.s) + ' – ' + esc(m.e) + '</code><span>' + (size >= 1048576 ? (size / 1048576).toFixed(1) + ' MB' : Math.round(size / 1024) + ' KB') + '</span><em>' + (m.w ? 'rw' : 'r-x') + '</em><small>' + esc(m.n) + '</small></button>';
    }).join('') || '<p class="fine">' + (st.pid ? 'Eşleşen bölge yok.' : 'Önce bir uygulamaya bağlan.') + '</p>';
    $('ml-maps-more').hidden = !(st.maps.length < st.mapsTotal);
  }
  $('ml-maps-refresh').addEventListener('click', () => loadMaps(true));
  $('ml-maps-more').addEventListener('click', () => loadMaps(false));
  $('ml-maps-filter').addEventListener('change', renderMaps);
  $('ml-maps').addEventListener('click', e => { const b = e.target.closest('.ml-map'); if (b) { showTab('hex'); hexGo(b.dataset.s); } });

  // ---- script motoru (gg API) ----
  const out = (...a) => {
    const el = $('ml-script-out');
    el.textContent += (el.textContent === 'Konsol hazır.' ? '' : '\n') + a.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' ');
    el.scrollTop = el.scrollHeight;
  };
  const REGION = {C_HEAP:1, JAVA_HEAP:2, C_ALLOC:4, C_DATA:8, C_BSS:16, ANONYMOUS:32, STACK:64, CODE_APP:16384, CODE_SYS:32768, JAVA:65536, ASHMEM:524288, VIDEO:1048576, OTHER:2097152};
  const REGION_NAME = {1:'cheap', 2:'jheap', 4:'calloc', 8:'cdata', 16:'cbss', 32:'anon', 64:'stack', 16384:'codeapp', 32768:'codesys', 65536:'java', 524288:'ashmem', 1048576:'video', 2097152:'other'};
  const SIGN = {EQUAL:'eq', NOT_EQUAL:'ne', GREATER:'gt', LESS:'lt', FUZZY_EQUAL:'unchanged', FUZZY_NOT_EQUAL:'changed', FUZZY_GREATER:'inc', FUZZY_LESS:'dec'};
  const gg = {
    TYPE_AUTO:'auto', TYPE_BYTE:'i8', TYPE_WORD:'i16', TYPE_DWORD:'i32', TYPE_QWORD:'i64', TYPE_FLOAT:'f32', TYPE_DOUBLE:'f64', TYPE_XOR:'xor'
  };
  Object.keys(REGION).forEach(k => { gg['REGION_' + k] = REGION[k]; });
  Object.keys(SIGN).forEach(k => { gg['SIGN_' + k] = SIGN[k]; });
  const core = async cmd => {
    if (st.scriptStop) throw new Error('Script durduruldu.');
    if (!st.pid) throw new Error(ERR.not_attached);
    const r = await call(cmd);
    if (!r.ok) throw new Error(errText(r));
    return r;
  };
  const needType = t => { const v = t === undefined || t === null ? 'auto' : String(t); if (v !== 'auto' && !TYPES.includes(v)) throw new Error('Geçersiz tür: ' + t); return v; };
  const addrStr = a => typeof a === 'string' ? (/^0x/i.test(a) ? a : '0x' + Number(a).toString(16)) : '0x' + Math.round(Number(a)).toString(16);
  const numOut = v => { const n = Number(v); return Number.isFinite(n) && String(n) === String(v).replace(/^\+/, '') ? n : v; };
  async function applyScriptRegions() {
    if (st.scriptRegions) { await core('region ' + st.scriptRegions); }
  }
  async function afterSearch(r) { applyResult(r); if (!st.fuzzy) await loadPage(); else renderResults(); }
  const searchText = (text, type) => {
    let t = String(text).trim().replace(/~/g, '..');
    if (t.includes(';')) { const g = parseGroup(t, type === 'auto' ? 'i32' : type); if (!g) throw new Error('Geçersiz grup: ' + text); return 'gscan ' + g.def + ' ' + g.window + ' ' + g.tokens.join(' '); }
    const parts = t.split('..').map(clean);
    if (!parts[0]) throw new Error('Boş değer.');
    return (type === 'auto' ? 'scan auto ' : 'scan ' + type + ' ') + parts.slice(0, 2).join(' ');
  };
  Object.assign(gg, {
    setRanges: async mask => {
      const names = Object.keys(REGION_NAME).filter(b => Number(mask) & Number(b)).map(b => REGION_NAME[b]);
      if (!names.length) throw new Error('Geçersiz bölge maskesi.');
      st.scriptRegions = names.join(','); st.scriptMask = Number(mask);
    },
    getRanges: async () => st.scriptMask || 0,
    searchNumber: async (text, type, _enc, sign) => {
      type = needType(type); sign = sign || 'eq';
      if (sign !== 'eq') throw new Error('İlk aramada yalnızca SIGN_EQUAL desteklenir (bulanık için searchFuzzy).');
      await applyScriptRegions();
      await afterSearch(await core(searchText(text, type)));
    },
    refineNumber: async (text, type, _enc, sign) => {
      sign = sign || 'eq';
      const needs = ['eq', 'ne', 'gt', 'lt'].includes(sign);
      const parts = String(text === undefined ? '' : text).trim().replace(/~/g, '..').split('..').map(clean);
      if (needs && !parts[0]) throw new Error('Boş değer.');
      await afterSearch(await core('next ' + sign + (needs ? ' ' + parts[0] + (sign === 'eq' && parts[1] ? ' ' + parts[1] : '') : '')));
    },
    searchFuzzy: async (diff, sign, type) => {
      sign = sign || 'unchanged'; type = needType(type); diff = Number(diff) || 0;
      if (!st.fuzzy && !st.total) { await applyScriptRegions(); await afterSearch(await core('fuzzy ' + (type === 'auto' || type === 'xor' ? 'i32' : type))); return; }
      let mode = sign; if (diff && sign === 'inc') mode = 'incby'; else if (diff && sign === 'dec') mode = 'decby';
      await afterSearch(await core('next ' + mode + (mode.endsWith('by') ? ' ' + diff : '')));
    },
    searchPointer: async maxOffset => {
      const first = await core('list 0 1'); if (!first.items.length) throw new Error(ERR.no_results);
      await afterSearch(await core('ptrscan ' + first.items[0].a + ' ' + (Number(maxOffset) || 256)));
    },
    getResultsCount: async () => (await core('list 0 1')).total,
    getResults: async (count, skip) => {
      count = Math.max(1, Math.min(Number(count) || 100, 5000)); skip = Number(skip) || 0;
      const res = [];
      while (res.length < count) {
        const r = await core('list ' + (skip + res.length) + ' ' + Math.min(200, count - res.length));
        if (!r.items.length) break;
        r.items.forEach(i => res.push({address: Number(BigInt(i.a)), value: numOut(i.v), flags: i.t}));
      }
      return res;
    },
    clearResults: async () => { await core('reset'); st.total = 0; st.fuzzy = false; renderResults(); },
    editAll: async value => (await core('setall ' + clean(value))).written,
    getValues: async list => {
      const items = (list || []).map(x => ({...x})), out2 = [];
      for (let i = 0; i < items.length; i += 40) {
        const chunk = items.slice(i, i + 40);
        const r = await core('getm ' + chunk.map(x => addrStr(x.address) + ':' + needType(x.flags || 'i32').replace('auto', 'i32')).join(' '));
        chunk.forEach((x, k) => { x.value = r.v[k] === '?' ? undefined : numOut(r.v[k]); out2.push(x); });
      }
      return out2;
    },
    setValues: async list => {
      for (const x of list || []) {
        const type = needType(x.flags || 'i32').replace('auto', 'i32');
        await core((type === 'bytes' ? 'setbytes ' : 'set ') + addrStr(x.address) + ' ' + type + ' ' + clean(x.value));
        if (x.freeze) await core('freeze ' + addrStr(x.address) + ' ' + type + ' ' + clean(x.value) + ' ' + (x.freezeMode || 'n'));
      }
      await refreshFrozen();
    },
    addListItems: async list => { (list || []).forEach(x => addSaved(addrStr(x.address), needType(x.flags || 'i32').replace('auto', 'i32'), true)); persistSaved(); renderSaved(); },
    getListItems: async () => st.saved.map(s => ({address: Number(BigInt(s.addr)), flags: s.type, name: s.label})),
    removeListItems: async list => {
      const ad = new Set((list || []).map(x => addrStr(x.address).toLowerCase()));
      st.saved = st.saved.filter(s => !ad.has(s.addr.toLowerCase())); persistSaved(); renderSaved();
    },
    clearList: async () => { st.saved = []; persistSaved(); renderSaved(); },
    getTargetInfo: async () => ({pid: st.pid, name: st.name, ptrSize: st.ptr}),
    getTargetPackage: async () => st.name,
    processPause: async () => { await core('pause'); st.paused = true; syncPauseBtn(); },
    processResume: async () => { await core('resume'); st.paused = false; syncPauseBtn(); },
    getRangesList: async () => {
      const all = []; let off = 0, total = 1;
      while (off < total && all.length < 2000) { const r = await core('maps ' + off + ' 200'); total = r.total; if (!r.items.length) break; all.push(...r.items); off += r.items.length; }
      return all.map(m => ({start: Number(BigInt(m.s)), end: Number(BigInt(m.e)), type: m.c, name: m.n, writable: !!m.w}));
    },
    dumpMemory: async (from, to) => {
      const name = 'script-' + Date.now() + '.bin';
      return (await core('dump ' + addrStr(from) + ' ' + addrStr(to) + ' ' + name)).path;
    },
    sleep: async ms => { const end = Date.now() + Math.max(0, Number(ms) || 0); while (Date.now() < end) { if (st.scriptStop) throw new Error('Script durduruldu.'); await sleep(Math.min(100, end - Date.now())); } },
    toast: async m => toast(String(m)),
    alert: async m => { window.alert(String(m)); },
    prompt: async (m, d) => window.prompt(String(m), d === undefined ? '' : String(d)),
    choice: async (items, _sel, m) => {
      const t = (m ? m + '\n' : '') + (items || []).map((x, i) => (i + 1) + ') ' + x).join('\n');
      const a = window.prompt(t, '1'); const n = Number(a);
      return a !== null && Number.isInteger(n) && n >= 1 && n <= items.length ? n : null;
    },
    copyText: async t => { try { await navigator.clipboard.writeText(String(t)); toast('Kopyalandı.'); } catch (_) { window.prompt('Kopyala:', String(t)); } },
    isVisible: async () => true, setVisible: async () => {}, skipRestoreState: async () => {}
  });

  const TEMPLATES = {
    'Örnek: tam değer bul ve değiştir': `// Oyunda altın 1000 iken çalıştır; altın değişince yeni değeri yaz.
gg.setRanges(gg.REGION_C_HEAP | gg.REGION_C_ALLOC | gg.REGION_ANONYMOUS | gg.REGION_JAVA_HEAP | gg.REGION_C_BSS | gg.REGION_C_DATA);
await gg.searchNumber('1000', gg.TYPE_DWORD);
print('Bulunan:', await gg.getResultsCount());
const yeni = await gg.prompt('Altın değişti. Yeni değeri yaz:');
if (yeni === null) return;
await gg.refineNumber(yeni, gg.TYPE_DWORD);
print('Kalan:', await gg.getResultsCount());
print('Yazılan adres sayısı:', await gg.editAll('99999', gg.TYPE_DWORD));`,
    'Örnek: grup arama (yan yana değerler)': `// Yan yana duran can;mana;altın gibi değerleri birlikte ara.
await gg.searchNumber('1234;5678;9000::128', gg.TYPE_DWORD);
const r = await gg.getResults(10);
r.forEach(x => print('0x' + x.address.toString(16), x.value, x.flags));`,
    'Örnek: bulanık arama (bilinmeyen değer)': `// Değer bilinmiyorsa: anlık görüntü al, oyunda değişiklik yap, sonra daralt.
await gg.searchFuzzy(0, gg.SIGN_FUZZY_EQUAL, gg.TYPE_DWORD);
await gg.alert('Oyunda değeri AZALT, sonra Tamam\\'a bas.');
await gg.searchFuzzy(0, gg.SIGN_FUZZY_LESS, gg.TYPE_DWORD);
print('Kalan:', await gg.getResultsCount());`,
    'Örnek: sonuçları dondur': `// İlk 5 sonucu 999 olarak dondur.
const r = await gg.getResults(5);
await gg.setValues(r.map(x => ({address: x.address, flags: x.flags, value: 999, freeze: true})));
print(r.length, 'adres donduruldu');`,
    'Örnek: kayıtlı listeyi göster': `const l = await gg.getListItems();
const v = await gg.getValues(l);
v.forEach(x => print(x.name, '0x' + x.address.toString(16), x.flags, x.value));`
  };
  const SCRIPT_KEY = 'zyron_ml_scripts_v1';
  let userScripts = store.get(SCRIPT_KEY, {});
  if (!userScripts || typeof userScripts !== 'object' || Array.isArray(userScripts)) userScripts = {};
  function renderScriptSel(sel) {
    const opts = ['<option value="">— şablon / kayıtlı script seç —</option>']
      .concat(Object.keys(TEMPLATES).map(k => '<option value="t:' + esc(k) + '">' + esc(k) + '</option>'))
      .concat(Object.keys(userScripts).map(k => '<option value="u:' + esc(k) + '">★ ' + esc(k) + '</option>'));
    $('ml-script-sel').innerHTML = opts.join(''); if (sel) $('ml-script-sel').value = sel;
  }
  renderScriptSel();
  $('ml-script-sel').addEventListener('change', () => {
    const v = $('ml-script-sel').value; if (!v) return;
    const key = v.slice(2);
    if (v[0] === 't') { $('ml-script-code').value = TEMPLATES[key]; $('ml-script-name').value = ''; }
    else { $('ml-script-code').value = userScripts[key] || ''; $('ml-script-name').value = key; }
  });
  $('ml-script-save').addEventListener('click', () => {
    const name = $('ml-script-name').value.trim();
    if (!name || name.length > 40) { toast('1–40 karakterlik bir ad yaz.'); return; }
    if (Object.keys(userScripts).length >= 50 && !(name in userScripts)) { toast('En fazla 50 script saklanır.'); return; }
    if ($('ml-script-code').value.length > 100000) { toast('Script çok uzun.'); return; }
    userScripts[name] = $('ml-script-code').value; store.set(SCRIPT_KEY, userScripts); renderScriptSel('u:' + name); toast('Script kaydedildi.');
  });
  $('ml-script-del').addEventListener('click', () => {
    const name = $('ml-script-name').value.trim();
    if (!(name in userScripts)) { toast('Kayıtlı script seç.'); return; }
    if (!confirm('"' + name + '" silinsin mi?')) return;
    delete userScripts[name]; store.set(SCRIPT_KEY, userScripts); renderScriptSel(); $('ml-script-name').value = ''; toast('Silindi.');
  });
  $('ml-script-clear').addEventListener('click', () => { $('ml-script-out').textContent = 'Konsol hazır.'; });
  $('ml-script-stop').addEventListener('click', () => { st.scriptStop = true; out('— durdurma istendi —'); });
  async function runScript() {
    if (st.scriptRunning) return;
    if (st.busy) { toast('Önceki işlem sürüyor…'); return; }
    const code = $('ml-script-code').value;
    if (!code.trim()) { toast('Script boş.'); return; }
    st.scriptRunning = true; st.scriptStop = false; setBusy(true);
    $('ml-script-stop').disabled = false; $('ml-script-run').disabled = true; out('— çalışıyor —');
    try {
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      const fn = new AsyncFunction('gg', 'print', 'console', code);
      const con = {log: out, warn: out, error: out, info: out};
      await fn(gg, out, con);
      out('— bitti —');
    } catch (e) { out('HATA: ' + (e && e.message ? e.message : e)); }
    finally {
      st.scriptRunning = false; setBusy(false); $('ml-script-stop').disabled = true; $('ml-script-run').disabled = !st.root;
      if (st.pid) { refreshFrozen(); if (!st.fuzzy && st.total) loadPage(); }
    }
  }
  $('ml-script-run').addEventListener('click', runScript);
  window.zyronGG = gg;   // test ve gelişmiş kullanım için

  // ---- canlı yenileme ----
  setInterval(async () => {
    if (st.busy || st.scriptRunning || !st.pid || !$('memlab').classList.contains('active') || document.hidden) return;
    if ($('ml-p-search').classList.contains('active') && $('ml-live').checked && st.total && !st.fuzzy) {
      const r = await call('list ' + (st.page * PAGE) + ' ' + PAGE);
      if (!r.ok) { lost(r); return; }
      const rows = $('ml-results').querySelectorAll('.ml-row');
      r.items.forEach((it, idx) => {
        const input = rows[idx] && rows[idx].querySelector('.ml-val');
        if (input && rows[idx].dataset.a === it.a && document.activeElement !== input) {
          input.value = it.v;
          const hv = rows[idx].querySelector('.ml-hexv'); if (hv) hv.textContent = hexOf(it.v, it.t);
        }
      });
    } else if ($('ml-p-saved').classList.contains('active')) refreshSaved();
  }, 1500);

  // ---- başlangıç ----
  async function adopt() {
    if (!bridge || typeof bridge.isRunning !== 'function' || !bridge.isRunning()) return;
    const s = await call('status'); if (!s.ok || s.euid !== 0) return;
    st.root = true; setStatus('Root hazır · çekirdek çalışıyor', true); step(1, true); enableControls(true); syncMode();
    refreshProcs();
    if (s.pid > 0) {
      setAttached(s.pid, s.name || ('PID ' + s.pid), s.ro, s.ptr);
      st.paused = !!s.paused; syncPauseBtn(); st.type = s.type;
      if (s.fuzzy) { st.fuzzy = true; renderResults(); }
      else if (s.hits > 0) { st.total = s.hits; step(3, true); await loadPage(); }
    }
  }
  if (!bridge) {
    $('ml-banner').hidden = false;
    document.querySelectorAll('#memlab button, #memlab input, #memlab select, #memlab textarea').forEach(el => {
      if (!el.closest('.ml-tabs') && !el.closest('#ml-p-script') && el.id !== 'ml-saved-export' && el.id !== 'ml-saved-clear') el.disabled = true;
    });
    $('ml-script-run').disabled = true;
    setStatus(ERR.no_bridge);
  } else {
    let info = {}; try { info = JSON.parse(bridge.info()); } catch (_) {}
    if (info.binary === false) setStatus(ERR.no_binary);
    else setStatus('Root izni henüz kontrol edilmedi' + (info.abi ? ' · ' + info.abi : ''));
    enableControls(false);
  }
  syncMode(); renderResults(); renderProcs(); renderFrozen(); renderSaved(); renderMaps(); renderHex();

  // ---- GG tarzı üst süreç çubuğu, otomatik sekme geçişi, ayarlar ----
  (function () {
    const chip = $('ml-topproc'), att = $('ml-attached'); let wasAttached = false;
    function sync() {
      const txt = att.textContent.trim(), on = /Bağlı/.test(txt);
      chip.textContent = on ? txt.replace(/^Bağlı:?\s*/, '') : 'Süreç seçilmedi';
      chip.classList.toggle('on', on);
      if (on && !wasAttached) showTab('search');
      if (!on && wasAttached) showTab('proc');
      wasAttached = on;
    }
    new MutationObserver(sync).observe(att, { childList: true, characterData: true, subtree: true });
    sync();
    $('ml-set-clear-saved').addEventListener('click', () => { st.saved = []; persistSaved(); renderSaved(); toast('Kayıtlı liste temizlendi.'); });
    $('ml-set-clear-scripts').addEventListener('click', () => { try { localStorage.removeItem('zyron_ml_scripts_v1'); } catch (_) {} toast('Kayıtlı scriptler silindi (sayfayı yenileyince listeden kalkar).'); });
  })();
  adopt();
})();
