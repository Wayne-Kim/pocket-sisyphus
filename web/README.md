**English** · [한국어](README.ko.md)

# web — Pocket Sisyphus marketing site

Pocket Sisyphus's **static marketing page (landing)**. A single marketing page with no
dynamic backend, DB, or login — built with Next.js static export (`output: "export"`) and
deployed to **GitHub Pages**.

> The community isn't built on the web — it links out to **GitHub Discussions** (the same
> destination as «Community» in the iOS settings). The «zero external infrastructure»
> principle is a property of the two user-run apps (iOS · Mac); this marketing site is not
> subject to it.

## Structure

- `app/` — Next.js App Router. `page.tsx` is a single landing that assembles the section components.
- `components/` — one section = one file (Hero · Principles · Architecture · Agents · Features · Install · Cost · Footer).
- `content/` — the copy SSOT (`site.en.ts`). Separated from layout — for i18n, add `site.<locale>.ts`.
- `lib/tokens.ts` — design tokens.

## Development

```bash
pnpm install
pnpm dev        # http://localhost:3000
pnpm gen:og     # regenerate public/og.png (1200×630 share card) — only when copy/brand changes
```

Build and deployment procedures are maintainer-only.
