# Roadmap

Bu roadmap, test sonuçları ve yeni bulgularla ortak karar sonucu değiştirilebilir; sabit bir sözleşme değildir.

0. Proje kapsamı ve başlangıç
1. Eski CHICEK projesinden çıkarılacak dersler
2. Hedef mimari ve entegrasyon sınırları
3. Telemetry taksonomisi ve şemalar
4. Threat model ve genel privacy politikası
5. Mühendislik altyapısı
6. Docker referans laboratuvarı
7. Frontend bootstrap entegrasyonu
8. OpenObserve RUM ve browser logs
9. Sanitization ve veri doğrulama
10. Trace ve korelasyon
11. Session replay güvenlik profili — **Security Blocked**: Session Replay is disabled and unsupported with the pinned OpenObserve OSS version (bkz. `docs/session-replay-security-decision.md`)
12. Gateway ve Collector pipeline
13. Sampling, queue, retry ve kesinti davranışı — **Security Blocked**: OpenObserve browser SDK 0.3.4'ün native retry queue'su consent revoke/shutdown sırasında purge edilemiyor (bkz. `docs/telemetry-delivery-security-decision.md`)
14. Runtime config ve kill switch
15. OpenObserve stream ve veri yaşam döngüsü — bkz. `docs/openobserve-stream-schema-lifecycle.md`
16. Dashboard ve sorgular — bkz. `docs/openobserve-query-dashboard-governance.md`
17. Alarm ve olay müdahale modeli — bkz. `docs/openobserve-alert-incident-governance.md`; native silence/incident lifecycle sınırları için `docs/openobserve-v0.91-alert-capabilities.md`
18. Güvenlik doğrulaması
19. Performans ve dayanıklılık doğrulaması
20. Upgrade, rollback ve veri koruma
21. Şirket entegrasyon paketi
22. Nihai ürün kabulü
