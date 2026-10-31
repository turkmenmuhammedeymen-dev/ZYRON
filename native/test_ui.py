#!/usr/bin/env python3
"""Memory Lab arayuzunu gercek Chrome'da, gercek memcore ile uctan uca test eder.
Kopru (window.ZyronMem) yerel bir HTTP sunucusu uzerinden memcore sureclerine baglanir.
Gerekenler: google-chrome (veya chromium), cc, root.   Calistirma: sudo python3 native/test_ui.py"""
import http.server, json, os, shutil, subprocess, sys, tempfile, threading, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(os.path.dirname(HERE), "web")
TMP = tempfile.mkdtemp(prefix="memlab-ui-")
CORE, TARGET = os.path.join(TMP, "memcore"), os.path.join(TMP, "target")
subprocess.check_call(["cc", "-O2", "-o", CORE, os.path.join(HERE, "memcore.c"), "-lpthread", "-lm"])
subprocess.check_call(["cc", "-O2", "-o", TARGET, os.path.join(HERE, "test_target.c")])
CHROME = next((c for c in ("google-chrome", "chromium", "chromium-browser") if shutil.which(c)), None)
if not CHROME:
    print("Chrome/Chromium bulunamadi, UI testi atlandi."); sys.exit(0)

core = subprocess.Popen([CORE, "--min-uid", "0"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
target = subprocess.Popen([TARGET], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
target.stdout.readline()
lock = threading.Lock()
report, done = {}, threading.Event()

MOCK = """<script>
window.ZyronMem={info:()=>JSON.stringify({abi:'test',binary:true,sdk:35}),
 checkRoot:id=>{fetch('/send?cmd=status').then(r=>r.text()).then(t=>window.zyronMemResult(id,t));},
 send:(id,c)=>{fetch('/send?cmd='+encodeURIComponent(c)).then(r=>r.text()).then(t=>window.zyronMemResult(id,t));}};
</script>"""

DRIVER = r"""<script defer>
window.addEventListener('load', async () => {
  const steps = [], $ = id => document.getElementById(id);
  const ok = (n, c, x) => steps.push([n, !!c, x === undefined ? '' : String(x)]);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const waitFor = async (f, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await f(); if (v) return v; } catch (e) {} await sleep(60); } return null; };
  const idle = () => waitFor(() => !$('ml-scan').disabled && $('ml-busy').textContent === '');
  const tg = async c => (await fetch('/target?cmd=' + c)).json();
  const rows = () => [...document.querySelectorAll('.ml-row')];
  const rowWith = v => rows().find(r => r.querySelector('.ml-val').value === v);
  try {
    ok('app.js still boots', $('overview-count').textContent === '4', $('overview-count').textContent);
    document.querySelector('[data-tab="memlab"]').click();
    ok('memlab tab opens', $('memlab').classList.contains('active'));
    ok('banner hidden when bridge exists', $('ml-banner').hidden === true);
    ok('controls disabled before root', $('ml-scan').disabled === true);

    $('ml-root').click();
    ok('root ready', await waitFor(() => $('ml-status').classList.contains('ml-ok')), $('ml-status').textContent);
    ok('controls enabled after root', await idle());
    ok('process list shows target', await waitFor(() => [...document.querySelectorAll('.ml-proc')].some(x => x.textContent.includes('target'))));

    $('ml-proc-q').value = 'target'; $('ml-proc-q').dispatchEvent(new Event('input'));
    [...document.querySelectorAll('.ml-proc')].find(x => x.textContent.includes('target')).click();
    ok('attached', await waitFor(() => $('ml-attached').textContent.includes('Bağlı')), $('ml-attached').textContent);

    await idle(); $('ml-scan').click(); // bos deger
    ok('empty value warns', await waitFor(() => $('toast').textContent.includes('Aranacak değeri')));

    await idle(); $('ml-type').value = 'i32'; $('ml-value').value = '1000'; $('ml-scan').click();
    ok('scan lists >=2 rows', await waitFor(() => rows().length >= 2), $('ml-count').textContent);
    ok('count label', /sonuç · i32/.test($('ml-count').textContent), $('ml-count').textContent);

    await idle(); await tg('dec');
    $('ml-mode').value = 'eq'; $('ml-nvalue').value = '900'; $('ml-next').click();
    ok('narrowed to 900', await waitFor(() => rows().length >= 1 && rows().length <= 3 && rowWith('900')));
    const row = rowWith('900');
    row.querySelector('.ml-val').value = '4242'; row.querySelector('[data-act=set]').click();
    ok('write reaches target', await waitFor(async () => (await tg('get')).gold === '4242'));
    ok('decoy untouched', (await tg('get')).decoy === '1000');

    row.querySelector('.ml-val').value = '7777'; row.querySelector('[data-act=freeze]').click();
    ok('frozen chip appears', await waitFor(() => $('ml-frozen').textContent.includes('7777')));
    await sleep(250); await tg('dec'); await sleep(250);
    ok('frozen value holds', (await tg('get')).gold === '7777');
    $('ml-frozen').querySelector('[data-unfreeze]').click();
    ok('unfreeze removes chip', await waitFor(() => !$('ml-frozen').textContent.includes('7777')));

    await idle(); $('ml-reset').click();
    ok('reset clears', await waitFor(() => $('ml-count').textContent === 'Sonuç yok'));
    await idle(); $('ml-type').value = 'i32'; $('ml-value').value = '1000'; $('ml-scan').click();
    ok('setall panel visible for small list', await waitFor(() => $('ml-setall').hidden === false && rows().length >= 1));
    $('ml-setall-value').value = '5';
    $('ml-setall-btn').click();
    ok('setall needs confirmation', $('ml-setall-btn').textContent.includes('Onayla'));
    ok('nothing written before confirm', (await tg('get')).decoy === '1000');
    $('ml-setall-btn').click();
    ok('setall writes after confirm', await waitFor(async () => (await tg('get')).decoy === '5'));

    await idle(); $('ml-value').value = '0'; $('ml-scan').click();
    ok('many results paginate', await waitFor(() => /\/ [2-9]|\/ \d\d+/.test($('ml-page').textContent) && rows().length === 50), $('ml-page').textContent);
    ok('setall hidden for big list', $('ml-setall').hidden === true);
    await idle(); $('ml-nextpage').click();
    ok('next page loads', await waitFor(() => $('ml-page').textContent.startsWith('2 /')), $('ml-page').textContent);

    await idle(); $('ml-detach').click();
    ok('detach resets UI', await waitFor(() => $('ml-attached').textContent.includes('Henüz')));
  } catch (e) { ok('driver exception', false, e && e.stack || e); }
  fetch('/report', { method: 'POST', body: JSON.stringify(steps) });
});
</script>"""

class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=WEB, **k)
    def log_message(self, *a): pass
    def _text(self, body, ctype="text/plain"):
        b = body.encode(); self.send_response(200)
        self.send_header("Content-Type", ctype + "; charset=utf-8"); self.send_header("Content-Length", str(len(b)))
        self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        u = urllib.parse.urlparse(self.path); q = urllib.parse.parse_qs(u.query)
        if u.path == "/test.html":
            html = open(os.path.join(WEB, "index.html"), encoding="utf-8").read()
            html = html.replace('<script src="./app.js" defer></script>', MOCK + '<script src="./app.js" defer></script>')
            html = html.replace('<script src="./memlab.js" defer></script>', '<script src="./memlab.js" defer></script>' + DRIVER)
            return self._text(html, "text/html")
        if u.path == "/send":
            with lock:
                core.stdin.write(q["cmd"][0] + "\n"); core.stdin.flush()
                return self._text(core.stdout.readline())
        if u.path == "/target":
            with lock:
                target.stdin.write(q["cmd"][0] + "\n"); target.stdin.flush()
                return self._text(json.dumps(dict(kv.split("=") for kv in target.stdout.readline().split())), "application/json")
        return super().do_GET()
    def do_POST(self):
        report["steps"] = json.loads(self.rfile.read(int(self.headers["Content-Length"]))); self._text("ok"); done.set()

srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
url = "http://127.0.0.1:%d/test.html" % srv.server_address[1]
chrome = subprocess.Popen([CHROME, "--headless=new", "--no-sandbox", "--disable-gpu", "--no-proxy-server",
                           "--user-data-dir=" + os.path.join(TMP, "profile"), url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
finished = done.wait(120)
chrome.terminate(); core.kill(); target.kill()

if not finished:
    print("FAIL UI testi zaman asimina ugradi (rapor gelmedi)"); sys.exit(1)
bad = 0
for name, passed, extra in report["steps"]:
    print(("PASS " if passed else "FAIL ") + name + ("" if passed or not extra else "  -> " + extra)); bad += (not passed)
print("\n%d basarisiz" % bad if bad else "\nTUM UI TESTLERI GECTI")
sys.exit(1 if bad else 0)
