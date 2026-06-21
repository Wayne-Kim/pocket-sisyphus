// PO 프롬프트 다국어 카탈로그 — «리서치(research)» 빌더 (buildPoResearchPrompt).
//
// ko 는 SSOT — prompt.ts 의 기존 리터럴과 byte-identical. scope(web_repo/repo_only) 분기는
// 빌더가 web/repo 변형을 골라 본문 템플릿의 {{placeholder}} 에 끼운다.

import type { Msg } from "./locale.js";

export const researchMessages = {
  // ── 도입 (intro) ────────────────────────────────────────────────────────────
  "research.intro.web": {
    ar: "طلب المستخدم «بحثاً» في الموضوع أدناه — نفّذ جمع المواد ودراسة السوق واكتب تقريراً، ثم اصنع بريفات فرص بناءً على نتائجه.",
    en: "The user requested «research» on the topic below — perform material gathering and market research, write a report, and create opportunity briefs based on its results.",
    es: "El usuario solicitó «investigación» sobre el tema de abajo — realiza la recopilación de material y la investigación de mercado, escribe un informe y crea briefs de oportunidad basados en sus resultados.",
    fr: "L'utilisateur a demandé une «recherche» sur le sujet ci-dessous — effectue la collecte de matériel et l'étude de marché, rédige un rapport, et crée des briefs d'opportunité basés sur ses résultats.",
    hi: "उपयोगकर्ता ने नीचे दिए विषय पर «शोध» का अनुरोध किया — सामग्री संग्रह व बाज़ार अध्ययन करें, एक रिपोर्ट लिखें, और उसके परिणामों के आधार पर अवसर-ब्रीफ़ बनाएँ।",
    ja: "ユーザーは下記の主題の「リサーチ」を要求した — 資料収集と市場調査を行って報告書を書き、その結果を根拠に機会ブリーフを作れ。",
    ko: "사용자가 아래 주제의 «리서치» 를 요청했다 — 자료 수집과 시장 조사를 수행해 보고서를 쓰고, 그 결과를 근거로 기회 브리프를 만들어라.",
    "pt-BR": "O usuário solicitou «pesquisa» sobre o tema abaixo — realize a coleta de material e a pesquisa de mercado, escreva um relatório e crie briefs de oportunidade com base em seus resultados.",
    ru: "Пользователь запросил «исследование» по теме ниже — выполните сбор материалов и исследование рынка, напишите отчёт и создайте брифы возможностей на основе его результатов.",
    "zh-Hans": "用户请求对下方主题进行「调研」——执行资料收集与市场调研,撰写报告,并基于其结果创建机会简报。",
  },
  "research.intro.repo": {
    ar: "طلب المستخدم «بحثاً» في الموضوع أدناه واختار نطاق «المستودع فقط» — دون بحث على الويب، ابحث هذا المستودع فقط واكتب تقريراً، ثم اصنع بريفات فرص بناءً على نتائجه.",
    en: "The user requested «research» on the topic below and chose the «repo only» scope — without web search, investigate this repo only and write a report, then create opportunity briefs based on its results.",
    es: "El usuario solicitó «investigación» sobre el tema de abajo y eligió el alcance «solo repo» — sin búsqueda web, investiga solo este repo y escribe un informe, luego crea briefs de oportunidad basados en sus resultados.",
    fr: "L'utilisateur a demandé une «recherche» sur le sujet ci-dessous et a choisi la portée «dépôt seul» — sans recherche web, investigue ce dépôt uniquement et rédige un rapport, puis crée des briefs d'opportunité basés sur ses résultats.",
    hi: "उपयोगकर्ता ने नीचे दिए विषय पर «शोध» का अनुरोध किया और «केवल रेपो» दायरा चुना — वेब खोज के बिना, केवल इस रेपो की जाँच करें और एक रिपोर्ट लिखें, फिर उसके परिणामों के आधार पर अवसर-ब्रीफ़ बनाएँ।",
    ja: "ユーザーは下記の主題の「リサーチ」を要求し「リポジトリのみ」の範囲を選んだ — ウェブ検索なしでこのリポジトリのみを調査して報告書を書き、その結果を根拠に機会ブリーフを作れ。",
    ko: "사용자가 아래 주제의 «리서치» 를 요청하며 «레포만» 범위를 골랐다 — 웹 검색 없이 이 레포만 조사해 보고서를 쓰고, 그 결과를 근거로 기회 브리프를 만들어라.",
    "pt-BR": "O usuário solicitou «pesquisa» sobre o tema abaixo e escolheu o escopo «apenas repo» — sem busca na web, investigue apenas este repo e escreva um relatório, depois crie briefs de oportunidade com base em seus resultados.",
    ru: "Пользователь запросил «исследование» по теме ниже и выбрал охват «только репозиторий» — без веб-поиска исследуйте только этот репозиторий и напишите отчёт, затем создайте брифы возможностей на основе его результатов.",
    "zh-Hans": "用户请求对下方主题进行「调研」并选择了「仅仓库」范围——不进行网络搜索,仅调研本仓库并撰写报告,然后基于其结果创建机会简报。",
  },

  // ── 1단계 조사 (investigation) ───────────────────────────────────────────────
  "research.investigation.web": {
    ar: `- **بحث الويب (الأساس)**: ابحث في الويب عن منتجات منافسة/مشابهة، وإشارات طلب السوق (نقاشات المجتمع·المراجعات)، وأفضل الممارسات، ومواد المراجعة التقنية. **اترك URL المصدر لكل ادّعاء** — لا يُكتب في التقرير ادّعاء بلا URL. إن تعذّر بحث الويب في البيئة فبيّن ذلك في التقرير وتابع ببحث المستودع.
- **سياق المستودع**: اقرأ الحالة الحالية لهذا المستودع (README، البنية، الكود ذو الصلة) لتفهم كيف يمسّ الموضوع هذا المنتج.`,
    en: `- **Web research (core)**: search the web for competing/similar products, market-demand signals (community discussions·reviews), best practices, and technical review materials. **Leave a source URL for every claim** — a claim without a URL cannot go in the report. If web search is impossible in the environment, state that in the report and proceed with repo research.
- **Repo context**: read this repo's current state (README, structure, related code) to understand how the topic touches this product.`,
    es: `- **Investigación web (núcleo)**: busca en la web productos competidores/similares, señales de demanda del mercado (discusiones de la comunidad·reseñas), mejores prácticas y materiales de revisión técnica. **Deja una URL de fuente para cada afirmación** — una afirmación sin URL no puede ir en el informe. Si la búsqueda web es imposible en el entorno, indícalo en el informe y procede con la investigación del repo.
- **Contexto del repo**: lee el estado actual de este repo (README, estructura, código relacionado) para entender cómo toca el tema a este producto.`,
    fr: `- **Recherche web (cœur)**: cherche sur le web des produits concurrents/similaires, des signaux de demande du marché (discussions communautaires·avis), des bonnes pratiques et des documents de revue technique. **Laisse une URL source pour chaque affirmation** — une affirmation sans URL ne peut pas figurer dans le rapport. Si la recherche web est impossible dans l'environnement, indique-le dans le rapport et procède à la recherche du dépôt.
- **Contexte du dépôt**: lis l'état actuel de ce dépôt (README, structure, code lié) pour comprendre comment le sujet touche ce produit.`,
    hi: `- **वेब शोध (मुख्य)**: वेब पर प्रतिस्पर्धी/समान उत्पाद, बाज़ार-माँग संकेत (समुदाय चर्चा·समीक्षाएँ), सर्वोत्तम अभ्यास, और तकनीकी समीक्षा सामग्री खोजें। **हर दावे के लिए स्रोत URL छोड़ें** — URL बिना दावा रिपोर्ट में नहीं जा सकता। यदि परिवेश में वेब खोज असंभव हो तो रिपोर्ट में बताएँ और रेपो शोध के साथ आगे बढ़ें।
- **रेपो संदर्भ**: इस रेपो की वर्तमान स्थिति (README, संरचना, संबंधित कोड) पढ़कर समझें कि विषय इस उत्पाद को कैसे छूता है।`,
    ja: `- **ウェブ調査(核心)**: ウェブ検索で競合/類似製品、市場需要の信号(コミュニティ議論·レビュー)、ベストプラクティス、技術レビュー資料を探せ。**すべての主張に出典 URL を残せ** — URL のない主張は報告書に書けない。環境でウェブ検索が不可能ならその事実を報告書に明示し、リポジトリ調査で進めよ。
- **リポジトリの文脈**: このリポジトリの現状(README、構造、関連コード)を読み、主題がこの製品にどう触れるかを把握せよ。`,
    ko: `- **웹 조사 (핵심)**: 웹 검색으로 경쟁/유사 제품, 시장 수요 신호(커뮤니티 논의·리뷰), 모범 사례, 기술 검토 자료를 찾아라. **모든 주장에 출처 URL 을 남겨라** — URL 없는 주장은 보고서에 못 쓴다. 웹 검색이 불가능한 환경이면 그 사실을 보고서에 명시하고 레포 조사로 진행하라.
- **레포 컨텍스트**: 이 레포의 현재 상태(README, 구조, 관련 코드)를 읽어 주제가 이 제품에 어떻게 닿는지 파악하라.`,
    "pt-BR": `- **Pesquisa web (núcleo)**: busque na web produtos concorrentes/similares, sinais de demanda de mercado (discussões da comunidade·avaliações), melhores práticas e materiais de revisão técnica. **Deixe uma URL de fonte para cada afirmação** — uma afirmação sem URL não pode ir no relatório. Se a busca web for impossível no ambiente, indique isso no relatório e prossiga com a pesquisa do repo.
- **Contexto do repo**: leia o estado atual deste repo (README, estrutura, código relacionado) para entender como o tema toca este produto.`,
    ru: `- **Веб-исследование (ядро)**: ищите в вебе конкурирующие/похожие продукты, сигналы рыночного спроса (обсуждения сообщества·отзывы), лучшие практики и материалы технического обзора. **Оставляйте URL источника для каждого утверждения** — утверждение без URL не может попасть в отчёт. Если веб-поиск невозможен в среде, укажите это в отчёте и продолжайте с исследованием репозитория.
- **Контекст репозитория**: прочитайте текущее состояние этого репозитория (README, структура, связанный код), чтобы понять, как тема касается этого продукта.`,
    "zh-Hans": `- **网络调研(核心)**: 在网络上搜索竞争/同类产品、市场需求信号(社区讨论·评价)、最佳实践与技术评审资料。**为每个主张留下来源 URL**——没有 URL 的主张不能写入报告。若环境中无法进行网络搜索,在报告中说明并以仓库调研推进。
- **仓库上下文**: 阅读本仓库当前状态(README、结构、相关代码),理解主题如何触及本产品。`,
  },
  "research.investigation.repo": {
    ar: `- **بحث المستودع فقط — ممنوع بحث الويب**: اختار المستخدم نطاق «المستودع فقط» (تحليل خفيف وسريع). «لا تبحث» في الويب. ابحث الموضوع بكود·وثائق (README·docs)·قضايا·تاريخ git هذا المستودع فقط — اعثر على سند كل ادّعاء داخل المستودع (ملف:سطر، sha الكوميت، رقم القضية).
- **سياق المستودع**: اقرأ الحالة الحالية لهذا المستودع (README، البنية، الكود ذو الصلة) لتفهم كيف يمسّ الموضوع هذا المنتج.`,
    en: `- **Repo-only research — no web search**: the user chose the «repo only» scope (a light, fast analysis). «Do not» search the web. Investigate the topic using only this repo's code·docs (README·docs)·issues·git history — find evidence for every claim within the repo (file:line, commit sha, issue number).
- **Repo context**: read this repo's current state (README, structure, related code) to understand how the topic touches this product.`,
    es: `- **Investigación solo-repo — sin búsqueda web**: el usuario eligió el alcance «solo repo» (un análisis ligero y rápido). «No» busques en la web. Investiga el tema usando solo el código·docs (README·docs)·issues·historial git de este repo — encuentra evidencia de cada afirmación dentro del repo (archivo:línea, sha de commit, número de issue).
- **Contexto del repo**: lee el estado actual de este repo (README, estructura, código relacionado) para entender cómo toca el tema a este producto.`,
    fr: `- **Recherche dépôt-seul — pas de recherche web**: l'utilisateur a choisi la portée «dépôt seul» (une analyse légère et rapide). «Ne» cherche «pas» sur le web. Investigue le sujet en utilisant uniquement le code·docs (README·docs)·issues·historique git de ce dépôt — trouve une preuve pour chaque affirmation dans le dépôt (fichier:ligne, sha de commit, numéro d'issue).
- **Contexte du dépôt**: lis l'état actuel de ce dépôt (README, structure, code lié) pour comprendre comment le sujet touche ce produit.`,
    hi: `- **केवल-रेपो शोध — कोई वेब खोज नहीं**: उपयोगकर्ता ने «केवल रेपो» दायरा चुना (हल्का, तेज़ विश्लेषण)। वेब पर «मत» खोजें। विषय की जाँच केवल इस रेपो के कोड·docs (README·docs)·issues·git इतिहास से करें — हर दावे का साक्ष्य रेपो के भीतर खोजें (फ़ाइल:लाइन, commit sha, issue संख्या)।
- **रेपो संदर्भ**: इस रेपो की वर्तमान स्थिति (README, संरचना, संबंधित कोड) पढ़कर समझें कि विषय इस उत्पाद को कैसे छूता है।`,
    ja: `- **リポジトリのみ調査 — ウェブ検索禁止**: ユーザーは「リポジトリのみ」の範囲を選んだ(軽く速い分析)。ウェブを「検索するな」。主題はこのリポジトリのコード·文書(README·docs)·課題·git 履歴のみで調査せよ — すべての主張の根拠をリポジトリ内(ファイル:行、コミット sha、課題番号)で見つけよ。
- **リポジトリの文脈**: このリポジトリの現状(README、構造、関連コード)を読み、主題がこの製品にどう触れるかを把握せよ。`,
    ko: `- **레포만 조사 — 웹 검색 금지**: 사용자가 «레포만» 범위를 선택했다 (가벼운 분석을 빠르게). 웹 검색을 «하지 마라». 이 레포의 코드·문서(README·docs)·이슈·git 이력만으로 주제를 조사하라 — 모든 주장의 근거를 레포 안에서(파일:라인, 커밋 sha, 이슈 번호) 찾아라.
- **레포 컨텍스트**: 이 레포의 현재 상태(README, 구조, 관련 코드)를 읽어 주제가 이 제품에 어떻게 닿는지 파악하라.`,
    "pt-BR": `- **Pesquisa apenas-repo — sem busca web**: o usuário escolheu o escopo «apenas repo» (uma análise leve e rápida). «Não» busque na web. Investigue o tema usando apenas o código·docs (README·docs)·issues·histórico git deste repo — encontre evidência para cada afirmação dentro do repo (arquivo:linha, sha de commit, número de issue).
- **Contexto do repo**: leia o estado atual deste repo (README, estrutura, código relacionado) para entender como o tema toca este produto.`,
    ru: `- **Исследование только-репозиторий — без веб-поиска**: пользователь выбрал охват «только репозиторий» (лёгкий, быстрый анализ). «Не» ищите в вебе. Исследуйте тему, используя только код·документы (README·docs)·issue·историю git этого репозитория — найдите доказательство каждого утверждения внутри репозитория (файл:строка, sha коммита, номер issue).
- **Контекст репозитория**: прочитайте текущее состояние этого репозитория (README, структура, связанный код), чтобы понять, как тема касается этого продукта.`,
    "zh-Hans": `- **仅仓库调研 — 禁止网络搜索**: 用户选择了「仅仓库」范围(轻量、快速的分析)。「不要」搜索网络。仅用本仓库的代码·文档(README·docs)·issue·git 历史调研主题——在仓库内为每个主张找到依据(文件:行、提交 sha、issue 编号)。
- **仓库上下文**: 阅读本仓库当前状态(README、结构、相关代码),理解主题如何触及本产品。`,
  },

  // ── 2단계 보고서 구성 (reportStructure) ─────────────────────────────────────
  "research.reportStructure.web": {
    ar: `البنية: ملخص(3 أسطر) → نتائج البحث (URL مصدر لكل ادّعاء) → وضع المنافسة/البدائل → الانعكاسات على هذا المنتج → التوصية. ليكن الطول وافياً لكن قابلاً للقراءة على الجوال (نحو 500~1500 كلمة).`,
    en: `Structure: summary (3 lines) → research findings (a source URL per claim) → competition/alternatives landscape → implications for this product → recommendation. Keep the length substantial but readable on mobile (roughly 500~1500 words).`,
    es: `Estructura: resumen (3 líneas) → hallazgos de la investigación (una URL de fuente por afirmación) → panorama de competencia/alternativas → implicaciones para este producto → recomendación. Mantén la longitud sustancial pero legible en móvil (aproximadamente 500~1500 palabras).`,
    fr: `Structure: résumé (3 lignes) → résultats de la recherche (une URL source par affirmation) → paysage concurrence/alternatives → implications pour ce produit → recommandation. Garde une longueur substantielle mais lisible sur mobile (environ 500~1500 mots).`,
    hi: `संरचना: सारांश (3 पंक्तियाँ) → शोध निष्कर्ष (प्रत्येक दावे हेतु एक स्रोत URL) → प्रतिस्पर्धा/विकल्प परिदृश्य → इस उत्पाद के लिए निहितार्थ → सिफ़ारिश। लंबाई पर्याप्त रखें पर मोबाइल पर पठनीय (लगभग 500~1500 शब्द)।`,
    ja: `構成: 要約(3行) → 調査の発見(主張ごとに出典 URL) → 競合/代替の状況 → この製品への含意 → 推奨。分量は充実しつつモバイルで読める程度に(おおよそ 500~1500 語)。`,
    ko: `구성: 요약(3줄) → 조사 발견(주장마다 출처 URL) → 경쟁/대안 현황 → 이 제품에의 함의 → 권고. 분량은 충실하되 모바일에서 읽을 수 있게 (대략 500~1500 단어).`,
    "pt-BR": `Estrutura: resumo (3 linhas) → achados da pesquisa (uma URL de fonte por afirmação) → panorama de concorrência/alternativas → implicações para este produto → recomendação. Mantenha a extensão substancial mas legível no celular (aproximadamente 500~1500 palavras).`,
    ru: `Структура: резюме (3 строки) → результаты исследования (URL источника на каждое утверждение) → ландшафт конкуренции/альтернатив → последствия для этого продукта → рекомендация. Держите объём содержательным, но читаемым на мобильном (примерно 500~1500 слов).`,
    "zh-Hans": `结构: 摘要(3 行) → 调研发现(每个主张附来源 URL) → 竞争/替代格局 → 对本产品的影响 → 建议。篇幅充实但适合手机阅读(大约 500~1500 字)。`,
  },
  "research.reportStructure.repo": {
    ar: `**اكتب في أعلى التقرير سطراً واحداً «نطاق البحث: المستودع فقط (دون استخدام الويب)»** — ليتّضح أنها نتيجة من المستودع فقط دون سند سوق/منافسة.
البنية: (سطر النطاق) → ملخص(3 أسطر) → نتائج البحث (سند مستودع لكل ادّعاء — ملف:سطر/كوميت/قضية) → الانعكاسات على هذا المنتج → التوصية. يجوز حذف فقرة «وضع المنافسة/البدائل» لأنك لم تستخدم الويب (لا تملأها بالتخمين قسراً). ليكن الطول وافياً لكن قابلاً للقراءة على الجوال (نحو 400~1200 كلمة).`,
    en: `**At the top of the report, state in one line «Research scope: repo only (no web used)»** — so it is clear this is a repo-only result without market/competition evidence.
Structure: (scope line) → summary (3 lines) → research findings (a repo evidence per claim — file:line/commit/issue) → implications for this product → recommendation. You may omit the «competition/alternatives landscape» section since you did not use the web (do not fill it forcibly by guessing). Keep the length substantial but readable on mobile (roughly 400~1200 words).`,
    es: `**En la parte superior del informe, indica en una línea «Alcance de investigación: solo repo (sin uso de web)»** — para que quede claro que es un resultado solo-repo sin evidencia de mercado/competencia.
Estructura: (línea de alcance) → resumen (3 líneas) → hallazgos de la investigación (una evidencia del repo por afirmación — archivo:línea/commit/issue) → implicaciones para este producto → recomendación. Puedes omitir la sección «panorama de competencia/alternativas» ya que no usaste la web (no la rellenes a la fuerza adivinando). Mantén la longitud sustancial pero legible en móvil (aproximadamente 400~1200 palabras).`,
    fr: `**En haut du rapport, indique en une ligne «Portée de recherche: dépôt seul (sans usage du web)»** — pour qu'il soit clair que c'est un résultat dépôt-seul sans preuve de marché/concurrence.
Structure: (ligne de portée) → résumé (3 lignes) → résultats de la recherche (une preuve du dépôt par affirmation — fichier:ligne/commit/issue) → implications pour ce produit → recommandation. Tu peux omettre la section «paysage concurrence/alternatives» puisque tu n'as pas utilisé le web (ne la remplis pas de force en devinant). Garde une longueur substantielle mais lisible sur mobile (environ 400~1200 mots).`,
    hi: `**रिपोर्ट के शीर्ष पर एक पंक्ति में «शोध दायरा: केवल रेपो (वेब का उपयोग नहीं)» लिखें** — ताकि स्पष्ट हो कि यह बाज़ार/प्रतिस्पर्धा साक्ष्य के बिना केवल-रेपो परिणाम है।
संरचना: (दायरा पंक्ति) → सारांश (3 पंक्तियाँ) → शोध निष्कर्ष (प्रत्येक दावे हेतु एक रेपो साक्ष्य — फ़ाइल:लाइन/commit/issue) → इस उत्पाद के लिए निहितार्थ → सिफ़ारिश। चूँकि आपने वेब का उपयोग नहीं किया, «प्रतिस्पर्धा/विकल्प परिदृश्य» खंड छोड़ सकते हैं (अनुमान से ज़बरदस्ती न भरें)। लंबाई पर्याप्त रखें पर मोबाइल पर पठनीय (लगभग 400~1200 शब्द)।`,
    ja: `**報告書の最上部に「調査範囲: リポジトリのみ(ウェブ未使用)」を一行で明記せよ** — 市場/競合の根拠なしにリポジトリのみを見た結果だと分かるように。
構成: (範囲明記行) → 要約(3行) → 調査の発見(主張ごとにリポジトリ根拠 — ファイル:行/コミット/課題) → この製品への含意 → 推奨。ウェブを使っていないので「競合/代替の状況」節は省略してよい(推測で無理に埋めるな)。分量は充実しつつモバイルで読める程度に(おおよそ 400~1200 語)。`,
    ko: `**보고서 맨 위에 «조사 범위: 레포만 (웹 미사용)» 을 한 줄로 명시하라** — 시장/경쟁 근거 없이 레포만 본 결과임이 드러나게.
구성: (범위 명시 줄) → 요약(3줄) → 조사 발견(주장마다 레포 근거 — 파일:라인/커밋/이슈) → 이 제품에의 함의 → 권고. «경쟁/대안 현황» 절은 웹을 안 썼으니 생략해도 된다(억지로 추측해 채우지 마라). 분량은 충실하되 모바일에서 읽을 수 있게 (대략 400~1200 단어).`,
    "pt-BR": `**No topo do relatório, indique em uma linha «Escopo de pesquisa: apenas repo (sem uso da web)»** — para deixar claro que é um resultado apenas-repo sem evidência de mercado/concorrência.
Estrutura: (linha de escopo) → resumo (3 linhas) → achados da pesquisa (uma evidência do repo por afirmação — arquivo:linha/commit/issue) → implicações para este produto → recomendação. Você pode omitir a seção «panorama de concorrência/alternativas» já que não usou a web (não a preencha à força adivinhando). Mantenha a extensão substancial mas legível no celular (aproximadamente 400~1200 palavras).`,
    ru: `**В начале отчёта укажите одной строкой «Охват исследования: только репозиторий (веб не использовался)»** — чтобы было ясно, что это результат только по репозиторию без рыночных/конкурентных данных.
Структура: (строка охвата) → резюме (3 строки) → результаты исследования (доказательство из репозитория на каждое утверждение — файл:строка/коммит/issue) → последствия для этого продукта → рекомендация. Можете опустить раздел «ландшафт конкуренции/альтернатив», так как веб не использовался (не заполняйте его насильно догадками). Держите объём содержательным, но читаемым на мобильном (примерно 400~1200 слов).`,
    "zh-Hans": `**在报告最上方用一行注明「调研范围: 仅仓库(未使用网络)」**——以表明这是在没有市场/竞争依据下仅看仓库的结果。
结构: (范围注明行) → 摘要(3 行) → 调研发现(每个主张附一条仓库依据——文件:行/提交/issue) → 对本产品的影响 → 建议。由于未使用网络,可省略「竞争/替代格局」一节(不要凭猜测强行填充)。篇幅充实但适合手机阅读(大约 400~1200 字)。`,
  },

  // ── 3단계 브리프 근거 규칙 (evidenceRule) ───────────────────────────────────
  "research.evidenceRule.web": {
    ar: `- استخدم في kind ضمن evidence: "web"(مصدر ويب — ref يجب أن يكون URL) / "market"(إشارة سوق — ref هو URL) / "repo"(سند مستودع — ملف:سطر) / "user_directive"(طلب البحث نفسه).
- **يجب أن يتضمّن كل بريف سنداً web/market واحداً على الأقل** — لا تصنع بريفاً لا يدعمه البحث. إن كان الاستنتاج «يجب ألا نفعل» فبريف بعدد 0 (مصفوفة فارغة) إجابة صحيحة أيضاً — ضع سبب ذلك في التقرير.`,
    en: `- For evidence's kind use: "web" (web source — ref must be a URL) / "market" (market signal — ref is a URL) / "repo" (repo evidence — file:line) / "user_directive" (the research request itself).
- **Each brief must include at least one web/market evidence** — do not make a brief the research does not support. If the conclusion is «should not do this», zero briefs (empty array) is also a correct answer — put the reason in the report.`,
    es: `- Para el kind de evidence usa: "web" (fuente web — ref debe ser una URL) / "market" (señal de mercado — ref es una URL) / "repo" (evidencia del repo — archivo:línea) / "user_directive" (la propia solicitud de investigación).
- **Cada brief debe incluir al menos una evidencia web/market** — no hagas un brief que la investigación no respalde. Si la conclusión es «no se debe hacer esto», cero briefs (array vacío) también es una respuesta correcta — pon la razón en el informe.`,
    fr: `- Pour le kind de evidence utilise: "web" (source web — ref doit être une URL) / "market" (signal de marché — ref est une URL) / "repo" (preuve du dépôt — fichier:ligne) / "user_directive" (la demande de recherche elle-même).
- **Chaque brief doit inclure au moins une preuve web/market** — ne fais pas un brief que la recherche ne soutient pas. Si la conclusion est «ne pas faire cela», zéro brief (tableau vide) est aussi une réponse correcte — mets la raison dans le rapport.`,
    hi: `- evidence के kind हेतु उपयोग करें: "web" (वेब स्रोत — ref अवश्य URL हो) / "market" (बाज़ार संकेत — ref URL है) / "repo" (रेपो साक्ष्य — फ़ाइल:लाइन) / "user_directive" (शोध अनुरोध स्वयं)।
- **हर ब्रीफ़ में कम से कम एक web/market साक्ष्य हो** — ऐसा ब्रीफ़ न बनाएँ जिसे शोध समर्थन न दे। यदि निष्कर्ष «यह नहीं करना चाहिए» हो, तो शून्य ब्रीफ़ (खाली array) भी सही उत्तर है — कारण रिपोर्ट में डालें।`,
    ja: `- evidence の kind は次を使え: "web"(ウェブ出典 — ref は必ず URL) / "market"(市場信号 — ref は URL) / "repo"(リポジトリ根拠 — ファイル:行) / "user_directive"(このリサーチ要求自体)。
- **各ブリーフは web/market 根拠を最低1つ含むこと** — 調査が裏付けないブリーフを作るな。結論が「やるべきでない」なら、ブリーフ0件(空配列)も正解だ — その理由を報告書に入れよ。`,
    ko: `- evidence 의 kind 는 "web"(웹 출처 — ref 는 반드시 URL) / "market"(시장 신호 — ref 는 URL) / "repo"(레포 근거 — 파일:라인) / "user_directive"(이 리서치 요청 자체) 를 쓴다.
- **각 브리프는 web/market 근거를 최소 1개** 포함해야 한다 — 조사가 뒷받침하지 않는 브리프는 만들지 마라. 조사 결과 «하지 말아야 한다» 는 결론이면 브리프 0건(빈 배열)도 정답이다 — 그 이유는 보고서에 담아라.`,
    "pt-BR": `- Para o kind de evidence use: "web" (fonte web — ref deve ser uma URL) / "market" (sinal de mercado — ref é uma URL) / "repo" (evidência do repo — arquivo:linha) / "user_directive" (a própria solicitação de pesquisa).
- **Cada brief deve incluir pelo menos uma evidência web/market** — não faça um brief que a pesquisa não sustente. Se a conclusão for «não se deve fazer isto», zero briefs (array vazio) também é uma resposta correta — coloque o motivo no relatório.`,
    ru: `- Для kind у evidence используйте: "web" (веб-источник — ref должен быть URL) / "market" (рыночный сигнал — ref это URL) / "repo" (доказательство из репозитория — файл:строка) / "user_directive" (сам запрос на исследование).
- **Каждый бриф должен включать хотя бы одно web/market доказательство** — не создавайте бриф, который исследование не подтверждает. Если вывод «не стоит этого делать», ноль брифов (пустой массив) — тоже правильный ответ — укажите причину в отчёте.`,
    "zh-Hans": `- evidence 的 kind 使用: "web"(网络来源——ref 必须为 URL) / "market"(市场信号——ref 为 URL) / "repo"(仓库依据——文件:行) / "user_directive"(本次调研请求本身)。
- **每条简报至少包含一条 web/market 依据**——不要做调研不支持的简报。若结论是「不应做此事」,则零条简报(空数组)也是正确答案——把理由写入报告。`,
  },
  "research.evidenceRule.repo": {
    ar: `- استخدم في kind ضمن evidence: "repo"(سند مستودع — ملف:سطر/كوميت/قضية) / "user_directive"(طلب البحث نفسه) — لم تستخدم الويب فلا يوجد سند web/market.
- **يجب أن يتضمّن كل بريف سند مستودع (repo) واحداً على الأقل** — لا تصنع بريفاً لا يدعمه المستودع. إن ضعف سند المستودع ولم يوجد بريف فبريف بعدد 0 (مصفوفة فارغة) إجابة صحيحة — ضع سبب ذلك في التقرير.`,
    en: `- For evidence's kind use: "repo" (repo evidence — file:line/commit/issue) / "user_directive" (the research request itself) — since you did not use the web, there is no web/market evidence.
- **Each brief must include at least one repo evidence (repo)** — do not make a brief the repo does not support. If the repo evidence is weak and there is no brief to make, zero briefs (empty array) is a correct answer — put the reason in the report.`,
    es: `- Para el kind de evidence usa: "repo" (evidencia del repo — archivo:línea/commit/issue) / "user_directive" (la propia solicitud de investigación) — como no usaste la web, no hay evidencia web/market.
- **Cada brief debe incluir al menos una evidencia del repo (repo)** — no hagas un brief que el repo no respalde. Si la evidencia del repo es débil y no hay brief que hacer, cero briefs (array vacío) es una respuesta correcta — pon la razón en el informe.`,
    fr: `- Pour le kind de evidence utilise: "repo" (preuve du dépôt — fichier:ligne/commit/issue) / "user_directive" (la demande de recherche elle-même) — comme tu n'as pas utilisé le web, il n'y a pas de preuve web/market.
- **Chaque brief doit inclure au moins une preuve du dépôt (repo)** — ne fais pas un brief que le dépôt ne soutient pas. Si la preuve du dépôt est faible et qu'il n'y a pas de brief à faire, zéro brief (tableau vide) est une réponse correcte — mets la raison dans le rapport.`,
    hi: `- evidence के kind हेतु उपयोग करें: "repo" (रेपो साक्ष्य — फ़ाइल:लाइन/commit/issue) / "user_directive" (शोध अनुरोध स्वयं) — चूँकि आपने वेब का उपयोग नहीं किया, web/market साक्ष्य नहीं है।
- **हर ब्रीफ़ में कम से कम एक रेपो साक्ष्य (repo) हो** — ऐसा ब्रीफ़ न बनाएँ जिसे रेपो समर्थन न दे। यदि रेपो साक्ष्य कमज़ोर हो और बनाने को ब्रीफ़ न हो, तो शून्य ब्रीफ़ (खाली array) सही उत्तर है — कारण रिपोर्ट में डालें।`,
    ja: `- evidence の kind は次を使え: "repo"(リポジトリ根拠 — ファイル:行/コミット/課題) / "user_directive"(このリサーチ要求自体) — ウェブを使っていないので web/market 根拠はない。
- **各ブリーフはリポジトリ根拠(repo)を最低1つ含むこと** — リポジトリが裏付けないブリーフを作るな。リポジトリ根拠が弱く作るブリーフがなければ、ブリーフ0件(空配列)も正解だ — その理由を報告書に入れよ。`,
    ko: `- evidence 의 kind 는 "repo"(레포 근거 — 파일:라인/커밋/이슈) / "user_directive"(이 리서치 요청 자체) 를 쓴다 — 웹을 안 썼으니 web/market 근거는 없다.
- **각 브리프는 레포 근거(repo)를 최소 1개** 포함해야 한다 — 레포가 뒷받침하지 않는 브리프는 만들지 마라. 레포 근거가 약해 만들 브리프가 없으면 브리프 0건(빈 배열)도 정답이다 — 그 사유는 보고서에 담아라.`,
    "pt-BR": `- Para o kind de evidence use: "repo" (evidência do repo — arquivo:linha/commit/issue) / "user_directive" (a própria solicitação de pesquisa) — como você não usou a web, não há evidência web/market.
- **Cada brief deve incluir pelo menos uma evidência do repo (repo)** — não faça um brief que o repo não sustente. Se a evidência do repo for fraca e não houver brief a fazer, zero briefs (array vazio) é uma resposta correta — coloque o motivo no relatório.`,
    ru: `- Для kind у evidence используйте: "repo" (доказательство из репозитория — файл:строка/коммит/issue) / "user_directive" (сам запрос на исследование) — поскольку веб не использовался, web/market доказательств нет.
- **Каждый бриф должен включать хотя бы одно доказательство из репозитория (repo)** — не создавайте бриф, который репозиторий не подтверждает. Если доказательства из репозитория слабы и брифа нет, ноль брифов (пустой массив) — правильный ответ — укажите причину в отчёте.`,
    "zh-Hans": `- evidence 的 kind 使用: "repo"(仓库依据——文件:行/提交/issue) / "user_directive"(本次调研请求本身)——由于未使用网络,没有 web/market 依据。
- **每条简报至少包含一条仓库依据(repo)**——不要做仓库不支持的简报。若仓库依据薄弱且无简报可做,则零条简报(空数组)是正确答案——把理由写入报告。`,
  },

  // ── 본문 (body) ─────────────────────────────────────────────────────────────
  "research.body": {
    ar: `{{persona}} {{intro}} لا تعدّل الكود — ابحث فقط.

## موضوع البحث (طلب المستخدم)
{{topic}}
{{history}}
{{designContext}}
{{lensBlock}}
## المرحلة 1 — البحث
{{investigation}}

## المرحلة 2 — كتابة التقرير
اكتب تقرير markdown في المسار التالي:
{{reportFile}}

{{reportStructure}}

## المرحلة 3 — بريفات الفرص (بناءً على التقرير، 4 كحد أقصى)
اكتب «مصفوفة» JSON في المسار التالي:
{{briefsFile}}

المخطط نفسه كالتجميع: { "title", "problem", "evidence": [{"kind","ref","summary"}], "impact": 1-5, "effort": 1-5, "scope", "spec", "dedup": {"relation":"new|refinement","ofTitle"} }.
{{evidenceRule}}
- **معايير قبول التصميم (للبريفات التي تمسّ واجهة المستخدم فقط)**: اعكس «قيود التصميم» أعلاه في معايير قبول spec — «معنى» اللون المستخدم (رموز/عهود هذا المستودع)، i18n للنصوص المعروضة («كامل مجموعة» اللغات المدعومة في هذا المستودع)، الحالات (فارغ/خطأ/تحميل/معطّل/تركيز)، إمكانية الوصول (تسميات·تباين). لا تثبّت لوناً/عدد لغات معيّناً بل «كما حدّده هذا المستودع». لا تدرجها في البريفات بلا واجهة.
{{dedup}}

{{backlog}}

بعد كتابة الملفّين، أنهِ بسطر واحد «اكتمل البحث — N بريف».{{outputDirective}}`,
    en: `{{persona}} {{intro}} Do not modify code — only investigate.

## Research topic (user request)
{{topic}}
{{history}}
{{designContext}}
{{lensBlock}}
## Step 1 — Investigation
{{investigation}}

## Step 2 — Write the report
Write a markdown report to the following path:
{{reportFile}}

{{reportStructure}}

## Step 3 — Opportunity briefs (based on the report, up to 4)
Write a JSON «array» to the following path:
{{briefsFile}}

The schema is the same as collection: { "title", "problem", "evidence": [{"kind","ref","summary"}], "impact": 1-5, "effort": 1-5, "scope", "spec", "dedup": {"relation":"new|refinement","ofTitle"} }.
{{evidenceRule}}
- **Design acceptance criteria (only for briefs that touch the UI)**: reflect the «Design constraints» above in spec's acceptance criteria — the «meaning» of the colors used (this repo's tokens/commitments), i18n of user-facing strings (the «entire set» of locales this repo supports), states (empty/error/loading/disabled/focus), accessibility (labels·contrast). Do not hardcode a specific color/locale count — «as this repo defines». Do not add this to briefs with no UI surface.
{{dedup}}

{{backlog}}

After writing both files, end with one line: «Research complete — N briefs».{{outputDirective}}`,
    es: `{{persona}} {{intro}} No modifiques código — solo investiga.

## Tema de investigación (solicitud del usuario)
{{topic}}
{{history}}
{{designContext}}
{{lensBlock}}
## Paso 1 — Investigación
{{investigation}}

## Paso 2 — Escribe el informe
Escribe un informe markdown en la siguiente ruta:
{{reportFile}}

{{reportStructure}}

## Paso 3 — Briefs de oportunidad (basados en el informe, hasta 4)
Escribe un «array» JSON en la siguiente ruta:
{{briefsFile}}

El esquema es el mismo que la recopilación: { "title", "problem", "evidence": [{"kind","ref","summary"}], "impact": 1-5, "effort": 1-5, "scope", "spec", "dedup": {"relation":"new|refinement","ofTitle"} }.
{{evidenceRule}}
- **Criterios de aceptación de diseño (solo para briefs que tocan la UI)**: refleja las «Restricciones de diseño» de arriba en los criterios de aceptación de spec — el «significado» de los colores usados (tokens/compromisos de este repo), i18n de las cadenas visibles (el «conjunto completo» de locales que soporta este repo), estados (vacío/error/carga/deshabilitado/foco), accesibilidad (etiquetas·contraste). No fijes un color/número de locales concreto — «como lo define este repo». No lo añadas a briefs sin superficie de UI.
{{dedup}}

{{backlog}}

Tras escribir ambos archivos, termina con una línea: «Investigación completa — N briefs».{{outputDirective}}`,
    fr: `{{persona}} {{intro}} Ne modifie pas le code — investigue seulement.

## Sujet de recherche (demande utilisateur)
{{topic}}
{{history}}
{{designContext}}
{{lensBlock}}
## Étape 1 — Investigation
{{investigation}}

## Étape 2 — Rédige le rapport
Écris un rapport markdown au chemin suivant:
{{reportFile}}

{{reportStructure}}

## Étape 3 — Briefs d'opportunité (basés sur le rapport, jusqu'à 4)
Écris un «tableau» JSON au chemin suivant:
{{briefsFile}}

Le schéma est le même que la collecte: { "title", "problem", "evidence": [{"kind","ref","summary"}], "impact": 1-5, "effort": 1-5, "scope", "spec", "dedup": {"relation":"new|refinement","ofTitle"} }.
{{evidenceRule}}
- **Critères d'acceptation de design (seulement pour les briefs qui touchent l'UI)**: reflète les «Contraintes de design» ci-dessus dans les critères d'acceptation de spec — le «sens» des couleurs utilisées (tokens/engagements de ce dépôt), i18n des chaînes visibles (l'«ensemble complet» des locales prises en charge par ce dépôt), états (vide/erreur/chargement/désactivé/focus), accessibilité (libellés·contraste). Ne fige pas une couleur/un nombre de locales précis — «tel que ce dépôt le définit». Ne l'ajoute pas aux briefs sans surface UI.
{{dedup}}

{{backlog}}

Après avoir écrit les deux fichiers, termine par une ligne: «Recherche terminée — N briefs».{{outputDirective}}`,
    hi: `{{persona}} {{intro}} कोड न बदलें — केवल जाँचें।

## शोध विषय (उपयोगकर्ता अनुरोध)
{{topic}}
{{history}}
{{designContext}}
{{lensBlock}}
## चरण 1 — जाँच
{{investigation}}

## चरण 2 — रिपोर्ट लिखें
निम्न पथ पर markdown रिपोर्ट लिखें:
{{reportFile}}

{{reportStructure}}

## चरण 3 — अवसर-ब्रीफ़ (रिपोर्ट के आधार पर, अधिकतम 4)
निम्न पथ पर JSON «array» लिखें:
{{briefsFile}}

स्कीमा संग्रह जैसा ही: { "title", "problem", "evidence": [{"kind","ref","summary"}], "impact": 1-5, "effort": 1-5, "scope", "spec", "dedup": {"relation":"new|refinement","ofTitle"} }।
{{evidenceRule}}
- **डिज़ाइन स्वीकृति मानदंड (केवल UI को छूने वाले ब्रीफ़)**: ऊपर की «डिज़ाइन प्रतिबंध» को spec के स्वीकृति मानदंड में दर्शाएँ — प्रयुक्त रंगों का «अर्थ» (इस रेपो के टोकन/प्रतिबद्धता), दिखने वाले स्ट्रिंग्स का i18n (इस रेपो द्वारा समर्थित लोकेल का «पूरा समुच्चय»), स्थितियाँ (खाली/त्रुटि/लोडिंग/निष्क्रिय/फोकस), एक्सेसिबिलिटी (लेबल·कंट्रास्ट)। किसी विशेष रंग/लोकेल-संख्या को न जड़ें — «जैसा यह रेपो तय करता है»। बिना UI सतह वाले ब्रीफ़ में न जोड़ें।
{{dedup}}

{{backlog}}

दोनों फ़ाइलें लिखने के बाद एक पंक्ति «शोध पूर्ण — N ब्रीफ़» से समाप्त करें।{{outputDirective}}`,
    ja: `{{persona}}{{intro}} コードを修正するな — 調査のみ。

## 調査主題(ユーザー要求)
{{topic}}
{{history}}
{{designContext}}
{{lensBlock}}
## ステップ1 — 調査
{{investigation}}

## ステップ2 — 報告書の作成
次のパスに markdown 報告書を書け:
{{reportFile}}

{{reportStructure}}

## ステップ3 — 機会ブリーフ(報告書を根拠に、最大4件)
次のパスに JSON「配列」を書け:
{{briefsFile}}

スキーマは収集と同じ: { "title", "problem", "evidence": [{"kind","ref","summary"}], "impact": 1-5, "effort": 1-5, "scope", "spec", "dedup": {"relation":"new|refinement","ofTitle"} }。
{{evidenceRule}}
- **デザイン受け入れ基準(UIに触れるブリーフのみ)**: spec の受け入れ基準に上の「デザイン制約」を反映せよ — 使う色の「意味」(このリポジトリのトークン/約束)、表示文字列の i18n(このリポジトリが対応するロケール「集合すべて」)、状態(空/エラー/読み込み/無効/フォーカス)、アクセシビリティ(ラベル·コントラスト)。特定の色·ロケール数を固定せず「このリポジトリが定めたとおり」。UI面のないブリーフには入れるな。
{{dedup}}

{{backlog}}

両方のファイルを書いたら「リサーチ完了 — N件のブリーフ」の一行で終えよ。{{outputDirective}}`,
    ko: `{{persona}} {{intro}} 코드를 수정하지 마라 — 조사만 한다.

## 조사 주제 (사용자 요청)
{{topic}}
{{history}}
{{designContext}}
{{lensBlock}}
## 1단계 — 조사
{{investigation}}

## 2단계 — 보고서 작성
다음 경로에 markdown 보고서를 써라:
{{reportFile}}

{{reportStructure}}

## 3단계 — 기회 브리프 (보고서 근거로, 최대 4건)
다음 경로에 JSON «배열» 을 써라:
{{briefsFile}}

스키마는 수집과 동일: { "title", "problem", "evidence": [{"kind","ref","summary"}], "impact": 1-5, "effort": 1-5, "scope", "spec", "dedup": {"relation":"new|refinement","ofTitle"} }.
{{evidenceRule}}
- **디자인 수용 기준 (UI 가 닿는 브리프만)**: spec 의 수용 기준에 위 「디자인 제약」 을 반영하라 — 쓰는 색의 «의미»(이 레포가 정한 토큰/약속), 노출 문자열의 i18n(이 레포가 지원하는 로케일 «집합» 전부), 상태(빈/오류/로딩/비활성/포커스), 접근성(라벨·대비). 특정 색·로케일 수를 박지 말고 «이 레포가 정한 대로». UI 표면이 없는 브리프엔 넣지 마라.
{{dedup}}

{{backlog}}

두 파일을 모두 쓴 뒤 «리서치 완료 — 브리프 N건» 한 줄로 끝내라.{{outputDirective}}`,
    "pt-BR": `{{persona}} {{intro}} Não modifique código — apenas investigue.

## Tema de pesquisa (solicitação do usuário)
{{topic}}
{{history}}
{{designContext}}
{{lensBlock}}
## Passo 1 — Investigação
{{investigation}}

## Passo 2 — Escreva o relatório
Escreva um relatório markdown no seguinte caminho:
{{reportFile}}

{{reportStructure}}

## Passo 3 — Briefs de oportunidade (com base no relatório, até 4)
Escreva um «array» JSON no seguinte caminho:
{{briefsFile}}

O esquema é o mesmo da coleta: { "title", "problem", "evidence": [{"kind","ref","summary"}], "impact": 1-5, "effort": 1-5, "scope", "spec", "dedup": {"relation":"new|refinement","ofTitle"} }.
{{evidenceRule}}
- **Critérios de aceitação de design (apenas para briefs que tocam a UI)**: reflita as «Restrições de design» acima nos critérios de aceitação de spec — o «significado» das cores usadas (tokens/compromissos deste repo), i18n das strings visíveis (o «conjunto inteiro» de localidades que este repo suporta), estados (vazio/erro/carregando/desabilitado/foco), acessibilidade (rótulos·contraste). Não fixe uma cor/contagem de localidades específica — «como este repo define». Não adicione isso a briefs sem superfície de UI.
{{dedup}}

{{backlog}}

Após escrever ambos os arquivos, termine com uma linha: «Pesquisa concluída — N briefs».{{outputDirective}}`,
    ru: `{{persona}} {{intro}} Не изменяй код — только исследуй.

## Тема исследования (запрос пользователя)
{{topic}}
{{history}}
{{designContext}}
{{lensBlock}}
## Шаг 1 — Исследование
{{investigation}}

## Шаг 2 — Напиши отчёт
Напиши markdown-отчёт по следующему пути:
{{reportFile}}

{{reportStructure}}

## Шаг 3 — Брифы возможностей (на основе отчёта, до 4)
Напиши JSON-«массив» по следующему пути:
{{briefsFile}}

Схема та же, что при сборе: { "title", "problem", "evidence": [{"kind","ref","summary"}], "impact": 1-5, "effort": 1-5, "scope", "spec", "dedup": {"relation":"new|refinement","ofTitle"} }.
{{evidenceRule}}
- **Критерии приёмки дизайна (только для брифов, касающихся UI)**: отрази «Ограничения дизайна» выше в критериях приёмки spec — «смысл» используемых цветов (токены/обязательства этого репозитория), i18n видимых строк («весь набор» локалей, поддерживаемых этим репозиторием), состояния (пусто/ошибка/загрузка/отключено/фокус), доступность (подписи·контраст). Не фиксируй конкретный цвет/число локалей — «как определяет этот репозиторий». Не добавляй это в брифы без поверхности UI.
{{dedup}}

{{backlog}}

После записи обоих файлов закончи одной строкой: «Исследование завершено — N брифов».{{outputDirective}}`,
    "zh-Hans": `{{persona}}{{intro}} 不要修改代码——只调研。

## 调研主题(用户请求)
{{topic}}
{{history}}
{{designContext}}
{{lensBlock}}
## 第 1 步 — 调研
{{investigation}}

## 第 2 步 — 撰写报告
将 markdown 报告写入以下路径:
{{reportFile}}

{{reportStructure}}

## 第 3 步 — 机会简报(以报告为依据,最多 4 条)
将 JSON「数组」写入以下路径:
{{briefsFile}}

schema 与收集相同: { "title", "problem", "evidence": [{"kind","ref","summary"}], "impact": 1-5, "effort": 1-5, "scope", "spec", "dedup": {"relation":"new|refinement","ofTitle"} }。
{{evidenceRule}}
- **设计验收标准(仅限触及 UI 的简报)**: 将上方「设计约束」反映到 spec 的验收标准中——所用颜色的「含义」(本仓库的令牌/约定)、可见字符串的 i18n(本仓库支持的语言环境「全部集合」)、状态(空/错误/加载/禁用/聚焦)、无障碍(标签·对比度)。不要写死某种颜色/语言环境数量——「按本仓库的规定」。不要将其加入没有 UI 表面的简报。
{{dedup}}

{{backlog}}

写完两个文件后,以一行「调研完成 — N 条简报」结束。{{outputDirective}}`,
  },
} satisfies Record<string, Msg>;
