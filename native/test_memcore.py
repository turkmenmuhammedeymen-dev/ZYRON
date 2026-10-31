#!/usr/bin/env python3
"""memcore uctan uca testi: sahte bir surec uzerinde tara / daralt / yaz / dondur ve guvenlik sinirlari.
Calistirma (root gerekir): sudo python3 native/test_memcore.py"""
import json, os, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
TMP = tempfile.mkdtemp(prefix="memcore-test-")
CORE, TARGET = os.path.join(TMP, "memcore"), os.path.join(TMP, "target")
for src, out in (("memcore.c", CORE), ("test_target.c", TARGET)):
    cc = os.environ.get("CC", "cc").split()          # ornek: CC="cc -fsanitize=address,undefined"
    subprocess.check_call(cc + ["-O2", "-Wall", "-Wextra", "-o", out, os.path.join(HERE, src)] + (["-lpthread", "-lm"] if src == "memcore.c" else []))

failures = []
def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name + (" " + str(extra) if (extra and not cond) else ""))
    if not cond: failures.append(name)

class Core:
    def __init__(self, *args):
        self.p = subprocess.Popen([CORE, *args], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
    def cmd(self, line):
        self.p.stdin.write(line + "\n"); self.p.stdin.flush()
        return json.loads(self.p.stdout.readline())
    def close(self):
        try: self.p.stdin.write("quit\n"); self.p.stdin.flush()
        except Exception: pass
        self.p.wait(timeout=5)

class Target:
    def __init__(self):
        self.p = subprocess.Popen([TARGET], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
        self.pid = int(self.p.stdout.readline().split("=")[1])
    def send(self, line):
        self.p.stdin.write(line + "\n"); self.p.stdin.flush()
        return dict(kv.split("=") for kv in self.p.stdout.readline().split())
    def close(self):
        try: self.p.stdin.write("quit\n"); self.p.stdin.flush()
        except Exception: pass
        self.p.wait(timeout=5)

t = Target()
c = Core("--min-uid", "0")           # test hedefi root olarak calisir; varsayilan sinirda reddedilirdi

st = c.cmd("status")
check("status ok", st["ok"] and st["v"] == 1)

ps = c.cmd("ps")
check("ps lists target", ps["ok"] and any(p["pid"] == t.pid for p in ps["procs"]))

r = c.cmd(f"attach {t.pid}")
check("attach", r["ok"] and r["pid"] == t.pid, r)

# --- i32: tara + daralt ---
r = c.cmd("scan i32 1000")
check("scan i32 finds >=2 (gold+decoy)", r["ok"] and r["hits"] >= 2, r)
t.send("dec")
r = c.cmd("next eq 900")
check("next eq 900 narrows to few", r["ok"] and 1 <= r["hits"] <= 3, r)
items = c.cmd("list 0 50")["items"]
check("list shows value 900", any(i["v"] == "900" for i in items), items)
gold_addr = next(i["a"] for i in items if i["v"] == "900")

# --- yazma ---
r = c.cmd(f"set {gold_addr} i32 99999")
check("set ok", r["ok"], r)
check("target sees 99999", t.send("get")["gold"] == "99999")
check("decoy untouched", t.send("get")["decoy"] == "1000")

# --- dondurma ---
r = c.cmd(f"freeze {gold_addr} i32 7777")
check("freeze ok", r["ok"], r)
time.sleep(0.3)
t.send("dec")                       # hedef dusurmeye calisir
time.sleep(0.3)
check("frozen value held", t.send("get")["gold"] == "7777")
check("frozen list has entry", len(c.cmd("frozen")["items"]) == 1)
c.cmd(f"unfreeze {gold_addr}")
check("unfreeze empties list", len(c.cmd("frozen")["items"]) == 0)

# --- float: dec filtresi ---
r = c.cmd("scan f32 87.5")
check("scan f32 finds hp", r["ok"] and r["hits"] >= 1, r)
t.send("hit")
r = c.cmd("next dec")
check("next dec keeps hp", r["ok"] and r["hits"] >= 1, r)
r = c.cmd("next eq 75")
check("next eq 75 narrows", r["ok"] and r["hits"] >= 1, r)
hp_items = c.cmd("list 0 20")["items"]
check("hp reads 75", any(i["v"] == "75" for i in hp_items), hp_items)

# --- f64 aralik, i64 ---
r = c.cmd("scan f64 3.1 3.2")
check("scan f64 range", r["ok"] and r["hits"] >= 1, r)
r = c.cmd("scan i64 5000000000")
check("scan i64", r["ok"] and r["hits"] >= 1, r)

# --- toplu yazma sinirlari ---
big = c.cmd("scan i32 0")           # bellekte cok sayida 0 vardir
check("scan i32 0 yields >50 hits", big["ok"] and big["hits"] > 50, big)
r = c.cmd("setall 5")
check("setall refuses large list", (not r["ok"]) and r["err"] == "too_many", r)
c.cmd("scan i32 1000")
r = c.cmd("setall 5")                # tek sonuc: izin verilir
check("setall writes small list", r["ok"] and r["written"] == r["total"] >= 1, r)

# --- guvenlik ---
check("attach pid 1 blocked", c.cmd("attach 1")["err"] in ("blocked", "no_process"))
check("attach self blocked", c.cmd(f"attach {c.p.pid}")["err"] == "blocked")
check("bad type rejected", c.cmd("scan i99 5")["err"] == "bad_arg")
check("bad value rejected", c.cmd("scan i32 abc")["err"] == "bad_arg")
check("range order rejected", c.cmd("scan i32 9 1")["err"] == "bad_arg")
check("shell metachar not executed", c.cmd("attach 1;touch /tmp/pwned")["ok"] is False and not os.path.exists("/tmp/pwned"))
check("unknown cmd", c.cmd("rm -rf /")["err"] == "unknown_cmd")
check("write to non-mapped addr refused", c.cmd("set 0x10 i32 1")["err"] in ("not_writable", "read_only"))
c.cmd("detach")
check("scan after detach refused", c.cmd("scan i32 1")["err"] == "not_attached")
c.close()

d = Core()                           # varsayilan min-uid=10000: root hedef reddedilmeli
check("default min-uid blocks system uid", d.cmd(f"attach {t.pid}")["err"] == "blocked")
check("default ps hides system procs", all(p["pid"] != t.pid for p in d.cmd("ps")["procs"]))
d.close()

# --- hedef olunce ---
c = Core("--min-uid", "0"); c.cmd(f"attach {t.pid}"); t.close(); time.sleep(0.3)
check("process_gone reported", c.cmd("scan i32 1")["err"] in ("process_gone", "no_process"))
c.close()

print("\n%d basarisiz" % len(failures) if failures else "\nTUM TESTLER GECTI")
sys.exit(1 if failures else 0)
