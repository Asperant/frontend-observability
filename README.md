# CHICEK Frontend Observability

OpenObserve RUM tabanlı, genel amaçlı bir frontend observability platformu.

Mevcut web uygulamalarına minimum müdahaleyle bağlanacak şekilde tasarlanır. Bu proje yeni bir iş uygulaması veya ticari bir SDK değildir. Referans CHICEK projesi (`chicek-observability-platform`) yalnızca lessons-learned kaynağı olarak kullanılır; kod veya dosya kopyalanmaz.

## Mevcut Durum

| Aşama                              | Durum                               |
| ---------------------------------- | ----------------------------------- |
| 0–10                               | ACCEPTED                            |
| 11 (Session Replay)                | SECURITY BLOCKED / CLOSED BY DESIGN |
| 12 (Reverse Proxy Hardening)       | ACCEPTED                            |
| 13 (Sampling/Queue/Retry)          | SECURITY BLOCKED / CLOSED BY DESIGN |
| 14 (Runtime Control & Kill Switch) | ACCEPTED                            |
| 15 (Stream & Data Lifecycle)       | ACCEPTED                            |
| 16 (Dashboard & Sorgular)          | ACCEPTED                            |

- RUM Sessions ve Browser Logs destekleniyor.
- Session Replay desteklenmiyor (bkz. [`docs/session-replay-security-decision.md`](docs/session-replay-security-decision.md)).
- Guaranteed delivery veya native SDK queue purge desteklenmiyor (bkz. [`docs/telemetry-delivery-security-decision.md`](docs/telemetry-delivery-security-decision.md)).
- Reverse proxy hardening tamamlandı (bkz. Aşama 12 bölümü aşağıda).
- Fail-closed runtime kill switch tamamlandı (bkz. [`docs/runtime-control-and-kill-switch.md`](docs/runtime-control-and-kill-switch.md)).
- OpenObserve stream/schema/veri yaşam döngüsü governance'ı tamamlandı (bkz. [`docs/openobserve-stream-schema-lifecycle.md`](docs/openobserve-stream-schema-lifecycle.md)).
- OpenObserve query/dashboard governance'ı (metric/query catalog, starter dashboardlar, audit/export/import/backup) tamamlandı (bkz. [`docs/openobserve-query-dashboard-governance.md`](docs/openobserve-query-dashboard-governance.md)).

## Frontend Bootstrap (Aşama 7)

Bootstrap çekirdeği host uygulamayı bozmadan runtime config yükler, lifecycle durumunu yönetir, consent kararını yalnız memory'de tutar ve gerçek OpenObserve adapter olmadığı durumda fail-closed çalışır. Bu aşamada OpenObserve browser SDK dependency'si yoktur ve telemetry gönderilmez.

Public API yalnız şunlardır:

```js
initializeObservability(options);
setTrackingConsent(consent);
recordAction(name, attributes);
recordError(error, context);
getObservabilityStatus();
shutdownObservability();
```

Runtime config şeması `privacyProfile` alanı için kapalı bir enum tanımlar: `"strict"` ve `"balanced"`. Şemanın kendi açıklaması da dahil olmak üzere, hiçbir profil body, credential, cookie veya session-token capture'a izin vermez — bu iki değer arasında güncel implementasyonda gözlemlenebilir bir davranış farkı yoktur. `mergePrivacyPolicy()` (`packages/browser-observability/src/config/merge-policy.js`) hangi profil verilirse verilsin dahili `privacyMode`'u her zaman `"strict"`e sabitler; yani `"balanced"`, şu an için `"strict"`e yükseltilen bir compatibility alias'tır, gizliliği düşüren ayrı bir davranış değildir. Bu, kabul edilmiş privacy contract'ının (hiçbir profilin hassas veri toplamasına izin verilmemesi) bir ihlali değil, dokümante edilmemiş bir no-op'tur.

## Telemetry Sanitization (Aşama 9)

Browser telemetry, host uygulamadan OpenObserve'a gitmeden önce fail-closed sanitizer katmanından geçer. Query string, URL fragment, user-info, request/response body, headers, cookies, raw console, form/input value, DOM text, local/session storage içeriği, GraphQL variables, nested arbitrary objects ve user identity alanları gönderilmez.

Sanitizer genel PII ve identifier sızıntılarını sabit placeholder'larla redakte eder; credential, private key, authorization veya cookie sinyali taşıyan event'ler düşürülür. URL'ler query/fragment olmadan normalize edilir; default hassas route'lar `/__sensitive__` değerine çevrilir. Action, error, resource, view, vital, long task ve log event'leri SDK `beforeSend` hook'larıyla sanitize edilir. Automatic interaction için SDK'nın DOM text ve attribute tabanlı action name ürettiği contract test ile doğrulanır; bu yüzden non-custom interaction adları `interaction.click`, `interaction.input` veya `interaction.submit` gibi generic adlara yeniden yazılır.

OpenObserve OSS tarafında Enterprise Sensitive Data Redaction'a bağımlı olunmaz. `infrastructure/openobserve/sanitization/` altında version-controlled VRL function/pipeline tanımları bulunur ve `pnpm lab:up` bunları idempotent olarak provision etmeye çalışır. Desteklenen API veya fail-closed pipeline davranışı doğrulanamazsa lab akışı başarısız olur.

Bu katman yalnız genel identifier, secret ve PII koruması sağlar. TCKN/VKN, faktoring alanları, ülke/şirket özel doğrulama algoritmaları, gerçek kullanıcı kimliği, session replay, source maps, dashboard/alert, retention, production sampling, queue/retry, backend tracing ve Collector/gateway kapsam dışıdır.

## Frontend Correlation (Aşama 10)

Frontend telemetry correlation yalnız browser içinde ve consent epoch seviyesinde çalışır. `not-granted → granted` geçişinde memory-only bir epoch üretilir; revoke ve shutdown sırasında temizlenir; regrant yeni epoch oluşturur. Epoch, native OpenObserve session/view/action context'iyle birlikte SDK `beforeSend` aşamasında güvenli `chicek.correlation.*` metadata olarak eklenir. Status ve diagnostics gerçek correlation ID içermez, yalnız capability ve sayaç verir.

RUM view/action/resource/error/long-task/vital event'leri native session ve view ID'leriyle zenginleşir; native action ID varsa korunur. Browser log event'leri önce event/native RUM context'i, sonra desteklenen SDK internal context API'si ile eşleşir; destek yoksa yalnız epoch taşır. Son görülen view/action üzerinden tahmin yapılmaz.

OpenObserve backstop pipeline'ı Stage 9 fail-closed graph'ını korur ve allow condition'dan sonra correlation normalize node'u çalıştırır. Invalid/oversized correlation alanları silinir, güvenli event sadece bu yüzden düşürülmez, direct-ingestion ile gelen correlation metadata trusted sayılmaz. Query şablonları `infrastructure/openobserve/correlation/` altında version-controlled tutulur ve event timeline'ı `_timestamp` sırasıyla sorgular.

Bu aşama frontend-only correlation sağlar. Backend tracing, distributed trace header propagation (`traceparent`, `tracestate`, `baggage`, Datadog trace headers), `x-request-id`/`x-correlation-id`, user/tenant/customer/account kimliği, cross-tab/cross-device correlation ve persistent correlation storage kapsam dışıdır. Gerçek lab correlation gate'leri Chromium ve Firefox için zorunludur; WebKit non-blocking kalır.

Runtime config varsayılan olarak `/observability/config.json` adresinden same-origin, timeout'lu, cache/cookie kullanmadan ve body sınırıyla çekilir. Consent varsayılanı `not-granted` değeridir; bootstrap bunu `localStorage`, `sessionStorage` veya IndexedDB'ye yazmaz.

Lifecycle durumları `idle`, `initializing`, `active`, `disabled`, `degraded`, `shutting-down` ve `shutdown` değerlerinden oluşur. Status snapshot her çağrıda yeni, immutable ve secretsiz bir object döndürür.

## Session Replay — Aşama 11 — Security Blocked

Session Replay is disabled and unsupported with the pinned OpenObserve OSS version.

OpenObserve OSS v0.91.0 replay masking client-side'dır ve sunucu tarafında herhangi bir segment içeriği doğrulaması yapılmaz. Gerçek RUM client token'ıyla browser'ı atlayarak gönderilen, şema açısından geçerli ve doğru şekilde deflate ile sıkıştırılmış kötücül bir replay payload'ı doğrudan kabul edilip `_sessionreplay` stream'ine olduğu gibi yazılabiliyor. RUM token browser-visible bir capability olduğundan (zaten `/rum` ve `/logs` için kabul edilmiş model), client-side masking bir güvenlik sınırı değildir. Bu proje kapsamında custom gateway/Lua/njs sanitizer eklenmesi kabul edilmez. Bu nedenle replay ingestion path allowlist'te açık değildir, replay sampling her zaman `0`'dır ve runtime config şeması replay'i etkinleştirecek hiçbir alan sunmaz. Ayrıntılar için bkz. [`docs/session-replay-security-decision.md`](docs/session-replay-security-decision.md).

## Sampling, Queue, Retry ve Kesinti Davranışı — Aşama 13 — Security Blocked

Stage 13 bir application-level delivery guarantee katmanı (manual queue, sampling gate, retry/backoff wrapper) eklemeden kapatıldı. `recordAction` / `recordError` ve SDK'nın otomatik topladığı event'ler, Stage 13 öncesindeki gibi doğrudan yüklü `@openobserve/browser-rum` / `@openobserve/browser-logs` 0.3.4 native transport'una teslim edilir.

Kaynak koddan doğrulanan native retry queue byte (20 MiB), in-flight request (32) ve byte (80 KiB) sayısı ile backoff tavanı (60 saniye) açısından bounded'dır, ancak maksimum retry count veya maksimum retry age doğrulanamadı. SDK public bir purge API, response hook veya transport hook sunmuyor. Bu nedenle consent revoke ve `shutdownObservability()`, SDK'nın yeni telemetry kabul etmesini durdurabilir ama revoke/shutdown öncesinde SDK'nın kendi retry queue'suna zaten kabul edilmiş telemetry'nin purge edildiğini garanti edemez. Global transport patch, private SDK API kullanımı, ikinci bir native-tarzı queue ve custom gateway; kapsam dışı bırakıldı (bkz. [`docs/telemetry-delivery-security-decision.md`](docs/telemetry-delivery-security-decision.md)). Status/diagnostics hiçbir yerde delivery/storage acknowledgement iddia etmez; `tests/contract/native-delivery-limitation.test.js` bunu kalıcı bir regression guard olarak doğrular.

## Reverse Proxy Hardening (Aşama 12)

`reverse-proxy` yalnız iki exact path'i upstream'e proxy eder: `POST /rum/v1/default/rum` ve `POST /rum/v1/default/logs`. Wildcard org, wildcard version veya genel `/rum/*` route yoktur; query string reddedilir, yalnız POST kabul edilir, Content-Type allowlist ve Content-Encoding reddi uygulanır. Body boyut limitleri RUM için 64 KiB, Logs için 32 KiB'dir; endpoint/IP başına 30 r/s (burst 20) ve global 200 r/s (burst 100) rate limit, IP başına 20 ve global 200 connection limit uygulanır.

Auth, cookie, referer, forwarded ve client-IP header'ları upstream'e iletilmez (`proxy_pass_request_headers off`); internal upstream response header'ları (Set-Cookie, Server, X-Request-Id vb.) browser'a sızmaz. Proxy access logu body, token, query string, tam client IP veya tam User-Agent içermez. OpenObserve management/API plane (arama, kullanıcı, pipeline yönetimi) bu public port üzerinden erişilemez; yönetim arayüzü yalnız loopback'te ayrı bir portta (`127.0.0.1:5080`) sunulur. Firefox'un `Origin: null` davranışı yalnız exact same-origin `Sec-Fetch-*` header kombinasyonunda kabul edilir; bu genel bir CORS izni değildir.

## Sampling, Queue, Retry ve Runtime Control (Aşama 14)

Aşama 13'ün blocked bıraktığı delivery garantisi eksikliğine karşı, telemetriyi canlı olarak durdurabilen fail-closed bir runtime kill switch eklendi. Kontrol dokümanı same-origin `GET/HEAD /observability/control.json` adresinden en fazla 8 KiB ve 3 saniye timeout ile çekilir; query string, yanlış method, yanlış Content-Type ve oversized body reddedilir. Kontrol dokümanı yalnız kill-switch alanlarını etkiler — SDK'nın tam config'i hot-reload edilmez ve control state yalnız memory'de tutulur.

Doğrulama fail-closed'dır: duplicate key, bilinmeyen key, gelecekteki `issuedAt`, TTL/expiry aşımı ve geri giden revision reddedilir. Kill switch page-latched'dır: bir sayfa `active:false` gördükten sonra, aynı sayfa reload olmadan yeniden aktifleşmez. İki katmanlı gate vardır: browser tarafı yeni RUM/log/manual event'leri durdurur; proxy tarafı exact RUM/logs endpoint'lerinde upstream'e hiç gitmeden `410` döner (retry fırtınası oluşturmaz). Kill switch, Aşama 13'te zaten kabul edilmiş olan native SDK retry queue purge garantisi eksikliğini değiştirmez — yalnız yeni telemetriyi durdurur, SDK'nın önceden kabul ettiği event'leri purge ettiğini iddia etmez. Detaylar için bkz. [`docs/runtime-control-and-kill-switch.md`](docs/runtime-control-and-kill-switch.md).

## OpenObserve Stream ve Veri Yaşam Döngüsü (Aşama 15)

Yalnız iki canonical stream yönetilir: `_rumdata` (RUM) ve `_rumlog` (browser logs). `_sessionreplay` veya başka bir replay stream'i, servis/environment başına ayrı stream, veya genel amaçlı custom telemetry stream'i yoktur; Stage 9 sanitization pipeline'ının hedefi (`chicek_rumdata_sanitize_pipeline_v1`/`chicek_rumlog_sanitize_pipeline_v1`) her `lab:streams:verify` çalışmasında bu iki canonical stream'le uyumlu olduğu yeniden doğrulanır.

Her capability iddiası, pinned `v0.91.0` container'ına karşı gerçek API çağrılarıyla doğrulandı — bkz. [`docs/openobserve-v0.91-stream-capabilities.md`](docs/openobserve-v0.91-stream-capabilities.md). Lab desired state: retention 7 gün, max query range 168 saat, UDS/`store_original_data` kapalı, tüm full-text/index/bloom/partition/distinct-value alanları kapalı — production retention `REQUIRED_COMPANY_DECISION`'dır ve hiçbir yerde production default'u gibi davranılmaz. Şema contract'ı native RUM/browser-logs alanlarını katı bir allow-list ile dondurmaz (OpenObserve'un kendi şeması additive-only'dir); required/conditional/controlled/forbidden alan sınıfları ve drift sınıfları (`NO_DRIFT`…`PIPELINE_DESTINATION_DRIFT`) için bkz. [`docs/openobserve-stream-schema-lifecycle.md`](docs/openobserve-stream-schema-lifecycle.md).

```bash
pnpm lab:streams:status     # read-only özet
pnpm lab:streams:dry-run    # normalized diff, write yok
pnpm lab:streams:provision  # yalnız pre-validated non-destructive değişiklik
pnpm lab:streams:verify     # API read-back + settings/schema-type/pipeline drift
pnpm test:stage15:streams   # tam kabul kapısı (disposable lifecycle + Chromium/Firefox canary + management isolation dahil)
```

Canonical streamler destructive işlemlere karşı hard-block'ludur; generic destructive test/lifecycle harness'i yalnız `_chicek_lifecycle_test_<run-id>` prefix'li, tek kullanımlık stream'ler üzerinde çalışır. Bu pinned OSS sürümünde time-range deletion ve deletion job/status API'si yok (yalnız whole-stream delete ve retention/compactor var); user-specific deletion desteklenmiyor; backup Aşama 20'ye bırakıldı. Index/partition için ölçülmüş bir query-profile faydası olmadığından yeni bir index/partition uygulanmadı — karar gerekçesi ve Aşama 16'ya devri için bkz. lifecycle dokümanı.

## OpenObserve Query ve Dashboard Governance (Aşama 16)

12 metrik (`infrastructure/openobserve/analytics/metric-catalog.json`) ve 26 query manifesti (`infrastructure/openobserve/analytics/queries/`) her biri gerçek pinned `v0.91.0` API'sine karşı doğrulandı — bkz. [`docs/openobserve-v0.91-dashboard-capabilities.md`](docs/openobserve-v0.91-dashboard-capabilities.md). Dört starter dashboard (`Frontend Operations`, `Error Analysis`, `Performance and Resources`, `Session Investigation`) ilk kurulum şablonudur; şirket bunları OpenObserve UI'den özgürce değiştirebilir/silebilir — sistem bunları geri yazmaz. Detaylı model, empty-data semantiği, marker tabanlı stable-identity yaklaşımı ve audit kuralları için bkz. [`docs/openobserve-query-dashboard-governance.md`](docs/openobserve-query-dashboard-governance.md).

```bash
pnpm lab:dashboards:install-starters     # eksik starter dashboardları oluşturur, overwrite/delete yapmaz
pnpm lab:dashboards:status               # read-only özet
pnpm lab:dashboards:audit                # read-only risk taraması (tüm folder/dashboardlar)
pnpm lab:dashboards:export               # normalize edilmiş, secretsiz export (repo manifestine yazmaz)
pnpm lab:dashboards:import               # dry-run varsayılan; --apply olmadan yazmaz
pnpm lab:dashboards:backup               # tam, secretsiz snapshot
pnpm lab:dashboards:restore-starters --confirm  # yalnız explicit reset; normal akışta çalışmaz
pnpm test:stage16:dashboards             # tam kabul kapısı
```

Session Replay paneli veya guaranteed-delivery iddiası hiçbir dashboardda yoktur; route bazlı overview breakdown pinned şemada normalize edilmiş bir route alanı olmadığı için desteklenmiyor (detay için governance dokümanına bakın).

## OpenObserve Alert ve Incident Governance (Aşama 17)

Altı starter alert policy (`infrastructure/openobserve/alerts/`) Stage 16 metric/query catalog'larını referanslar: error-session-rate, errors-per-thousand-views, resource-failure-rate, web-vital-degradation, telemetry-freshness ve version-regression. Production starter alert'leri disabled gelir; threshold, destination, owner, expected traffic ve escalation kararları `REQUIRED_COMPANY_DECISION` olarak kalır. Capability sonucu için bkz. [`docs/openobserve-v0.91-alert-capabilities.md`](docs/openobserve-v0.91-alert-capabilities.md), yönetim modeli için bkz. [`docs/openobserve-alert-incident-governance.md`](docs/openobserve-alert-incident-governance.md).

```bash
pnpm lab:alerts:install-starters
pnpm lab:alerts:status
pnpm lab:alerts:audit
pnpm lab:alerts:export
pnpm lab:alerts:import
pnpm lab:alerts:backup
pnpm lab:alerts:restore-starters --confirm
pnpm lab:alerts:test-notification
pnpm test:stage17:alerts
```

Local mock notification sink external network kullanmaz; OpenObserve loopback üstünden bounded aggregate body alır. Native incident list endpoint'i var ama create/stats lifecycle desteklenmedi; silence/maintenance lifecycle güvenle doğrulanmadı. Bu nedenle Stage 17 incident'i notification + dashboard + runbook metadata sınırında tutar, şirket ticket/on-call entegrasyonunu Aşama 21'e bırakır.

## OpenObserve Entegrasyonu (Aşama 8)

`src/adapter/openobserve/` altındaki adapter, runtime config `enabled:true` olduğunda gerçek `@openobserve/browser-rum` + `@openobserve/browser-logs` SDK'larını (exact-pinned) tarayıcıda dinamik olarak yükler; host uygulamaya ham SDK referansı hiçbir zaman sızmaz.

**Vendor SDK lifecycle kısıtı:** Vendor SDK, sayfa boyunca gerçek bir singleton'dır ve destroy/dispose API'si yoktur — ikinci bir `init()` çağrısı SDK içinde sessiz bir no-op'tur. Bu paket bunu, `shutdown()`'ın SDK'yı gerçekten yok etmiş gibi göstermeden, dürüstçe modelliyor:

- Bir bağlantı kimliği fingerprint'i (`site`, `organizationIdentifier`, `applicationId`, `clientToken`'ın hash'i, `service`, `environment`, `version`) hesaplanır; token'ın kendisi hiçbir zaman saklanmaz, yalnızca bu hash tutulur.
- İlk `initialize()` gerçek SDK `init()`'ini bir kez çağırır. `shutdown()` consent'i `not-granted` yapar ve session'ı kapatır, ancak SDK singleton'ını (ve fingerprint'i) bozmadan bırakır.
- Aynı fingerprint ile bir sonraki `initialize()` (gerçek shutdown→reinitialize akışı) SDK `init()`'ini **tekrar çağırmaz**; yalnız consent'i yeniden uygular ve SDK kendi session'ını bir sonraki kabul edilen event'te yeniden başlatır.
- Farklı bir fingerprint ile reinitialize denemesi fail-closed reddedilir (`reasonCode: SDK_REINITIALIZATION_UNSUPPORTED`); zaten çalışan SDK singleton'ının config/session/consent durumu hiç dokunulmadan kalır.
- Adapter capability'si bu modeli `lifecycleModel: "singleton-resume"` olarak bildirir (sabit, adapter'a özgü bir özelliktir).

**Tarayıcı kapsamı:** Zorunlu gerçek entegrasyon kapıları yalnızca **Chromium** ve **Firefox**'tur (bkz. `playwright-stage8.config.js`, `tests/e2e/stage8-lab.spec.js`, `scripts/lab/verify-stage8-openobserve.mjs`). WebKit/Safari bu aşamanın kabul kapısı değildir; mevcut WebKit smoke testi (`tests/e2e/stage8-adapter.spec.js`, plain HTTP, lab dışı) korunur ama bu self-signed HTTPS lab'ına karşı yeni bir WebKit/OpenObserve E2E veya HTTP forwarder eklenmez — bilinen bir Playwright/WebKit-Linux kısıtı nedeniyle non-blocking kabul edilir.

## Docker Referans Laboratuvarı (Aşama 6)

Güvenli, tekrarlanabilir bir Docker Compose laboratuvarı: `demo-frontend` ve `mock-api` fixture'larını, gerçek stable OpenObserve OSS'i ve bunların önündeki tek giriş noktası `reverse-proxy`'yi bir araya getirir. Şirket backend'i, Collector/gateway veya alternatif dashboard yoktur; bu aşamada OpenObserve'un kendi web arayüzü kullanılır ve gerçek RUM/browser-log gönderimi henüz başlatılmaz.

Servisler: `reverse-proxy`, `demo-frontend`, `mock-api`, `openobserve` — bkz. `infrastructure/docker/compose.yaml` ve `infrastructure/docker/images.lock.json`.

```bash
pnpm lab:init     # runtime secret + TLS sertifikası + runtime config üretir (.runtime/, git'e girmez)
pnpm lab:up       # image'ları build eder, stack'i başlatır, healthy olmasını bekler, sanitization backstop provision eder
pnpm lab:verify   # Aşama 6 kabul kapısı: güvenlik, TLS, kalıcılık, failure-isolation
pnpm lab:status   # container/health/port/izin durumu
pnpm lab:logs     # secret redaction uygulanmış loglar
pnpm lab:down     # container/network kaldırır; openobserve-data volume ve .runtime/ korunur
pnpm lab:purge --yes   # container/network/volume ve .runtime/ içeriğini tamamen siler
```

- Demo: `https://localhost:8443` (yerel lab CA sistem trust store'una kurulmaz; tarayıcıda güven uyarısı beklenir)
- OpenObserve yönetim arayüzü: `http://localhost:5080`
- `pnpm lab:verify` Docker'a bağımlıdır ve `pnpm verify`'dan tamamen ayrıdır; `pnpm verify` hâlâ Docker gerektirmez.

## Teknoloji

JavaScript (ESM, TypeScript yok) · Node.js LTS · pnpm workspace · Vite · React · Node.js built-in HTTP · Vitest · Playwright · ESLint (flat config) · Prettier · JSON Schema.

## Workspace Yapısı

```text
apps/
  demo-frontend/          Test fixture React uygulaması (üretim ürünü değildir)
  mock-api/                Node.js built-in HTTP ile deterministik mock API
packages/
  browser-observability/   Ana ürün: @chicek/browser-observability paketi
  contracts/                JSON Schema sözleşmeleri ve validator'lar
tests/
  contract/ consumer/ e2e/ security/ fixtures/
scripts/
  verify/ security/ build/
.github/workflows/
```

Ana ürün `packages/browser-observability` paketidir. `apps/demo-frontend` ve `apps/mock-api` yalnızca bu paketi test etmek için kullanılan fixture'lardır; gerçek şirket entegrasyonu veya OpenObserve dashboard alternatifi değildir.

## Temel Komutlar

```bash
pnpm install --frozen-lockfile
pnpm dev              # demo frontend
pnpm build            # browser-observability + demo-frontend
pnpm test             # unit + contract
pnpm test:coverage
pnpm test:consumer    # pack → install → build → runtime smoke
pnpm test:e2e         # Playwright (chromium/firefox/webkit)
pnpm lint
pnpm format:check
pnpm security:local
pnpm sbom
pnpm verify           # tüm doğrulama zincirini sırasıyla çalıştırır
```

## Geliştirme Yöntemi

1. Her aşama önce kullanıcı ve mimari denetçiyle konuşulur.
2. Ardından IDE yapay zekâsına tek kapsamlı görev verilir.
3. Çıktı denetlenmeden sonraki aşamaya geçilmez.
