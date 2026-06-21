/**
 * 차별화 카피 SSOT — «공식이 공짜인데 이게 왜 필요?» 에 30초 안에 답하는 두 블록:
 *   1) edge      = «우리만의 것» 3축 (헤드라인급)
 *   2) comparison = 공식 원격 제어·릴레이 앱 대비 정직한 비교표
 *
 * 로컬라이즈: 이 모듈의 «새» 문자열은 레포 지원 10개 로케일 전부 번역돼 있다
 * (ar/en/es/fr/hi/ja/ko/pt-BR/ru/zh-Hans, 소스 ko). 단, web 은 아직 locale 라우팅이
 * 없어 라이브 렌더는 영어(`DEFAULT_LOCALE = "en"`, layout 의 lang="en" 과 일치).
 * 번역 데이터는 `getDifferentiators(locale)` 로 이미 «선택 가능» 하게 준비돼 있어,
 * 훗날 i18n 을 켜면 라우팅만 붙이면 된다 (site.en.ts 헤더의 i18n 계획과 동일 궤도).
 *
 * 사실성: comparison 의 각 셀은 «전송 경로 · 지원 에이전트» 같은 검증 가능한 사실만 담는다
 * (전송: README/ARCHITECTURE §1–4·§9–11, 에이전트: AgentKind/agent index, PO 루프: §14).
 * 경쟁사(공식 원격 제어·릴레이 앱)는 과장·비방 없이 «아키텍처 범주» 수준으로만 서술하고,
 * Tor 폴백 지연 같은 트레이드오프는 footnote 에 그대로 밝힌다.
 *
 * 구조 분리: id·pro 같은 «로케일 무관» 메타는 AXIS_META/ROW_META 에 한 번만 두고,
 * 번역 텍스트는 인덱스로 정렬한다 — 10개 로케일에 id 를 반복하다 어긋나는 사고를 막는다.
 */

export type Locale =
  | "ar"
  | "en"
  | "es"
  | "fr"
  | "hi"
  | "ja"
  | "ko"
  | "pt-BR"
  | "ru"
  | "zh-Hans";

/** 3축 카드의 로케일-무관 메타 — `pro` 는 «주황=프로» 약속을 따른다(PO 루프만 전부 Pro). */
export const AXIS_META = [
  { id: "no-relay", pro: false },
  { id: "multi-agent", pro: false },
  { id: "po-loop", pro: true },
] as const;

/** 비교표 행의 로케일-무관 메타 — 텍스트는 CONTENT[locale].comparison.rows 와 인덱스 정렬. */
export const ROW_META = [
  { id: "data-path" },
  { id: "agents" },
  { id: "local-llm" },
  { id: "po-loop" },
  { id: "cost" },
] as const;

type Edge = {
  heading: string;
  subheading: string;
  /** AXIS_META 와 인덱스 정렬 (길이 3). */
  axes: readonly { title: string; body: string }[];
};

type Comparison = {
  heading: string;
  subheading: string;
  /** 스크린리더용 표 캡션 (sr-only). */
  caption: string;
  /** 행 머리(첫 열) 헤더 라벨. */
  colCapability: string;
  colYou: string;
  colOfficial: string;
  colRelay: string;
  /** ROW_META 와 인덱스 정렬 (길이 5). */
  rows: readonly { label: string; you: string; official: string; relay: string }[];
  /** 트레이드오프 정직 고지 — info(파랑) 톤의 보조 정보, 경고(노랑) 아님. */
  footnoteLabel: string;
  footnote: string;
};

export type Differentiators = { edge: Edge; comparison: Comparison };

const CONTENT: Record<Locale, Differentiators> = {
  // ───────────────────────────────────────── 소스 언어 (ko) ─────────────────────────────────────────
  ko: {
    edge: {
      heading: "공식 원격 제어로 충분하지 않나요?",
      subheading:
        "여기엔 우리만의 것 세 가지가 있어요 — 자체 중계 서버 0, 일곱 에이전트 + 기기 내 LLM, 그리고 «어떻게»가 아니라 «무엇을 만들지»를 정하는 루프.",
      axes: [
        {
          title: "자체 중계 서버가 없어요",
          body: "코드도 대화도 Anthropic·우리·그 어떤 릴레이도 거치지 않아요. 폰이 Mac 에 SSH 로 직접 닿고, 직접 경로가 없을 땐 설정이 필요 없는 Tor 로 폴백해요. 네트워크를 절대 벗어나지 않는 같은 Wi-Fi 전용 모드도 선택할 수 있어요.",
        },
        {
          title: "일곱 에이전트, 게다가 기기 안의 LLM",
          body: "세션마다 에이전트를 골라요 — Claude Code, Codex, Antigravity, Copilot, OpenCode, 내장 터미널, 또는 기기 내 Qwen Code: 클라우드 계정도 인터넷도 전혀 없이 도는 로컬 LLM. (터미널과 로컬 LLM 은 Pro.)",
        },
        {
          title: "무엇을 만들지 정하는 루프",
          body: "어떤 원격 제어든 시킨 일을 실행해요. 이건 «무엇을 시킬 가치가 있는지»까지 정해요 — 프로덕트 오너 에이전트가 레포의 신호(이슈·TODO·문서·최근 변경)를 읽어 기회 브리프를 제안하고, 당신은 승인·보류·기각만 해요.",
        },
      ],
    },
    comparison: {
      heading: "정직한 비교",
      subheading:
        "모든 주장은 전송 경로와 에이전트에 관한 것 — 직접 확인할 수 있는 사실이에요. 내주는 게 있으면 그대로 적었어요.",
      caption:
        "Pocket Sisyphus 를 공식 원격 제어·릴레이 기반 앱과 데이터 경로, 코드 에이전트, 기기 내 LLM, 프로덕트 오너 루프, 비용 기준으로 비교한 표.",
      colCapability: "항목",
      colYou: "Pocket Sisyphus",
      colOfficial: "공식 원격 제어",
      colRelay: "릴레이 기반 앱",
      rows: [
        {
          label: "데이터 경로 — 중간에 누가 있나",
          you: "폰 → 내 Mac 직접. 우리 릴레이 없음: SSH 우선, Tor 폴백, 같은 Wi-Fi 전용 선택 가능.",
          official: "제공자의 클라우드를 거쳐요.",
          relay: "앱 제공사의 릴레이 서버를 거쳐요.",
        },
        {
          label: "코드 에이전트",
          you: "원하는 걸 직접: Claude Code, Codex, Antigravity, Copilot, OpenCode + 터미널.",
          official: "제공자 자체 에이전트.",
          relay: "앱마다 달라요.",
        },
        {
          label: "기기 내 LLM — 계정·인터넷 불필요",
          you: "예 — Qwen Code, 완전 로컬 (Pro).",
          official: "아니요 — 클라우드 필요.",
          relay: "거의 없음.",
        },
        {
          label: "무엇을 만들지 정함 (PO 루프)",
          you: "예 — 기회 브리프를 제안하고 승인받아요 (Pro).",
          official: "아니요 — 실행만.",
          relay: "아니요 — 실행만.",
        },
        {
          label: "비용",
          you: "앱 무료; Pro 선택. 추론은 제공자가 청구 — 중계도 가산도 없음.",
          official: "유료 플랜에 포함.",
          relay: "별도 구독인 경우가 많음.",
        },
      ],
      footnoteLabel: "트레이드오프",
      footnote:
        "직접 SSH 경로가 안 닿을 때(CGNAT 나 잠긴 라우터) Tor 폴백은 늘 클라우드인 서비스엔 없는 지연을 더해요. 트래픽을 우리 서버에 두지 않는 값어치가 있다고 봐요. 그리고 내 네트워크 안에서는 같은 Wi-Fi 전용 모드가 가장 빠른 경로예요.",
    },
  },

  // ───────────────────────────────────────── 라이브 렌더 (en) ─────────────────────────────────────────
  en: {
    edge: {
      heading: "Why not just the official remote control?",
      subheading:
        "Three things here are ours alone: no relay servers of our own, seven agents plus an on-device LLM, and a loop that decides what to build — not just how.",
      axes: [
        {
          title: "No relay servers of our own",
          body: "Your code and your conversations never pass through Anthropic, through us, or through any relay. Your phone reaches your Mac directly over SSH, with a zero-config Tor fallback when a direct route isn't there — plus an optional same-Wi-Fi-only mode that never leaves your network.",
        },
        {
          title: "Seven agents, plus an LLM on your device",
          body: "Choose the agent per session — Claude Code, Codex, Antigravity, Copilot, OpenCode, a built-in Terminal, or on-device Qwen Code: a local LLM that runs with no cloud account and no internet at all. (Terminal and the local LLM are Pro.)",
        },
        {
          title: "A loop that decides what to build",
          body: "Every remote control runs what you ask. This one also decides what's worth asking — a product-owner agent reads your repo's signals (issues, TODOs, docs, recent changes) and proposes opportunity briefs you approve, hold, or reject.",
        },
      ],
    },
    comparison: {
      heading: "An honest comparison",
      subheading:
        "Every claim is about the transport path and the agents — things you can check. Where we trade something away, we say so.",
      caption:
        "Pocket Sisyphus compared with the official remote control and relay-based apps across data path, coding agents, on-device LLM, the product-owner loop, and cost.",
      colCapability: "Capability",
      colYou: "Pocket Sisyphus",
      colOfficial: "Official remote control",
      colRelay: "Relay-based apps",
      rows: [
        {
          label: "Data path — who sits in the middle",
          you: "Phone → your Mac directly. No relay of ours: SSH-first, Tor fallback, optional LAN-only.",
          official: "Routed through the provider's cloud.",
          relay: "Routed through the vendor's relay server.",
        },
        {
          label: "Coding agents",
          you: "Bring your own: Claude Code, Codex, Antigravity, Copilot, OpenCode + Terminal.",
          official: "The provider's own agent.",
          relay: "Varies by app.",
        },
        {
          label: "On-device LLM — no account, no internet",
          you: "Yes — Qwen Code, fully local (Pro).",
          official: "No — needs the cloud.",
          relay: "Rarely.",
        },
        {
          label: "Decides what to build (PO loop)",
          you: "Yes — proposes opportunity briefs you approve (Pro).",
          official: "No — executes only.",
          relay: "No — executes only.",
        },
        {
          label: "Cost",
          you: "App free; optional Pro. Inference billed by your provider — never relayed or marked up.",
          official: "Bundled with a paid plan.",
          relay: "Often a separate subscription.",
        },
      ],
      footnoteLabel: "Trade-off",
      footnote:
        "When a direct SSH route isn't reachable (CGNAT or a locked-down router), the Tor fallback adds latency that an always-cloud service doesn't have. We think keeping your traffic off our servers is worth it; and on your own network, LAN-only mode is the fastest path of all.",
    },
  },

  // ───────────────────────────────────────── 日本語 (ja) ─────────────────────────────────────────
  ja: {
    edge: {
      heading: "公式リモートコントロールだけで十分?",
      subheading:
        "ここには私たちだけのものが三つあります — 自前の中継サーバーがゼロ、七つのエージェント＋端末内 LLM、そして «どう作るか» ではなく «何を作るか» を決めるループ。",
      axes: [
        {
          title: "自前の中継サーバーがありません",
          body: "コードも会話も、Anthropic・私たち・どの中継も通りません。スマホは SSH で Mac に直接つながり、直接経路がないときは設定不要の Tor にフォールバックします。ネットワークから一切出ない «同一 Wi-Fi 限定» モードも選べます。",
        },
        {
          title: "七つのエージェント、さらに端末内の LLM",
          body: "セッションごとにエージェントを選択 — Claude Code、Codex、Antigravity、Copilot、OpenCode、内蔵ターミナル、または端末内 Qwen Code（クラウドアカウントもインターネットも一切なしで動くローカル LLM）。（ターミナルとローカル LLM は Pro。）",
        },
        {
          title: "何を作るかを決めるループ",
          body: "どのリモートコントロールも、頼んだことを実行します。これは «何を頼む価値があるか» まで決めます — プロダクトオーナーのエージェントがリポジトリの signal（Issue・TODO・ドキュメント・最近の変更）を読み、機会ブリーフを提案。あなたは承認・保留・却下するだけ。",
        },
      ],
    },
    comparison: {
      heading: "正直な比較",
      subheading:
        "どの主張も転送経路とエージェントについて — 自分で確認できる事実です。引き換えにするものがあれば、そのまま書きました。",
      caption:
        "Pocket Sisyphus を公式リモートコントロール・中継型アプリと、データ経路・コードエージェント・端末内 LLM・プロダクトオーナーループ・費用で比較した表。",
      colCapability: "項目",
      colYou: "Pocket Sisyphus",
      colOfficial: "公式リモートコントロール",
      colRelay: "中継型アプリ",
      rows: [
        {
          label: "データ経路 — 間に誰がいるか",
          you: "スマホ → 自分の Mac へ直接。自前の中継なし: SSH 優先、Tor フォールバック、同一 Wi-Fi 限定も選択可。",
          official: "提供元のクラウドを経由。",
          relay: "アプリ提供元の中継サーバーを経由。",
        },
        {
          label: "コードエージェント",
          you: "好きなものを: Claude Code、Codex、Antigravity、Copilot、OpenCode ＋ ターミナル。",
          official: "提供元の自社エージェント。",
          relay: "アプリによる。",
        },
        {
          label: "端末内 LLM — アカウント・ネット不要",
          you: "はい — Qwen Code、完全ローカル（Pro）。",
          official: "いいえ — クラウドが必要。",
          relay: "ほとんどなし。",
        },
        {
          label: "何を作るかを決める（PO ループ）",
          you: "はい — 機会ブリーフを提案し承認を得る（Pro）。",
          official: "いいえ — 実行のみ。",
          relay: "いいえ — 実行のみ。",
        },
        {
          label: "費用",
          you: "アプリ無料、Pro は任意。推論は提供元が課金 — 中継も上乗せもなし。",
          official: "有料プランに付属。",
          relay: "別途サブスクのことが多い。",
        },
      ],
      footnoteLabel: "トレードオフ",
      footnote:
        "直接 SSH 経路に届かないとき（CGNAT やロックダウンされたルーター）、Tor フォールバックは、常時クラウドのサービスにはない遅延を加えます。トラフィックを私たちのサーバーに置かない価値はあると考えています。そして自分のネットワーク内では、同一 Wi-Fi 限定モードが最速の経路です。",
    },
  },

  // ───────────────────────────────────────── 简体中文 (zh-Hans) ─────────────────────────────────────────
  "zh-Hans": {
    edge: {
      heading: "官方远程控制还不够吗?",
      subheading:
        "这里有三样只属于我们的东西：没有自己的中转服务器、七种智能体外加设备端 LLM，以及一个决定 «做什么» 而非只是 «怎么做» 的闭环。",
      axes: [
        {
          title: "没有我们自己的中转服务器",
          body: "你的代码和对话不会经过 Anthropic、不会经过我们、也不会经过任何中转。手机通过 SSH 直接连到你的 Mac；没有直连路径时，自动回退到免配置的 Tor。还可选 «仅同一 Wi-Fi» 模式，数据绝不离开你的网络。",
        },
        {
          title: "七种智能体，外加设备里的 LLM",
          body: "每个会话自选智能体 — Claude Code、Codex、Antigravity、Copilot、OpenCode、内置终端，或设备端 Qwen Code：一个无需云账号、完全离线也能跑的本地 LLM。（终端与本地 LLM 为 Pro。）",
        },
        {
          title: "决定做什么的闭环",
          body: "任何远程控制都会执行你下达的指令。而这个还会决定 «什么值得做»——产品负责人智能体读取仓库信号（issue、TODO、文档、近期改动）并提出机会简报，你只需批准、搁置或驳回。",
        },
      ],
    },
    comparison: {
      heading: "诚实的对比",
      subheading:
        "每一条都关于传输路径和智能体 — 都是你能核实的事实。凡有取舍，我们如实写明。",
      caption:
        "将 Pocket Sisyphus 与官方远程控制、基于中转的应用，按数据路径、代码智能体、设备端 LLM、产品负责人闭环和费用进行对比的表格。",
      colCapability: "项目",
      colYou: "Pocket Sisyphus",
      colOfficial: "官方远程控制",
      colRelay: "基于中转的应用",
      rows: [
        {
          label: "数据路径 — 中间是谁",
          you: "手机 → 直连你的 Mac。没有我们的中转：SSH 优先、Tor 回退、可选仅局域网。",
          official: "经过提供方的云。",
          relay: "经过应用厂商的中转服务器。",
        },
        {
          label: "代码智能体",
          you: "自带自选：Claude Code、Codex、Antigravity、Copilot、OpenCode ＋ 终端。",
          official: "提供方自家的智能体。",
          relay: "因应用而异。",
        },
        {
          label: "设备端 LLM — 无需账号与联网",
          you: "是 — Qwen Code，完全本地（Pro）。",
          official: "否 — 需要云。",
          relay: "极少。",
        },
        {
          label: "决定做什么（PO 闭环）",
          you: "是 — 提出机会简报供你批准（Pro）。",
          official: "否 — 仅执行。",
          relay: "否 — 仅执行。",
        },
        {
          label: "费用",
          you: "应用免费；Pro 可选。推理由你的提供方计费 — 绝不中转、绝不加价。",
          official: "随付费套餐附带。",
          relay: "通常需另行订阅。",
        },
      ],
      footnoteLabel: "取舍",
      footnote:
        "当直连 SSH 路径不可达时（CGNAT 或被锁定的路由器），Tor 回退会带来始终在云端的服务所没有的延迟。我们认为，让流量不经过我们的服务器是值得的；而在你自己的网络里，仅局域网模式是最快的路径。",
    },
  },

  // ───────────────────────────────────────── Español (es) ─────────────────────────────────────────
  es: {
    edge: {
      heading: "¿No basta con el control remoto oficial?",
      subheading:
        "Aquí hay tres cosas que solo son nuestras: cero servidores de retransmisión propios, siete agentes más un LLM en el dispositivo, y un bucle que decide qué construir, no solo cómo.",
      axes: [
        {
          title: "Sin servidores de retransmisión propios",
          body: "Tu código y tus conversaciones nunca pasan por Anthropic, ni por nosotros, ni por ningún relé. Tu teléfono llega a tu Mac directamente por SSH, con una vuelta a Tor sin configuración cuando no hay ruta directa, más un modo opcional solo-misma-Wi-Fi que nunca sale de tu red.",
        },
        {
          title: "Siete agentes, más un LLM en tu dispositivo",
          body: "Elige el agente por sesión: Claude Code, Codex, Antigravity, Copilot, OpenCode, una Terminal integrada o Qwen Code en el dispositivo — un LLM local que funciona sin cuenta en la nube y sin internet. (La Terminal y el LLM local son Pro.)",
        },
        {
          title: "Un bucle que decide qué construir",
          body: "Todo control remoto ejecuta lo que le pides. Este además decide qué vale la pena pedir — un agente product owner lee las señales de tu repo (incidencias, TODOs, documentos, cambios recientes) y propone informes de oportunidad que apruebas, aplazas o rechazas.",
        },
      ],
    },
    comparison: {
      heading: "Una comparación honesta",
      subheading:
        "Cada afirmación trata sobre la ruta de transporte y los agentes — cosas que puedes comprobar. Donde cedemos algo, lo decimos.",
      caption:
        "Pocket Sisyphus comparado con el control remoto oficial y las apps basadas en retransmisión, según ruta de datos, agentes de código, LLM en el dispositivo, el bucle product owner y el coste.",
      colCapability: "Aspecto",
      colYou: "Pocket Sisyphus",
      colOfficial: "Control remoto oficial",
      colRelay: "Apps con retransmisión",
      rows: [
        {
          label: "Ruta de datos — quién está en medio",
          you: "Teléfono → tu Mac, directo. Sin relé nuestro: SSH primero, Tor de respaldo, solo-LAN opcional.",
          official: "Pasa por la nube del proveedor.",
          relay: "Pasa por el servidor de retransmisión del proveedor de la app.",
        },
        {
          label: "Agentes de código",
          you: "Trae el tuyo: Claude Code, Codex, Antigravity, Copilot, OpenCode + Terminal.",
          official: "El agente propio del proveedor.",
          relay: "Depende de la app.",
        },
        {
          label: "LLM en el dispositivo — sin cuenta ni internet",
          you: "Sí — Qwen Code, totalmente local (Pro).",
          official: "No — necesita la nube.",
          relay: "Casi nunca.",
        },
        {
          label: "Decide qué construir (bucle PO)",
          you: "Sí — propone informes de oportunidad que apruebas (Pro).",
          official: "No — solo ejecuta.",
          relay: "No — solo ejecuta.",
        },
        {
          label: "Coste",
          you: "App gratis; Pro opcional. La inferencia la cobra tu proveedor — sin retransmisión ni recargo.",
          official: "Incluido en un plan de pago.",
          relay: "A menudo, una suscripción aparte.",
        },
      ],
      footnoteLabel: "Compromiso",
      footnote:
        "Cuando no se alcanza una ruta SSH directa (CGNAT o un router bloqueado), el respaldo por Tor añade una latencia que un servicio siempre-en-la-nube no tiene. Creemos que mantener tu tráfico fuera de nuestros servidores lo vale; y en tu propia red, el modo solo-LAN es la ruta más rápida de todas.",
    },
  },

  // ───────────────────────────────────────── Français (fr) ─────────────────────────────────────────
  fr: {
    edge: {
      heading: "Le contrôle à distance officiel ne suffit pas ?",
      subheading:
        "Trois choses ici n'appartiennent qu'à nous : zéro serveur relais à nous, sept agents plus un LLM sur l'appareil, et une boucle qui décide quoi construire, pas seulement comment.",
      axes: [
        {
          title: "Aucun serveur relais à nous",
          body: "Votre code et vos conversations ne passent jamais par Anthropic, par nous, ni par un quelconque relais. Votre téléphone atteint votre Mac directement en SSH, avec un repli Tor sans configuration quand la voie directe manque — plus un mode optionnel «même Wi-Fi uniquement» qui ne quitte jamais votre réseau.",
        },
        {
          title: "Sept agents, plus un LLM sur votre appareil",
          body: "Choisissez l'agent par session : Claude Code, Codex, Antigravity, Copilot, OpenCode, un Terminal intégré, ou Qwen Code sur l'appareil — un LLM local qui tourne sans compte cloud et sans aucune connexion internet. (Le Terminal et le LLM local sont Pro.)",
        },
        {
          title: "Une boucle qui décide quoi construire",
          body: "Tout contrôle à distance exécute ce que vous demandez. Celui-ci décide aussi de ce qui vaut la peine d'être demandé — un agent product owner lit les signaux de votre dépôt (tickets, TODO, docs, changements récents) et propose des notes d'opportunité que vous approuvez, suspendez ou rejetez.",
        },
      ],
    },
    comparison: {
      heading: "Une comparaison honnête",
      subheading:
        "Chaque affirmation porte sur le chemin de transport et les agents — des choses vérifiables. Là où nous cédons quelque chose, nous le disons.",
      caption:
        "Pocket Sisyphus comparé au contrôle à distance officiel et aux applis à relais, selon le chemin des données, les agents de code, le LLM sur l'appareil, la boucle product owner et le coût.",
      colCapability: "Critère",
      colYou: "Pocket Sisyphus",
      colOfficial: "Contrôle à distance officiel",
      colRelay: "Applis à relais",
      rows: [
        {
          label: "Chemin des données — qui est au milieu",
          you: "Téléphone → votre Mac, direct. Aucun relais à nous : SSH d'abord, repli Tor, LAN seul en option.",
          official: "Passe par le cloud du fournisseur.",
          relay: "Passe par le serveur relais de l'éditeur de l'appli.",
        },
        {
          label: "Agents de code",
          you: "Apportez le vôtre : Claude Code, Codex, Antigravity, Copilot, OpenCode + Terminal.",
          official: "L'agent maison du fournisseur.",
          relay: "Selon l'appli.",
        },
        {
          label: "LLM sur l'appareil — sans compte ni internet",
          you: "Oui — Qwen Code, entièrement local (Pro).",
          official: "Non — nécessite le cloud.",
          relay: "Rarement.",
        },
        {
          label: "Décide quoi construire (boucle PO)",
          you: "Oui — propose des notes d'opportunité que vous approuvez (Pro).",
          official: "Non — exécute seulement.",
          relay: "Non — exécute seulement.",
        },
        {
          label: "Coût",
          you: "Appli gratuite ; Pro en option. L'inférence est facturée par votre fournisseur — jamais relayée ni majorée.",
          official: "Inclus dans une offre payante.",
          relay: "Souvent un abonnement à part.",
        },
      ],
      footnoteLabel: "Compromis",
      footnote:
        "Quand une voie SSH directe est injoignable (CGNAT ou routeur verrouillé), le repli Tor ajoute une latence qu'un service toujours-cloud n'a pas. Garder votre trafic hors de nos serveurs en vaut la peine, selon nous ; et sur votre propre réseau, le mode LAN seul est la voie la plus rapide.",
    },
  },

  // ───────────────────────────────────────── Português, Brasil (pt-BR) ─────────────────────────────────────────
  "pt-BR": {
    edge: {
      heading: "O controle remoto oficial não basta?",
      subheading:
        "Aqui há três coisas que só são nossas: zero servidores de retransmissão próprios, sete agentes mais um LLM no dispositivo, e um ciclo que decide o que construir, não apenas como.",
      axes: [
        {
          title: "Sem servidores de retransmissão nossos",
          body: "Seu código e suas conversas nunca passam pela Anthropic, por nós, nem por qualquer retransmissor. Seu telefone chega ao seu Mac direto por SSH, com retorno ao Tor sem configuração quando não há rota direta — além de um modo opcional só-mesmo-Wi-Fi que nunca sai da sua rede.",
        },
        {
          title: "Sete agentes, mais um LLM no seu dispositivo",
          body: "Escolha o agente por sessão: Claude Code, Codex, Antigravity, Copilot, OpenCode, um Terminal embutido ou o Qwen Code no dispositivo — um LLM local que roda sem conta na nuvem e sem internet alguma. (Terminal e o LLM local são Pro.)",
        },
        {
          title: "Um ciclo que decide o que construir",
          body: "Todo controle remoto executa o que você pede. Este também decide o que vale a pena pedir — um agente product owner lê os sinais do seu repositório (issues, TODOs, docs, mudanças recentes) e propõe resumos de oportunidade que você aprova, adia ou rejeita.",
        },
      ],
    },
    comparison: {
      heading: "Uma comparação honesta",
      subheading:
        "Toda afirmação é sobre o caminho de transporte e os agentes — coisas que você pode verificar. Onde abrimos mão de algo, dizemos.",
      caption:
        "Pocket Sisyphus comparado ao controle remoto oficial e aos apps baseados em retransmissão, por caminho dos dados, agentes de código, LLM no dispositivo, ciclo product owner e custo.",
      colCapability: "Item",
      colYou: "Pocket Sisyphus",
      colOfficial: "Controle remoto oficial",
      colRelay: "Apps com retransmissão",
      rows: [
        {
          label: "Caminho dos dados — quem fica no meio",
          you: "Telefone → seu Mac, direto. Sem retransmissor nosso: SSH primeiro, Tor de reserva, só-LAN opcional.",
          official: "Passa pela nuvem do provedor.",
          relay: "Passa pelo servidor de retransmissão do fornecedor do app.",
        },
        {
          label: "Agentes de código",
          you: "Traga o seu: Claude Code, Codex, Antigravity, Copilot, OpenCode + Terminal.",
          official: "O agente próprio do provedor.",
          relay: "Depende do app.",
        },
        {
          label: "LLM no dispositivo — sem conta nem internet",
          you: "Sim — Qwen Code, totalmente local (Pro).",
          official: "Não — precisa da nuvem.",
          relay: "Raramente.",
        },
        {
          label: "Decide o que construir (ciclo PO)",
          you: "Sim — propõe resumos de oportunidade que você aprova (Pro).",
          official: "Não — só executa.",
          relay: "Não — só executa.",
        },
        {
          label: "Custo",
          you: "App grátis; Pro opcional. A inferência é cobrada pelo seu provedor — nunca retransmitida nem com acréscimo.",
          official: "Incluído em um plano pago.",
          relay: "Muitas vezes, uma assinatura à parte.",
        },
      ],
      footnoteLabel: "Compensação",
      footnote:
        "Quando uma rota SSH direta não é alcançável (CGNAT ou um roteador bloqueado), o retorno via Tor adiciona uma latência que um serviço sempre-na-nuvem não tem. Achamos que manter seu tráfego fora dos nossos servidores vale a pena; e na sua própria rede, o modo só-LAN é o caminho mais rápido de todos.",
    },
  },

  // ───────────────────────────────────────── Русский (ru) ─────────────────────────────────────────
  ru: {
    edge: {
      heading: "Разве официального удалённого управления не достаточно?",
      subheading:
        "Здесь есть три вещи, которые есть только у нас: ноль собственных серверов-ретрансляторов, семь агентов плюс LLM на устройстве и цикл, который решает, что создавать, а не только как.",
      axes: [
        {
          title: "Никаких собственных серверов-ретрансляторов",
          body: "Ваш код и переписка никогда не проходят через Anthropic, через нас или через какой-либо ретранслятор. Телефон соединяется с вашим Mac напрямую по SSH, а если прямого пути нет — автоматически переходит на Tor без настройки. Есть и режим «только своя Wi-Fi», который никогда не покидает вашу сеть.",
        },
        {
          title: "Семь агентов плюс LLM на вашем устройстве",
          body: "Выбирайте агента для каждой сессии: Claude Code, Codex, Antigravity, Copilot, OpenCode, встроенный терминал или Qwen Code на устройстве — локальная LLM, работающая вообще без облачного аккаунта и без интернета. (Терминал и локальная LLM — Pro.)",
        },
        {
          title: "Цикл, который решает, что создавать",
          body: "Любое удалённое управление выполняет то, что вы скажете. Это ещё и решает, что стоит просить — агент-владелец продукта читает сигналы репозитория (задачи, TODO, документацию, недавние изменения) и предлагает брифы возможностей, которые вы одобряете, откладываете или отклоняете.",
        },
      ],
    },
    comparison: {
      heading: "Честное сравнение",
      subheading:
        "Каждое утверждение — о маршруте передачи и агентах, то есть о том, что можно проверить. Где мы чем-то жертвуем, мы об этом говорим.",
      caption:
        "Сравнение Pocket Sisyphus с официальным удалённым управлением и приложениями на ретрансляции по маршруту данных, агентам кода, LLM на устройстве, циклу владельца продукта и стоимости.",
      colCapability: "Критерий",
      colYou: "Pocket Sisyphus",
      colOfficial: "Официальное удалённое управление",
      colRelay: "Приложения с ретрансляцией",
      rows: [
        {
          label: "Маршрут данных — кто посередине",
          you: "Телефон → ваш Mac напрямую. Без нашего ретранслятора: сначала SSH, затем Tor, опционально только-LAN.",
          official: "Через облако поставщика.",
          relay: "Через сервер-ретранслятор разработчика приложения.",
        },
        {
          label: "Агенты кода",
          you: "Свой на выбор: Claude Code, Codex, Antigravity, Copilot, OpenCode + терминал.",
          official: "Собственный агент поставщика.",
          relay: "Зависит от приложения.",
        },
        {
          label: "LLM на устройстве — без аккаунта и интернета",
          you: "Да — Qwen Code, полностью локально (Pro).",
          official: "Нет — нужен облачный сервис.",
          relay: "Почти никогда.",
        },
        {
          label: "Решает, что создавать (цикл PO)",
          you: "Да — предлагает брифы возможностей на ваше одобрение (Pro).",
          official: "Нет — только выполняет.",
          relay: "Нет — только выполняет.",
        },
        {
          label: "Стоимость",
          you: "Приложение бесплатно; Pro по желанию. Инференс оплачивается вашему поставщику — без ретрансляции и наценки.",
          official: "Входит в платный тариф.",
          relay: "Часто отдельная подписка.",
        },
      ],
      footnoteLabel: "Компромисс",
      footnote:
        "Когда прямой путь по SSH недоступен (CGNAT или закрытый роутер), переход на Tor добавляет задержку, которой нет у всегда-облачного сервиса. Мы считаем, что держать ваш трафик вне наших серверов того стоит; а внутри вашей сети режим только-LAN — самый быстрый путь.",
    },
  },

  // ───────────────────────────────────────── हिन्दी (hi) ─────────────────────────────────────────
  hi: {
    edge: {
      heading: "क्या आधिकारिक रिमोट कंट्रोल काफ़ी नहीं?",
      subheading:
        "यहाँ तीन चीज़ें सिर्फ़ हमारी हैं: अपना कोई रिले सर्वर नहीं, सात एजेंट और साथ में डिवाइस पर चलने वाला LLM, और एक लूप जो तय करता है कि क्या बनाना है — सिर्फ़ कैसे नहीं।",
      axes: [
        {
          title: "हमारा अपना कोई रिले सर्वर नहीं",
          body: "आपका कोड और आपकी बातचीत कभी Anthropic, हमारे, या किसी भी रिले से होकर नहीं गुज़रती। आपका फ़ोन SSH से सीधे आपके Mac तक पहुँचता है, और सीधा रास्ता न मिलने पर बिना सेटअप वाले Tor पर लौट आता है — साथ ही एक वैकल्पिक «सिर्फ़ उसी Wi-Fi» मोड जो कभी आपके नेटवर्क से बाहर नहीं जाता।",
        },
        {
          title: "सात एजेंट, और आपके डिवाइस में एक LLM",
          body: "हर सेशन में एजेंट चुनें — Claude Code, Codex, Antigravity, Copilot, OpenCode, एक बिल्ट-इन Terminal, या डिवाइस पर Qwen Code: एक लोकल LLM जो बिना किसी क्लाउड अकाउंट और बिना इंटरनेट के चलता है। (Terminal और लोकल LLM Pro हैं।)",
        },
        {
          title: "एक लूप जो तय करता है कि क्या बनाना है",
          body: "हर रिमोट कंट्रोल वही करता है जो आप कहते हैं। यह यह भी तय करता है कि माँगने लायक क्या है — एक प्रोडक्ट-ओनर एजेंट आपके रेपो के संकेत (issues, TODOs, docs, हाल के बदलाव) पढ़ता है और अवसर ब्रीफ़ सुझाता है, जिन्हें आप मंज़ूर, स्थगित या अस्वीकार करते हैं।",
        },
      ],
    },
    comparison: {
      heading: "एक ईमानदार तुलना",
      subheading:
        "हर दावा ट्रांसपोर्ट पथ और एजेंट के बारे में है — ऐसी बातें जिन्हें आप जाँच सकते हैं। जहाँ हम कुछ छोड़ते हैं, वहाँ हम साफ़ कहते हैं।",
      caption:
        "Pocket Sisyphus की तुलना आधिकारिक रिमोट कंट्रोल और रिले-आधारित ऐप्स से — डेटा पथ, कोड एजेंट, डिवाइस पर LLM, प्रोडक्ट-ओनर लूप और लागत के आधार पर।",
      colCapability: "मद",
      colYou: "Pocket Sisyphus",
      colOfficial: "आधिकारिक रिमोट कंट्रोल",
      colRelay: "रिले-आधारित ऐप्स",
      rows: [
        {
          label: "डेटा पथ — बीच में कौन है",
          you: "फ़ोन → सीधे आपका Mac। हमारा कोई रिले नहीं: पहले SSH, फिर Tor, वैकल्पिक रूप से सिर्फ़-LAN।",
          official: "प्रदाता के क्लाउड से होकर।",
          relay: "ऐप विक्रेता के रिले सर्वर से होकर।",
        },
        {
          label: "कोड एजेंट",
          you: "अपना चुनें: Claude Code, Codex, Antigravity, Copilot, OpenCode + Terminal।",
          official: "प्रदाता का अपना एजेंट।",
          relay: "ऐप के अनुसार बदलता है।",
        },
        {
          label: "डिवाइस पर LLM — बिना अकाउंट, बिना इंटरनेट",
          you: "हाँ — Qwen Code, पूरी तरह लोकल (Pro)।",
          official: "नहीं — क्लाउड चाहिए।",
          relay: "बहुत कम।",
        },
        {
          label: "तय करता है कि क्या बनाना है (PO लूप)",
          you: "हाँ — अवसर ब्रीफ़ सुझाता है जिन्हें आप मंज़ूर करते हैं (Pro)।",
          official: "नहीं — सिर्फ़ चलाता है।",
          relay: "नहीं — सिर्फ़ चलाता है।",
        },
        {
          label: "लागत",
          you: "ऐप मुफ़्त; Pro वैकल्पिक। इन्फ़रेंस का बिल आपका प्रदाता लेता है — न रिले, न कोई अतिरिक्त शुल्क।",
          official: "किसी सशुल्क प्लान में शामिल।",
          relay: "अक्सर अलग सब्सक्रिप्शन।",
        },
      ],
      footnoteLabel: "समझौता",
      footnote:
        "जब सीधा SSH रास्ता न मिले (CGNAT या लॉक किया हुआ राउटर), तो Tor पर लौटना उतनी देरी जोड़ता है जो हमेशा-क्लाउड सेवा में नहीं होती। हमें लगता है कि आपके ट्रैफ़िक को हमारे सर्वरों से दूर रखना इसके लायक है; और आपके अपने नेटवर्क में, सिर्फ़-LAN मोड सबसे तेज़ रास्ता है।",
    },
  },

  // ───────────────────────────────────────── العربية (ar) ─────────────────────────────────────────
  ar: {
    edge: {
      heading: "أليس التحكّم عن بُعد الرسمي كافيًا؟",
      subheading:
        "هنا ثلاثة أشياء تخصّنا وحدنا: صفر خوادم وسيطة خاصة بنا، سبعة وكلاء بالإضافة إلى نموذج LLM على الجهاز، وحلقة تقرّر ماذا تبني، لا كيف فقط.",
      axes: [
        {
          title: "لا خوادم وسيطة خاصة بنا",
          body: "لا يمرّ كودك ولا محادثاتك عبر Anthropic، ولا عبرنا، ولا عبر أي وسيط. يصل هاتفك إلى جهاز Mac مباشرةً عبر SSH، مع تحوّل تلقائي إلى Tor دون إعداد عند غياب المسار المباشر — إضافةً إلى وضع اختياري «نفس شبكة Wi-Fi فقط» لا يغادر شبكتك أبدًا.",
        },
        {
          title: "سبعة وكلاء، وأيضًا نموذج LLM على جهازك",
          body: "اختر الوكيل لكل جلسة: Claude Code وCodex وAntigravity وCopilot وOpenCode، وTerminal مدمج، أو Qwen Code على الجهاز — نموذج LLM محلي يعمل دون حساب سحابي ودون إنترنت إطلاقًا. (Terminal والنموذج المحلي ضمن Pro.)",
        },
        {
          title: "حلقة تقرّر ماذا تبني",
          body: "كل تحكّم عن بُعد ينفّذ ما تطلبه. وهذا يقرّر أيضًا ما يستحقّ الطلب — وكيل «مالك المنتج» يقرأ إشارات مستودعك (المشكلات وملاحظات TODO والوثائق والتغييرات الأخيرة) ويقترح موجزات فرص توافق عليها أو تؤجّلها أو ترفضها.",
        },
      ],
    },
    comparison: {
      heading: "مقارنة صادقة",
      subheading:
        "كل ادعاء يخصّ مسار النقل والوكلاء — أمور يمكنك التحقّق منها. وحيثما نتنازل عن شيء، نقوله بوضوح.",
      caption:
        "مقارنة Pocket Sisyphus مع التحكّم عن بُعد الرسمي والتطبيقات المعتمدة على الوسيط، حسب مسار البيانات ووكلاء الكود ونموذج LLM على الجهاز وحلقة مالك المنتج والتكلفة.",
      colCapability: "البند",
      colYou: "Pocket Sisyphus",
      colOfficial: "التحكّم عن بُعد الرسمي",
      colRelay: "تطبيقات تعتمد على وسيط",
      rows: [
        {
          label: "مسار البيانات — من في المنتصف",
          you: "الهاتف → جهاز Mac مباشرةً. لا وسيط لنا: SSH أولًا، ثم Tor احتياطيًا، ووضع الشبكة المحلية فقط اختياريًا.",
          official: "يمرّ عبر سحابة المزوّد.",
          relay: "يمرّ عبر الخادم الوسيط لمزوّد التطبيق.",
        },
        {
          label: "وكلاء الكود",
          you: "أحضر ما تشاء: Claude Code وCodex وAntigravity وCopilot وOpenCode + Terminal.",
          official: "وكيل المزوّد الخاص.",
          relay: "يختلف حسب التطبيق.",
        },
        {
          label: "نموذج LLM على الجهاز — دون حساب ودون إنترنت",
          you: "نعم — Qwen Code، محلي بالكامل (Pro).",
          official: "لا — يحتاج إلى السحابة.",
          relay: "نادرًا.",
        },
        {
          label: "يقرّر ماذا تبني (حلقة PO)",
          you: "نعم — يقترح موجزات فرص توافق عليها (Pro).",
          official: "لا — ينفّذ فقط.",
          relay: "لا — ينفّذ فقط.",
        },
        {
          label: "التكلفة",
          you: "التطبيق مجاني؛ وPro اختياري. يُحاسبك مزوّدك على الاستدلال — دون وساطة ودون هامش إضافي.",
          official: "مضمَّن ضمن خطة مدفوعة.",
          relay: "غالبًا اشتراك منفصل.",
        },
      ],
      footnoteLabel: "مقايضة",
      footnote:
        "عندما يتعذّر الوصول عبر مسار SSH مباشر (بسبب CGNAT أو موجّه مقيَّد)، يضيف التحوّل إلى Tor زمن استجابة لا تواجهه خدمة سحابية دائمًا. نرى أن إبقاء حركة بياناتك خارج خوادمنا يستحقّ ذلك؛ وداخل شبكتك، يكون وضع الشبكة المحلية فقط أسرع مسار على الإطلاق.",
    },
  },
};

/**
 * 라이브 렌더 로케일 — web 은 아직 locale 라우팅이 없어 영어로 렌더한다
 * (layout 의 lang="en" 과 일치). i18n 을 켜면 이 기본값 대신 요청 locale 을 넘기면 된다.
 */
export const DEFAULT_LOCALE: Locale = "en";

/** locale 선택자 — i18n 준비됨. 미지원/누락 locale 은 기본(en)으로 안전 폴백. */
export function getDifferentiators(locale: Locale = DEFAULT_LOCALE): Differentiators {
  return CONTENT[locale] ?? CONTENT[DEFAULT_LOCALE];
}

/** 컴포넌트가 곧장 쓰는 라이브(en) 콘텐츠. */
export const differentiators = CONTENT[DEFAULT_LOCALE];
