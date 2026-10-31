// ZYRON Memory Lab - native core.
// Satir tabanli komut protokolu: stdin'den bir komut, stdout'a tam bir JSON satiri.
// Root gerektirir (/proc/<pid>/mem). Android'de uygulama tarafindan "su -c" ile baslatilir.
//
// Guvenlik sinirlari (kodda zorunlu):
//  - sistem surecleri (uid < min-uid, varsayilan 10000), pid 1, kendi sureci ve
//    com.android.* / gms / ZYRON surecleri baglanamaz
//  - yazma yalnizca hedefin su anda yazilabilir (rw) eslenmis bolgelerine yapilir
//  - toplu yazma (setall) en fazla 50 sonuc, dondurma en fazla 64 adres
//  - hicbir komut kabuga gitmez, hicbir dosya silinmez/olusturulmaz

#define _GNU_SOURCE
#define _FILE_OFFSET_BITS 64
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <inttypes.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <math.h>
#include <dirent.h>
#include <ctype.h>
#include <pthread.h>
#include <sys/types.h>

#define MAX_HITS 3000000u
#define MAX_FROZEN 64
#define MAX_SETALL 50
#define MAX_LIST 200
#define MAX_PROCS 600

typedef enum { T_I8, T_I16, T_I32, T_I64, T_F32, T_F64, T_COUNT } Type;
static const char *TN[] = {"i8", "i16", "i32", "i64", "f32", "f64"};
static const int TS[] = {1, 2, 4, 8, 4, 8};
static int is_float(Type t) { return t == T_F32 || t == T_F64; }

typedef union { int64_t i; double d; } Num;
typedef struct { uint64_t s, e; } Region;
typedef struct { uint64_t addr; uint8_t val[8]; } Hit;
typedef struct { uint64_t addr; Type type; uint8_t val[8]; } Frozen;
typedef enum { RF_ALL, RF_ANON, RF_JAVA, RF_FILE, RF_STACK } RegionFilter;
typedef enum { M_RANGE, M_CHANGED, M_UNCH, M_INC, M_DEC, M_INCBY, M_DECBY } Mode;

static int g_pid = 0, g_mem = -1, g_ro = 0;
static uint32_t g_min_uid = 10000;
static Type g_type = T_I32;
static RegionFilter g_rf = RF_ALL;
static Hit *hits = NULL;
static size_t nhits = 0, caphits = 0;
static int truncated = 0;
static Frozen frozen[MAX_FROZEN];
static int nfrozen = 0;
static pthread_mutex_t fmu = PTHREAD_MUTEX_INITIALIZER;
static int freezer_started = 0;

// ---------- cikti ----------
static void jerr(const char *code, const char *msg) {
    printf("{\"ok\":false,\"err\":\"%s\",\"msg\":\"%s\"}\n", code, msg);
    fflush(stdout);
}
static void sanitize(char *s) {
    for (; *s; s++) if ((unsigned char)*s < 0x20 || *s == '"' || *s == '\\' || (unsigned char)*s > 0x7e) *s = '_';
}

// ---------- sayi islemleri ----------
static int parse_type(const char *s, Type *t) {
    for (int i = 0; i < T_COUNT; i++) if (!strcmp(s, TN[i])) { *t = (Type)i; return 0; }
    return -1;
}
static Num decode(Type t, const uint8_t *b) {
    Num n; n.i = 0;
    switch (t) {
    case T_I8: { int8_t x; memcpy(&x, b, 1); n.i = x; break; }
    case T_I16: { int16_t x; memcpy(&x, b, 2); n.i = x; break; }
    case T_I32: { int32_t x; memcpy(&x, b, 4); n.i = x; break; }
    case T_I64: { int64_t x; memcpy(&x, b, 8); n.i = x; break; }
    case T_F32: { float x; memcpy(&x, b, 4); n.d = x; break; }
    case T_F64: { double x; memcpy(&x, b, 8); n.d = x; break; }
    default: break;
    }
    return n;
}
static void encode(Type t, Num n, uint8_t *b) {
    memset(b, 0, 8);
    switch (t) {
    case T_I8: { int8_t x = (int8_t)n.i; memcpy(b, &x, 1); break; }
    case T_I16: { int16_t x = (int16_t)n.i; memcpy(b, &x, 2); break; }
    case T_I32: { int32_t x = (int32_t)n.i; memcpy(b, &x, 4); break; }
    case T_I64: { int64_t x = n.i; memcpy(b, &x, 8); break; }
    case T_F32: { float x = (float)n.d; memcpy(b, &x, 4); break; }
    case T_F64: { double x = n.d; memcpy(b, &x, 8); break; }
    default: break;
    }
}
static int parse_num(Type t, const char *s, Num *out) {
    char *e; Num n; n.i = 0; errno = 0;
    if (is_float(t)) {
        double v = strtod(s, &e);
        if (e == s || *e || errno || !isfinite(v)) return -1;
        if (t == T_F32) { if (fabs(v) > 3.4028234e38) return -1; n.d = (double)(float)v; }
        else n.d = v;
    } else {
        int base = (s[0] == '0' && (s[1] == 'x' || s[1] == 'X')) ? 16 : 10;
        long long v = strtoll(s, &e, base);
        if (e == s || *e || errno) return -1;
        switch (t) {
        case T_I8: if (v < -128 || v > 255) return -1; n.i = (int8_t)v; break;
        case T_I16: if (v < -32768 || v > 65535) return -1; n.i = (int16_t)v; break;
        case T_I32: if (v < INT32_MIN || v > (long long)UINT32_MAX) return -1; n.i = (int32_t)v; break;
        default: n.i = v;
        }
    }
    *out = n;
    return 0;
}
static void num_str(Type t, Num n, char *buf, size_t sz) {
    if (!is_float(t)) { snprintf(buf, sz, "%lld", (long long)n.i); return; }
    if (!isfinite(n.d)) { snprintf(buf, sz, "nan"); return; }
    snprintf(buf, sz, t == T_F32 ? "%.7g" : "%.15g", n.d);
}
static int matches(Mode m, Type t, Num cur, Num prev, Num a, Num b) {
    int f = is_float(t);
    switch (m) {
    case M_RANGE: return f ? (cur.d >= a.d && cur.d <= b.d) : (cur.i >= a.i && cur.i <= b.i);
    case M_CHANGED: return f ? (cur.d != prev.d) : (cur.i != prev.i);
    case M_UNCH: return f ? (cur.d == prev.d) : (cur.i == prev.i);
    case M_INC: return f ? (cur.d > prev.d) : (cur.i > prev.i);
    case M_DEC: return f ? (cur.d < prev.d) : (cur.i < prev.i);
    case M_INCBY: return f ? fabs((cur.d - prev.d) - a.d) < 1e-4 : (int64_t)((uint64_t)cur.i - (uint64_t)prev.i) == a.i;
    case M_DECBY: return f ? fabs((prev.d - cur.d) - a.d) < 1e-4 : (int64_t)((uint64_t)prev.i - (uint64_t)cur.i) == a.i;
    }
    return 0;
}

// ---------- surecler ----------
static int proc_info(int pid, char *name, size_t nl, uint32_t *uid) {
    char p[64], line[256];
    snprintf(p, sizeof p, "/proc/%d/cmdline", pid);
    FILE *f = fopen(p, "r");
    if (!f) return -1;
    size_t n = fread(name, 1, nl - 1, f);
    fclose(f);
    name[n] = 0;
    if (!name[0]) return -1;               // kernel thread
    sanitize(name);
    snprintf(p, sizeof p, "/proc/%d/status", pid);
    f = fopen(p, "r");
    if (!f) return -1;
    *uid = (uint32_t)-1;
    while (fgets(line, sizeof line, f)) {
        unsigned u;
        if (sscanf(line, "Uid: %u", &u) == 1) { *uid = u; break; }
    }
    fclose(f);
    return *uid == (uint32_t)-1 ? -1 : 0;
}
static const char *blocked_reason(int pid, const char *name, uint32_t uid) {
    if (pid <= 1 || pid == getpid()) return "own or init process";
    if ((uid % 100000u) < g_min_uid) return "system process";
    if (!strncmp(name, "com.android.", 12) || !strncmp(name, "com.google.android.gms", 22) ||
        !strncmp(name, "com.google.android.gsf", 22) || !strncmp(name, "com.zyron.lab", 13) ||
        !strcmp(name, "android") || !strcmp(name, "system_server") || !strncmp(name, "zygote", 6))
        return "protected process";
    return NULL;
}
static void cmd_ps(void) {
    DIR *d = opendir("/proc");
    if (!d) { jerr("proc", "cannot read /proc"); return; }
    printf("{\"ok\":true,\"procs\":[");
    struct dirent *e; int n = 0;
    while ((e = readdir(d)) && n < MAX_PROCS) {
        if (!isdigit((unsigned char)e->d_name[0])) continue;
        int pid = atoi(e->d_name); char name[160]; uint32_t uid;
        if (proc_info(pid, name, sizeof name, &uid)) continue;
        if (blocked_reason(pid, name, uid)) continue;
        printf("%s{\"pid\":%d,\"name\":\"%s\"}", n ? "," : "", pid, name);
        n++;
    }
    closedir(d);
    printf("]}\n"); fflush(stdout);
}

// ---------- bolgeler ----------
static int region_ok(const char *p) {
    switch (g_rf) {
    case RF_ALL: return 1;
    case RF_ANON: return !*p || !strncmp(p, "[anon:", 6) || !strcmp(p, "[heap]");
    case RF_JAVA: return !strncmp(p, "[anon:dalvik", 12);
    case RF_FILE: return *p == '/';
    case RF_STACK: return !strncmp(p, "[stack", 6);
    }
    return 1;
}
static size_t load_regions(int apply_filter, Region **out) {
    char path[64], line[1100];
    snprintf(path, sizeof path, "/proc/%d/maps", g_pid);
    FILE *f = fopen(path, "r");
    if (!f) { *out = NULL; return 0; }
    size_t cap = 256, n = 0;
    Region *r = malloc(cap * sizeof(Region));
    while (fgets(line, sizeof line, f)) {
        unsigned long long s, e; char perms[8], rest[900] = "";
        if (sscanf(line, "%llx-%llx %7s %*s %*s %*s %899[^\n]", &s, &e, perms, rest) < 3) continue;
        if (perms[0] != 'r' || perms[1] != 'w') continue;
        char *p = rest; while (*p == ' ') p++;
        if (!strncmp(p, "[vvar", 5) || !strncmp(p, "[vsyscall", 9) || !strncmp(p, "/dev/", 5)) continue;
        if (apply_filter && !region_ok(p)) continue;
        if (n == cap) { cap *= 2; r = realloc(r, cap * sizeof(Region)); }
        r[n].s = s; r[n].e = e; n++;
    }
    fclose(f);
    *out = r;
    return n;
}
static int addr_writable(uint64_t a, int sz) {
    Region *r; size_t n = load_regions(0, &r); int ok = 0;
    for (size_t i = 0; i < n; i++) if (a >= r[i].s && a + (uint64_t)sz <= r[i].e) { ok = 1; break; }
    free(r);
    return ok;
}

// ---------- okuma / yazma ----------
static uint8_t win[65536];
static uint64_t win_base = 1;
static size_t win_len = 0;
static void win_reset(void) { win_base = 1; win_len = 0; }
static int cached_read(uint64_t a, uint8_t *dst, int sz) {
    if (!(a >= win_base && a + (uint64_t)sz <= win_base + win_len)) {
        uint64_t base = a & ~0xFFFFull;
        ssize_t r = pread(g_mem, win, sizeof win, (off_t)base);
        win_base = base; win_len = r > 0 ? (size_t)r : 0;
        if (!(a >= win_base && a + (uint64_t)sz <= win_base + win_len)) {
            return pread(g_mem, dst, (size_t)sz, (off_t)a) == sz ? 0 : -1;
        }
    }
    memcpy(dst, win + (a - win_base), (size_t)sz);
    return 0;
}
static int add_hit(uint64_t addr, const uint8_t *v, int sz) {
    if (nhits >= MAX_HITS) { truncated = 1; return 0; }
    if (nhits == caphits) {
        size_t nc = caphits ? caphits * 2 : (1u << 16);
        Hit *nh = realloc(hits, nc * sizeof(Hit));
        if (!nh) { truncated = 1; return 0; }
        hits = nh; caphits = nc;
    }
    hits[nhits].addr = addr;
    memset(hits[nhits].val, 0, 8);
    memcpy(hits[nhits].val, v, (size_t)sz);
    nhits++;
    return 1;
}

// ---------- komutlar ----------
static int need_attach(void) {
    if (g_pid <= 0 || g_mem < 0) { jerr("not_attached", "attach to a process first"); return 0; }
    char p[32]; snprintf(p, sizeof p, "/proc/%d", g_pid);
    if (access(p, F_OK)) { jerr("process_gone", "the target process has exited"); return 0; }
    return 1;
}
static void clear_state(void) {
    nhits = 0; truncated = 0;
    pthread_mutex_lock(&fmu); nfrozen = 0; pthread_mutex_unlock(&fmu);
}
static void cmd_attach(const char *arg) {
    int pid = atoi(arg); char name[160]; uint32_t uid;
    if (pid <= 0 || proc_info(pid, name, sizeof name, &uid)) { jerr("no_process", "process not found"); return; }
    const char *why = blocked_reason(pid, name, uid);
    if (why) { jerr("blocked", "this process is protected and cannot be attached"); return; }
    if (g_mem >= 0) { close(g_mem); g_mem = -1; }
    clear_state();
    char path[64]; snprintf(path, sizeof path, "/proc/%d/mem", pid);
    g_ro = 0;
    g_mem = open(path, O_RDWR);
    if (g_mem < 0) { g_mem = open(path, O_RDONLY); g_ro = 1; }
    if (g_mem < 0) { g_pid = 0; jerr("open_failed", "cannot open process memory (root required)"); return; }
    g_pid = pid;
    printf("{\"ok\":true,\"pid\":%d,\"name\":\"%s\",\"ro\":%d}\n", pid, name, g_ro); fflush(stdout);
}
static void cmd_detach(void) {
    if (g_mem >= 0) close(g_mem);
    g_mem = -1; g_pid = 0; clear_state();
    printf("{\"ok\":true}\n"); fflush(stdout);
}
static void cmd_scan(Type t, Num lo, Num hi) {
    if (!need_attach()) return;
    Region *r; size_t nr = load_regions(1, &r);
    nhits = 0; truncated = 0; g_type = t;
    int sz = TS[t]; const size_t CH = 1u << 20;
    uint8_t *buf = malloc(CH);
    int stop = 0;
    for (size_t i = 0; i < nr && !stop; i++) {
        uint64_t a = r[i].s;
        while (a < r[i].e && !stop) {
            size_t len = (r[i].e - a < CH) ? (size_t)(r[i].e - a) : CH;
            ssize_t n = pread(g_mem, buf, len, (off_t)a);
            if (n <= 0) { a = (a | 4095) + 1; continue; }
            size_t cnt = (size_t)n;
            for (size_t o = 0; o + (size_t)sz <= cnt; o += (size_t)sz) {
                Num c = decode(t, buf + o);
                if (matches(M_RANGE, t, c, c, lo, hi) && !add_hit(a + o, buf + o, sz)) { stop = 1; break; }
            }
            a += cnt;
            if (cnt < len) a = (a | 4095) + 1;
        }
    }
    free(buf); free(r);
    printf("{\"ok\":true,\"hits\":%zu,\"truncated\":%d,\"type\":\"%s\"}\n", nhits, truncated, TN[t]); fflush(stdout);
}
static void cmd_next(Mode m, Num a, Num b) {
    if (!need_attach()) return;
    if (!nhits) { jerr("no_results", "run a scan first"); return; }
    win_reset();
    int sz = TS[g_type]; size_t keep = 0;
    for (size_t i = 0; i < nhits; i++) {
        uint8_t tmp[8] = {0};
        if (cached_read(hits[i].addr, tmp, sz)) continue;
        Num cur = decode(g_type, tmp), prev = decode(g_type, hits[i].val);
        if (matches(m, g_type, cur, prev, a, b)) {
            hits[keep] = hits[i];
            memcpy(hits[keep].val, tmp, 8);
            keep++;
        }
    }
    nhits = keep;
    printf("{\"ok\":true,\"hits\":%zu,\"truncated\":%d,\"type\":\"%s\"}\n", nhits, truncated, TN[g_type]); fflush(stdout);
}
static void cmd_list(size_t off, size_t count) {
    if (!need_attach()) return;
    if (count > MAX_LIST) count = MAX_LIST;
    win_reset();
    printf("{\"ok\":true,\"total\":%zu,\"type\":\"%s\",\"items\":[", nhits, TN[g_type]);
    int first = 1;
    for (size_t i = off; i < nhits && i < off + count; i++) {
        uint8_t tmp[8] = {0}; char vs[48];
        if (cached_read(hits[i].addr, tmp, TS[g_type])) strcpy(vs, "?");
        else num_str(g_type, decode(g_type, tmp), vs, sizeof vs);
        printf("%s{\"a\":\"0x%" PRIx64 "\",\"v\":\"%s\"}", first ? "" : ",", hits[i].addr, vs);
        first = 0;
    }
    printf("]}\n"); fflush(stdout);
}
static int parse_addr(const char *s, uint64_t *a) {
    char *e; errno = 0;
    if (s[0] != '0' || (s[1] != 'x' && s[1] != 'X')) return -1;
    unsigned long long v = strtoull(s, &e, 16);
    if (e == s || *e || errno) return -1;
    *a = v; return 0;
}
static int write_checked(uint64_t addr, Type t, Num v, const char **why) {
    if (g_ro) { *why = "read_only"; return -1; }
    int sz = TS[t];
    if (!addr_writable(addr, sz)) { *why = "not_writable"; return -1; }
    uint8_t b[8]; encode(t, v, b);
    if (pwrite(g_mem, b, (size_t)sz, (off_t)addr) != sz) { *why = "write_failed"; return -1; }
    return 0;
}
static void cmd_get(uint64_t addr, Type t) {
    if (!need_attach()) return;
    uint8_t tmp[8] = {0}; char vs[48];
    if (pread(g_mem, tmp, (size_t)TS[t], (off_t)addr) != TS[t]) { jerr("read_failed", "cannot read that address"); return; }
    num_str(t, decode(t, tmp), vs, sizeof vs);
    printf("{\"ok\":true,\"v\":\"%s\"}\n", vs); fflush(stdout);
}
static void cmd_set(uint64_t addr, Type t, Num v) {
    if (!need_attach()) return;
    const char *why = "";
    if (write_checked(addr, t, v, &why)) { jerr(why, "write refused or failed"); return; }
    printf("{\"ok\":true}\n"); fflush(stdout);
}
static void cmd_setall(Num v) {
    if (!need_attach()) return;
    if (!nhits) { jerr("no_results", "no results"); return; }
    if (nhits > MAX_SETALL) { jerr("too_many", "narrow the list to 50 results or fewer first"); return; }
    size_t okc = 0; const char *why = "";
    for (size_t i = 0; i < nhits; i++) if (!write_checked(hits[i].addr, g_type, v, &why)) okc++;
    printf("{\"ok\":true,\"written\":%zu,\"total\":%zu}\n", okc, nhits); fflush(stdout);
}
static void *freezer(void *arg) {
    (void)arg;
    int fails = 0;
    for (;;) {
        pthread_mutex_lock(&fmu);
        int bad = 0;
        for (int i = 0; i < nfrozen; i++)
            if (g_mem >= 0 && pwrite(g_mem, frozen[i].val, (size_t)TS[frozen[i].type], (off_t)frozen[i].addr) != TS[frozen[i].type]) bad++;
        if (nfrozen && bad == nfrozen) fails++; else fails = 0;
        if (fails > 40) { nfrozen = 0; fails = 0; }   // hedef gitti: dondurmayi birak
        pthread_mutex_unlock(&fmu);
        usleep(50000);
    }
    return NULL;
}
static void cmd_freeze(uint64_t addr, Type t, Num v) {
    if (!need_attach()) return;
    if (g_ro || !addr_writable(addr, TS[t])) { jerr("not_writable", "cannot write to that address"); return; }
    pthread_mutex_lock(&fmu);
    int idx = -1;
    for (int i = 0; i < nfrozen; i++) if (frozen[i].addr == addr) idx = i;
    if (idx < 0) {
        if (nfrozen >= MAX_FROZEN) { pthread_mutex_unlock(&fmu); jerr("freeze_limit", "at most 64 frozen addresses"); return; }
        idx = nfrozen++;
    }
    frozen[idx].addr = addr; frozen[idx].type = t; encode(t, v, frozen[idx].val);
    pthread_mutex_unlock(&fmu);
    if (!freezer_started) { pthread_t th; pthread_create(&th, NULL, freezer, NULL); pthread_detach(th); freezer_started = 1; }
    printf("{\"ok\":true}\n"); fflush(stdout);
}
static void cmd_unfreeze(uint64_t addr) {
    pthread_mutex_lock(&fmu);
    for (int i = 0; i < nfrozen; i++) if (frozen[i].addr == addr) { frozen[i] = frozen[--nfrozen]; break; }
    pthread_mutex_unlock(&fmu);
    printf("{\"ok\":true}\n"); fflush(stdout);
}
static void cmd_frozen(void) {
    pthread_mutex_lock(&fmu);
    printf("{\"ok\":true,\"items\":[");
    for (int i = 0; i < nfrozen; i++) {
        char vs[48]; num_str(frozen[i].type, decode(frozen[i].type, frozen[i].val), vs, sizeof vs);
        printf("%s{\"a\":\"0x%" PRIx64 "\",\"t\":\"%s\",\"v\":\"%s\"}", i ? "," : "", frozen[i].addr, TN[frozen[i].type], vs);
    }
    printf("]}\n");
    pthread_mutex_unlock(&fmu);
    fflush(stdout);
}
static void cmd_status(void) {
    printf("{\"ok\":true,\"v\":1,\"euid\":%d,\"pid\":%d,\"ro\":%d,\"hits\":%zu,\"frozen\":%d,\"type\":\"%s\"}\n",
           (int)geteuid(), g_pid, g_ro, nhits, nfrozen, TN[g_type]);
    fflush(stdout);
}

// ---------- ana dongu ----------
static void handle(char *line) {
    char *tok[7] = {0}; int nt = 0;
    for (char *p = strtok(line, " \t\r\n"); p && nt < 7; p = strtok(NULL, " \t\r\n")) tok[nt++] = p;
    if (!nt) return;
    const char *c = tok[0]; Type t; Num a, b; uint64_t addr;
    if (!strcmp(c, "status")) cmd_status();
    else if (!strcmp(c, "ps")) cmd_ps();
    else if (!strcmp(c, "attach") && nt == 2) cmd_attach(tok[1]);
    else if (!strcmp(c, "detach")) cmd_detach();
    else if (!strcmp(c, "reset")) { nhits = 0; truncated = 0; printf("{\"ok\":true}\n"); fflush(stdout); }
    else if (!strcmp(c, "region") && nt == 2) {
        const char *n[] = {"all", "anon", "java", "file", "stack"}; int ok = 0;
        for (int i = 0; i < 5; i++) if (!strcmp(tok[1], n[i])) { g_rf = (RegionFilter)i; ok = 1; }
        if (ok) { printf("{\"ok\":true}\n"); fflush(stdout); } else jerr("bad_arg", "unknown region filter");
    }
    else if (!strcmp(c, "scan") && (nt == 3 || nt == 4)) {
        if (parse_type(tok[1], &t) || parse_num(t, tok[2], &a) || (nt == 4 ? parse_num(t, tok[3], &b) : (b = a, 0))) { jerr("bad_arg", "invalid type or value"); return; }
        if (is_float(t) ? a.d > b.d : a.i > b.i) { jerr("bad_arg", "range start is greater than end"); return; }
        cmd_scan(t, a, b);
    }
    else if (!strcmp(c, "next") && nt >= 2) {
        Mode m; a.i = 0; b.i = 0; const char *k = tok[1];
        if (!strcmp(k, "eq") && (nt == 3 || nt == 4)) {
            m = M_RANGE;
            if (parse_num(g_type, tok[2], &a) || (nt == 4 ? parse_num(g_type, tok[3], &b) : (b = a, 0))) { jerr("bad_arg", "invalid value"); return; }
        }
        else if (!strcmp(k, "changed") && nt == 2) m = M_CHANGED;
        else if (!strcmp(k, "unchanged") && nt == 2) m = M_UNCH;
        else if (!strcmp(k, "inc") && nt == 2) m = M_INC;
        else if (!strcmp(k, "dec") && nt == 2) m = M_DEC;
        else if ((!strcmp(k, "incby") || !strcmp(k, "decby")) && nt == 3) {
            m = !strcmp(k, "incby") ? M_INCBY : M_DECBY;
            if (parse_num(g_type, tok[2], &a)) { jerr("bad_arg", "invalid value"); return; }
        }
        else { jerr("bad_arg", "unknown filter"); return; }
        cmd_next(m, a, b);
    }
    else if (!strcmp(c, "list") && nt == 3) cmd_list((size_t)strtoull(tok[1], NULL, 10), (size_t)strtoull(tok[2], NULL, 10));
    else if (!strcmp(c, "get") && nt == 3) {
        if (parse_addr(tok[1], &addr) || parse_type(tok[2], &t)) jerr("bad_arg", "invalid address or type"); else cmd_get(addr, t);
    }
    else if ((!strcmp(c, "set") || !strcmp(c, "freeze")) && nt == 4) {
        if (parse_addr(tok[1], &addr) || parse_type(tok[2], &t) || parse_num(t, tok[3], &a)) { jerr("bad_arg", "invalid address, type or value"); return; }
        if (!strcmp(c, "set")) cmd_set(addr, t, a); else cmd_freeze(addr, t, a);
    }
    else if (!strcmp(c, "setall") && nt == 2) {
        if (parse_num(g_type, tok[1], &a)) jerr("bad_arg", "invalid value"); else cmd_setall(a);
    }
    else if (!strcmp(c, "unfreeze") && nt == 2) {
        if (parse_addr(tok[1], &addr)) jerr("bad_arg", "invalid address"); else cmd_unfreeze(addr);
    }
    else if (!strcmp(c, "frozen")) cmd_frozen();
    else jerr("unknown_cmd", "unknown or malformed command");
}

int main(int argc, char **argv) {
    for (int i = 1; i + 1 < argc; i++)
        if (!strcmp(argv[i], "--min-uid")) g_min_uid = (uint32_t)strtoul(argv[i + 1], NULL, 10);
    setvbuf(stdout, NULL, _IOLBF, 0);
    char line[512];
    while (fgets(line, sizeof line, stdin)) {
        if (strchr(line, '\n') == NULL && !feof(stdin)) { int ch; while ((ch = getchar()) != '\n' && ch != EOF) {} jerr("too_long", "command too long"); continue; }
        if (!strncmp(line, "quit", 4)) break;
        handle(line);
    }
    if (g_mem >= 0) close(g_mem);
    return 0;
}
