# web — Pocket Sisyphus 소개 사이트

Pocket Sisyphus 의 **정적 소개 페이지(랜딩)**. Next.js 정적 추출(`output: "export"`)로 만들어
**GitHub Pages** 에 배포하는, 동적 백엔드·DB·로그인 없는 마케팅 한 장짜리 페이지다.

> 커뮤니티는 웹에서 만들지 않고 **GitHub Discussions** 외부 링크로 보낸다(iOS 설정의
> 「커뮤니티」와 동일 목적지). 「외부 인프라 0」 원칙은 사용자가 직접 돌리는 두 앱(iOS · Mac)의
> 성질이며, 이 소개 사이트는 그 적용 대상이 아니다.

## 구조

- `app/` — Next.js App Router. `page.tsx` 가 섹션 컴포넌트를 조립하는 단일 랜딩.
- `components/` — 한 섹션 = 한 파일 (Hero · Principles · Architecture · Agents · Features · Install · Cost · Footer).
- `content/` — 카피 SSOT (`site.en.ts`). 레이아웃과 분리 — i18n 시 `site.<locale>.ts` 추가.
- `lib/tokens.ts` — 디자인 토큰.

## 개발

```bash
pnpm install
pnpm dev        # http://localhost:3000
pnpm gen:og     # public/og.png(1200×630 공유 카드) 재생성 — 카피/브랜드 바뀔 때만
```

빌드·배포 절차는 메인테이너 전용이다.
