import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { site } from "@/content";
import DevLocator from "@/components/DevLocator";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// 배포 origin — GitHub Pages 워크플로우가 NEXT_PUBLIC_SITE_URL 로 주입한다(미설정 시 정식 도메인).
// basePath(프로젝트 페이지 하위경로)는 next.config 가 og:image 경로에 자동 반영한다.
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? site.meta.url;
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const canonicalUrl = `${siteUrl}${basePath}/`;

export const metadata: Metadata = {
  // basePath 까지 포함한 base — 프로젝트 페이지 하위경로에서 og:image 절대 URL 이 맞춰진다.
  metadataBase: new URL(canonicalUrl),
  title: site.meta.title,
  description: site.meta.description,
  // OG 카드는 정적 PNG(public/og.png, `pnpm gen:og` 로 재생성). 상대 URL("og.png")이라
  // metadataBase(=canonical, basePath 포함)에 붙어 하위경로에서도 절대 URL 이 맞고,
  // «.png» 확장자라 GitHub Pages 가 image/png 로 서빙한다(라우트 핸들러는 octet-stream 이라 제외).
  openGraph: {
    title: site.meta.title,
    description: site.meta.description,
    url: canonicalUrl,
    siteName: site.brand.name,
    type: "website",
    images: [
      { url: "og.png", width: 1200, height: 630, alt: site.meta.title, type: "image/png" },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: site.meta.title,
    description: site.meta.description,
    images: ["og.png"],
  },
  // 파비콘은 app/favicon.ico 를 Next 가 자동 인식한다(basePath 자동 반영). 수동 "/logo.png"
  // 지정은 하위경로에서 basePath 가 안 붙어 404 → 제거.
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full font-sans">
        {children}
        {/* 개발 모드에서만 소스 추적 보조(LocatorJS) 마운트 */}
        {process.env.NODE_ENV === "development" && <DevLocator />}
      </body>
    </html>
  );
}
