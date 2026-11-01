# mgg - kişisel bellek tarayıcı (Game Guardian benzeri, CLI)

Başka bir sürecin belleğinde değer arar, daraltır, değiştirir ve dondurur.
Tek dosya, bağımlılık yok: `mgg.c`

## Android (root'lu cihaz, Termux)

```
pkg install clang
clang -O2 -o mgg mgg.c -lpthread
su -c ./mgg
```

Oyunun pid'sini bulmak için başka bir Termux oturumunda: `su -c "pidof <paket.adi>"`
(ya da `su -c "ps -A | grep <oyun>"`).

## Linux'ta deneme

```
gcc -O2 -o mgg mgg.c -lpthread
gcc -O2 -o dummy_game dummy_game.c
./dummy_game &        # pid yazar
sudo ./mgg
```

## Örnek akış

```
attach 1234
type i32
scan 1000        # ekrandaki altın 1000 iken
next 900         # altın 900 olunca daralt
list
set 0 99999
freeze 0 99999   # sabit tut
unfreeze 0
```

Bilmediğin değerler için: `scan` yerine önce tam değeri bul, olmazsa float (`type f32`) dene.
`changed / unchanged / inc / dec` komutları değişime göre daraltır.

## Komutlar

| Komut | Ne yapar |
|---|---|
| `attach <pid>` | süreci seç |
| `type i32\|i64\|f32\|f64` | değer tipi |
| `scan <değer>` | yeni tarama |
| `next <değer>` | listeyi bu değere göre daralt |
| `changed`, `unchanged`, `inc`, `dec` | değişime göre daralt |
| `list [n]` | sonuçlar |
| `set <idx\|0xadres> <değer>` | yaz |
| `freeze` / `unfreeze` | sabitle / çöz |
| `maps` | bellek özeti |
| `reset`, `quit` | |

## Sınırlar (dürüst liste)

- Yalnızca root ile çalışır (`/proc/<pid>/mem`). Root'suz sanal alan modu yok.
- Hizalı tarama yapar (4/8 bayt adımla); GG'deki gibi tüm bölge filtreleri, "XOR", "grup araması", Lua, yüzen arayüz yok.
- Sadece tam sayı ve ondalık tipler; metin/bayt dizisi araması yok.
- Bazı oyunlarda koruma (anti-cheat) `/proc/pid/mem` erişimini engeller; çevrimiçi oyunlarda kullanma, hesap banlanır.
- Burada sadece Linux'ta sahte bir süreçle test ettim; Android'de denemedim.
