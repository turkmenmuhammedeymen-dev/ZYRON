# ZYRON Memory Lab: Kullanım Kılavuzu

Bu kılavuz uygulamanın içinde de var: **Süreç** sekmesinde "📖 Kullanım rehberi" düğmesi.

## 1. Gerekenler
- **Root'lu Android telefon** (Magisk gibi). Root yoksa Memory Lab çalışmaz; bu Android'in kuralı.
- Çevrimdışı / tek kişilik bir oyun. Çevrimiçi oyunlarda (ör. Car Parking Multiplayer) değerler sunucuda tutulur ve hesap banlanabilir.

## 2. APK'yı indirme ve kurma
1. Tarayıcıda şu adrese git: https://github.com/turkmenmuhammedeymen-dev/ZYRON/releases/tag/latest
2. **Assets** altından `zyron-memory-lab.apk` dosyasına dokun, indir.
3. Dosyaya dokun, "Bilinmeyen kaynaklardan yüklemeye izin ver" çıkarsa izin ver, kur.
4. Release sayfası yoksa: depoda **Actions** sekmesi → en üstteki yeşil çalışma → sayfanın en altındaki **Artifacts** bölümünden `zyron-android-apk` zip'ini indir, içinden `app-debug.apk` çıkar.

## 3. İlk bağlanma (Süreç sekmesi)
1. Uygulamayı aç; alttaki menüde **Süreç** açıktır.
2. **Root'u kontrol et**'e bas, Magisk'in root isteğini **Ver** ile onayla. Durum "Root hazır" olur.
3. Oyunu aç, ZYRON'a dön, **Yenile**'ye bas.
4. Listeden oyunu seç. Üstte oyunun adı görünür ve uygulama **Arama** sekmesine geçer.

## 4. Değer bulma (en sık kullanım)
Örnek: oyunda altının 1000.
1. **Arama** sekmesi: Arama kipi "Tam değer", Tür "Dword" (tam sayılar), Değer `1000` → **Tara**.
2. Oyunda altını değiştir (ör. 900 oldu). **Daralt** bölümünde Değer `900` → **Daralt**.
3. Birkaç turda 1–3 adres kalır. Sonuçlarda değeri düzenleyip **Yaz**'a bas.
4. Değerin sabit kalması için **❄** (dondur). Dondurma kipi: sabit / yalnız artabilir / yalnız azalabilir.

İpuçları:
- Küsuratlı değer (87.5) için **Float**, çok büyük sayı için **Qword**. Emin değilsen **Auto**.
- Değeri bilmiyorsan Arama kipi **Bulanık**: tara, oyunda değiştir, Daralt'ta "Arttı / Azaldı / Değişti / Değişmedi" seç.
- Aynı yapıda yan yana değerler için **Grup**: `1234567;2345678::64` (pencere 64 bayt).
- Metin: **Metin** kipi. Bayt dizisi: **Bayt** kipi, `5a 59 52 4f`.
- Hız için **Bellek bölgeleri**'nden gereksizleri kapat. Sonuç çıkmazsa bölgeleri genişlet veya türü değiştir.
- Tarama sırasında değer değişiyorsa **Oyunu duraklat** (en çok 5 dk, sonra kendiliğinden sürer).

## 5. Diğer sekmeler
- **Liste:** Sonuçlarda **＋** ile buraya ekle; adı değiştir, düzenle, dondur, dışa/içe aktar. Adresler oyun kapanana kadar geçerlidir.
- **Bellek:** Adres yazıp hex olarak gör, bayta dokun (7 farklı türde okuma), bayt yaz, belleği dosyaya döker.
- **Harita:** Bellek bölgeleri; birine dokununca Bellek sekmesinde açılır.
- **Script:** GG'nin `gg` API'si, **Lua** (5.3'ün büyük bir alt kümesi) veya JavaScript ile. Dili seç, şablondan başla; **Çalıştır / Durdur**. Örnek Lua: `gg.searchNumber('1000', gg.TYPE_DWORD)`, `gg.getResults(10)`, `gg.editAll('99999', gg.TYPE_DWORD)`.
- **Ayarlar:** Listeyi/scriptleri sil, desteklenen ve desteklenmeyenler, hakkında.
- Sonuçta **⋯**: Hex'te aç, işaretçi ara, işaretçiye git, listeden çıkar. Toplu yazma (en çok 2000) ve ofset kaydırma sonuçların altındadır.

## 6. Yüzen pencere (oyunun üstünde)
1. **Süreç** sekmesinde **Yüzen pencere**'ye bas.
2. İlk seferde "Diğer uygulamaların üzerinde göster" iznini aç, geri dön ve tekrar bas. Bildirim izni de istenir.
3. Oyunu aç; ekranda **Z** baloncuğu durur. Dokununca panel açılır, başlığından sürüklenir, — ile küçülür, ✕ ile kapanır.
4. Önce ana uygulamada root'u ve oyunu seçmiş olman gerekir.

## 7. Sorun giderme
| Sorun | Çözüm |
|---|---|
| "Root izni alınamadı" | Telefon root'lu mu? Magisk'te ZYRON'a izin ver, tekrar dene. |
| Süreç listesi boş | Oyunu aç, sonra **Yenile**. Sistem uygulamaları bilerek listelenmez. |
| Değer bulunamadı | Türü değiştir (Dword/Float/Auto), bölgeleri genişlet, değeri ekrandakiyle aynı yaz. |
| Çok fazla sonuç | Oyunda değeri değiştirip **Daralt**'ı tekrarla. |
| Değer geri dönüyor | Oyun değeri başka yerden yeniden yazıyor: ❄ ile dondur. Çevrimiçi oyunda sunucu geri alır. |
| Oyun donuyor | **Oyunu duraklat** açıksa **Oyunu sürdür**'e bas. |
| Yüzen pencere açılmıyor | "Diğer uygulamaların üzerinde göster" ve bildirim izinlerini kontrol et. |

## 8. Bilerek olmayanlar
Hız hilesi, kendini gizleme / anti-cheat atlatma, ASM yama / disassembler yok. Lua kendi yazdığımız bir alt kümedir: 64 bit tamsayı (2^53 üstü), karmaşık `goto`, `string.pack`, `__eq`/`__gc` yok; sayılar `5.0` yerine `5` yazdırılır.

## Rootsuz kip (Pratik oyunu)

Bağlantı ekranındaki **Kip** menüsünden "Rootsuz" seçilir. Android, root olmadan bir uygulamanın başka uygulamanın (oyunun) belleğine erişmesine izin vermez; bu yüzden rootsuz kip gerçek oyunlarda çalışmaz. Çalıştığı yer ZYRON'un kendi kullanıcı alanıdır: **🎮 Pratik oyununu başlat** düğmesi altın (1000), can (100.0), mermi (30) ve hız değerleri olan sahte bir süreç açar. Arama, daraltma, değiştirme, dondurma ve Lua scriptlerini orada güvenle öğrenebilirsin. Gerçek oyunlar için root'lu kip gerekir.
