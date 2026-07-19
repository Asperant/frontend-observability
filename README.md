# CHICEK Frontend Observability

OpenObserve RUM tabanlı, genel amaçlı bir frontend observability platformu.

Mevcut web uygulamalarına minimum müdahaleyle bağlanacak şekilde tasarlanır. Bu proje yeni bir iş uygulaması veya ticari bir SDK değildir. Referans CHICEK projesi (`chicek-observability-platform`) yalnızca lessons-learned kaynağı olarak kullanılır; kod veya dosya kopyalanmaz.

## Mevcut Durum

`Aşama 10 Implemented — Verification Pending`

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
