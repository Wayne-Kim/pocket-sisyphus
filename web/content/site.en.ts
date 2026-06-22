/**
 * 사이트 카피 SSOT (영어). 레이아웃과 분리해 둔다 — i18n 시 `site.ko.ts` 등
 * 같은 모양의 객체를 추가하고 locale 로 고르면 된다(현재는 en 단일).
 *
 * 주의: «외부 서버 0 · 메인테이너 인프라 0» 은 *Pocket Sisyphus 앱(iOS + Mac)* 의
 * 성질이다 — 이 소개 «웹사이트» 의 호스팅과는 무관하다(웹은 Vercel 에 올린다).
 * 단, 앱은 «공짜» 가 아니라 freemium 이다: 기본 무료 + 선택형 Pro(구독/평생 이용권)로
 * 고급 기능 해제. «유료 0 / No subscription» 으로 적지 말 것 — 인프라 비용 0(메인테이너가
 * 운영하는 서버·SaaS 없음)과 제품 가격(free base + optional Pro)은 «분리해서» 서술한다.
 */
/**
 * 외부 목적지 SSOT — 같은 URL 이 hero / install / footer 에 흩어지면 한 곳만 고쳐
 * 나머지가 어긋나는 «깨진 링크» 사고가 난다. 모든 카피는 이 맵을 통해서만 외부로 나간다.
 * discussions 는 b85960b(iOS 설정 「커뮤니티」)이 가리키는 GitHub Discussions 와 동일 목적지.
 */
const URLS = {
  appStore: "https://apps.apple.com/app/pocket-sisyphus/id6772206998",
  repo: "https://github.com/Wayne-Kim/pocket-sisyphus",
  discussions: "https://github.com/Wayne-Kim/pocket-sisyphus/discussions",
  // Android 「관심 표명」 경로 — 백엔드·폼·DB 없이 신호를 모으는 한 곳. discussions 와
  // 같은 GitHub Discussions(메인테이너 인프라 0)이며, android 로 필터해 사람들이 👍/댓글로
  // 「얼마나 원하는지」를 남기게 한다. 전용 스레드를 핀하면 이 한 줄만 그 URL 로 교체하면 됨.
  discussionsAndroid:
    "https://github.com/Wayne-Kim/pocket-sisyphus/discussions?discussions_q=android",
  installShRaw:
    "https://raw.githubusercontent.com/Wayne-Kim/pocket-sisyphus/main/install.sh",
  installShBlob:
    "https://github.com/Wayne-Kim/pocket-sisyphus/blob/main/install.sh",
} as const;

export const site = {
  meta: {
    title: "Pocket Sisyphus — coding agents in your pocket",
    description:
      "Drive Claude Code, Codex, Antigravity, Copilot & OpenCode running on your Mac — securely, from your iPhone. Dual-channel SSH-first with Tor fallback, or a private same-Wi-Fi-only mode. The app keeps zero servers of its own.",
    url: "https://wayne-kim.github.io/pocket-sisyphus",
  },

  brand: {
    name: "Pocket Sisyphus",
    logo: "/logo.png",
  },

  hero: {
    // 정체성 레이어(1줄) — 능력 카피(title/tagline) «위» 에 얹는다. README 핵심 원칙의
    // «1인 군단» 서사(README:45)를 hero 첫 줄로 끌어올려, 능력(폰에서 에이전트 제어) 위에
    // 정체성(혼자서 다 만들고 굴린다)을 세운다. 자급의 근거는 아래 principles 에서 묶는다.
    eyebrow: "One person, a whole legion — build and run a service solo.",
    title: "Your coding agents, in your pocket",
    tagline:
      "Drive Claude Code, Codex, Antigravity, Copilot & OpenCode on your Mac — securely, from your phone.",
    // 1차 = App Store 다운로드(외부), 2차 = 페어가 되는 Mac 앱 설치 허브(앵커).
    primaryCta: { label: "Download on the App Store", href: URLS.appStore },
    secondaryCta: { label: "Get the Mac app", href: "#install" },
    pills: ["In your pocket", "Anywhere, anytime", "Paired devices only", "Never blocked", "Free to start"],
  },

  /** 앱(iOS+Mac)의 핵심 원칙 — 웹사이트가 아니라 앱의 성질임을 분명히. */
  principles: {
    heading: "No servers of ours. No middleman. No cloud hop.",
    subheading:
      "These guarantees describe the Pocket Sisyphus app on your iPhone and Mac — your traffic never touches infrastructure we run. That self-sufficiency is the point: with nothing of ours in the path and nothing to rent, one person can keep building and running their service on it — even if we disappear.",
    items: [
      {
        id: "zero-servers",
        title: "Zero servers of ours",
        body: "No maintainer backend. The app uses only the Tor distributed network and a public-IP echo (ipify) to find your Mac.",
      },
      {
        id: "zero-cost",
        title: "Zero paid infrastructure",
        body: "No domains, certificates, relays, or SaaS in the data path — we run nothing to bill you for. (The app itself is free, with optional Pro; see pricing below.)",
      },
      {
        id: "ssh-first",
        title: "SSH-first data plane",
        body: "On a consumer router with IPv6 / UPnP, your phone reaches your Mac over direct SSH at 10–50 ms latency.",
      },
      {
        id: "tor-fallback",
        title: "Tor fallback, zero-config",
        body: "Behind CGNAT or a locked-down router, the app falls back to a Tor hidden service automatically — nothing to set up.",
      },
      {
        id: "lan-only",
        title: "Same-Wi-Fi-only mode",
        body: "Prefer to never leave your network? Flip on LAN-only mode and the app reaches your Mac only over your local Wi-Fi via a private address — no Tor, no public IP, no outside hop. Choose it on first launch; off-network it fails closed, so nothing leaves your LAN.",
      },
      {
        id: "crypto-identity",
        title: "Cryptographic identity, twice",
        body: "An .onion v3 address (Ed25519) plus the SSH host-key fingerprint, both pinned in the pairing QR.",
      },
      {
        id: "paired-only",
        title: "Only your paired devices get in",
        body: "Pairing mints a unique SSH key — added to your Mac's allow-list — plus a per-device token, handed over once by QR. No passwords, no door left open to anyone else. Lost your phone? Rotate in a tap and the old device is locked out instantly.",
      },
    ],
  },

  agents: {
    heading: "Bring your own agent",
    subheading:
      "Pick the agent per session. For the coding CLIs the daemon spawns the binary you already have installed — inference goes straight to each provider, never relayed through us. A built-in Terminal and an on-device Qwen Code (local LLM) round out the list (both Pro).",
    items: [
      { id: "claude-code", name: "Claude Code", vendor: "Anthropic" },
      { id: "antigravity", name: "Google Antigravity", vendor: "Google · agy" },
      { id: "codex", name: "OpenAI Codex", vendor: "OpenAI" },
      { id: "copilot", name: "GitHub Copilot CLI", vendor: "GitHub" },
      { id: "opencode", name: "OpenCode", vendor: "Open-source · OpenAI-compatible" },
      { id: "terminal", name: "Terminal", vendor: "Built-in shell · Pro" },
      { id: "local-llm", name: "Qwen Code", vendor: "On-device local LLM · Pro" },
    ],
  },

  architecture: {
    heading: "One secure path, two channels",
    subheading:
      "Happy-eyeballs: your phone races a direct SSH connection against Tor and takes whichever answers first. No cloud hop either way.",
    phone: {
      title: "iPhone — Pocket Sisyphus.app",
      lines: [
        "Tor.framework (in-process, lazy)",
        "Citadel SSH client (swift-nio-ssh)",
        "ConnectionManager — races direct / onion",
      ],
    },
    channelLabels: ["Direct SSH", "Tor fallback"],
    mac: {
      title: "Mac — menu-bar app",
      lines: [
        "tor hidden service (SSH-over-Tor)",
        "embedded sshd (direct-tcpip)",
        "daemon (Node + Hono + WS) → PTY",
        "spawns claude / agy / codex / copilot / shell / local LLM",
      ],
    },
  },

  features: {
    heading: "Built for steering, not just watching",
    items: [
      // PO 루프(백로그 탭) — 이 앱의 «가장 다른 점». 카피는 두 SSOT 와 정합을 맞춘다:
      //   ① 스토어 4_backlog 밴드(store v2.20.0 config.py): "An AI product owner for your
      //      backlog" / "Scored by impact, effort & evidence".
      //   ② iOS GuideContent.backlog: 레포 신호 수집(이슈·TODO·문서·변경) → 기회 브리프
      //      (문제·근거·스코프·스펙) → 폰에서 승인·보류·기각. 백로그 탭이 주황 = 프로(고급).
      // 포지셔닝: 경쟁 «폰에서 에이전트 보기» 와 달리 «폰에서 백로그를 운영» — heading 의
      // «steering, not just watching» 과 한 줄로 맞물린다. pro:true → 주황 Pro 배지(노랑 아님).
      {
        id: "backlog",
        icon: "🗂️",
        title: "An AI product owner for your backlog",
        body: "Instead of spelling out every task, an agent combs your repo — issues, TODOs, docs, recent changes — and posts opportunity briefs scored by impact, effort, and evidence. Each lays out the problem, evidence, scope, and spec, so you approve, hold, or reject right from your phone. You don't just watch agents — you run the backlog.",
        pro: true,
      },
      {
        id: "remote-sessions",
        icon: "📱",
        title: "Run sessions anywhere",
        body: "Kick off, steer, and review agent sessions from your iPhone over LTE / 5G on a secure channel.",
      },
      {
        id: "live-preview",
        icon: "🔭",
        title: "Live-preview your dev server",
        body: "See your Mac's local web app render on your phone. Mark up a capture and the app attaches the exact DOM element you pointed at.",
        pro: true,
      },
      {
        id: "workflows",
        icon: "🧩",
        title: "Visual multi-agent workflows",
        body: "Chain start · task · end nodes on a canvas and let them run on a schedule.",
        pro: true,
      },
      {
        id: "voice",
        icon: "🎙️",
        title: "On-device voice input",
        body: "Dictate prompts with on-device Whisper (CoreML). No speech ever leaves your phone.",
      },
    ],
  },

  install: {
    heading: "Install in one line",
    subheading:
      "macOS ships with curl — that's the only prerequisite. The script grabs the latest notarized DMG and drops the app into /Applications.",
    command: `curl -fsSL ${URLS.installShRaw} | bash`,
    copyLabel: "Copy",
    copiedLabel: "Copied!",
    note: "That's the Mac app. The iPhone app is on the App Store — both share one marketing version so you always run a compatible pair.",
    appStore: {
      label: "Download on the App Store",
      sublabel: "iPhone app",
      href: URLS.appStore,
    },
    // 안드로이드 — 「준비 중」 + 관심 표명 한 줄. 실제 앱 빌드/배포는 비-목표(브리프 스코프).
    // 「Coming soon」 은 경고도 프로도 아닌 중립 상태 → 토큰 warning/pro 차용 금지(중립 muted 칩).
    android: {
      label: "Android",
      status: "Coming soon",
      note: "An Android app isn't out yet. Want it sooner? React or comment on the Android thread — that's how we gauge demand and set priority.",
      cta: { label: "Tell us you want Android", href: URLS.discussionsAndroid },
    },
    repoLabel: "View install.sh on GitHub",
    repoHref: URLS.installShBlob,
  },

  cost: {
    heading: "What it costs",
    subheading:
      "The app is free to install and use. Optional Pro unlocks the advanced features; agent inference is billed by whichever AI provider you run — never relayed through us, never marked up.",
    rows: [
      { item: "Pocket Sisyphus app (iPhone + Mac)", price: "Free" },
      {
        item: "Pro — workflows, scheduling, Terminal & Local-LLM agents, live preview, monitor mirror",
        price: "Optional · subscription or one-time, on the App Store",
      },
      {
        item: "Agent usage (Claude · Codex · Antigravity · Copilot · OpenCode)",
        price: "Billed by each provider — never through us",
      },
    ],
    total: { item: "To get started", price: "Free" },
  },

  footer: {
    tagline: "Coding agents in your pocket.",
    // 2차 CTA 군 — App Store(다운로드) · GitHub(소스) · Discussions(커뮤니티, b85960b 와 동일).
    links: [
      { label: "App Store", href: URLS.appStore },
      { label: "GitHub", href: URLS.repo },
      { label: "Discussions", href: URLS.discussions },
    ],
    note: "© 2026 Pocket Sisyphus",
  },
} as const;

export type Site = typeof site;
