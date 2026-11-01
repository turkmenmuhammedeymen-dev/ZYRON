// Test icin sahte "oyun": altin ve can degerlerini tutar, her saniye yazdirir.
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

int main(void) {
    int *gold = malloc(sizeof(int));
    float *hp = malloc(sizeof(float));
    *gold = 1000;
    *hp = 87.5f;
    printf("pid=%d\n", getpid());
    fflush(stdout);
    for (int t = 0; t < 120; t++) {
        printf("gold=%d hp=%g\n", *(volatile int *)gold, *(volatile float *)hp);
        fflush(stdout);
        if (t == 3) *gold -= 100;   // degisim simule et
        if (t == 6) *gold -= 50;
        sleep(1);
    }
    return 0;
}
