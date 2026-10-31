// memcore testleri icin sahte hedef surec. stdin'den komut alir:
//   dec  -> gold -= 100        hit -> hp -= 12.5        get -> degerleri yazdir        quit
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(void) {
    int *gold = malloc(sizeof(int));
    int *decoy = malloc(sizeof(int));          // ayni deger, hic degismez
    float *hp = malloc(sizeof(float));
    double *speed = malloc(sizeof(double));
    long long *big = malloc(sizeof(long long));
    *gold = 1000; *decoy = 1000; *hp = 87.5f; *speed = 3.14159; *big = 5000000000LL;
    printf("pid=%d\n", getpid()); fflush(stdout);
    char line[64];
    while (fgets(line, sizeof line, stdin)) {
        if (!strncmp(line, "dec", 3)) *(volatile int *)gold -= 100;
        else if (!strncmp(line, "hit", 3)) *(volatile float *)hp -= 12.5f;
        else if (!strncmp(line, "quit", 4)) break;
        printf("gold=%d decoy=%d hp=%g speed=%g big=%lld\n", *(volatile int *)gold, *(volatile int *)decoy,
               *(volatile float *)hp, *(volatile double *)speed, *(volatile long long *)big);
        fflush(stdout);
        // "get" ve diger tum satirlar da degerleri yazdirir
        (void)decoy;
    }
    return 0;
}
