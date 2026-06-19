// public/og.png (1200×630 공유 카드) 재생성기.
//
// 왜 라우트(app/opengraph-image.tsx)가 아니라 «정적 PNG» 인가:
// GitHub Pages 는 확장자로 MIME 을 정한다. Next 메타데이터 이미지 라우트는 확장자 없는
// 파일(out/opengraph-image)로 떨어져 application/octet-stream 으로 서빙 → 일부 SNS 스크래퍼가
// 카드를 못 그린다. 그래서 빌드와 분리된 이 스크립트로 «.png» 를 만들어 커밋하고
// metadata 가 그 파일을 가리킨다(확장자 → image/png 보장).
//
// 실행:  pnpm gen:og   (카피/브랜드 변경 시 다시 돌려 og.png 갱신 + 커밋)
// 평문 node 라 번들러 조건이 없어 "next/og" 베어 specifier 는 안 풀린다 → 실제 파일 경로로.
import { ImageResponse } from "next/og.js";
import { createElement as h } from "react";
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// lib/tokens.ts 색 정책 미러(브랜드 보라). 스크립트라 TS import 대신 값 인라인.
const C = {
  ink: "#ece4fc",
  muted: "#b9a9e0",
  base: "#08060f",
  purpleLt: "#966de2",
  purpleMd: "#6c3fa8",
  accentSoft: "#a77cff",
};
// content/site.en.ts 카피와 동일.
const TEXT = {
  brand: "Pocket Sisyphus",
  title: "Your coding agents, in your pocket",
  tagline:
    "Drive Claude Code, Codex & Antigravity on your Mac — securely, from your phone.",
  chips: ["SSH-first", "Tor fallback", "Free to start"],
};

const logo = await readFile(join(root, "public", "logo.png"));
const logoSrc = `data:image/png;base64,${logo.toString("base64")}`;

const tree = h(
  "div",
  {
    style: {
      width: "100%",
      height: "100%",
      display: "flex",
      flexDirection: "column",
      justifyContent: "space-between",
      padding: "72px 80px",
      color: C.ink,
      backgroundColor: C.base,
      backgroundImage: `radial-gradient(120% 90% at 12% 0%, ${C.purpleLt} 0%, ${C.purpleMd} 36%, #1b0f33 70%, ${C.base} 100%)`,
      fontFamily: "sans-serif",
    },
  },
  h(
    "div",
    { style: { display: "flex", alignItems: "center", gap: 24 } },
    h("img", { src: logoSrc, width: 84, height: 84, style: { borderRadius: 20 } }),
    h("span", { style: { fontSize: 40, fontWeight: 700, opacity: 0.96 } }, TEXT.brand),
  ),
  h(
    "div",
    { style: { display: "flex", flexDirection: "column", gap: 24 } },
    h(
      "span",
      {
        style: {
          fontSize: 78,
          fontWeight: 800,
          lineHeight: 1.05,
          letterSpacing: "-0.02em",
          maxWidth: 920,
        },
      },
      TEXT.title,
    ),
    h(
      "span",
      { style: { fontSize: 34, fontWeight: 400, color: C.muted, maxWidth: 940 } },
      TEXT.tagline,
    ),
  ),
  h(
    "div",
    { style: { display: "flex", alignItems: "center", gap: 16 } },
    ...TEXT.chips.map((chip) =>
      h(
        "span",
        {
          key: chip,
          style: {
            display: "flex",
            fontSize: 26,
            fontWeight: 500,
            color: C.ink,
            border: `1px solid ${C.accentSoft}`,
            borderRadius: 999,
            padding: "10px 24px",
            opacity: 0.9,
          },
        },
        chip,
      ),
    ),
  ),
);

const res = new ImageResponse(tree, { width: 1200, height: 630 });
const buf = Buffer.from(await res.arrayBuffer());
await writeFile(join(root, "public", "og.png"), buf);
console.log(`og.png written (${buf.length} bytes, 1200×630)`);
