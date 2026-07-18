# Proje Bağlamı

## Amaç

OpenObserve tabanlı, domain bağımsız ve üretim kalitesinde bir frontend observability platformu geliştirmek.

## Kapsam

- OpenObserve RUM
- Browser logs
- Hata, performans, navigation, session ve network telemetry
- Trace korelasyonu
- Session replay için varsayılan kapalı güvenli altyapı
- Sampling, runtime config ve kill switch
- Collector/gateway veri hattı
- Docker referans laboratuvarı
- OpenObserve stream, dashboard ve alarm varlıkları
- Güvenlik, performans ve kesinti testleri

## Kapsam Dışı

- Gerçek şirket frontend entegrasyonu
- Şirkete özgü domain ve business event kuralları
- TLS, DNS, firewall, IAM/SSO, secret manager ve production deployment

## Değişmez İlkeler

1. Observability ana uygulamayı bozamaz.
2. Authorization, cookie ve session token toplanamaz.
3. Request/response body varsayılan olarak toplanamaz.
4. Gerçek secret repoda veya frontend bundle'da bulunamaz.
5. Session replay varsayılan kapalıdır.
6. Queue, retry, payload, CPU ve bellek kullanımı bounded olmalıdır.
7. OpenObserve/Collector/gateway kesintisi ana uygulamayı etkilememelidir.
8. Referans sistem repo içinden yeniden üretilebilmelidir.
9. Gereksiz servis, soyutlama veya genel amaçlı SDK geliştirilemez.
10. Eski CHICEK kodu doğrudan kopyalanamaz.

## Aşama Kabul Yöntemi

- IDE çıktısı kod, test, komut, diff ve riskleriyle raporlanır.
- Denetim sonucu `ACCEPTED` veya `REWORK` olur.
- `ACCEPTED` olmadan sonraki aşamaya geçilmez.
