// "Pratik oyunu": rootsuz modda GG'yi guvenle denemek icin uygulamanin kendi kullanici alaninda
// calisan sahte bir oyun sureci. Degerler: altin (int), can (float), mermi (int), hiz (double).
// stdin kapaninca (uygulama kapaninca) kendiliginden cikar.
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <unistd.h>
#include <poll.h>

int main(void) {
    volatile int *gold = malloc(sizeof(int));
    volatile float *hp = malloc(sizeof(float));
    volatile int *ammo = malloc(sizeof(int));
    volatile double *speed = malloc(sizeof(double));
    *gold = 1000; *hp = 100.0f; *ammo = 30; *speed = 1.5;
    printf("pid=%d\n", getpid());
    fflush(stdout);
    int tick = 0;
    for (;;) {
        struct pollfd p = { 0, POLLIN, 0 };
        int r = poll(&p, 1, 1000);
        if (r > 0 && (p.revents & (POLLHUP | POLLERR))) break;
        if (r > 0 && (p.revents & POLLIN)) { char b[64]; if (read(0, b, sizeof b) <= 0) break; }
        tick++;
        if (tick % 3 == 0 && *hp > 5.0f) *hp -= 5.0f;      // can yavas yavas azalir
        if (tick % 4 == 0 && *ammo > 0) *ammo -= 1;        // mermi azalir
        if (tick % 5 == 0) *gold += 10;                    // altin artar
    }
    return 0;
}
