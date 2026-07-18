# CHICEK Frontend Observability

OpenObserve RUM tabanlı, genel amaçlı bir frontend observability platformu.

Mevcut web uygulamalarına minimum müdahaleyle bağlanacak şekilde tasarlanır. Bu proje yeni bir iş uygulaması veya ticari bir SDK değildir. Referans CHICEK projesi (`chicek-observability-platform`) yalnızca lessons-learned kaynağı olarak kullanılır; kod veya dosya kopyalanmaz.

## Mevcut Durum

`Stage 5 Implemented — Review Pending`

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
