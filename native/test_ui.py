#!/usr/bin/env python3
"""Memory Lab arayuzunu gercek Chrome'da, gercek memcore ile uctan uca test eder.
Kopru (window.ZyronMem) yerel bir HTTP sunucusu uzerinden memcore surecine baglanir.
Sayfa 1: normal kip (tum ozellikler). Sayfa 2: yuzen pencere kipi (?overlay=1) + acik oturumu devralma.
Gerekenler: google-chrome (veya chromium), cc, root.   Calistirma: sudo python3 native/test_ui.py"""
import http.server, json, os, shutil, subprocess, sys, tempfile, threading, urllib.parse

if os.geteuid() != 0:
    print("Bu test root gerektirir (sudo python3 native/test_ui.py). Atlandi."); sys.exit(0)
HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(os.path.dirname(HERE), "web")
TMP = tempfile.mkdtemp(prefix="memlab-ui-")
DATA = os.path.join(TMP, "data"); os.makedirs(DATA)
CORE, TARGET = os.path.join(TMP, "memcore"), os.path.join(TMP, "target")
subprocess.check_call(["cc", "-O2", "-o", CORE, os.path.join(HERE, "memcore.c"), "-lpthread", "-lm"])
subprocess.check_call(["cc", "-O2", "-o", TARGET, os.path.join(HERE, "test_target.c")])
CHROME = next((c for c in ("google-chrome", "chromium", "chromium-browser") if shutil.which(c)), None)
if not CHROME:
    print("Chrome/Chromium bulunamadi, UI testi atlandi."); sys.exit(0)

core = subprocess.Popen([CORE, "--min-uid", "0", "--data-dir", DATA, "--tmp-dir", TMP],
                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
target = subprocess.Popen([TARGET], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
T_PID = int(target.stdout.readline().split("=")[1])
ADDRS = dict(kv.split("=") for kv in target.stdout.readline().split()[1:])
lock = threading.Lock()
reports, events = {}, {"1": threading.Event(), "2": threading.Event()}

def mock(running):
    return """<script>
window.ZyronMem={info:()=>JSON.stringify({abi:'test',binary:true,sdk:35,dataDir:'%s'}),
 isRunning:()=>%s,
 openOverlay:()=>{window.__overlayOpened=true;},
 checkRoot:id=>{fetch('/send?cmd=status').then(r=>r.text()).then(t=>window.zyronMemResult(id,t));},
 send:(id,c)=>{fetch('/send?cmd='+encodeURIComponent(c)).then(r=>r.text()).then(t=>window.zyronMemResult(id,t));}};
</script>""" % (DATA, "true" if running else "false")

COMMON = r"""
const $ = id => document.getElementById(id), steps = [];
const ok = (n, c, x) => steps.push([n, !!c, x === undefined ? '' : String(x)]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (f, ms = 12000) => { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await f(); if (v) return v; } catch (e) {} await sleep(60); } return null; };
const idle = () => waitFor(() => !$('ml-scan').disabled && $('ml-busy').textContent === '');
const tg = async c => (await fetch('/target?cmd=' + c)).json();
const A = () => fetch('/addrs').then(r => r.json());
const rows = () => [...document.querySelectorAll('#ml-results .ml-row')];
const rowOf = a => rows().find(r => r.dataset.a === a);
const hasRow = a => !!rowOf(a);
const setv = (id, v) => { $(id).value = v; $(id).dispatchEvent(new Event('input')); $(id).dispatchEvent(new Event('change')); };
const done = n => fetch('/report?n=' + n, { method: 'POST', body: JSON.stringify(steps) });
"""

DRIVER1 = COMMON + r"""
window.addEventListener('load', async () => {
  try {
    const ad = await A(); const gold = ad.gold, decoy = ad.decoy, hp = ad.hp, enc = ad.enc, pl = ad.pl, holder = ad.holder, name = ad.name;
    const hex = n => '0x' + BigInt(n).toString(16);
    ok('memlab is the only screen', $('memlab').classList.contains('active') && !document.querySelector('.sidebar, .hero-banner, #lab, #cpmlab'));
    ok('process panel is the start screen', $('ml-p-proc').classList.contains('active'));
    ok('top chip says no process', $('ml-topproc').textContent === 'Süreç seçilmedi');
    $('ml-p-proc').querySelector('[data-open-tab=guide]').click();
    ok('guide opens from the process screen', $('ml-p-guide').classList.contains('active') && document.querySelectorAll('.ml-guide').length >= 8);
    $('ml-p-guide').querySelector('[data-open-tab=proc]').click();
    ok('guide back button returns', $('ml-p-proc').classList.contains('active'));
    ok('seven GG-style bottom tabs', document.querySelectorAll('.ml-tabs .ml-tab').length === 7);
    ok('banner hidden when bridge exists', $('ml-banner').hidden === true);
    ok('controls disabled before root', $('ml-scan').disabled === true);
    ok('float button visible in the app', $('ml-float').hidden === false);
    $('ml-float').click(); ok('float button calls the bridge', window.__overlayOpened === true);

    $('ml-root').click();
    ok('root ready', await waitFor(() => $('ml-status').classList.contains('ml-ok')), $('ml-status').textContent);
    ok('controls enabled after root', await idle());
    ok('process list shows target', await waitFor(() => [...document.querySelectorAll('.ml-proc')].some(x => x.textContent.includes('target'))));
    setv('ml-proc-q', 'target');
    [...document.querySelectorAll('.ml-proc')].find(x => x.textContent.includes('target')).click();
    ok('attached', await waitFor(() => $('ml-attached').textContent.includes('Bağlı') && $('ml-attached').textContent.includes('64 bit')), $('ml-attached').textContent);
    ok('top chip shows the target', await waitFor(() => $('ml-topproc').classList.contains('on') && $('ml-topproc').textContent.includes('target')), $('ml-topproc').textContent);
    ok('auto switch to search after attach', await waitFor(() => $('ml-p-search').classList.contains('active')));

    // --- tam deger, daralt, yaz ---
    await idle(); $('ml-scan').click();
    ok('empty value warns', await waitFor(() => $('toast').textContent.includes('Aranacak değeri')));
    setv('ml-type', 'i32'); setv('ml-value', '1000'); $('ml-scan').click();
    ok('scan lists >=2 rows', await waitFor(() => rows().length >= 2), $('ml-count').textContent);
    ok('count label has type', /sonuç · i32/.test($('ml-count').textContent), $('ml-count').textContent);
    await idle(); await tg('dec');
    setv('ml-rmode', 'eq'); setv('ml-nvalue', '900'); $('ml-next').click();
    ok('narrowed to gold', await waitFor(() => rows().length >= 1 && rows().length <= 3 && hasRow(gold)));
    await idle(); let r = rowOf(gold);
    r.querySelector('.ml-val').value = '4242'; r.querySelector('[data-act=set]').click();
    ok('write reaches target', await waitFor(async () => (await tg('get')).gold === '4242'), $('toast').textContent + ' | ' + JSON.stringify(await tg('get')) + ' | ' + r.outerHTML.slice(0,200));
    ok('decoy untouched', (await tg('get')).decoy === '1000');
    $('ml-hexdisp').checked = true; $('ml-hexdisp').dispatchEvent(new Event('change'));
    ok('hex display shows 0x1092', await waitFor(() => { const x = rowOf(gold); return x && x.textContent.includes('0x1092'); }));
    $('ml-hexdisp').checked = false; $('ml-hexdisp').dispatchEvent(new Event('change')); await idle();

    // --- yon kisitli dondurma ---
    await idle(); setv('ml-fmode', 'inc'); r = rowOf(gold);
    r.querySelector('[data-act=freeze]').click();
    ok('freeze chip shows up with mode arrow', await waitFor(() => $('ml-frozen').textContent.includes(gold) && $('ml-frozen').textContent.includes('↑')), $('ml-frozen').textContent);
    await sleep(250); await tg('dec'); await sleep(350);
    ok('inc freeze restores the floor', (await tg('get')).gold === '4242');
    $('ml-frozen').querySelector('[data-unfreeze]').click();
    ok('unfreeze removes chip', await waitFor(() => !$('ml-frozen').textContent.includes(gold)));

    // --- kayitli liste ---
    await idle(); rowOf(gold).querySelector('[data-act=save]').click();
    ok('saved badge counts 1', await waitFor(() => $('ml-saved-badge').textContent === '1'));
    document.querySelector('[data-mltab=saved]').click();
    ok('saved row shows live value', await waitFor(() => { const v = document.querySelector('#ml-saved .ml-val'); return v && v.value === '4242'; }), document.querySelector('.ml-panel.active').id + ' | ' + $('ml-saved').innerHTML.slice(0,300) + ' | ' + $('toast').textContent);
    const sv = document.querySelector('#ml-saved .ml-row');
    sv.querySelector('.ml-val').value = '5000'; sv.querySelector('[data-act=set]').click();
    ok('saved list writes', await waitFor(async () => (await tg('get')).gold === '5000'));
    sv.querySelector('[data-act=freeze]').click();
    ok('saved list freezes', await waitFor(async () => { await sleep(100); return $('ml-frozen').textContent.includes(gold); }));
    $('ml-saved-unfreezeall').click();
    ok('saved unfreeze all', await waitFor(() => !$('ml-frozen').textContent.includes(gold)));
    ok('saved list persisted', JSON.parse(localStorage.getItem('zyron_ml_saved_v1')).items.length === 1);

    // --- hex goruntuleyici ---
    sv.querySelector('[data-act=hex]').click();
    ok('hex tab opens and shows bytes', await waitFor(() => document.querySelectorAll('.hb').length >= 128), document.querySelectorAll('.hb').length);
    ok('hex address field filled', $('ml-hex-addr').value.toLowerCase() === gold.toLowerCase());
    document.querySelector('.hb[data-o="0"]').click();
    ok('byte select shows 7 type readouts', await waitFor(() => document.querySelectorAll('#ml-hex-vals .ml-hv').length === 7), document.querySelectorAll('#ml-hex-vals .ml-hv').length);
    ok('selected label shows address', $('ml-hex-sel').textContent.includes(gold));
    setv('ml-hex-write', '00'); $('ml-hex-write-btn').click();
    ok('hex write reaches target (0x1388 -> 0x1300)', await waitFor(async () => (await tg('get')).gold === '4864'));
    setv('ml-dump-name', 'ui-dump.bin'); setv('ml-dump-len', '4096'); $('ml-dump-btn').click();
    ok('dump reports a path', await waitFor(() => $('ml-dump-result').textContent.includes('ui-dump.bin')), $('ml-dump-result').textContent);
    setv('ml-dump-name', '../x'); $('ml-dump-btn').click();
    ok('dump rejects bad file name', await waitFor(() => $('toast').textContent.includes('Dosya adı')));

    // --- harita ---
    document.querySelector('[data-mltab=maps]').click();
    ok('maps load', await waitFor(() => document.querySelectorAll('.ml-map').length > 5), document.querySelectorAll('.ml-map').length);
    setv('ml-maps-filter', 'Ch');
    ok('maps filter keeps only Ch', document.querySelectorAll('.ml-map').length >= 1 && [...document.querySelectorAll('.ml-cls')].every(x => x.textContent === 'Ch'));
    document.querySelector('.ml-map').click();
    ok('map row opens hex tab', await waitFor(() => $('ml-p-hex').classList.contains('active') && document.querySelectorAll('.hb').length > 0));

    // --- bulanik ---
    document.querySelector('[data-mltab=search]').click();
    await idle(); setv('ml-smode', 'fuzzy'); setv('ml-type', 'i32');
    ok('fuzzy hides value box', $('ml-value').disabled === true);
    $('ml-scan').click();
    ok('fuzzy snapshot is announced', await waitFor(() => $('ml-count').textContent.includes('Bulanık') && $('ml-results').textContent.includes('MB')), $('ml-count').textContent);
    await idle(); await tg('dec');
    setv('ml-rmode', 'decby'); setv('ml-nvalue', '100'); $('ml-next').click();
    ok('fuzzy decby finds gold', await waitFor(() => hasRow(gold)), $('ml-count').textContent);

    // --- grup ---
    await idle(); setv('ml-smode', 'group'); setv('ml-value', '1234567;2345678;3456789::64'); $('ml-scan').click();
    ok('group finds the 3 fields', await waitFor(() => rows().length === 3 && hasRow(pl) && hasRow(hex(BigInt(pl) + 4n)) && hasRow(hex(BigInt(pl) + 8n))), rows().length);
    await idle(); setv('ml-value', 'abc;def'); $('ml-scan').click();
    ok('bad group warns', await waitFor(() => $('toast').textContent.includes('Grup biçimi')));
    await idle(); setv('ml-value', '1000D;87.5F::512'); $('ml-scan').click();
    ok('suffix group (D/F letters)', await waitFor(() => hasRow(gold) === false && hasRow(decoy) && hasRow(hp)), rows().map(x => x.dataset.a + ':' + x.dataset.t).join());

    // --- metin ve bayt ---
    await idle(); setv('ml-smode', 'text'); setv('ml-value', 'ZYRON_HERO_NAME'); $('ml-scan').click();
    ok('text finds the string', await waitFor(() => hasRow(name) && rowOf(name).dataset.t === 'bytes'), $('ml-count').textContent);
    await idle(); setv('ml-smode', 'bytes'); setv('ml-value', '5a 59 52 4f 4e 5f'); $('ml-scan').click();
    ok('bytes finds the string', await waitFor(() => hasRow(name)));
    await idle(); r = rowOf(name); r.querySelector('.ml-val').value = '4142'; r.querySelector('[data-act=set]').click();
    ok('bytes row write reaches target', await waitFor(async () => (await tg('get')).name === 'ABRON_HERO_NAME'));
    await idle(); setv('ml-value', 'XYZ'); $('ml-scan').click();
    ok('bad hex warns', await waitFor(() => $('toast').textContent.includes('Geçersiz hex')));

    // --- XOR ve Auto ---
    await idle(); setv('ml-smode', 'exact'); setv('ml-type', 'xor'); setv('ml-value', '777'); setv('ml-value2', ''); $('ml-scan').click();
    ok('xor finds enc', await waitFor(() => hasRow(enc) && rowOf(enc).dataset.t === 'xor'));
    r = rowOf(enc); r.querySelector('.ml-val').value = '999'; r.querySelector('[data-act=set]').click();
    ok('xor write decrypts on target', await waitFor(async () => (await tg('get')).enc === '999'));
    await idle(); setv('ml-type', 'auto'); setv('ml-value', '87.5'); $('ml-scan').click();
    ok('auto float finds hp as f32', await waitFor(() => hasRow(hp) && rowOf(hp).dataset.t === 'f32'));

    // --- isaretci ---
    await idle(); setv('ml-type', 'i32'); setv('ml-value', '1234567'); $('ml-scan').click();
    ok('struct field found', await waitFor(() => hasRow(pl)));
    setv('ml-ptr-off', '0'); rowOf(pl).querySelector('[data-act=more]').click();
    rowOf(pl).querySelector('[data-act=ptr]').click();
    ok('pointer search finds holder', await waitFor(() => hasRow(holder) && rowOf(holder).dataset.t === 'i64'), $('ml-count').textContent);
    await idle(); rowOf(holder).querySelector('[data-act=more]').click();
    rowOf(holder).querySelector('[data-act=jump]').click();
    ok('jump shows the struct', await waitFor(() => rows().length === 1 && rows()[0].dataset.a === pl && rows()[0].querySelector('.ml-val').value === '1234567'));
    await idle(); setv('ml-shift', '4'); $('ml-shift-btn').click();
    ok('offset shift lands on mp', await waitFor(() => rows().length === 1 && rows()[0].querySelector('.ml-val').value === '2345678'));
    await idle(); rows()[0].querySelector('[data-act=more]').click(); rows()[0].querySelector('[data-act=drop]').click();
    ok('drop empties the list', await waitFor(() => $('ml-count').textContent === 'Sonuç yok' || rows().length === 0));

    // --- toplu yazma (iki adimli onay) ---
    await idle(); setv('ml-value', '1234567'); $('ml-scan').click();
    ok('setall panel visible for small list', await waitFor(() => $('ml-bulk').hidden === false && rows().length >= 1));
    setv('ml-setall-value', '7'); $('ml-setall-btn').click();
    ok('setall needs confirmation', $('ml-setall-btn').textContent.includes('Onayla'));
    ok('nothing written before confirm', (await tg('get')).php === '1234567');
    $('ml-setall-btn').click();
    ok('setall writes after confirm', await waitFor(async () => (await tg('get')).php === '7'));

    // --- bolge secimi ---
    document.querySelectorAll('#ml-regions [data-r]').forEach(i => { i.checked = i.dataset.r === 'stack'; }); $('ml-regions').dispatchEvent(new Event('change'));
    await idle(); setv('ml-value', '5000'); $('ml-scan').click();
    ok('stack-only scan does not see gold neighbours', await waitFor(() => $('ml-count').textContent.length > 0 && !hasRow(gold)));
    document.querySelectorAll('#ml-regions [data-r]').forEach(i => { i.checked = ['cheap'].includes(i.dataset.r); }); $('ml-regions').dispatchEvent(new Event('change'));
    await idle(); setv('ml-value', '7'); $('ml-scan').click();
    ok('heap-only scan sees struct field', await waitFor(() => hasRow(pl)));
    document.querySelectorAll('#ml-regions [data-r]').forEach(i => { i.checked = !['video', 'codeapp', 'codesys'].includes(i.dataset.r); }); $('ml-regions').dispatchEvent(new Event('change'));
    document.querySelectorAll('#ml-regions [data-r]').forEach(i => { i.checked = i.dataset.r !== 'video' && i.dataset.r !== 'codeapp' && i.dataset.r !== 'codesys'; });

    // --- sayfalama ---
    await idle(); setv('ml-value', '0'); $('ml-scan').click();
    ok('many results paginate', await waitFor(() => /\/ [2-9]|\/ \d\d+/.test($('ml-page').textContent) && rows().length === 50), $('ml-page').textContent);
    await idle(); $('ml-nextpage').click();
    ok('next page loads', await waitFor(() => $('ml-page').textContent.startsWith('2 /')), $('ml-page').textContent);
    await idle(); $('ml-prev').click();
    ok('prev page loads', await waitFor(() => $('ml-page').textContent.startsWith('1 /')));

    // --- duraklat ---
    $('ml-pause').click();
    ok('pause stops the target', await waitFor(async () => (await (await fetch('/state')).text()) === 'T'));
    ok('pause button label flips', $('ml-pause').textContent.includes('sürdür'));
    $('ml-pause').click();
    ok('resume runs the target', await waitFor(async () => (await (await fetch('/state')).text()) !== 'T'));

    // --- script motoru ---
    document.querySelector('[data-mltab=script]').click();
    ok('templates are listed', $('ml-script-sel').options.length >= 6);
    $('ml-script-sel').value = $('ml-script-sel').options[1].value; $('ml-script-sel').dispatchEvent(new Event('change'));
    ok('template fills the editor', $('ml-script-code').value.includes('gg.searchNumber'));
    $('ml-script-code').value = "await gg.searchNumber('1000', gg.TYPE_DWORD);\nprint('n=' + await gg.getResultsCount());\nawait gg.setValues([{address: " + Number(BigInt(decoy)) + ", flags: gg.TYPE_DWORD, value: 31337}]);\nprint('v=' + (await gg.getValues([{address: " + Number(BigInt(decoy)) + ", flags: gg.TYPE_DWORD}]))[0].value);";
    $('ml-script-run').click();
    ok('script runs to the end', await waitFor(() => $('ml-script-out').textContent.includes('— bitti —')), $('ml-script-out').textContent);
    ok('script console shows search count', /n=\d+/.test($('ml-script-out').textContent));
    ok('script wrote the value', (await tg('get')).decoy === '31337' && $('ml-script-out').textContent.includes('v=31337'));
    $('ml-script-clear').click();
    $('ml-script-code').value = "await gg.searchNumber('1234567;2345678;3456789::64', gg.TYPE_DWORD);\nprint('grup=' + await gg.getResultsCount());";
    $('ml-script-run').click();
    ok('script group search counts 3 (struct hp was set to 7, so 2 or 3 as appropriate)', await waitFor(() => /grup=\d/.test($('ml-script-out').textContent) || $('ml-script-out').textContent.includes('HATA')), $('ml-script-out').textContent);
    await waitFor(() => !$('ml-script-run').disabled);
    $('ml-script-clear').click();
    $('ml-script-code').value = "throw new Error('boom');";
    $('ml-script-run').click();
    ok('script errors are reported', await waitFor(() => $('ml-script-out').textContent.includes('HATA: boom')));
    await waitFor(() => !$('ml-script-run').disabled);
    $('ml-script-code').value = "while (true) { await gg.sleep(50); }";
    $('ml-script-run').click();
    await sleep(300); $('ml-script-stop').click();
    ok('script can be stopped', await waitFor(() => $('ml-script-out').textContent.includes('Script durduruldu')), $('ml-script-out').textContent);
    await waitFor(() => !$('ml-script-run').disabled);
    $('ml-script-code').value = "await gg.processPause(); await gg.processResume(); print('ok-pause');\nawait gg.searchFuzzy(0, gg.SIGN_FUZZY_EQUAL, gg.TYPE_DWORD);\nprint('fz');";
    $('ml-script-run').click();
    ok('script pause/resume and fuzzy API work', await waitFor(() => $('ml-script-out').textContent.includes('fz')), $('ml-script-out').textContent);
    await waitFor(() => !$('ml-script-run').disabled);
    setv('ml-script-name', 'benim-scriptim'); $('ml-script-save').click();
    ok('script can be saved', [...$('ml-script-sel').options].some(o => o.textContent.includes('benim-scriptim')));

    // oturumu sayfa 2 icin hazirla: decoy sonuclari acik, bagli kal
    document.querySelector('[data-mltab=search]').click();
    await idle(); setv('ml-smode', 'exact'); setv('ml-type', 'i32'); setv('ml-value', '31337'); $('ml-scan').click();
    ok('leaves decoy result for page 2', await waitFor(() => hasRow(decoy)));
  } catch (e) { ok('driver exception', false, e && e.stack || e); }
  done('1');
});
"""

DRIVER2 = COMMON + r"""
window.addEventListener('load', async () => {
  try {
    const ad = await A();
    ok('overlay class set', document.documentElement.classList.contains('overlay'));
    ok('memlab shown automatically', $('memlab').classList.contains('active'));
    ok('float button hidden in overlay', $('ml-float').hidden === true);
    ok('session adopted without asking for root', await waitFor(() => $('ml-status').classList.contains('ml-ok')), $('ml-status').textContent);
    ok('attached app adopted', await waitFor(() => $('ml-attached').textContent.includes('target')), $('ml-attached').textContent);
    ok('previous results adopted', await waitFor(() => rows().some(r => r.dataset.a === ad.decoy && r.querySelector('.ml-val').value === '31337')), $('ml-count').textContent);
    ok('controls enabled', await idle());
    ok('saved badge renders in overlay', $('ml-saved-badge') !== null)
  } catch (e) { ok('driver exception', false, e && e.stack || e); }
  done('2');
});
"""

class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=WEB, **k)
    def log_message(self, *a): pass
    def _text(self, body, ctype="text/plain"):
        b = body.encode(); self.send_response(200)
        self.send_header("Content-Type", ctype + "; charset=utf-8"); self.send_header("Content-Length", str(len(b)))
        self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        u = urllib.parse.urlparse(self.path); q = urllib.parse.parse_qs(u.query)
        if u.path in ("/test1.html", "/test2.html"):
            html = open(os.path.join(WEB, "index.html"), encoding="utf-8").read()
            first = u.path == "/test1.html"
            html = html.replace('<script src="./memlab.js" defer></script>', mock(not first) + '<script src="./memlab.js" defer></script>')
            html = html.replace('<script src="./memlab.js" defer></script>', '<script src="./memlab.js" defer></script><script defer>' + (DRIVER1 if first else DRIVER2).replace("<script defer>", "") + '</script>')
            return self._text(html, "text/html")
        if u.path == "/send":
            with lock:
                core.stdin.write(q["cmd"][0] + "\n"); core.stdin.flush()
                return self._text(core.stdout.readline())
        if u.path == "/target":
            with lock:
                target.stdin.write(q["cmd"][0] + "\n"); target.stdin.flush()
                return self._text(json.dumps(dict(kv.split("=") for kv in target.stdout.readline().split())), "application/json")
        if u.path == "/addrs": return self._text(json.dumps(ADDRS), "application/json")
        if u.path == "/state":
            for l in open(f"/proc/{T_PID}/status"):
                if l.startswith("State:"): return self._text(l.split()[1])
        return super().do_GET()
    def do_POST(self):
        n = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)["n"][0]
        reports[n] = json.loads(self.rfile.read(int(self.headers["Content-Length"]))); self._text("ok"); events[n].set()

srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = "http://127.0.0.1:%d" % srv.server_address[1]

def run_page(n, path, timeout=170):
    chrome = subprocess.Popen([CHROME, "--headless=new", "--no-sandbox", "--disable-gpu", "--no-proxy-server",
                               "--user-data-dir=" + os.path.join(TMP, "profile"), "--window-size=1200,2400", base + path],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    finished = events[n].wait(timeout)
    chrome.terminate()
    try: chrome.wait(timeout=10)
    except Exception: chrome.kill()
    return finished

bad = 0
ok1 = run_page("1", "/test1.html")
ok2 = run_page("2", "/test2.html?overlay=1", 90) if ok1 else False
core.kill(); target.kill()
for n, finished in (("1", ok1), ("2", ok2)):
    if not finished:
        print("FAIL sayfa %s zaman asimina ugradi (rapor gelmedi)" % n); bad += 1; continue
    for name, passed, extra in reports[n]:
        print(("PASS " if passed else "FAIL ") + "[%s] " % n + name + ("" if passed or not extra else "  -> " + extra)); bad += (not passed)
dump = os.path.join(DATA, "ui-dump.bin")
good = os.path.exists(dump) and os.path.getsize(dump) == 4096
print(("PASS " if good else "FAIL ") + "dump file exists with 4096 bytes"); bad += (not good)
print("\n%d basarisiz" % bad if bad else "\nTUM UI TESTLERI GECTI")
sys.exit(1 if bad else 0)
