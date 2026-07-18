# CHICEK Frontend Observability

OpenObserve RUM tabanlı, genel amaçlı bir frontend observability platformu.

Mevcut web uygulamalarına minimum müdahaleyle bağlanacak şekilde tasarlanır. Bu proje yeni bir iş uygulaması veya ticari bir SDK değildir. Referans CHICEK projesi (`chicek-observability-platform`) yalnızca lessons-learned kaynağı olarak kullanılır; kod veya dosya kopyalanmaz.

## Mevcut Durum

`Stage 6 Implemented — Review Pending`

## Docker Referans Laboratuvarı (Aşama 6)

Güvenli, tekrarlanabilir bir Docker Compose laboratuvarı: `demo-frontend` ve `mock-api` fixture'larını, gerçek stable OpenObserve OSS'i ve bunların önündeki tek giriş noktası `reverse-proxy`'yi bir araya getirir. Şirket backend'i, Collector/gateway veya alternatif dashboard yoktur; bu aşamada OpenObserve'un kendi web arayüzü kullanılır ve gerçek RUM/browser-log gönderimi henüz başlatılmaz.

Servisler: `reverse-proxy`, `demo-frontend`, `mock-api`, `openobserve` — bkz. `infrastructure/docker/compose.yaml` ve `infrastructure/docker/images.lock.json`.

```bash
pnpm lab:init     # runtime secret + TLS sertifikası + runtime config üretir (.runtime/, git'e girmez)
pnpm lab:up       # image'ları build eder, stack'i başlatır, healthy olmasını bekler
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
