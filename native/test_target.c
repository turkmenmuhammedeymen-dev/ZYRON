// memcore testleri icin sahte hedef surec.
// Ilk satir: "pid=<n>", ikinci satir: "addrs gold=0x.. ..." (test adresleri bilir).
// stdin komutlari: dec (gold -= 100), hit (hp -= 12.5), get (degerleri yazdir), quit.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <unistd.h>

typedef struct { int hp, mp, gold2, pad; } Player;

int main(void) {
    int *gold = malloc(sizeof(int));
    int *decoy = malloc(sizeof(int));          // ayni deger, hic degismez
    float *hp = malloc(sizeof(float));
    double *speed = malloc(sizeof(double));
    long long *big = malloc(sizeof(long long));
    uint32_t *enc = malloc(8);                 // XOR ile saklanan deger: enc[0] ^ enc[1]
    Player *pl = malloc(sizeof(Player));       // yan yana uc alan (grup arama)
    void **holder = malloc(sizeof(void *));    // pl'yi gosteren isaretci
    char *name = strdup("ZYRON_HERO_NAME");

    *gold = 1000; *decoy = 1000; *hp = 87.5f; *speed = 3.14159; *big = 5000000000LL;
    enc[1] = 0xA5A5A5A5u; enc[0] = 777u ^ enc[1];
    pl->hp = 1234567; pl->mp = 2345678; pl->gold2 = 3456789; pl->pad = 0;
    *holder = pl;

    printf("pid=%d\n", getpid());
    printf("addrs gold=0x%lx decoy=0x%lx hp=0x%lx speed=0x%lx big=0x%lx enc=0x%lx pl=0x%lx holder=0x%lx name=0x%lx\n",
           (unsigned long)gold, (unsigned long)decoy, (unsigned long)hp, (unsigned long)speed, (unsigned long)big,
           (unsigned long)enc, (unsigned long)pl, (unsigned long)holder, (unsigned long)name);
    fflush(stdout);

    char line[64];
    while (fgets(line, sizeof line, stdin)) {
        if (!strncmp(line, "dec", 3)) *(volatile int *)gold -= 100;
        else if (!strncmp(line, "hit", 3)) *(volatile float *)hp -= 12.5f;
        else if (!strncmp(line, "quit", 4)) break;
        printf("gold=%d decoy=%d hp=%g speed=%g big=%lld enc=%u name=%s php=%d pmp=%d pg=%d\n",
               *(volatile int *)gold, *(volatile int *)decoy, *(volatile float *)hp, *(volatile double *)speed,
               *(volatile long long *)big, (unsigned)(((volatile uint32_t *)enc)[0] ^ ((volatile uint32_t *)enc)[1]),
               name, *(volatile int *)&pl->hp, *(volatile int *)&pl->mp, *(volatile int *)&pl->gold2);
        fflush(stdout);
    }
    return 0;
}
