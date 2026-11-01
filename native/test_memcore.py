#!/usr/bin/env python3
"""memcore uctan uca testi (v2): tarama kipleri, daraltma, yazma, dondurma, bolgeler, isaretci, hex, dokum,
duraklat ve guvenlik sinirlari. Sahte bir hedef surec kullanir.
Calistirma (root gerekir): sudo python3 native/test_memcore.py
Sanitizer: CORE_CC="cc -fsanitize=address,undefined -g" ASAN_OPTIONS=detect_leaks=0 sudo -E python3 native/test_memcore.py"""
import json, os, signal, subprocess, sys, tempfile, time

if os.geteuid() != 0:
    print("Bu test root gerektirir (sudo python3 native/test_memcore.py). Atlandi."); sys.exit(0)

HERE = os.path.dirname(os.path.abspath(__file__))
TMP = tempfile.mkdtemp(prefix="memcore-test-")
DATA = os.path.join(TMP, "data"); os.makedirs(DATA)
CORE, TARGET = os.path.join(TMP, "memcore"), os.path.join(TMP, "target")
for src, out in (("memcore.c", CORE), ("test_target.c", TARGET)):
    cc = (os.environ.get("CORE_CC", "cc") if src == "memcore.c" else "cc").split()
    subprocess.check_call(cc + ["-O2", "-Wall", "-Wextra", "-o", out, os.path.join(HERE, src)] + (["-lpthread", "-lm"] if src == "memcore.c" else []))

failures = []
def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name + ("  -> " + str(extra) if (extra != "" and not cond) else ""))
    if not cond: failures.append(name)

class Core:
    def __init__(self, *args):
        self.p = subprocess.Popen([CORE, "--min-uid", "0", "--data-dir", DATA, "--tmp-dir", TMP, *args],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
    def cmd(self, line):
        self.p.stdin.write(line + "\n"); self.p.stdin.flush()
        return json.loads(self.p.stdout.readline())
    def items(self, total=None):
        out, off = [], 0
        while True:
            r = self.cmd(f"list {off} 200")
            if not r.get("ok"): return out
            out += r["items"]; off += 200
            if off >= r["total"]: return out
    def addrs(self): return {i["a"] for i in self.items()}
    def close(self):
        try: self.p.stdin.write("quit\n"); self.p.stdin.flush()
        except Exception: pass
        try: self.p.wait(timeout=8)
        except Exception: self.p.kill()

class Target:
    def __init__(self):
        self.p = subprocess.Popen([TARGET], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
        self.pid = int(self.p.stdout.readline().split("=")[1])
        self.A = dict(kv.split("=") for kv in self.p.stdout.readline().split()[1:])
    def send(self, line):
        self.p.stdin.write(line + "\n"); self.p.stdin.flush()
        return dict(kv.split("=") for kv in self.p.stdout.readline().split())
    def state(self):
        for l in open(f"/proc/{self.pid}/status"):
            if l.startswith("State:"): return l.split()[1]
    def close(self):
        try: self.p.stdin.write("quit\n"); self.p.stdin.flush()
        except Exception: pass
        try: self.p.wait(timeout=5)
        except Exception: self.p.kill()

def fresh(*core_args):
    t = Target(); c = Core(*core_args)
    r = c.cmd(f"attach {t.pid}")
    assert r["ok"], r
    return t, c, r

def hexint(s): return int(s, 16)
def settle(sec=0.35): time.sleep(sec)

# ============ temel ============
t, c, r = fresh()
check("status v2 + root", (lambda s: s["ok"] and s["v"] == 2 and s["euid"] == 0)(c.cmd("status")))
check("attach reports 64-bit pointer size", r["ptr"] == 8, r)
check("ps lists target", any(p["pid"] == t.pid for p in c.cmd("ps")["procs"]))

# ============ i32: tara, daralt, yaz ============
r = c.cmd("scan i32 1000"); check("scan i32 finds gold+decoy", r["ok"] and r["hits"] >= 2, r)
t.send("dec")
r = c.cmd("next eq 900"); check("next eq narrows", r["ok"] and 1 <= r["hits"] <= 3, r)
gold = t.A["gold"]
check("gold address is among results", gold in c.addrs(), (gold, c.addrs()))
check("set ok", c.cmd(f"set {gold} i32 4242")["ok"])
check("target sees 4242", t.send("get")["gold"] == "4242")
check("decoy untouched", t.send("get")["decoy"] == "1000")

# ============ dondurma: normal / yalniz artabilir / yalniz azalabilir ============
check("freeze normal ok", c.cmd(f"freeze {gold} i32 7777")["ok"])
settle(); t.send("dec"); settle()
check("frozen value holds", t.send("get")["gold"] == "7777")
check("frozen list entry has mode 0", c.cmd("frozen")["items"][0]["m"] == 0)
check("freeze inc ok", c.cmd(f"freeze {gold} i32 5000 inc")["ok"])
check("freeze entry updated in place", len(c.cmd("frozen")["items"]) == 1 and c.cmd("frozen")["items"][0]["m"] == 1)
c.cmd(f"set {gold} i32 3000"); settle()
check("inc mode lifts value up to frozen floor", t.send("get")["gold"] == "5000")
c.cmd(f"set {gold} i32 6000"); settle()
check("inc mode lets value rise", t.send("get")["gold"] == "6000")
check("freeze dec ok", c.cmd(f"freeze {gold} i32 100 dec")["ok"])
settle()
check("dec mode pulls value down to ceiling", t.send("get")["gold"] == "100")
c.cmd(f"set {gold} i32 50"); settle()
check("dec mode lets value fall", t.send("get")["gold"] == "50")
check("freeze bad mode rejected", c.cmd(f"freeze {gold} i32 1 sideways")["err"] == "bad_arg")
c.cmd("unfreeze all")
check("unfreeze all empties list", len(c.cmd("frozen")["items"]) == 0)

# ============ bolge filtreleri ============
mp = c.cmd("maps 0 200")
codes = {i["c"] for i in mp["items"]}
check("maps lists classes incl. heap and stack", mp["ok"] and "Ch" in codes and "S" in codes, codes)
check("bad region rejected", c.cmd("region nonsense")["err"] == "bad_arg")
c.cmd(f"set {gold} i32 1000")
check("region cheap ok", c.cmd("region cheap")["ok"])
c.cmd("scan i32 1000")
check("cheap region contains gold", gold in c.addrs())
check("region stack ok", c.cmd("region stack")["ok"])
c.cmd("scan i32 1000")
check("stack region does not contain gold", gold not in c.addrs())
check("region multi ok", c.cmd("region cheap,stack,cdata,cbss,anon")["ok"])
c.cmd("scan i32 1000")
check("multi region contains gold", gold in c.addrs())
c.cmd("region all")

# ============ bulanik arama ============
r = c.cmd("fuzzy i32")
check("fuzzy snapshot taken", r["ok"] and r.get("fuzzy") is True and r["bytes"] > 100000, r)
check("fuzzy list is empty before refine", c.cmd("list 0 10")["total"] == 0)
t.send("dec")
r = c.cmd("next decby 100"); check("fuzzy decby 100 narrows", r["ok"] and 1 <= r["hits"] < 5000, r)
check("fuzzy result has gold", gold in c.addrs())
t.send("get")
r = c.cmd("next unchanged"); check("then unchanged keeps gold", gold in c.addrs(), r)
r = c.cmd("fuzzy f32"); check("fuzzy f32", r["ok"])
t.send("hit")
r = c.cmd("next decby 12.5"); check("fuzzy f32 decby 12.5 finds hp", r["ok"] and t.A["hp"] in c.addrs(), r)
check("fuzzy non-numeric type rejected", c.cmd("fuzzy bytes")["err"] == "bad_arg")
t.close(); c.close()

# ============ grup arama ============
t, c, _ = fresh()
r = c.cmd("gscan i32 64 1234567 2345678 3456789")
pl = hexint(t.A["pl"])
check("group finds the 3 struct fields", c.addrs() == {hex(pl), hex(pl + 4), hex(pl + 8)}, (r, c.addrs()))
r = c.cmd("gscan i32 512 1000 87.5:f32 3.14159:f64")
got = {i["a"]: i["t"] for i in c.items()}
check("mixed-type group finds gold, hp and speed", got.get(t.A["gold"]) == "i32" and got.get(t.A["hp"]) == "f32" and got.get(t.A["speed"]) == "f64", got)
check("group needs two values", c.cmd("gscan i32 64 5")["err"] == "unknown_cmd")
check("group bad spec", c.cmd("gscan i32 64 1 abc")["err"] == "bad_arg")
check("group window zero rejected", c.cmd("gscan i32 0 1 2")["err"] == "bad_arg")
check("group results support refine", c.cmd("next changed")["ok"])

# ============ XOR ============
r = c.cmd("scan xor 777")
check("xor scan finds the encrypted value", t.A["enc"] in c.addrs(), r)
check("xor list shows decrypted value", any(i["a"] == t.A["enc"] and i["v"] == "777" and i["t"] == "xor" for i in c.items()))
check("xor set ok", c.cmd(f"set {t.A['enc']} xor 999")["ok"])
check("target decrypts new value", t.send("get")["enc"] == "999")
key = c.cmd(f"hex {hex(hexint(t.A['enc']) + 4)} 4")["h"]
check("xor key left untouched", key == "A5A5A5A5", key)
check("xor freeze ok", c.cmd(f"freeze {t.A['enc']} xor 999")["ok"])
c.cmd(f"setbytes {t.A['enc']} 00000000"); settle()
check("xor freeze restores value", t.send("get")["enc"] == "999")
c.cmd("unfreeze all")
check("xor rejects float value", c.cmd("scan xor 1.5")["err"] == "bad_arg")

# ============ bayt dizisi / metin ============
HEXNAME = "ZYRON_HERO_NAME".encode().hex().upper()
r = c.cmd(f"scan bytes {HEXNAME}")
check("bytes scan finds the string", t.A["name"] in c.addrs(), r)
check("bytes list shows hex", any(i["a"] == t.A["name"] and i["v"].startswith("5A59524F4E") and i["t"] == "bytes" for i in c.items()))
check("setbytes writes", c.cmd(f"setbytes {t.A['name']} 4142")["ok"])
check("target sees edited text", t.send("get")["name"] == "ABRON_HERO_NAME")
check("bytes refine changed keeps it", t.A["name"] in (c.cmd("next changed") and c.addrs()))
check("hex view returns bytes", c.cmd(f"hex {t.A['name']} 6")["h"] == "4142524F4E5F")
check("bytes odd length rejected", c.cmd("scan bytes ABC")["err"] == "bad_arg")
check("bytes non-hex rejected", c.cmd("scan bytes ZZ")["err"] == "bad_arg")
check("hex too long rejected", c.cmd(f"hex {t.A['name']} 600")["err"] == "bad_arg")
check("hex unmapped address fails", c.cmd("hex 0x10 16")["err"] == "read_failed")
check("setbytes unmapped refused", c.cmd("setbytes 0x10 00")["err"] == "not_writable")

# ============ Auto ============
r = c.cmd("scan auto 87.5")
check("auto float finds hp as f32", any(i["a"] == t.A["hp"] and i["t"] == "f32" for i in c.items()), r)
r = c.cmd("scan auto 5000000000")
check("auto large int finds big as i64", any(i["a"] == t.A["big"] and i["t"] == "i64" for i in c.items()), r)
r = c.cmd("scan auto 1000")
types = {i["t"] for i in c.items() if i["a"] in (t.A["gold"], t.A["decoy"])}
check("auto int finds gold as i32", "i32" in types, types)

# ============ isaretci, atlama, ofset, sil ============
r = c.cmd(f"ptrscan {t.A['pl']} 0")
check("ptrscan finds the holder", t.A["holder"] in c.addrs() and r["type"] == "i64", r)
check("ptrscan list reports target", c.cmd("list 0 5")["pt"] == t.A["pl"])
check("ptrscan with offset range", c.cmd(f"ptrscan {t.A['pl']} 16")["ok"] and t.A["holder"] in c.addrs())
check("ptrscan offset limit", c.cmd(f"ptrscan {t.A['pl']} 0x200000")["err"] == "bad_arg")
r = c.cmd(f"jump {t.A['holder']}")
check("jump follows the pointer", r["ok"] and r["to"] == t.A["pl"], r)
check("jump result shows struct hp", c.items()[0]["v"] == "1234567", c.items())
check("jump rejects non pointer", c.cmd(f"jump {t.A['gold']}")["err"] == "bad_pointer")
c.cmd("scan i32 1234567")
r = c.cmd("shift 4")
check("shift +4 lands on mp", any(i["a"] == hex(pl + 4) and i["v"] == "2345678" for i in c.items()), r)
r = c.cmd("shift 4 f32")
check("shift can change type", all(i["t"] == "f32" for i in c.items()) and r["type"] == "f32", r)
c.cmd("scan i32 1000"); n0 = c.cmd("list 0 1")["total"]
check("drop removes one result", c.cmd("drop 0")["ok"] and c.cmd("list 0 1")["total"] == n0 - 1)
check("drop bad index", c.cmd("drop 99999999")["err"] == "bad_arg")

# ============ ne / gt / lt ============
c.cmd("scan i32 1234567 3456789")
check("range scan contains the three fields", {hex(pl), hex(pl + 4), hex(pl + 8)} <= c.addrs())
c.cmd("next gt 2000000"); a = c.addrs()
check("gt drops the smallest", hex(pl) not in a and hex(pl + 4) in a and hex(pl + 8) in a)
c.cmd("next lt 3000000"); a = c.addrs()
check("lt drops the largest", hex(pl + 8) not in a and hex(pl + 4) in a)
c.cmd("next ne 2345678"); a = c.addrs()
check("ne drops equal value", hex(pl + 4) not in a)
check("next wrong arity rejected", c.cmd("next gt")["err"] == "bad_arg")
check("next unknown filter rejected", c.cmd("next between 1 2")["err"] == "bad_arg")

# ============ toplu yazma ============
c.cmd("scan i32 1234567")
r = c.cmd("setall 7654321")
check("setall writes", r["ok"] and r["written"] >= 1 and r["skipped"] == 0, r)
check("target sees setall value", t.send("get")["php"] == "7654321")
big = c.cmd("scan i32 0")
if big["hits"] > 2000:
    check("setall refuses more than 2000 results", c.cmd("setall 5")["err"] == "too_many")
else:
    print("SKIP setall limit (not enough zero values in this process: %s)" % big["hits"])
c.cmd("scan i32 7654321")
r = c.cmd("setall 1.5")
check("setall float value skips int results", r["ok"] and r["skipped"] >= 1 and r["written"] == 0, r)

# ============ dokum ============
heap = next(i for i in c.cmd("maps 0 200")["items"] if i["c"] == "Ch")
s0 = hexint(heap["s"])
r = c.cmd(f"dump {hex(s0)} {hex(s0 + 4096)} heap-test.bin")
check("dump writes the file", r["ok"] and r["bytes"] == 4096 and os.path.getsize(os.path.join(DATA, "heap-test.bin")) == 4096, r)
check("dump rejects path tricks", c.cmd(f"dump {hex(s0)} {hex(s0 + 16)} ../evil")["err"] == "bad_arg")
check("dump rejects hidden names", c.cmd(f"dump {hex(s0)} {hex(s0 + 16)} .evil")["err"] == "bad_arg")
check("dump rejects empty range", c.cmd(f"dump {hex(s0)} {hex(s0)} x.bin")["err"] == "bad_arg")
check("dump unmapped range fails", c.cmd("dump 0x10 0x1000 y.bin")["err"] == "read_failed")
check("evil file was not created", not os.path.exists(os.path.join(TMP, "evil")) and not os.path.exists(os.path.join(DATA, ".evil")))

# ============ getm ============
r = c.cmd(f"getm {t.A['gold']}:i32 {t.A['hp']}:f32 0x10:i32")
check("getm batch read", r["ok"] and r["v"][1] in ("75", "87.5") and r["v"][2] == "?", r)

# ============ guvenlik ============
check("attach pid 1 blocked", c.cmd("attach 1")["err"] in ("blocked", "no_process"))
check("attach self blocked", c.cmd(f"attach {c.p.pid}")["err"] == "blocked")
check("bad type rejected", c.cmd("scan i99 5")["err"] == "bad_arg")
check("bad value rejected", c.cmd("scan i32 abc")["err"] == "bad_arg")
check("range order rejected", c.cmd("scan i32 9 1")["err"] == "bad_arg")
check("shell metachar not executed", c.cmd("attach 1;touch /tmp/pwned")["ok"] is False and not os.path.exists("/tmp/pwned"))
check("unknown cmd", c.cmd("rm -rf /")["err"] == "unknown_cmd")
check("write to unmapped addr refused", c.cmd("set 0x10 i32 1")["err"] == "not_writable")
check("write to code mapping refused", (lambda m: (not m) or c.cmd(f"set {m[0]['s']} i32 1")["err"] in ("not_writable", "read_only"))(
    [i for i in c.cmd("maps 0 200")["items"] if not i["w"]]))
check("too long command rejected", c.cmd("scan i32 " + "9" * 3000)["err"] == "too_long")
t.close()
check("process_gone reported", c.cmd("scan i32 1")["err"] in ("process_gone", "no_process"))
c.cmd("detach")
check("scan after detach refused", c.cmd("scan i32 1")["err"] == "not_attached")
c.close()

d = Core(); d.p.kill(); d.p.wait()   # varsayilan guvenlik: root hedef reddedilmeli
t, _c, _ = fresh()
dflt = subprocess.Popen([CORE], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
def dcmd(l): dflt.stdin.write(l + "\n"); dflt.stdin.flush(); return json.loads(dflt.stdout.readline())
check("default min-uid blocks system uid", dcmd(f"attach {t.pid}")["err"] == "blocked")
check("default ps hides system procs", all(p["pid"] != t.pid for p in dcmd("ps")["procs"]))
dflt.stdin.write("quit\n"); dflt.stdin.flush(); dflt.wait(timeout=5)
_c.close(); t.close()

# ============ duraklat / surdur ============
t, c, _ = fresh()
check("pause ok", c.cmd("pause")["ok"])
settle(); check("target is stopped", t.state() == "T", t.state())
check("status shows paused", c.cmd("status")["paused"] == 1)
check("resume ok", c.cmd("resume")["ok"])
settle(); check("target runs again", t.state() != "T", t.state())
c.cmd("pause"); settle()
c.cmd("detach"); settle()
check("detach resumes a paused target", t.state() != "T", t.state())
c.cmd(f"attach {t.pid}"); c.cmd("pause"); settle()
c.close(); settle()
check("quitting the core resumes a paused target", t.state() != "T", t.state())
c = Core(); c.cmd(f"attach {t.pid}"); c.cmd("pause"); settle()
c.p.send_signal(signal.SIGTERM); c.p.wait(timeout=5); settle()
check("SIGTERM resumes a paused target", t.state() != "T", t.state())
c = Core("--max-pause", "5"); c.cmd(f"attach {t.pid}"); c.cmd("pause"); settle()
check("paused before the watchdog fires", t.state() == "T", t.state())
time.sleep(7)
check("watchdog auto-resumes after max-pause", t.state() != "T", t.state())
c.close(); t.close()

print("\n%d basarisiz" % len(failures) if failures else "\nTUM TESTLER GECTI")
sys.exit(1 if failures else 0)
