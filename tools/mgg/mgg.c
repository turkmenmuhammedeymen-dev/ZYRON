// mgg - kisisel bellek tarayici / duzenleyici (Game Guardian benzeri, CLI)
// Linux ve rootlu Android (Termux) uzerinde calisir.
// Derleme: clang -O2 -o mgg mgg.c -lpthread
// Kullanim: su -c ./mgg   (Android)   |   sudo ./mgg  (Linux)

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <inttypes.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <pthread.h>
#include <sys/types.h>

typedef enum { T_I32, T_I64, T_F32, T_F64 } Type;
static const char *TNAME[] = {"i32", "i64", "f32", "f64"};
static int tsize(Type t) { return (t == T_I32 || t == T_F32) ? 4 : 8; }

typedef struct { uint64_t start, end; } Region;
typedef struct { uint64_t addr; uint8_t val[8]; } Hit;
typedef struct { uint64_t addr; uint8_t val[8]; int size; } Frozen;

static pid_t g_pid = 0;
static int g_mem = -1;
static Type g_type = T_I32;

static Hit *hits = NULL;
static size_t nhits = 0, caphits = 0;

static Frozen frozen[256];
static int nfrozen = 0;
static pthread_mutex_t fmu = PTHREAD_MUTEX_INITIALIZER;
static int freezer_started = 0;

// ---------- yardimcilar ----------

static void add_hit(uint64_t addr, const uint8_t *v, int sz) {
    if (nhits == caphits) {
        caphits = caphits ? caphits * 2 : 1 << 16;
        hits = realloc(hits, caphits * sizeof(Hit));
        if (!hits) { perror("realloc"); exit(1); }
    }
    hits[nhits].addr = addr;
    memset(hits[nhits].val, 0, 8);
    memcpy(hits[nhits].val, v, sz);
    nhits++;
}

static int parse_value(Type t, const char *s, uint8_t out[8]) {
    char *e;
    memset(out, 0, 8);
    errno = 0;
    switch (t) {
    case T_I32: { long long v = strtoll(s, &e, 0); if (e == s || errno) return -1; int32_t x = (int32_t)v; memcpy(out, &x, 4); break; }
    case T_I64: { long long v = strtoll(s, &e, 0); if (e == s || errno) return -1; int64_t x = v; memcpy(out, &x, 8); break; }
    case T_F32: { double v = strtod(s, &e); if (e == s) return -1; float x = (float)v; memcpy(out, &x, 4); break; }
    case T_F64: { double v = strtod(s, &e); if (e == s) return -1; memcpy(out, &v, 8); break; }
    }
    return 0;
}

static void fmt_value(Type t, const uint8_t *b, char *buf, size_t n) {
    switch (t) {
    case T_I32: { int32_t x; memcpy(&x, b, 4); snprintf(buf, n, "%" PRId32, x); break; }
    case T_I64: { int64_t x; memcpy(&x, b, 8); snprintf(buf, n, "%" PRId64, x); break; }
    case T_F32: { float x; memcpy(&x, b, 4); snprintf(buf, n, "%g", x); break; }
    case T_F64: { double x; memcpy(&x, b, 8); snprintf(buf, n, "%g", x); break; }
    }
}

// a<b: -1, a==b: 0, a>b: 1
static int cmp_val(Type t, const uint8_t *a, const uint8_t *b) {
    switch (t) {
    case T_I32: { int32_t x, y; memcpy(&x, a, 4); memcpy(&y, b, 4); return (x > y) - (x < y); }
    case T_I64: { int64_t x, y; memcpy(&x, a, 8); memcpy(&y, b, 8); return (x > y) - (x < y); }
    case T_F32: { float x, y; memcpy(&x, a, 4); memcpy(&y, b, 4); return (x > y) - (x < y); }
    default:    { double x, y; memcpy(&x, a, 8); memcpy(&y, b, 8); return (x > y) - (x < y); }
    }
}

static int read_mem(uint64_t addr, void *buf, size_t n) {
    ssize_t r = pread(g_mem, buf, n, (off_t)addr);
    return r == (ssize_t)n ? 0 : -1;
}

static int write_mem(uint64_t addr, const void *buf, size_t n) {
    ssize_t r = pwrite(g_mem, buf, n, (off_t)addr);
    return r == (ssize_t)n ? 0 : -1;
}

// ---------- maps ----------

static size_t load_regions(Region **out) {
    char path[64];
    snprintf(path, sizeof path, "/proc/%d/maps", g_pid);
    FILE *f = fopen(path, "r");
    if (!f) { perror(path); return 0; }
    size_t cap = 256, n = 0;
    Region *r = malloc(cap * sizeof(Region));
    char line[1024];
    while (fgets(line, sizeof line, f)) {
        unsigned long long s, e;
        char perms[8], rest[900] = "";
        if (sscanf(line, "%llx-%llx %7s %*s %*s %*s %899[^\n]", &s, &e, perms, rest) < 3) continue;
        if (perms[0] != 'r' || perms[1] != 'w') continue;
        char *p = rest; while (*p == ' ') p++;
        if (!strncmp(p, "[vvar", 5) || !strncmp(p, "[vsyscall", 9) || !strncmp(p, "/dev/", 5)) continue;
        if (n == cap) { cap *= 2; r = realloc(r, cap * sizeof(Region)); }
        r[n].start = s; r[n].end = e; n++;
    }
    fclose(f);
    *out = r;
    return n;
}

static void cmd_maps(void) {
    Region *r; size_t n = load_regions(&r);
    uint64_t total = 0;
    for (size_t i = 0; i < n; i++) total += r[i].end - r[i].start;
    printf("%zu yazilabilir bolge, toplam %.1f MB\n", n, total / 1048576.0);
    free(r);
}

// ---------- tarama ----------

static void cmd_scan(const char *vs) {
    if (!g_pid) { puts("once: attach <pid>"); return; }
    uint8_t want[8];
    if (parse_value(g_type, vs, want)) { puts("gecersiz deger"); return; }
    int sz = tsize(g_type);
    Region *regs; size_t nr = load_regions(&regs);
    nhits = 0;
    const size_t CH = 1 << 20;
    uint8_t *buf = malloc(CH);
    for (size_t i = 0; i < nr; i++) {
        for (uint64_t a = regs[i].start; a < regs[i].end; a += CH) {
            size_t len = regs[i].end - a < CH ? regs[i].end - a : CH;
            if (read_mem(a, buf, len)) continue;
            for (size_t o = 0; o + sz <= len; o += sz)
                if (!memcmp(buf + o, want, sz)) add_hit(a + o, buf + o, sz);
        }
    }
    free(buf); free(regs);
    printf("%zu sonuc\n", nhits);
}

typedef enum { M_EQ, M_CHANGED, M_UNCH, M_INC, M_DEC } Mode;

static void cmd_next(Mode m, const char *vs) {
    if (!nhits) { puts("liste bos, once scan"); return; }
    uint8_t want[8];
    if (m == M_EQ && parse_value(g_type, vs, want)) { puts("gecersiz deger"); return; }
    int sz = tsize(g_type);
    size_t keep = 0;
    for (size_t i = 0; i < nhits; i++) {
        uint8_t cur[8] = {0};
        if (read_mem(hits[i].addr, cur, sz)) continue;
        int c = cmp_val(g_type, cur, hits[i].val);
        int ok = 0;
        switch (m) {
        case M_EQ: ok = !memcmp(cur, want, sz); break;
        case M_CHANGED: ok = memcmp(cur, hits[i].val, sz) != 0; break;
        case M_UNCH: ok = !memcmp(cur, hits[i].val, sz); break;
        case M_INC: ok = c > 0; break;
        case M_DEC: ok = c < 0; break;
        }
        if (ok) { hits[keep] = hits[i]; memcpy(hits[keep].val, cur, 8); keep++; }
    }
    nhits = keep;
    printf("%zu sonuc\n", nhits);
}

static void cmd_list(int n) {
    int sz = tsize(g_type); (void)sz;
    for (size_t i = 0; i < nhits && (int)i < n; i++) {
        uint8_t cur[8] = {0}; char b[64];
        if (read_mem(hits[i].addr, cur, tsize(g_type))) strcpy(b, "?");
        else fmt_value(g_type, cur, b, sizeof b);
        printf("[%zu] 0x%" PRIx64 "  %s  (%s)\n", i, hits[i].addr, b, TNAME[g_type]);
    }
    if ((int)nhits > n) printf("... +%zu daha\n", nhits - n);
}

static int resolve_addr(const char *s, uint64_t *addr) {
    if (!strncmp(s, "0x", 2)) { *addr = strtoull(s, NULL, 16); return 0; }
    size_t i = strtoul(s, NULL, 10);
    if (i >= nhits) { puts("gecersiz indeks"); return -1; }
    *addr = hits[i].addr;
    return 0;
}

static void cmd_set(const char *as, const char *vs) {
    uint64_t addr; uint8_t v[8];
    if (resolve_addr(as, &addr) || parse_value(g_type, vs, v)) { puts("gecersiz arguman"); return; }
    if (write_mem(addr, v, tsize(g_type))) perror("yazma basarisiz");
    else printf("0x%" PRIx64 " <- %s\n", addr, vs);
}

// ---------- dondurma ----------

static void *freezer(void *arg) {
    (void)arg;
    for (;;) {
        pthread_mutex_lock(&fmu);
        for (int i = 0; i < nfrozen; i++) write_mem(frozen[i].addr, frozen[i].val, frozen[i].size);
        pthread_mutex_unlock(&fmu);
        usleep(30000);
    }
    return NULL;
}

static void cmd_freeze(const char *as, const char *vs) {
    uint64_t addr; uint8_t v[8];
    if (resolve_addr(as, &addr) || parse_value(g_type, vs, v)) { puts("gecersiz arguman"); return; }
    pthread_mutex_lock(&fmu);
    int idx = -1;
    for (int i = 0; i < nfrozen; i++) if (frozen[i].addr == addr) idx = i;
    if (idx < 0) {
        if (nfrozen == 256) { pthread_mutex_unlock(&fmu); puts("dondurma limiti"); return; }
        idx = nfrozen++;
    }
    frozen[idx].addr = addr; frozen[idx].size = tsize(g_type); memcpy(frozen[idx].val, v, 8);
    pthread_mutex_unlock(&fmu);
    if (!freezer_started) { pthread_t t; pthread_create(&t, NULL, freezer, NULL); pthread_detach(t); freezer_started = 1; }
    printf("donduruldu 0x%" PRIx64 " = %s\n", addr, vs);
}

static void cmd_unfreeze(const char *as) {
    uint64_t addr;
    if (resolve_addr(as, &addr)) return;
    pthread_mutex_lock(&fmu);
    for (int i = 0; i < nfrozen; i++)
        if (frozen[i].addr == addr) { frozen[i] = frozen[--nfrozen]; break; }
    pthread_mutex_unlock(&fmu);
    puts("cozuldu");
}

// ---------- baglanma ve ana dongu ----------

static void cmd_attach(pid_t pid) {
    char path[64];
    if (g_mem >= 0) close(g_mem);
    snprintf(path, sizeof path, "/proc/%d/mem", pid);
    g_mem = open(path, O_RDWR);
    if (g_mem < 0) { perror(path); g_pid = 0; return; }
    g_pid = pid; nhits = 0;
    pthread_mutex_lock(&fmu); nfrozen = 0; pthread_mutex_unlock(&fmu);
    printf("baglandi: pid %d\n", pid);
}

static void help(void) {
    puts("attach <pid>        sureci sec\n"
         "type i32|i64|f32|f64 deger tipi (varsayilan i32)\n"
         "scan <deger>        yeni tarama\n"
         "next <deger>        listeyi bu degere gore daralt\n"
         "changed|unchanged|inc|dec   degisime gore daralt\n"
         "list [n]            sonuclari goster (varsayilan 20)\n"
         "set <idx|0xadres> <deger>      deger yaz\n"
         "freeze <idx|0xadres> <deger>   degeri sabitle\n"
         "unfreeze <idx|0xadres>\n"
         "maps                bellek bolgelerini ozetle\n"
         "reset               listeyi temizle\n"
         "quit");
}

int main(void) {
    char line[256];
    puts("mgg - 'help' yaz");
    for (;;) {
        printf("mgg> "); fflush(stdout);
        if (!fgets(line, sizeof line, stdin)) break;
        char *cmd = strtok(line, " \t\r\n");
        if (!cmd) continue;
        char *a1 = strtok(NULL, " \t\r\n"), *a2 = strtok(NULL, " \t\r\n");
        if (!strcmp(cmd, "quit") || !strcmp(cmd, "exit")) break;
        else if (!strcmp(cmd, "help")) help();
        else if (!strcmp(cmd, "attach") && a1) cmd_attach(atoi(a1));
        else if (!strcmp(cmd, "type") && a1) {
            int ok = 0;
            for (int i = 0; i < 4; i++) if (!strcmp(a1, TNAME[i])) { g_type = i; ok = 1; }
            puts(ok ? "tamam" : "i32|i64|f32|f64");
        }
        else if (!strcmp(cmd, "scan") && a1) cmd_scan(a1);
        else if (!strcmp(cmd, "next") && a1) cmd_next(M_EQ, a1);
        else if (!strcmp(cmd, "changed")) cmd_next(M_CHANGED, NULL);
        else if (!strcmp(cmd, "unchanged")) cmd_next(M_UNCH, NULL);
        else if (!strcmp(cmd, "inc")) cmd_next(M_INC, NULL);
        else if (!strcmp(cmd, "dec")) cmd_next(M_DEC, NULL);
        else if (!strcmp(cmd, "list")) cmd_list(a1 ? atoi(a1) : 20);
        else if (!strcmp(cmd, "set") && a1 && a2) cmd_set(a1, a2);
        else if (!strcmp(cmd, "freeze") && a1 && a2) cmd_freeze(a1, a2);
        else if (!strcmp(cmd, "unfreeze") && a1) cmd_unfreeze(a1);
        else if (!strcmp(cmd, "maps")) { if (g_pid) cmd_maps(); else puts("once attach"); }
        else if (!strcmp(cmd, "reset")) { nhits = 0; puts("temizlendi"); }
        else puts("bilinmeyen komut, 'help'");
    }
    return 0;
}
