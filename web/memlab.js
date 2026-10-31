(()=> {
  'use strict';
  // Memory Lab arayüzü. Yalnızca root'lu ZYRON Android uygulamasında (window.ZyronMem köprüsü) çalışır.
  const $ = id => document.getElementById(id);
  if (!$('memlab')) return;
  const PAGE = 50;
  const bridge = window.ZyronMem || null;
  const esc = v => String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let toastTimer = null;
  const toast = message => {
    const t = $('toast'); if (!t) return;
    t.textContent = message; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
  };

  const ERR = {
    no_bridge: 'Memory Lab yalnızca ZYRON Android uygulamasında çalışır.',
    no_root: 'Root izni alınamadı. Root yöneticisinde ZYRON için izin ver ve tekrar dene.',
    no_binary: 'Yerel çekirdek bu cihaz mimarisi için pakette yok.',
    blocked: 'Bu süreç korumalı (sistem veya korumalı uygulama). Bağlanılamaz.',
    not_attached: 'Önce listeden bir uygulama seç.',
    process_gone: 'Hedef uygulama kapanmış. Yeniden aç ve tekrar seç.',
    no_results: 'Önce bir tarama yap.',
    too_many: 'Toplu yazma için önce sonuçları 50 veya daha aza indir.',
    not_writable: 'Bu adrese yazılamıyor.',
    read_only: 'Bu süreç salt okunur açıldı, yazılamaz.',
    write_failed: 'Yazma başarısız oldu.',
    freeze_limit: 'En fazla 64 adres dondurulabilir.',
    bad_arg: 'Değer veya tür geçersiz.',
    bad_command: 'Geçersiz komut.',
    core_exited: 'Çekirdek kapandı. "Root\'u kontrol et" ile yeniden başlat.',
    open_failed: 'Süreç belleği açılamadı (root gerekli).',
    no_process: 'Süreç bulunamadı.'
  };
  const errText = r => ERR[r && r.err] || (r && r.msg) || 'İşlem başarısız.';

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
    const id = ++seq; pending.set(id, resolve);
    try { fn(id); } catch (e) { pending.delete(id); resolve({ok:false, err:'bridge', msg:String(e)}); }
  });
  const call = command => viaBridge(id => bridge.send(id, command));

  // ---- durum ----
  const st = { root:false, pid:0, name:'', type:'i32', total:0, page:0, busy:false, procs:[] };
  const setBusy = on => {
    st.busy = on;
    ['ml-scan','ml-next','ml-reset','ml-proc-refresh','ml-setall-btn'].forEach(id => { const el = $(id); if (el) el.disabled = on || !st.root; });
  };
  const setStatus = (text, ok) => { const el = $('ml-status'); el.textContent = text; el.classList.toggle('ml-ok', !!ok); };
  const step = (n, done) => { const el = $('ml-step-' + n); if (el) el.classList.toggle('done', !!done); };

  async function run(label, fn) {
    if (st.busy) { toast('Önceki işlem sürüyor…'); return; }
    setBusy(true); $('ml-busy').textContent = label;
    try { return await fn(); } finally { setBusy(false); $('ml-busy').textContent = ''; }
  }

  // ---- 1) root ----
  $('ml-root').addEventListener('click', async () => {
    $('ml-root').disabled = true; setStatus('Root kontrol ediliyor…');
    const r = await viaBridge(id => bridge.checkRoot(id));
    $('ml-root').disabled = !bridge;
    if (r.ok && r.euid === 0) {
      st.root = true; setStatus('Root hazır · çekirdek çalışıyor', true); step(1, true);
      document.querySelectorAll('#memlab [data-needs-root]').forEach(el => el.disabled = false);
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
  $('ml-procs').addEventListener('click', async event => {
    const b = event.target.closest('[data-pid]'); if (!b) return;
    await run('Bağlanılıyor…', async () => {
      const r = await call('attach ' + Number(b.dataset.pid));
      if (!r.ok) { toast(errText(r)); return; }
      st.pid = r.pid; st.name = r.name; st.total = 0; st.page = 0;
      $('ml-attached').innerHTML = '<span class="ml-dot"></span> Bağlı: <strong>' + esc(r.name) + '</strong> <small>PID ' + r.pid + (r.ro ? ' · salt okunur' : '') + '</small>';
      $('ml-detach').hidden = false; step(2, true); renderResults(); renderFrozen();
      toast('Bağlandı: ' + r.name);
    });
  });
  $('ml-detach').addEventListener('click', async () => {
    await call('detach'); resetAttach();
  });
  function resetAttach() {
    st.pid = 0; st.name = ''; st.total = 0; st.page = 0;
    $('ml-attached').textContent = 'Henüz uygulama seçilmedi.';
    $('ml-detach').hidden = true; step(2, false); step(3, false); renderResults(); renderFrozen();
  }
  const lost = r => { if (r && (r.err === 'process_gone' || r.err === 'not_attached')) { resetAttach(); } };

  // ---- 3) tarama ----
  const valueArgs = (a, b) => (a ? ' ' + a : '') + (b ? ' ' + b : '');
  const clean = v => v.trim().replace(/\s+/g, '');
  $('ml-type').addEventListener('change', () => { st.type = $('ml-type').value; });
  $('ml-scan').addEventListener('click', async () => {
    if (!st.pid) { toast(ERR.not_attached); return; }
    const type = $('ml-type').value, v1 = clean($('ml-value').value), v2 = clean($('ml-value2').value);
    if (!v1) { toast('Aranacak değeri yaz.'); return; }
    await run('Taranıyor… (büyük oyunlarda biraz sürebilir)', async () => {
      let r = await call('region ' + $('ml-region').value);
      if (r.ok) r = await call('scan ' + type + valueArgs(v1, v2));
      if (!r.ok) { toast(errText(r)); lost(r); return; }
      st.type = r.type; st.total = r.hits; st.page = 0; step(3, true);
      if (r.truncated) toast('Çok fazla sonuç: ilk 3 milyon tutuldu. Değeri değiştirip daralt.');
      await loadPage();
    });
  });
  $('ml-reset').addEventListener('click', async () => {
    await run('Sıfırlanıyor…', async () => { await call('reset'); st.total = 0; st.page = 0; step(3, false); renderResults(); });
  });
  $('ml-next').addEventListener('click', async () => {
    if (!st.pid) { toast(ERR.not_attached); return; }
    const mode = $('ml-mode').value, v1 = clean($('ml-nvalue').value), v2 = clean($('ml-nvalue2').value);
    const needsValue = ['eq', 'incby', 'decby'].includes(mode);
    if (needsValue && !v1) { toast('Yeni değeri yaz.'); return; }
    await run('Daraltılıyor…', async () => {
      const r = await call('next ' + mode + (needsValue ? valueArgs(v1, mode === 'eq' ? v2 : '') : ''));
      if (!r.ok) { toast(errText(r)); lost(r); return; }
      st.total = r.hits; st.page = 0; await loadPage();
      if (r.hits === 0) toast('Sonuç kalmadı. Sıfırlayıp yeniden tara.');
    });
  });

  // ---- 4) sonuçlar ----
  function renderResults(items) {
    const head = st.total ? st.total.toLocaleString('tr-TR') + ' sonuç · ' + st.type : 'Sonuç yok';
    $('ml-count').textContent = head;
    const pages = Math.max(1, Math.ceil(st.total / PAGE));
    $('ml-page').textContent = (st.page + 1) + ' / ' + pages;
    $('ml-prev').disabled = st.page <= 0; $('ml-nextpage').disabled = st.page + 1 >= pages;
    $('ml-setall').hidden = !(st.total > 0 && st.total <= 50);
    if (!items) { $('ml-results').innerHTML = '<p class="fine">Tarama yaptığında adresler burada görünür.</p>'; return; }
    $('ml-results').innerHTML = items.map(i =>
      '<div class="ml-row" data-a="' + esc(i.a) + '"><code>' + esc(i.a) + '</code>' +
      '<input class="ml-val" value="' + esc(i.v) + '" inputmode="decimal" aria-label="Değer ' + esc(i.a) + '">' +
      '<button type="button" class="secondary" data-act="set">Yaz</button>' +
      '<button type="button" class="secondary" data-act="freeze">Dondur</button></div>'
    ).join('') || '<p class="fine">Sonuç kalmadı.</p>';
  }
  async function loadPage() {
    const r = await call('list ' + (st.page * PAGE) + ' ' + PAGE);
    if (!r.ok) { toast(errText(r)); lost(r); return; }
    st.total = r.total; st.type = r.type; renderResults(r.items);
  }
  $('ml-prev').addEventListener('click', () => run('Yükleniyor…', async () => { st.page = Math.max(0, st.page - 1); await loadPage(); }));
  $('ml-nextpage').addEventListener('click', () => run('Yükleniyor…', async () => { st.page++; await loadPage(); }));

  $('ml-results').addEventListener('click', async event => {
    const b = event.target.closest('[data-act]'); if (!b) return;
    const row = b.closest('.ml-row'), addr = row.dataset.a, val = clean(row.querySelector('.ml-val').value);
    if (!val) { toast('Bir değer yaz.'); return; }
    const verb = b.dataset.act === 'set' ? 'set ' : 'freeze ';
    await run('Yazılıyor…', async () => {
      const r = await call(verb + addr + ' ' + st.type + ' ' + val);
      if (!r.ok) { toast(errText(r)); lost(r); return; }
      toast(b.dataset.act === 'set' ? 'Yazıldı: ' + addr : 'Donduruldu: ' + addr);
      if (b.dataset.act === 'freeze') renderFrozen();
    });
  });

  // toplu yazma: iki adımlı onay
  let armTimer = null;
  $('ml-setall-btn').addEventListener('click', async () => {
    const btn = $('ml-setall-btn'), v = clean($('ml-setall-value').value);
    if (!v) { toast('Yazılacak değeri gir.'); return; }
    if (btn.dataset.armed !== '1') {
      btn.dataset.armed = '1'; btn.textContent = st.total + ' adrese yaz — Onayla';
      clearTimeout(armTimer);
      armTimer = setTimeout(() => { btn.dataset.armed = ''; btn.textContent = 'Hepsine yaz'; }, 4000);
      return;
    }
    btn.dataset.armed = ''; btn.textContent = 'Hepsine yaz'; clearTimeout(armTimer);
    await run('Yazılıyor…', async () => {
      const r = await call('setall ' + v);
      if (!r.ok) { toast(errText(r)); lost(r); return; }
      toast(r.written + ' / ' + r.total + ' adrese yazıldı.'); await loadPage();
    });
  });

  // ---- dondurulanlar ----
  async function renderFrozen() {
    if (!st.pid) { $('ml-frozen').innerHTML = '<span class="fine">Dondurulmuş değer yok.</span>'; return; }
    const r = await call('frozen');
    if (!r.ok) return;
    $('ml-frozen').innerHTML = r.items.map(i =>
      '<span class="profile-chip"><code>' + esc(i.a) + '</code> = ' + esc(i.v) + ' <small>' + esc(i.t) + '</small> ' +
      '<button type="button" data-unfreeze="' + esc(i.a) + '">Çöz</button></span>'
    ).join('') || '<span class="fine">Dondurulmuş değer yok.</span>';
  }
  $('ml-frozen').addEventListener('click', async event => {
    const b = event.target.closest('[data-unfreeze]'); if (!b) return;
    await call('unfreeze ' + b.dataset.unfreeze); renderFrozen();
  });

  // ---- canlı değer yenileme ----
  setInterval(async () => {
    if (!$('ml-live').checked || st.busy || !st.pid || !st.total) return;
    if (!$('memlab').classList.contains('active')) return;
    const r = await call('list ' + (st.page * PAGE) + ' ' + PAGE);
    if (!r.ok) { lost(r); return; }
    const rows = $('ml-results').querySelectorAll('.ml-row');
    r.items.forEach((it, idx) => {
      const input = rows[idx] && rows[idx].querySelector('.ml-val');
      if (input && rows[idx].dataset.a === it.a && document.activeElement !== input) input.value = it.v;
    });
  }, 1500);

  // ---- başlangıç ----
  if (!bridge) {
    $('ml-banner').hidden = false;
    document.querySelectorAll('#memlab button, #memlab input, #memlab select').forEach(el => el.disabled = true);
    setStatus(ERR.no_bridge);
  } else {
    let info = {}; try { info = JSON.parse(bridge.info()); } catch (_) {}
    if (info.binary === false) setStatus(ERR.no_binary);
    else setStatus('Root izni henüz kontrol edilmedi · ' + (info.abi || ''));
    document.querySelectorAll('#memlab [data-needs-root]').forEach(el => el.disabled = true);
  }
  renderResults(); renderProcs(); renderFrozen();
})();
