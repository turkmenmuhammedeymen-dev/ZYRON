// ZYRON Memory Lab - native core v2.
// Satir tabanli komut protokolu: stdin'den bir komut, stdout'a tam bir JSON satiri.
// Root gerektirir (/proc/<pid>/mem). Android'de uygulama tarafindan "su -c" ile baslatilir.
//
// Ozellikler: tam/aralik/bulanik/grup/XOR/bayt dizisi/Auto arama, GG tarzi bellek bolgesi filtreleri,
// daraltma (eq, ne, gt, lt, changed, unchanged, inc, dec, incby, decby), yazma, yon kisitli dondurma,
// ofset ekleme, isaretci (pointer) arama / atlama, hex goruntuleme ve bayt yazma, bellek haritasi,
// bellek dokumu, sureci duraklat / surdur.
//
// Guvenlik sinirlari (kodda zorunlu):
//  - sistem surecleri (uid < min-uid, varsayilan 10000), pid 1, kendi sureci ve
//    com.android.* / gms / ZYRON surecleri baglanamaz
//  - yazma yalnizca hedefin yazilabilir (rw) eslenmis bolgelerine yapilir
//  - toplu yazma en fazla 2000 sonuc, dondurma en fazla 256 adres
//  - hicbir komut kabuga gitmez; dosya yalnizca --data-dir icine ve guvenli bir adla yazilir (dump);
//    bulanik arama icin --tmp-dir icinde hemen silinen ozel bir gecici anlik goruntu dosyasi kullanilir
//  - duraklatilan surec en gec --max-pause saniye sonra otomatik surdurulur

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
#include <signal.h>
#include <time.h>
#include <pthread.h>
#include <sys/types.h>
#include <sys/stat.h>

#define CORE_VERSION 2
#define MAX_HITS 3000000u
#define MAX_FROZEN 256
#define MAX_SETALL 2000
#define MAX_LIST 200
#define MAX_PROCS 600
#define MAX_GROUP 8
#define MAX_TOK 64
#define MAX_GETM 40
#define MAX_HEX 512
#define MAX_SETBYTES 64
#define SNAP_MAX (768ull << 20)
#define DUMP_MAX (256ull << 20)

typedef enum { T_I8, T_I16, T_I32, T_I64, T_F32, T_F64, T_XOR, T_BYTES, T_COUNT } Type;
static const char *TN[] = {"i8", "i16", "i32", "i64", "f32", "f64", "xor", "bytes"};
static const int TS[] = {1, 2, 4, 8, 4, 8, 8, 0};      // okunacak bayt sayisi (xor: deger + anahtar)
static int is_float(Type t) { return t == T_F32 || t == T_F64; }
static int is_plain(Type t) { return t <= T_F64; }
static int step_of(Type t) { return t == T_XOR ? 4 : TS[t]; }

typedef union { int64_t i; double d; } Num;
typedef struct { uint64_t s, e; } Region;
typedef struct { uint64_t addr; uint8_t val[8]; uint8_t type; } Hit;
typedef struct { uint64_t addr; Type type; Num v; int mode; } Frozen;   // mode 0 sabit, 1 yalniz artabilir, 2 yalniz azalabilir
typedef struct { uint64_t addr, len, foff; } Seg;
typedef struct { uint64_t *a; size_t n, cap; } AddrVec;
typedef enum { M_RANGE, M_NE, M_GT, M_LT, M_CHANGED, M_UNCH, M_INC, M_DEC, M_INCBY, M_DECBY } Mode;

// bellek bolgesi siniflari (GG: A, Ja, Jh, Ch, Ca, Cd, Cb, S, As, V, Xa, Xs, O)
enum {
    RC_ANON = 1u << 0, RC_JHEAP = 1u << 1, RC_JAVA = 1u << 2, RC_CHEAP = 1u << 3, RC_CALLOC = 1u << 4,
    RC_CDATA = 1u << 5, RC_CBSS = 1u << 6, RC_STACK = 1u << 7, RC_ASHMEM = 1u << 8, RC_VIDEO = 1u << 9,
    RC_CODEAPP = 1u << 10, RC_CODESYS = 1u << 11, RC_OTHER = 1u << 12
};
#define RC_ALL (RC_ANON | RC_JHEAP | RC_JAVA | RC_CHEAP | RC_CALLOC | RC_CDATA | RC_CBSS | RC_STACK | RC_ASHMEM | RC_OTHER)
static const struct { const char *name, *code; uint32_t bit; } RCN[] = {
    {"anon", "A", RC_ANON}, {"jheap", "Ja", RC_JHEAP}, {"java", "Jh", RC_JAVA}, {"cheap", "Ch", RC_CHEAP},
    {"calloc", "Ca", RC_CALLOC}, {"cdata", "Cd", RC_CDATA}, {"cbss", "Cb", RC_CBSS}, {"stack", "S", RC_STACK},
    {"ashmem", "As", RC_ASHMEM}, {"video", "V", RC_VIDEO}, {"codeapp", "Xa", RC_CODEAPP},
    {"codesys", "Xs", RC_CODESYS}, {"other", "O", RC_OTHER}
};
#define NRCN (sizeof RCN / sizeof RCN[0])

typedef struct { uint64_t s, e; uint32_t cls; int w; char name[96]; } Map;

// ---------- durum ----------
static int g_pid = 0, g_mem = -1, g_ro = 0, g_ptrsize = 8;
static char g_name[160] = "";
static uint32_t g_min_uid = 10000;
static uint32_t g_rmask = RC_ALL;
static Type g_type = T_I32;
static char g_datadir[256] = "", g_tmpdir[256] = "/tmp";
static unsigned g_max_pause = 300;
static Hit *hits = NULL;
static size_t nhits = 0, caphits = 0;
static int truncated = 0;
static uint64_t g_ptr_target = 0;
static uint8_t g_pat[64];
static size_t g_plen = 0;

static Frozen frozen[MAX_FROZEN];
static int nfrozen = 0;
static pthread_mutex_t fmu = PTHREAD_MUTEX_INITIALIZER;
static int freezer_started = 0;

static Seg *segs = NULL;
static size_t nsegs = 0, capsegs = 0;
static int snap_fd = -1, g_fuzzy = 0;
static uint64_t snap_bytes = 0;
static Type g_fz_type = T_I32;

static pthread_mutex_t pmu = PTHREAD_MUTEX_INITIALIZER;
static int g_paused = 0, watchdog_started = 0;
static struct timespec paused_at;
static volatile sig_atomic_t sig_paused = 0, sig_pid = 0;

// ---------- cikti ----------
static void jerr(const char *code, const char *msg) {
    printf("{\"ok\":false,\"err\":\"%s\",\"msg\":\"%s\"}\n", code, msg);
    fflush(stdout);
}
static void jok(void) { puts("{\"ok\":true}"); fflush(stdout); }
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
    case T_XOR: { uint32_t a, k; memcpy(&a, b, 4); memcpy(&k, b + 4, 4); n.i = (int32_t)(a ^ k); break; }
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
    if (t == T_BYTES) return -1;
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
        case T_I32: case T_XOR: if (v < INT32_MIN || v > (long long)UINT32_MAX) return -1; n.i = (int32_t)v; break;
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
    case M_NE: return f ? cur.d != a.d : cur.i != a.i;
    case M_GT: return f ? cur.d > a.d : cur.i > a.i;
    case M_LT: return f ? cur.d < a.d : cur.i < a.i;
    case M_CHANGED: return f ? (cur.d != prev.d) : (cur.i != prev.i);
    case M_UNCH: return f ? (cur.d == prev.d) : (cur.i == prev.i);
    case M_INC: return f ? (cur.d > prev.d) : (cur.i > prev.i);
    case M_DEC: return f ? (cur.d < prev.d) : (cur.i < prev.i);
    case M_INCBY: return f ? fabs((cur.d - prev.d) - a.d) < 1e-4 : (int64_t)((uint64_t)cur.i - (uint64_t)prev.i) == a.i;
    case M_DECBY: return f ? fabs((prev.d - cur.d) - a.d) < 1e-4 : (int64_t)((uint64_t)prev.i - (uint64_t)cur.i) == a.i;
    }
    return 0;
}
static int hexval(int c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}
static int parse_hex(const char *s, uint8_t *out, size_t max, size_t *n) {
    size_t l = strlen(s);
    if (!l || (l & 1) || l / 2 > max) return -1;
    for (size_t i = 0; i < l / 2; i++) {
        int h = hexval(s[2 * i]), lo = hexval(s[2 * i + 1]);
        if (h < 0 || lo < 0) return -1;
        out[i] = (uint8_t)(h * 16 + lo);
    }
    *n = l / 2;
    return 0;
}
static void hex_str(const uint8_t *b, size_t n, char *out) {
    static const char *H = "0123456789ABCDEF";
    for (size_t i = 0; i < n; i++) { out[2 * i] = H[b[i] >> 4]; out[2 * i + 1] = H[b[i] & 15]; }
    out[2 * n] = 0;
}
static int parse_addr(const char *s, uint64_t *a) {
    char *e; errno = 0;
    if (s[0] != '0' || (s[1] != 'x' && s[1] != 'X')) return -1;
    unsigned long long v = strtoull(s, &e, 16);
    if (e == s || *e || errno) return -1;
    *a = v;
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
static int detect_ptrsize(int pid) {
    char p[64]; unsigned char h[5];
    snprintf(p, sizeof p, "/proc/%d/exe", pid);
    int fd = open(p, O_RDONLY);
    if (fd < 0) return 8;
    ssize_t n = read(fd, h, 5);
    close(fd);
    if (n == 5 && h[0] == 0x7f && h[1] == 'E' && h[2] == 'L' && h[3] == 'F') return h[4] == 1 ? 4 : 8;
    return 8;
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
static int has_dot(const char *p) {
    const char *base = strrchr(p, '/');
    base = base ? base + 1 : p;
    return strchr(base, '.') != NULL;
}
static uint32_t classify(const char *perms, const char *p, uint64_t s, uint64_t e, uint64_t *lib_end) {
    int w = perms[1] == 'w', x = perms[2] == 'x';
    if (x && !w) {
        if (!strncmp(p, "/data/", 6)) return RC_CODEAPP;
        if (!strncmp(p, "/system", 7) || !strncmp(p, "/vendor", 7) || !strncmp(p, "/apex", 5) ||
            !strncmp(p, "/product", 8) || !strncmp(p, "/odm", 4)) return RC_CODESYS;
        return 0;
    }
    if (!w) return 0;
    uint32_t c;
    if (!strcmp(p, "[heap]")) c = RC_CHEAP;
    else if (!strncmp(p, "[stack", 6)) c = RC_STACK;
    else if (!strncmp(p, "/dev/ashmem", 11) || !strncmp(p, "/memfd:", 7)) c = RC_ASHMEM;
    else if (!strncmp(p, "/dev/", 5)) c = RC_VIDEO;
    else if (!strncmp(p, "[anon:dalvik-", 13)) c = strstr(p, "space") ? RC_JHEAP : RC_JAVA;
    else if (!strncmp(p, "[anon:libc_malloc", 17) || !strncmp(p, "[anon:scudo:", 12) ||
             !strncmp(p, "[anon:jemalloc", 14) || !strncmp(p, "[anon:GWP-ASan", 14)) c = RC_CALLOC;
    else if (!strncmp(p, "[anon:.bss", 10)) c = RC_CBSS;
    else if (!strncmp(p, "[anon:", 6)) c = RC_ANON;
    else if (*p == 0) c = (*lib_end == s) ? RC_CBSS : RC_ANON;
    else if (*p == '/') {
        size_t l = strlen(p);
        if ((l > 4 && !strcmp(p + l - 4, ".art")) || (l > 4 && !strcmp(p + l - 4, ".oat")) ||
            (l > 5 && !strcmp(p + l - 5, ".vdex")) || (l > 5 && !strcmp(p + l - 5, ".odex")) ||
            (l > 4 && !strcmp(p + l - 4, ".dex")) || strstr(p, "/dalvik-cache/")) c = RC_JAVA;
        else if (strstr(p, ".so") || !has_dot(p)) c = RC_CDATA;
        else c = RC_OTHER;
    } else c = RC_OTHER;
    if (c == RC_CDATA) *lib_end = e; else *lib_end = 0;
    return c;
}
static size_t read_maps(Map **out) {
    char path[64], line[1200];
    snprintf(path, sizeof path, "/proc/%d/maps", g_pid);
    FILE *f = fopen(path, "r");
    if (!f) { *out = NULL; return 0; }
    size_t cap = 256, n = 0;
    Map *m = malloc(cap * sizeof(Map));
    uint64_t lib_end = 0;
    while (fgets(line, sizeof line, f)) {
        unsigned long long s, e; char perms[8], rest[900] = "";
        if (sscanf(line, "%llx-%llx %7s %*s %*s %*s %899[^\n]", &s, &e, perms, rest) < 3) continue;
        if (perms[0] != 'r') continue;
        char *p = rest; while (*p == ' ') p++;
        if (!strncmp(p, "[vvar", 5) || !strncmp(p, "[vsyscall", 9) || !strncmp(p, "[vdso", 5)) continue;
        uint32_t cls = classify(perms, p, s, e, &lib_end);
        if (!cls) continue;
        if (n == cap) { cap *= 2; m = realloc(m, cap * sizeof(Map)); }
        m[n].s = s; m[n].e = e; m[n].cls = cls; m[n].w = perms[1] == 'w';
        strncpy(m[n].name, p, sizeof m[n].name - 1); m[n].name[sizeof m[n].name - 1] = 0;
        sanitize(m[n].name);
        n++;
    }
    fclose(f);
    *out = m;
    return n;
}
static size_t load_scan_regions(Region **out) {
    Map *m; size_t nm = read_maps(&m), n = 0;
    Region *r = malloc((nm + 1) * sizeof(Region));
    for (size_t i = 0; i < nm; i++) if (m[i].cls & g_rmask) { r[n].s = m[i].s; r[n].e = m[i].e; n++; }
    free(m);
    *out = r;
    return n;
}
// yazilabilir bolgeler (siralidir); [a, a+sz) tek bir bolgenin icinde mi?
static int in_maps(const Map *m, size_t n, uint64_t a, int sz, int need_w) {
    size_t lo = 0, hi = n;
    while (lo < hi) {
        size_t mid = (lo + hi) / 2;
        if (m[mid].e <= a) lo = mid + 1; else hi = mid;
    }
    return lo < n && m[lo].s <= a && a + (uint64_t)sz <= m[lo].e && (!need_w || m[lo].w);
}
static const char *class_code(uint32_t cls) {
    for (size_t i = 0; i < NRCN; i++) if (RCN[i].bit == cls) return RCN[i].code;
    return "?";
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
        if (!(a >= win_base && a + (uint64_t)sz <= win_base + win_len))
            return pread(g_mem, dst, (size_t)sz, (off_t)a) == sz ? 0 : -1;
    }
    memcpy(dst, win + (a - win_base), (size_t)sz);
    return 0;
}
static int add_hit(uint64_t addr, const uint8_t *v, int sz, Type t) {
    if (nhits >= MAX_HITS) { truncated = 1; return 0; }
    if (nhits == caphits) {
        size_t nc = caphits ? caphits * 2 : (1u << 16);
        Hit *nh = realloc(hits, nc * sizeof(Hit));
        if (!nh) { truncated = 1; return 0; }
        hits = nh; caphits = nc;
    }
    hits[nhits].addr = addr;
    hits[nhits].type = (uint8_t)t;
    memset(hits[nhits].val, 0, 8);
    memcpy(hits[nhits].val, v, (size_t)(sz > 8 ? 8 : sz));
    nhits++;
    return 1;
}
static void vec_add(AddrVec *v, uint64_t a) {
    if (v->n >= MAX_HITS) { truncated = 1; return; }
    if (v->n == v->cap) {
        size_t nc = v->cap ? v->cap * 2 : 4096;
        uint64_t *na = realloc(v->a, nc * sizeof(uint64_t));
        if (!na) { truncated = 1; return; }
        v->a = na; v->cap = nc;
    }
    v->a[v->n++] = a;
}
static int write_value(uint64_t addr, Type t, Num v) {
    uint8_t b[8]; int sz;
    if (t == T_XOR) {
        uint32_t k;
        if (pread(g_mem, &k, 4, (off_t)(addr + 4)) != 4) return -1;
        uint32_t a = (uint32_t)v.i ^ k;
        memcpy(b, &a, 4); sz = 4;
    } else { encode(t, v, b); sz = TS[t]; }
    return pwrite(g_mem, b, (size_t)sz, (off_t)addr) == sz ? 0 : -1;
}
static int wsize(Type t) { return t == T_XOR ? 4 : TS[t]; }

// ---------- genel ----------
static int need_attach(void) {
    if (g_pid <= 0 || g_mem < 0) { jerr("not_attached", "attach to a process first"); return 0; }
    char p[32]; snprintf(p, sizeof p, "/proc/%d", g_pid);
    if (access(p, F_OK)) { jerr("process_gone", "the target process has exited"); return 0; }
    return 1;
}
static void snap_free(void) {
    if (snap_fd >= 0) close(snap_fd);
    snap_fd = -1; free(segs); segs = NULL; nsegs = capsegs = 0; snap_bytes = 0; g_fuzzy = 0;
}
static void do_resume(void) {
    pthread_mutex_lock(&pmu);
    if (g_paused && g_pid > 0) kill(g_pid, SIGCONT);
    g_paused = 0; sig_paused = 0;
    pthread_mutex_unlock(&pmu);
}
static void clear_state(void) {
    nhits = 0; truncated = 0; g_ptr_target = 0; snap_free();
    pthread_mutex_lock(&fmu); nfrozen = 0; pthread_mutex_unlock(&fmu);
}
static void print_list_head(void) {
    printf("{\"ok\":true,\"hits\":%zu,\"truncated\":%d,\"type\":\"%s\"}\n", nhits, truncated, TN[g_type]);
    fflush(stdout);
}

static void cmd_attach(const char *arg) {
    int pid = atoi(arg); char name[160]; uint32_t uid;
    if (pid <= 0 || proc_info(pid, name, sizeof name, &uid)) { jerr("no_process", "process not found"); return; }
    if (blocked_reason(pid, name, uid)) { jerr("blocked", "this process is protected and cannot be attached"); return; }
    do_resume();
    pthread_mutex_lock(&fmu);
    nfrozen = 0;
    if (g_mem >= 0) { close(g_mem); g_mem = -1; }
    pthread_mutex_unlock(&fmu);
    clear_state();
    char path[64]; snprintf(path, sizeof path, "/proc/%d/mem", pid);
    g_ro = 0;
    int fd = open(path, O_RDWR);
    if (fd < 0) { fd = open(path, O_RDONLY); g_ro = 1; }
    if (fd < 0) { g_pid = 0; jerr("open_failed", "cannot open process memory (root required)"); return; }
    pthread_mutex_lock(&fmu); g_mem = fd; pthread_mutex_unlock(&fmu);
    g_pid = pid; sig_pid = pid; g_ptrsize = detect_ptrsize(pid); win_reset();
    snprintf(g_name, sizeof g_name, "%s", name);
    printf("{\"ok\":true,\"pid\":%d,\"name\":\"%s\",\"ro\":%d,\"ptr\":%d}\n", pid, name, g_ro, g_ptrsize); fflush(stdout);
}
static void cmd_detach(void) {
    do_resume();
    pthread_mutex_lock(&fmu);
    nfrozen = 0;
    if (g_mem >= 0) close(g_mem);
    g_mem = -1;
    pthread_mutex_unlock(&fmu);
    g_pid = 0; sig_pid = 0; g_name[0] = 0; clear_state();
    jok();
}

// ---------- tarama ----------
typedef struct { Type t; Num lo, hi; } Spec;

static void scan_pass(Type t, Num lo, Num hi, AddrVec *vec) {
    Region *r; size_t nr = load_scan_regions(&r);
    int sz = TS[t], st = step_of(t);
    const size_t CH = 1u << 20;
    uint8_t *buf = malloc(CH + 16);
    int stop = 0;
    for (size_t i = 0; i < nr && !stop; i++) {
        uint64_t a = r[i].s;
        while (a < r[i].e && !stop) {
            size_t len = (r[i].e - a < CH) ? (size_t)(r[i].e - a) : CH;
            ssize_t n = pread(g_mem, buf, len, (off_t)a);
            if (n <= 0) { a = (a | 4095) + 1; continue; }
            size_t cnt = (size_t)n;
            for (size_t o = 0; o + (size_t)sz <= cnt; o += (size_t)st) {
                Num c = decode(t, buf + o);
                if (matches(M_RANGE, t, c, c, lo, hi)) {
                    if (vec) vec_add(vec, a + o);
                    else if (!add_hit(a + o, buf + o, sz, t)) { stop = 1; break; }
                }
            }
            size_t adv = cnt;
            if (t == T_XOR && cnt == len && a + cnt < r[i].e) adv = cnt - 4;
            a += adv;
            if (cnt < len) a = (a | 4095) + 1;
        }
    }
    free(buf); free(r);
}
static void cmd_scan(Type t, Num lo, Num hi) {
    if (!need_attach()) return;
    snap_free(); nhits = 0; truncated = 0; g_ptr_target = 0; g_type = t;
    scan_pass(t, lo, hi, NULL);
    print_list_head();
}
static int looks_float(const char *s) { return strpbrk(s, ".eE") != NULL && !(s[0] == '0' && (s[1] == 'x' || s[1] == 'X')); }
static void cmd_scan_auto(const char *s1, const char *s2) {
    if (!need_attach()) return;
    Type ts[4]; int nt = 0;
    if (looks_float(s1)) { ts[nt++] = T_F32; ts[nt++] = T_F64; }
    else { ts[nt++] = T_I32; ts[nt++] = T_I64; ts[nt++] = T_F32; ts[nt++] = T_F64; }
    Num lo[4], hi[4]; int ok[4];
    int any = 0;
    for (int i = 0; i < nt; i++) {
        ok[i] = !parse_num(ts[i], s1, &lo[i]) && (s2 ? !parse_num(ts[i], s2, &hi[i]) : (hi[i] = lo[i], 1));
        any |= ok[i];
    }
    if (!any) { jerr("bad_arg", "invalid value"); return; }
    snap_free(); nhits = 0; truncated = 0; g_ptr_target = 0;
    for (int i = 0; i < nt; i++) if (ok[i]) scan_pass(ts[i], lo[i], hi[i], NULL);
    g_type = nhits ? (Type)hits[0].type : T_I32;
    print_list_head();
}
static void cmd_scan_bytes(const uint8_t *pat, size_t plen) {
    if (!need_attach()) return;
    snap_free(); nhits = 0; truncated = 0; g_ptr_target = 0; g_type = T_BYTES;
    memcpy(g_pat, pat, plen); g_plen = plen;
    Region *r; size_t nr = load_scan_regions(&r);
    const size_t CH = 1u << 20;
    uint8_t *buf = malloc(CH + 16);
    int stop = 0;
    for (size_t i = 0; i < nr && !stop; i++) {
        uint64_t a = r[i].s;
        while (a < r[i].e && !stop) {
            size_t len = (r[i].e - a < CH) ? (size_t)(r[i].e - a) : CH;
            ssize_t n = pread(g_mem, buf, len, (off_t)a);
            if (n <= 0) { a = (a | 4095) + 1; continue; }
            size_t cnt = (size_t)n;
            size_t o = 0;
            while (o + plen <= cnt) {
                uint8_t *f = memmem(buf + o, cnt - o, pat, plen);
                if (!f) break;
                size_t at = (size_t)(f - buf);
                if (!add_hit(a + at, f, (int)plen, T_BYTES)) { stop = 1; break; }
                o = at + 1;
            }
            size_t adv = cnt;
            if (cnt == len && a + cnt < r[i].e && cnt > plen) adv = cnt - (plen - 1);
            a += adv;
            if (cnt < len) a = (a | 4095) + 1;
        }
    }
    free(buf); free(r);
    print_list_head();
}
static int cmp_hit(const void *x, const void *y) {
    const Hit *a = x, *b = y;
    if (a->addr != b->addr) return a->addr < b->addr ? -1 : 1;
    return (int)a->type - (int)b->type;
}
static size_t lower_bound(const uint64_t *a, size_t n, uint64_t key) {
    size_t lo = 0, hi = n;
    while (lo < hi) { size_t mid = (lo + hi) / 2; if (a[mid] < key) lo = mid + 1; else hi = mid; }
    return lo;
}
static int parse_spec(const char *tok, Type def, Spec *sp) {
    char b[96];
    if (strlen(tok) >= sizeof b) return -1;
    strcpy(b, tok);
    sp->t = def;
    char *c = strchr(b, ':');
    if (c) { *c = 0; if (parse_type(c + 1, &sp->t)) return -1; }
    if (!is_plain(sp->t)) return -1;
    char *d = strstr(b, "..");
    if (d) { *d = 0; return (parse_num(sp->t, b, &sp->lo) || parse_num(sp->t, d + 2, &sp->hi)) ? -1 : 0; }
    if (parse_num(sp->t, b, &sp->lo)) return -1;
    sp->hi = sp->lo;
    return 0;
}
static void cmd_gscan(Type def, uint64_t window, int ns, char **toks) {
    if (!need_attach()) return;
    Spec sp[MAX_GROUP]; AddrVec v[MAX_GROUP];
    memset(v, 0, sizeof v);
    for (int k = 0; k < ns; k++) if (parse_spec(toks[k], def, &sp[k])) { jerr("bad_arg", "invalid group value"); return; }
    if (is_float(sp[0].t) ? sp[0].lo.d > sp[0].hi.d : sp[0].lo.i > sp[0].hi.i) { jerr("bad_arg", "range start is greater than end"); return; }
    snap_free(); nhits = 0; truncated = 0; g_ptr_target = 0;
    for (int k = 0; k < ns; k++) scan_pass(sp[k].t, sp[k].lo, sp[k].hi, &v[k]);
    win_reset();
    for (size_t i = 0; i < v[0].n; i++) {
        uint64_t a = v[0].a[i], near[MAX_GROUP]; int ok = 1;
        near[0] = a;
        for (int k = 1; k < ns && ok; k++) {
            size_t j = lower_bound(v[k].a, v[k].n, a); uint64_t best = 0; int found = 0, bestd = 0;
            for (int d = -1; d <= 0; d++) {
                if ((d == -1 && j == 0) || (d == 0 && j >= v[k].n)) continue;
                uint64_t x = v[k].a[(size_t)((long)j + d)];
                uint64_t dist = x > a ? x - a : a - x;
                if (dist < window && (!found || dist < (uint64_t)bestd)) { found = 1; best = x; bestd = (int)dist; }
            }
            if (!found) ok = 0; else near[k] = best;
        }
        if (!ok) continue;
        for (int k = 0; k < ns; k++) {
            uint8_t tmp[8] = {0};
            if (cached_read(near[k], tmp, TS[sp[k].t])) continue;
            if (!add_hit(near[k], tmp, TS[sp[k].t], sp[k].t)) break;
        }
    }
    for (int k = 0; k < ns; k++) free(v[k].a);
    qsort(hits, nhits, sizeof(Hit), cmp_hit);
    size_t u = 0;
    for (size_t i = 0; i < nhits; i++) if (!u || hits[i].addr != hits[u - 1].addr || hits[i].type != hits[u - 1].type) hits[u++] = hits[i];
    nhits = u;
    g_type = nhits ? (Type)hits[0].type : def;
    print_list_head();
}

// ---------- bulanik arama ----------
static int snap_open(void) {
    char path[320];
    snprintf(path, sizeof path, "%s/zyron-fz-XXXXXX", g_tmpdir);
    int fd = mkstemp(path);
    if (fd >= 0) unlink(path);
    return fd;
}
static void cmd_fuzzy(Type t) {
    if (!need_attach()) return;
    if (!is_plain(t)) { jerr("bad_arg", "fuzzy search needs a plain numeric type"); return; }
    snap_free(); nhits = 0; truncated = 0; g_ptr_target = 0; g_type = t;
    snap_fd = snap_open();
    if (snap_fd < 0) { jerr("tmp_failed", "cannot create snapshot file"); return; }
    Region *r; size_t nr = load_scan_regions(&r);
    const size_t CH = 1u << 20;
    uint8_t *buf = malloc(CH);
    int stop = 0;
    for (size_t i = 0; i < nr && !stop; i++) {
        uint64_t a = r[i].s;
        while (a < r[i].e && !stop) {
            size_t len = (r[i].e - a < CH) ? (size_t)(r[i].e - a) : CH;
            ssize_t n = pread(g_mem, buf, len, (off_t)a);
            if (n <= 0) { a = (a | 4095) + 1; continue; }
            if (snap_bytes + (uint64_t)n > SNAP_MAX) { truncated = 1; stop = 1; break; }
            if (pwrite(snap_fd, buf, (size_t)n, (off_t)snap_bytes) != n) { jerr("tmp_failed", "snapshot write failed"); free(buf); free(r); snap_free(); return; }
            if (nsegs == capsegs) { capsegs = capsegs ? capsegs * 2 : 1024; segs = realloc(segs, capsegs * sizeof(Seg)); }
            segs[nsegs].addr = a; segs[nsegs].len = (uint64_t)n; segs[nsegs].foff = snap_bytes; nsegs++;
            snap_bytes += (uint64_t)n;
            a += (uint64_t)n;
            if ((size_t)n < len) a = (a | 4095) + 1;
        }
    }
    free(buf); free(r);
    g_fuzzy = 1; g_fz_type = t;
    printf("{\"ok\":true,\"fuzzy\":true,\"bytes\":%" PRIu64 ",\"truncated\":%d,\"type\":\"%s\"}\n", snap_bytes, truncated, TN[t]);
    fflush(stdout);
}
static void fuzzy_refine(Mode m, Num a, Num b) {
    Type t = g_fz_type; int sz = TS[t];
    nhits = 0; truncated = 0;
    const size_t CH = 1u << 20;
    uint8_t *pb = malloc(CH), *cb = malloc(CH);
    for (size_t s = 0; s < nsegs; s++) {
        for (uint64_t off = 0; off < segs[s].len; off += CH) {
            size_t len = (segs[s].len - off < CH) ? (size_t)(segs[s].len - off) : CH;
            if (pread(snap_fd, pb, len, (off_t)(segs[s].foff + off)) != (ssize_t)len) continue;
            ssize_t n = pread(g_mem, cb, len, (off_t)(segs[s].addr + off));
            if (n <= 0) continue;
            size_t cnt = (size_t)n;
            for (size_t o = 0; o + (size_t)sz <= cnt; o += (size_t)sz)
                if (matches(m, t, decode(t, cb + o), decode(t, pb + o), a, b) &&
                    !add_hit(segs[s].addr + off + o, cb + o, sz, t)) goto done;
        }
    }
done:
    free(pb); free(cb);
    snap_free();
    g_type = t;
    print_list_head();
}

// ---------- daraltma ----------
static void cmd_next(Mode m, const char *s1, const char *s2) {
    if (!need_attach()) return;
    int need_val = (m == M_RANGE || m == M_NE || m == M_GT || m == M_LT || m == M_INCBY || m == M_DECBY);
    Num A[T_COUNT], B[T_COUNT]; int ok[T_COUNT];
    for (int t = 0; t < T_COUNT; t++) {
        A[t].i = 0; B[t].i = 0; ok[t] = 1;
        if (!need_val || t == T_BYTES) continue;
        ok[t] = s1 && !parse_num((Type)t, s1, &A[t]) && (s2 ? !parse_num((Type)t, s2, &B[t]) : (B[t] = A[t], 1));
    }
    if (g_fuzzy) {
        if (!ok[g_fz_type]) { jerr("bad_arg", "invalid value"); return; }
        fuzzy_refine(m, A[g_fz_type], B[g_fz_type]);
        return;
    }
    if (!nhits) { jerr("no_results", "run a scan first"); return; }
    win_reset();
    size_t keep = 0;
    for (size_t i = 0; i < nhits; i++) {
        Type t = (Type)hits[i].type; uint8_t tmp[8] = {0};
        if (t == T_BYTES) {
            uint8_t cur[64]; size_t n = g_plen;
            if (pread(g_mem, cur, n, (off_t)hits[i].addr) != (ssize_t)n) continue;
            int keepit;
            if (m == M_RANGE) keepit = !memcmp(cur, g_pat, n);
            else if (m == M_CHANGED) keepit = memcmp(cur, hits[i].val, n > 8 ? 8 : n) != 0;
            else if (m == M_UNCH) keepit = !memcmp(cur, hits[i].val, n > 8 ? 8 : n);
            else keepit = 0;
            if (keepit) { memcpy(hits[i].val, cur, n > 8 ? 8 : n); hits[keep++] = hits[i]; }
            continue;
        }
        if (!ok[t]) continue;
        if (cached_read(hits[i].addr, tmp, TS[t])) continue;
        Num cur = decode(t, tmp), prev = decode(t, hits[i].val);
        if (matches(m, t, cur, prev, A[t], B[t])) { memcpy(hits[i].val, tmp, 8); hits[keep++] = hits[i]; }
    }
    nhits = keep;
    print_list_head();
}

// ---------- sonuc listesi ----------
static void value_json(const Hit *h, char *vs, size_t n) {
    Type t = (Type)h->type; uint8_t tmp[64] = {0};
    if (t == T_BYTES) {
        size_t l = g_plen > 32 ? 32 : g_plen;
        if (pread(g_mem, tmp, l, (off_t)h->addr) != (ssize_t)l) { snprintf(vs, n, "?"); return; }
        hex_str(tmp, l, vs); return;
    }
    if (cached_read(h->addr, tmp, TS[t])) { snprintf(vs, n, "?"); return; }
    num_str(t, decode(t, tmp), vs, n);
}
static void cmd_list(size_t off, size_t count) {
    if (!need_attach()) return;
    if (count > MAX_LIST) count = MAX_LIST;
    win_reset();
    printf("{\"ok\":true,\"total\":%zu,\"type\":\"%s\",\"pt\":\"0x%" PRIx64 "\",\"fuzzy\":%d,\"items\":[", nhits, TN[g_type], g_ptr_target, g_fuzzy);
    int first = 1;
    for (size_t i = off; i < nhits && i < off + count; i++) {
        char vs[96]; value_json(&hits[i], vs, sizeof vs);
        printf("%s{\"a\":\"0x%" PRIx64 "\",\"v\":\"%s\",\"t\":\"%s\"}", first ? "" : ",", hits[i].addr, vs, TN[hits[i].type]);
        first = 0;
    }
    printf("]}\n"); fflush(stdout);
}
static int resolve_addr(const char *s, uint64_t *addr) {
    if (!strncmp(s, "0x", 2) || !strncmp(s, "0X", 2)) return parse_addr(s, addr);
    char *e; errno = 0;
    unsigned long long i = strtoull(s, &e, 10);
    if (e == s || *e || errno || i >= nhits) return -1;
    *addr = hits[i].addr;
    return 0;
}
static void cmd_get(uint64_t addr, Type t) {
    if (!need_attach()) return;
    uint8_t tmp[8] = {0}; char vs[48];
    if (t == T_BYTES) { jerr("bad_arg", "use hex for bytes"); return; }
    if (pread(g_mem, tmp, (size_t)TS[t], (off_t)addr) != TS[t]) { jerr("read_failed", "cannot read that address"); return; }
    num_str(t, decode(t, tmp), vs, sizeof vs);
    printf("{\"ok\":true,\"v\":\"%s\"}\n", vs); fflush(stdout);
}
static void cmd_getm(int n, char **toks) {
    if (!need_attach()) return;
    printf("{\"ok\":true,\"v\":[");
    for (int i = 0; i < n; i++) {
        char b[96]; uint64_t addr; Type t; char vs[48] = "?"; uint8_t tmp[8] = {0};
        strncpy(b, toks[i], sizeof b - 1); b[sizeof b - 1] = 0;
        char *c = strchr(b, ':');
        if (c) { *c = 0; if (!parse_addr(b, &addr) && !parse_type(c + 1, &t) && t != T_BYTES &&
                             pread(g_mem, tmp, (size_t)TS[t], (off_t)addr) == TS[t]) num_str(t, decode(t, tmp), vs, sizeof vs); }
        printf("%s\"%s\"", i ? "," : "", vs);
    }
    printf("]}\n"); fflush(stdout);
}
static void cmd_drop(const char *s) {
    if (g_fuzzy) { jerr("bad_arg", "no list yet"); return; }
    char *e; errno = 0;
    unsigned long long i = strtoull(s, &e, 10);
    if (e == s || *e || errno || i >= nhits) { jerr("bad_arg", "invalid index"); return; }
    memmove(&hits[i], &hits[i + 1], (nhits - i - 1) * sizeof(Hit));
    nhits--;
    jok();
}

// ---------- yazma ----------
static int check_writable(const Map *wm, size_t nwm, uint64_t addr, Type t, const char **why) {
    if (g_ro) { *why = "read_only"; return -1; }
    if (t == T_BYTES) { *why = "bad_arg"; return -1; }
    if (!in_maps(wm, nwm, addr, wsize(t), 1)) { *why = "not_writable"; return -1; }
    return 0;
}
static void cmd_set(uint64_t addr, Type t, Num v) {
    if (!need_attach()) return;
    Map *wm; size_t nwm = read_maps(&wm); const char *why = "";
    int bad = check_writable(wm, nwm, addr, t, &why);
    free(wm);
    if (bad) { jerr(why, "write refused"); return; }
    if (write_value(addr, t, v)) { jerr("write_failed", "write failed"); return; }
    jok();
}
static void cmd_setall(const char *vs) {
    if (!need_attach()) return;
    if (!nhits) { jerr("no_results", "no results"); return; }
    if (nhits > MAX_SETALL) { jerr("too_many", "narrow the list to 2000 results or fewer first"); return; }
    Map *wm; size_t nwm = read_maps(&wm);
    Num A[T_COUNT]; int ok[T_COUNT];
    for (int t = 0; t < T_COUNT; t++) ok[t] = t != T_BYTES && !parse_num((Type)t, vs, &A[t]);
    size_t written = 0, skipped = 0; const char *why = "";
    for (size_t i = 0; i < nhits; i++) {
        Type t = (Type)hits[i].type;
        if (!ok[t] || check_writable(wm, nwm, hits[i].addr, t, &why) || write_value(hits[i].addr, t, A[t])) { skipped++; continue; }
        written++;
    }
    free(wm);
    printf("{\"ok\":true,\"written\":%zu,\"skipped\":%zu,\"total\":%zu}\n", written, skipped, nhits); fflush(stdout);
}
static void cmd_setbytes(uint64_t addr, const char *hex) {
    if (!need_attach()) return;
    uint8_t b[MAX_SETBYTES]; size_t n;
    if (parse_hex(hex, b, MAX_SETBYTES, &n)) { jerr("bad_arg", "invalid hex (even length, at most 64 bytes)"); return; }
    if (g_ro) { jerr("read_only", "read only"); return; }
    Map *wm; size_t nwm = read_maps(&wm);
    int ok = in_maps(wm, nwm, addr, (int)n, 1);
    free(wm);
    if (!ok) { jerr("not_writable", "not writable"); return; }
    if (pwrite(g_mem, b, n, (off_t)addr) != (ssize_t)n) { jerr("write_failed", "write failed"); return; }
    jok();
}

// ---------- dondurma ----------
static void *freezer(void *arg) {
    (void)arg;
    int fails = 0;
    for (;;) {
        pthread_mutex_lock(&fmu);
        int bad = 0;
        for (int i = 0; i < nfrozen && g_mem >= 0; i++) {
            Frozen *f = &frozen[i];
            if (f->mode) {
                uint8_t cur[8] = {0};
                if (pread(g_mem, cur, (size_t)TS[f->type], (off_t)f->addr) != TS[f->type]) { bad++; continue; }
                Num c = decode(f->type, cur);
                int lt = is_float(f->type) ? c.d < f->v.d : c.i < f->v.i;
                int gt = is_float(f->type) ? c.d > f->v.d : c.i > f->v.i;
                if (!((f->mode == 1 && lt) || (f->mode == 2 && gt))) continue;
            }
            if (write_value(f->addr, f->type, f->v)) bad++;
        }
        if (nfrozen && bad == nfrozen) fails++; else fails = 0;
        if (fails > 40) { nfrozen = 0; fails = 0; }   // hedef gitti: dondurmayi birak
        pthread_mutex_unlock(&fmu);
        usleep(50000);
    }
    return NULL;
}
static void cmd_freeze(uint64_t addr, Type t, Num v, int mode) {
    if (!need_attach()) return;
    Map *wm; size_t nwm = read_maps(&wm); const char *why = "";
    int bad = check_writable(wm, nwm, addr, t, &why);
    free(wm);
    if (bad) { jerr(why, "cannot write to that address"); return; }
    pthread_mutex_lock(&fmu);
    int idx = -1;
    for (int i = 0; i < nfrozen; i++) if (frozen[i].addr == addr) idx = i;
    if (idx < 0) {
        if (nfrozen >= MAX_FROZEN) { pthread_mutex_unlock(&fmu); jerr("freeze_limit", "at most 256 frozen addresses"); return; }
        idx = nfrozen++;
    }
    frozen[idx].addr = addr; frozen[idx].type = t; frozen[idx].v = v; frozen[idx].mode = mode;
    pthread_mutex_unlock(&fmu);
    if (!freezer_started) { pthread_t th; pthread_create(&th, NULL, freezer, NULL); pthread_detach(th); freezer_started = 1; }
    jok();
}
static void cmd_unfreeze(const char *s) {
    pthread_mutex_lock(&fmu);
    if (!strcmp(s, "all")) nfrozen = 0;
    else {
        uint64_t addr;
        if (!parse_addr(s, &addr)) for (int i = 0; i < nfrozen; i++) if (frozen[i].addr == addr) { frozen[i] = frozen[--nfrozen]; break; }
    }
    pthread_mutex_unlock(&fmu);
    jok();
}
static void cmd_frozen(void) {
    pthread_mutex_lock(&fmu);
    printf("{\"ok\":true,\"items\":[");
    for (int i = 0; i < nfrozen; i++) {
        char vs[48]; num_str(frozen[i].type, frozen[i].v, vs, sizeof vs);
        printf("%s{\"a\":\"0x%" PRIx64 "\",\"t\":\"%s\",\"v\":\"%s\",\"m\":%d}", i ? "," : "", frozen[i].addr, TN[frozen[i].type], vs, frozen[i].mode);
    }
    printf("]}\n");
    pthread_mutex_unlock(&fmu);
    fflush(stdout);
}

// ---------- isaretci / ofset / atlama ----------
static void cmd_ptrscan(uint64_t target, uint64_t maxoff) {
    if (!need_attach()) return;
    int psz = g_ptrsize; Type pt = psz == 8 ? T_I64 : T_I32;
    snap_free(); nhits = 0; truncated = 0;
    Region *r; size_t nr = load_scan_regions(&r);
    const size_t CH = 1u << 20;
    uint8_t *buf = malloc(CH);
    int stop = 0;
    for (size_t i = 0; i < nr && !stop; i++) {
        uint64_t a = r[i].s;
        while (a < r[i].e && !stop) {
            size_t len = (r[i].e - a < CH) ? (size_t)(r[i].e - a) : CH;
            ssize_t n = pread(g_mem, buf, len, (off_t)a);
            if (n <= 0) { a = (a | 4095) + 1; continue; }
            size_t cnt = (size_t)n;
            for (size_t o = 0; o + (size_t)psz <= cnt; o += (size_t)psz) {
                uint64_t p = 0;
                if (psz == 8) memcpy(&p, buf + o, 8); else { uint32_t q; memcpy(&q, buf + o, 4); p = q; }
                if (p <= target && target - p <= maxoff && !add_hit(a + o, buf + o, psz, pt)) { stop = 1; break; }
            }
            a += cnt;
            if (cnt < len) a = (a | 4095) + 1;
        }
    }
    free(buf); free(r);
    g_type = pt; g_ptr_target = target;
    print_list_head();
}
static void cmd_jump(uint64_t addr) {
    if (!need_attach()) return;
    uint64_t p = 0; int psz = g_ptrsize;
    if (psz == 8) { if (pread(g_mem, &p, 8, (off_t)addr) != 8) { jerr("read_failed", "cannot read that address"); return; } }
    else { uint32_t q; if (pread(g_mem, &q, 4, (off_t)addr) != 4) { jerr("read_failed", "cannot read that address"); return; } p = q; }
    Map *m; size_t nm = read_maps(&m);
    int ok = p && in_maps(m, nm, p, 1, 0);
    free(m);
    if (!ok) { jerr("bad_pointer", "the value is not a valid pointer"); return; }
    snap_free(); nhits = 0; truncated = 0; g_ptr_target = 0; g_type = T_I32;
    uint8_t tmp[8] = {0};
    if (pread(g_mem, tmp, 4, (off_t)p) != 4) memset(tmp, 0, 8);
    add_hit(p, tmp, 4, T_I32);
    printf("{\"ok\":true,\"to\":\"0x%" PRIx64 "\"}\n", p); fflush(stdout);
}
static void cmd_shift(long long delta, int has_type, Type nt) {
    if (!need_attach()) return;
    if (g_fuzzy || !nhits) { jerr("no_results", "run a scan first"); return; }
    if (has_type && !is_plain(nt) && nt != T_XOR) { jerr("bad_arg", "invalid type"); return; }
    win_reset();
    size_t keep = 0;
    for (size_t i = 0; i < nhits; i++) {
        Type t = has_type ? nt : (Type)hits[i].type;
        if (t == T_BYTES) continue;
        uint64_t na = (uint64_t)((int64_t)hits[i].addr + delta);
        uint8_t tmp[8] = {0};
        if (cached_read(na, tmp, TS[t])) continue;
        hits[keep].addr = na; hits[keep].type = (uint8_t)t; memcpy(hits[keep].val, tmp, 8); keep++;
    }
    nhits = keep; g_ptr_target = 0;
    if (has_type) g_type = nt; else if (nhits) g_type = (Type)hits[0].type;
    print_list_head();
}

// ---------- hex / harita / dokum ----------
static void cmd_hex(uint64_t addr, size_t len) {
    if (!need_attach()) return;
    if (len == 0 || len > MAX_HEX) { jerr("bad_arg", "length must be 1..512"); return; }
    uint8_t b[MAX_HEX]; char h[2 * MAX_HEX + 1];
    ssize_t n = pread(g_mem, b, len, (off_t)addr);
    if (n <= 0) { jerr("read_failed", "cannot read that address"); return; }
    hex_str(b, (size_t)n, h);
    printf("{\"ok\":true,\"a\":\"0x%" PRIx64 "\",\"h\":\"%s\"}\n", addr, h); fflush(stdout);
}
static void cmd_maps(size_t off, size_t count) {
    if (!need_attach()) return;
    if (count > 200) count = 200;
    Map *m; size_t nm = read_maps(&m);
    printf("{\"ok\":true,\"total\":%zu,\"items\":[", nm);
    int first = 1;
    for (size_t i = off; i < nm && i < off + count; i++) {
        printf("%s{\"s\":\"0x%" PRIx64 "\",\"e\":\"0x%" PRIx64 "\",\"c\":\"%s\",\"w\":%d,\"n\":\"%s\"}", first ? "" : ",", m[i].s, m[i].e, class_code(m[i].cls), m[i].w, m[i].name);
        first = 0;
    }
    printf("]}\n"); fflush(stdout);
    free(m);
}
static int safe_name(const char *s) {
    size_t l = strlen(s);
    if (!l || l > 60 || s[0] == '.') return 0;
    for (; *s; s++) if (!(isalnum((unsigned char)*s) || *s == '_' || *s == '.' || *s == '-')) return 0;
    return 1;
}
static void cmd_dump(uint64_t s, uint64_t e, const char *name) {
    if (!need_attach()) return;
    if (!g_datadir[0]) { jerr("no_datadir", "dump directory not configured"); return; }
    if (!safe_name(name)) { jerr("bad_arg", "invalid file name"); return; }
    if (e <= s || e - s > DUMP_MAX) { jerr("bad_arg", "range must be 1 byte .. 256 MB"); return; }
    char path[600]; snprintf(path, sizeof path, "%s/%s", g_datadir, name);
    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0644);
    if (fd < 0) { jerr("open_failed", "cannot create the dump file"); return; }
    const size_t CH = 1u << 20; uint8_t *buf = malloc(CH);
    uint64_t done = 0, a = s;
    while (a < e) {
        size_t len = (e - a < CH) ? (size_t)(e - a) : CH;
        ssize_t n = pread(g_mem, buf, len, (off_t)a);
        if (n <= 0 || write(fd, buf, (size_t)n) != n) break;
        a += (uint64_t)n; done += (uint64_t)n;
    }
    close(fd); free(buf);
    if (!done) { unlink(path); jerr("read_failed", "cannot read that range"); return; }
    printf("{\"ok\":true,\"bytes\":%" PRIu64 ",\"path\":\"%s\"}\n", done, path); fflush(stdout);
}

// ---------- duraklat / surdur ----------
static void *watchdog(void *arg) {
    (void)arg;
    for (;;) {
        sleep(1);
        pthread_mutex_lock(&pmu);
        if (g_paused) {
            struct timespec now; clock_gettime(CLOCK_MONOTONIC, &now);
            if ((unsigned)(now.tv_sec - paused_at.tv_sec) >= g_max_pause) {
                if (g_pid > 0) kill(g_pid, SIGCONT);
                g_paused = 0; sig_paused = 0;
            }
        }
        pthread_mutex_unlock(&pmu);
    }
    return NULL;
}
static void cmd_pause(void) {
    if (!need_attach()) return;
    pthread_mutex_lock(&pmu);
    if (!g_paused) {
        if (kill(g_pid, SIGSTOP)) { pthread_mutex_unlock(&pmu); jerr("pause_failed", "cannot pause the process"); return; }
        g_paused = 1; sig_paused = 1; clock_gettime(CLOCK_MONOTONIC, &paused_at);
    }
    pthread_mutex_unlock(&pmu);
    if (!watchdog_started) { pthread_t th; pthread_create(&th, NULL, watchdog, NULL); pthread_detach(th); watchdog_started = 1; }
    jok();
}
static void on_signal(int sig) {
    (void)sig;
    if (sig_paused && sig_pid > 0) kill(sig_pid, SIGCONT);
    _exit(0);
}

static void cmd_status(void) {
    printf("{\"ok\":true,\"v\":%d,\"euid\":%d,\"pid\":%d,\"name\":\"%s\",\"ro\":%d,\"ptr\":%d,\"hits\":%zu,\"frozen\":%d,\"type\":\"%s\",\"paused\":%d,\"fuzzy\":%d,\"datadir\":%d}\n",
           CORE_VERSION, (int)geteuid(), g_pid, g_name, g_ro, g_ptrsize, nhits, nfrozen, TN[g_type], g_paused, g_fuzzy, g_datadir[0] ? 1 : 0);
    fflush(stdout);
}

// ---------- ana dongu ----------
static int parse_mask(const char *s, uint32_t *mask) {
    char b[200];
    if (strlen(s) >= sizeof b) return -1;
    strcpy(b, s);
    uint32_t m = 0;
    for (char *p = strtok(b, ","); p; p = strtok(NULL, ",")) {
        if (!strcmp(p, "all")) { m |= RC_ALL; continue; }
        int f = 0;
        for (size_t i = 0; i < NRCN; i++) if (!strcmp(p, RCN[i].name)) { m |= RCN[i].bit; f = 1; }
        if (!f) return -1;
    }
    if (!m) return -1;
    *mask = m;
    return 0;
}
static int parse_mode(const char *k, Mode *m) {
    static const struct { const char *n; Mode m; } T[] = {
        {"eq", M_RANGE}, {"ne", M_NE}, {"gt", M_GT}, {"lt", M_LT}, {"changed", M_CHANGED}, {"unchanged", M_UNCH},
        {"inc", M_INC}, {"dec", M_DEC}, {"incby", M_INCBY}, {"decby", M_DECBY}
    };
    for (size_t i = 0; i < sizeof T / sizeof T[0]; i++) if (!strcmp(k, T[i].n)) { *m = T[i].m; return 0; }
    return -1;
}

static void handle(char *line) {
    char *tok[MAX_TOK] = {0}; int nt = 0;
    for (char *p = strtok(line, " \t\r\n"); p && nt < MAX_TOK; p = strtok(NULL, " \t\r\n")) tok[nt++] = p;
    if (!nt) return;
    const char *c = tok[0]; Type t; Num a, b; uint64_t addr, addr2; Mode m;
    if (!strcmp(c, "status")) cmd_status();
    else if (!strcmp(c, "ps")) cmd_ps();
    else if (!strcmp(c, "attach") && nt == 2) cmd_attach(tok[1]);
    else if (!strcmp(c, "detach")) cmd_detach();
    else if (!strcmp(c, "reset")) { nhits = 0; truncated = 0; g_ptr_target = 0; snap_free(); jok(); }
    else if (!strcmp(c, "region") && nt == 2) { uint32_t mk; if (parse_mask(tok[1], &mk)) jerr("bad_arg", "unknown region"); else { g_rmask = mk; jok(); } }
    else if (!strcmp(c, "scan") && nt >= 3 && nt <= 4 && !strcmp(tok[1], "auto")) cmd_scan_auto(tok[2], nt == 4 ? tok[3] : NULL);
    else if (!strcmp(c, "scan") && nt == 3 && !strcmp(tok[1], "bytes")) {
        uint8_t pat[64]; size_t pl;
        if (parse_hex(tok[2], pat, sizeof pat, &pl)) jerr("bad_arg", "invalid hex (even length, at most 64 bytes)"); else cmd_scan_bytes(pat, pl);
    }
    else if (!strcmp(c, "scan") && (nt == 3 || nt == 4)) {
        if (parse_type(tok[1], &t) || t == T_BYTES) { jerr("bad_arg", "invalid type"); return; }
        if (parse_num(t, tok[2], &a) || (nt == 4 ? parse_num(t, tok[3], &b) : (b = a, 0))) { jerr("bad_arg", "invalid type or value"); return; }
        if (is_float(t) ? a.d > b.d : a.i > b.i) { jerr("bad_arg", "range start is greater than end"); return; }
        cmd_scan(t, a, b);
    }
    else if (!strcmp(c, "fuzzy") && nt == 2) { if (parse_type(tok[1], &t)) jerr("bad_arg", "invalid type"); else cmd_fuzzy(t); }
    else if (!strcmp(c, "gscan") && nt >= 5 && nt - 3 <= MAX_GROUP) {
        char *e; errno = 0; unsigned long long w = strtoull(tok[2], &e, 10);
        if (parse_type(tok[1], &t) || !is_plain(t) || e == tok[2] || *e || errno || w < 1 || w > (1u << 20)) jerr("bad_arg", "invalid type or window");
        else cmd_gscan(t, w, nt - 3, tok + 3);
    }
    else if (!strcmp(c, "next") && nt >= 2) {
        const char *k = tok[1];
        if (parse_mode(k, &m)) { jerr("bad_arg", "unknown filter"); return; }
        int needs = (m == M_RANGE || m == M_NE || m == M_GT || m == M_LT || m == M_INCBY || m == M_DECBY);
        if (needs ? (nt < 3 || nt > 4 || (nt == 4 && m != M_RANGE)) : nt != 2) { jerr("bad_arg", "wrong number of arguments"); return; }
        cmd_next(m, needs ? tok[2] : NULL, nt == 4 ? tok[3] : NULL);
    }
    else if (!strcmp(c, "list") && nt == 3) cmd_list((size_t)strtoull(tok[1], NULL, 10), (size_t)strtoull(tok[2], NULL, 10));
    else if (!strcmp(c, "get") && nt == 3) {
        if (parse_addr(tok[1], &addr) || parse_type(tok[2], &t)) jerr("bad_arg", "invalid address or type"); else cmd_get(addr, t);
    }
    else if (!strcmp(c, "getm") && nt >= 2 && nt - 1 <= MAX_GETM) cmd_getm(nt - 1, tok + 1);
    else if (!strcmp(c, "set") && nt == 4) {
        if (parse_addr(tok[1], &addr) || parse_type(tok[2], &t) || parse_num(t, tok[3], &a)) jerr("bad_arg", "invalid address, type or value"); else cmd_set(addr, t, a);
    }
    else if (!strcmp(c, "freeze") && (nt == 4 || nt == 5)) {
        int mode = 0;
        if (nt == 5) { if (!strcmp(tok[4], "inc")) mode = 1; else if (!strcmp(tok[4], "dec")) mode = 2; else if (strcmp(tok[4], "n")) { jerr("bad_arg", "freeze mode must be n, inc or dec"); return; } }
        if (parse_addr(tok[1], &addr) || parse_type(tok[2], &t) || parse_num(t, tok[3], &a)) jerr("bad_arg", "invalid address, type or value"); else cmd_freeze(addr, t, a, mode);
    }
    else if (!strcmp(c, "setall") && nt == 2) cmd_setall(tok[1]);
    else if (!strcmp(c, "setbytes") && nt == 3) { if (parse_addr(tok[1], &addr)) jerr("bad_arg", "invalid address"); else cmd_setbytes(addr, tok[2]); }
    else if (!strcmp(c, "unfreeze") && nt == 2) cmd_unfreeze(tok[1]);
    else if (!strcmp(c, "frozen")) cmd_frozen();
    else if (!strcmp(c, "drop") && nt == 2) cmd_drop(tok[1]);
    else if (!strcmp(c, "ptrscan") && (nt == 2 || nt == 3)) {
        uint64_t mo = 0x100;
        if (nt == 3) { char *e; errno = 0; mo = strtoull(tok[2], &e, 0); if (e == tok[2] || *e || errno || mo > 0x100000) { jerr("bad_arg", "max offset must be 0..0x100000"); return; } }
        if (resolve_addr(tok[1], &addr)) jerr("bad_arg", "invalid address or index"); else cmd_ptrscan(addr, mo);
    }
    else if (!strcmp(c, "jump") && nt == 2) { if (resolve_addr(tok[1], &addr)) jerr("bad_arg", "invalid address or index"); else cmd_jump(addr); }
    else if (!strcmp(c, "shift") && (nt == 2 || nt == 3)) {
        char *e; errno = 0; long long d = strtoll(tok[1], &e, 0); Type nt2 = T_I32;
        if (e == tok[1] || *e || errno || d < -(1 << 20) || d > (1 << 20) || (nt == 3 && parse_type(tok[2], &nt2))) jerr("bad_arg", "invalid offset or type");
        else cmd_shift(d, nt == 3, nt2);
    }
    else if (!strcmp(c, "hex") && nt == 3) { if (parse_addr(tok[1], &addr)) jerr("bad_arg", "invalid address"); else cmd_hex(addr, (size_t)strtoull(tok[2], NULL, 10)); }
    else if (!strcmp(c, "maps") && nt == 3) cmd_maps((size_t)strtoull(tok[1], NULL, 10), (size_t)strtoull(tok[2], NULL, 10));
    else if (!strcmp(c, "dump") && nt == 4) { if (parse_addr(tok[1], &addr) || parse_addr(tok[2], &addr2)) jerr("bad_arg", "invalid address"); else cmd_dump(addr, addr2, tok[3]); }
    else if (!strcmp(c, "pause")) cmd_pause();
    else if (!strcmp(c, "resume")) { do_resume(); jok(); }
    else jerr("unknown_cmd", "unknown or malformed command");
}

int main(int argc, char **argv) {
    for (int i = 1; i + 1 < argc; i++) {
        if (!strcmp(argv[i], "--min-uid")) g_min_uid = (uint32_t)strtoul(argv[i + 1], NULL, 10);
        else if (!strcmp(argv[i], "--data-dir")) snprintf(g_datadir, sizeof g_datadir, "%s", argv[i + 1]);
        else if (!strcmp(argv[i], "--tmp-dir")) snprintf(g_tmpdir, sizeof g_tmpdir, "%s", argv[i + 1]);
        else if (!strcmp(argv[i], "--max-pause")) { g_max_pause = (unsigned)strtoul(argv[i + 1], NULL, 10); if (g_max_pause < 5) g_max_pause = 5; }
    }
    signal(SIGTERM, on_signal); signal(SIGHUP, on_signal); signal(SIGINT, on_signal); signal(SIGPIPE, on_signal);
    setvbuf(stdout, NULL, _IOLBF, 0);
    char line[2048];
    while (fgets(line, sizeof line, stdin)) {
        if (strchr(line, '\n') == NULL && !feof(stdin)) { int ch; while ((ch = getchar()) != '\n' && ch != EOF) {} jerr("too_long", "command too long"); continue; }
        if (!strncmp(line, "quit", 4)) break;
        handle(line);
    }
    do_resume();
    if (g_mem >= 0) close(g_mem);
    return 0;
}
