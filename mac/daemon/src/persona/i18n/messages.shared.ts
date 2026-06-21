// PO 프롬프트 다국어 카탈로그 — «공용» 메시지 (여러 빌더가 공유하는 블록).
//
// ko 는 SSOT — prompt.ts 의 기존 리터럴과 «byte-identical» 해야 한다 (prompt.test.ts 의 ko 단언이
// 회귀 가드). 나머지 9개는 번역. «{{name}}» 은 format() 보간 자리 (단일 중괄호 JSON 예시와 구분).

import type { Msg } from "./locale.js";

export const sharedMessages = {
  // ── 백로그 한 줄의 status 라벨 (BRIEF_STATUS_LABEL) ──────────────────────────
  "status.proposed": {
    ar: "مُقترح",
    en: "Proposed",
    es: "Propuesto",
    fr: "Proposé",
    hi: "प्रस्तावित",
    ja: "提案",
    ko: "제안",
    "pt-BR": "Proposto",
    ru: "Предложено",
    "zh-Hans": "提议",
  },
  "status.held": {
    ar: "مُعلّق",
    en: "Held",
    es: "En espera",
    fr: "En attente",
    hi: "रोका गया",
    ja: "保留",
    ko: "보류",
    "pt-BR": "Em espera",
    ru: "Отложено",
    "zh-Hans": "暂缓",
  },
  "status.approved": {
    ar: "مُعتمد",
    en: "Approved",
    es: "Aprobado",
    fr: "Approuvé",
    hi: "स्वीकृत",
    ja: "承認",
    ko: "승인",
    "pt-BR": "Aprovado",
    ru: "Одобрено",
    "zh-Hans": "已批准",
  },
  "status.running": {
    ar: "قيد التنفيذ",
    en: "Running",
    es: "En curso",
    fr: "En cours",
    hi: "चल रहा है",
    ja: "進行中",
    ko: "진행",
    "pt-BR": "Em andamento",
    ru: "Выполняется",
    "zh-Hans": "进行中",
  },
  "status.rejected": {
    ar: "مرفوض",
    en: "Rejected",
    es: "Rechazado",
    fr: "Rejeté",
    hi: "अस्वीकृत",
    ja: "却下",
    ko: "기각",
    "pt-BR": "Rejeitado",
    ru: "Отклонено",
    "zh-Hans": "已拒绝",
  },
  "status.shipped": {
    ar: "تم الإطلاق",
    en: "Shipped",
    es: "Lanzado",
    fr: "Livré",
    hi: "जारी किया गया",
    ja: "リリース済み",
    ko: "출시",
    "pt-BR": "Lançado",
    ru: "Выпущено",
    "zh-Hans": "已发布",
  },
  "status.verified": {
    ar: "تم التحقق",
    en: "Verified",
    es: "Verificado",
    fr: "Vérifié",
    hi: "सत्यापित",
    ja: "検証済み",
    ko: "검증",
    "pt-BR": "Verificado",
    ru: "Проверено",
    "zh-Hans": "已验证",
  },
  "status.missed": {
    ar: "أخفق",
    en: "Missed",
    es: "Fallido",
    fr: "Manqué",
    hi: "चूक गया",
    ja: "外れ",
    ko: "빗나감",
    "pt-BR": "Não atingido",
    ru: "Не оправдалось",
    "zh-Hans": "未命中",
  },

  // ── 결정 이력 한 줄의 «결정/결과» 라벨 (DECISION_LABEL) ──────────────────────
  "decision.rejected": {
    ar: "مرفوض",
    en: "Rejected",
    es: "Rechazado",
    fr: "Rejeté",
    hi: "अस्वीकृत",
    ja: "却下",
    ko: "기각",
    "pt-BR": "Rejeitado",
    ru: "Отклонено",
    "zh-Hans": "已拒绝",
  },
  "decision.approved": {
    ar: "مُعتمد",
    en: "Approved",
    es: "Aprobado",
    fr: "Approuvé",
    hi: "स्वीकृत",
    ja: "承認",
    ko: "승인",
    "pt-BR": "Aprovado",
    ru: "Одобрено",
    "zh-Hans": "已批准",
  },
  "decision.verified": {
    ar: "تم التحقق",
    en: "Verified",
    es: "Verificado",
    fr: "Vérifié",
    hi: "सत्यापित",
    ja: "検証済み",
    ko: "검증됨",
    "pt-BR": "Verificado",
    ru: "Проверено",
    "zh-Hans": "已验证",
  },
  "decision.missed": {
    ar: "أخفق",
    en: "Missed",
    es: "Fallido",
    fr: "Manqué",
    hi: "चूक गया",
    ja: "外れ",
    ko: "빗나감",
    "pt-BR": "Não atingido",
    ru: "Не оправдалось",
    "zh-Hans": "未命中",
  },

  // ── 기각 사유 라벨 (DECIDE_REASON_LABEL — po_decide_reason_v1 / po_locale_v2) ─────
  // «기각» 이력 줄에 « · {{reasonPrefix}}: {{라벨}}» 로 붙는다 — 같은 사유로 또 기각될 제안을
  // 미리 피하게 하는 보정 신호. enum 키(routes/po.ts DECIDE_REASONS)는 비번역 식별자, 라벨만 번역.
  "decision.reasonPrefix": {
    ar: "السبب",
    en: "reason",
    es: "motivo",
    fr: "motif",
    hi: "कारण",
    ja: "理由",
    ko: "사유",
    "pt-BR": "motivo",
    ru: "причина",
    "zh-Hans": "原因",
  },
  "reason.priorityLow": {
    ar: "أولوية منخفضة",
    en: "Low priority",
    es: "Prioridad baja",
    fr: "Priorité faible",
    hi: "कम प्राथमिकता",
    ja: "優先度が低い",
    ko: "우선순위 낮음",
    "pt-BR": "Prioridade baixa",
    ru: "Низкий приоритет",
    "zh-Hans": "优先级低",
  },
  "reason.scopeTooBig": {
    ar: "نطاق كبير جداً",
    en: "Scope too big",
    es: "Alcance demasiado grande",
    fr: "Périmètre trop large",
    hi: "दायरा बहुत बड़ा",
    ja: "スコープが大きすぎる",
    ko: "범위 과대",
    "pt-BR": "Escopo grande demais",
    ru: "Слишком большой объём",
    "zh-Hans": "范围过大",
  },
  "reason.alreadyExists": {
    ar: "موجود بالفعل",
    en: "Already exists",
    es: "Ya existe",
    fr: "Existe déjà",
    hi: "पहले से मौजूद",
    ja: "すでに存在する",
    ko: "이미 있음",
    "pt-BR": "Já existe",
    ru: "Уже существует",
    "zh-Hans": "已存在",
  },
  "reason.weakEvidence": {
    ar: "أدلة ضعيفة",
    en: "Weak evidence",
    es: "Evidencia débil",
    fr: "Preuves insuffisantes",
    hi: "कमज़ोर प्रमाण",
    ja: "根拠が弱い",
    ko: "근거 약함",
    "pt-BR": "Evidência fraca",
    ru: "Слабое обоснование",
    "zh-Hans": "依据不足",
  },
  "reason.wrongDirection": {
    ar: "اتجاه غير مناسب",
    en: "Wrong direction",
    es: "Dirección equivocada",
    fr: "Mauvaise direction",
    hi: "ग़लत दिशा",
    ja: "方向性が合わない",
    ko: "방향 안 맞음",
    "pt-BR": "Direção errada",
    ru: "Неверное направление",
    "zh-Hans": "方向不对",
  },

  // ── 백로그 dedup 앵커 (renderBacklogAnchor) ─────────────────────────────────
  "backlog.none": {
    ar: "(لا شيء)",
    en: "(none)",
    es: "(ninguno)",
    fr: "(aucun)",
    hi: "(कोई नहीं)",
    ja: "(なし)",
    ko: "(없음)",
    "pt-BR": "(nenhum)",
    ru: "(нет)",
    "zh-Hans": "(无)",
  },
  "backlog.forbiddenHeader": {
    ar: "السجل الحالي/السابق (لا تُعد اقتراح ما يطابق «نفس الفرصة» أدناه — بما في ذلك إعادة الصياغة أو المرفوض أو المُطلق):",
    en: "Existing/past backlog (do not re-propose anything that is the «same opportunity» as below — including reworded, rejected, or shipped items):",
    es: "Backlog existente/pasado (no vuelvas a proponer nada que sea la «misma oportunidad» que lo de abajo — incluidos los reformulados, rechazados o lanzados):",
    fr: "Backlog existant/passé (ne re-proposez rien qui soit la «même opportunité» que ci-dessous — y compris reformulé, rejeté ou livré):",
    hi: "मौजूदा/पिछला बैकलॉग (नीचे दी गई «समान अवसर» वाली किसी भी चीज़ का दोबारा प्रस्ताव न करें — शीर्षक बदला हुआ, अस्वीकृत या जारी किया गया भी शामिल):",
    ja: "既存・過去のバックログ(下記と「同じ機会」のもの — 言い換え・却下・リリース済みを含む — を再提案するな):",
    ko: "기존·과거 백로그 (아래와 «같은 기회» 는 — 제목 재서술·기각·출시 포함 — 재제안 금지):",
    "pt-BR": "Backlog existente/passado (não reproponha nada que seja a «mesma oportunidade» que o de baixo — incluindo reformulado, rejeitado ou lançado):",
    ru: "Существующий/прошлый бэклог (не предлагайте повторно то, что является «той же возможностью», что и ниже — включая переформулированное, отклонённое или выпущенное):",
    "zh-Hans": "现有/过往待办(不要再次提出与下方「相同机会」的任何条目——包括改写、已拒绝或已发布的):",
  },
  "backlog.missedHeader": {
    ar: "فرص «أخفقت» رغم إطلاقها (مرشّحة لإعادة المحاولة — ليست قراراً مغلقاً، فجوة غير محلولة):",
    en: "«Missed» opportunities despite shipping (retry candidates — not closed decisions, unresolved gaps):",
    es: "Oportunidades «fallidas» a pesar de haberse lanzado (candidatas a reintento — no son decisiones cerradas, brechas no resueltas):",
    fr: "Opportunités «manquées» malgré la livraison (candidates à une nouvelle tentative — pas des décisions closes, écarts non résolus):",
    hi: "जारी होने के बावजूद «चूक गए» अवसर (पुनः प्रयास के उम्मीदवार — बंद निर्णय नहीं, अनसुलझे अंतराल):",
    ja: "リリースされたが「外れた」機会(再試行候補 — クローズされた決定ではない、未解決のギャップ):",
    ko: "출시됐으나 «빗나간» 기회 (재시도 후보 — 닫힌 결정 아님, 미해결 갭):",
    "pt-BR": "Oportunidades «não atingidas» apesar do lançamento (candidatas a nova tentativa — não são decisões encerradas, lacunas não resolvidas):",
    ru: "«Не оправдавшиеся» возможности, несмотря на выпуск (кандидаты на повтор — не закрытые решения, нерешённые пробелы):",
    "zh-Hans": "已发布但「未命中」的机会(重试候选——并非已关闭的决定,而是未解决的缺口):",
  },
  "backlog.missedInstruction": {
    ar: "- **قاعدة إعادة محاولة «الإخفاق (missed)»**: العناصر أعلاه أُطلقت لكن «الفرضية أخفقت» وبقيت المشكلة (الفجوة) كما هي. ليست قراراً مغلقاً، لذا يُسمح ببريف جديد يعالج «الفجوة غير المحلولة بنهج مختلف». لكن — ① احذفه إن كان مجرد إعادة اقتراح «لنفس الفرضية/نفس النهج» (يجب أن «يختلف» النهج — لا تكرّر المحاولة نفسها). ② إن وُجد في السجل أعلاه اقتراح «حيّ» حول الموضوع نفسه (مُقترح/مُعلّق/مُعتمد/قيد التنفيذ) فهو الأولى، فلا تُنشئ واحداً جديداً.",
    en: "- **Missed-retry rule**: The items above shipped but their «hypothesis missed» — the problem (gap) remains. These are not closed decisions, so a new brief that tackles the «unresolved gap with a different approach» is «allowed». But — ① drop it if it is just a re-proposal of the «same hypothesis/same approach» (the approach must «differ» — do not repeat the same attempt). ② if a «live» proposal on the same topic already exists in the backlog above (proposed/held/approved/running), that one takes priority, so do not create a new one.",
    es: "- **Regla de reintento de fallidos**: Los elementos anteriores se lanzaron pero su «hipótesis falló» — el problema (la brecha) persiste. No son decisiones cerradas, así que se «permite» un nuevo brief que aborde la «brecha no resuelta con un enfoque distinto». Pero — ① descártalo si es solo una nueva propuesta de la «misma hipótesis/mismo enfoque» (el enfoque debe «diferir» — no repitas el mismo intento). ② si ya existe en el backlog anterior una propuesta «viva» sobre el mismo tema (propuesto/en espera/aprobado/en curso), esa tiene prioridad, así que no crees una nueva.",
    fr: "- **Règle de nouvelle tentative pour les manqués**: Les éléments ci-dessus ont été livrés mais leur «hypothèse a échoué» — le problème (l'écart) demeure. Ce ne sont pas des décisions closes, donc un nouveau brief traitant l'«écart non résolu avec une approche différente» est «autorisé». Mais — ① écarte-le s'il s'agit seulement d'une re-proposition de la «même hypothèse/même approche» (l'approche doit «différer» — ne répète pas la même tentative). ② si une proposition «vivante» sur le même sujet existe déjà dans le backlog ci-dessus (proposé/en attente/approuvé/en cours), c'est elle qui prime, donc n'en crée pas de nouvelle.",
    hi: "- **छूट गए (missed) के पुनः प्रयास का नियम**: ऊपर दिए आइटम रिलीज़ हो चुके हैं पर उनकी «परिकल्पना चूक गई» — समस्या (अंतराल) ज्यों की त्यों बनी है। ये बंद निर्णय नहीं हैं, इसलिए «अनसुलझे अंतराल को एक अलग दृष्टिकोण से» हल करने वाला नया ब्रीफ «अनुमत» है। पर — ① यदि यह केवल «वही परिकल्पना/वही दृष्टिकोण» का दोबारा प्रस्ताव है तो हटा दें (दृष्टिकोण «अलग होना» चाहिए — वही प्रयास न दोहराएँ)। ② यदि ऊपर बैकलॉग में उसी विषय पर पहले से कोई «सक्रिय» प्रस्ताव (प्रस्तावित/रोका गया/स्वीकृत/चल रहा) मौजूद है, तो वही प्राथमिकता रखता है, इसलिए नया न बनाएँ।",
    ja: "- **「外れ(missed)」再試行ルール**: 上記の項目はリリース済みだが「仮説が外れ」、問題(ギャップ)がそのまま残っている。クローズされた決定ではないので、「未解決のギャップを別のアプローチ」で扱う新しいブリーフは「許可」される。ただし — ① 「同じ仮説/同じアプローチ」の単なる再提案なら除外せよ(アプローチが「異なる」必要がある — 同じ試みを繰り返すな)。② 同じテーマで既に「生きている」提案(提案/保留/承認/進行)が上のバックログにあれば、そちらが優先なので新たに作るな。",
    ko: "- **빗나감(missed) 재시도 규칙**: 위 항목들은 출시됐으나 «가설이 빗나가» 문제(갭)가 그대로 남았다. 닫힌 결정이 아니므로 «미해결 갭을 다른 접근» 으로 다루는 새 브리프는 «허용» 된다. 단 — ① «같은 가설/같은 접근» 의 단순 재제안이면 빼라(접근이 «달라야» 한다 — 같은 시도를 반복하지 마라). ② 같은 주제로 이미 «살아있는» 제안(제안/보류/승인/진행)이 위 백로그에 있으면 그쪽이 우선이니 새로 만들지 마라.",
    "pt-BR": "- **Regra de nova tentativa para os não atingidos**: Os itens acima foram lançados, mas sua «hipótese falhou» — o problema (a lacuna) permanece. Não são decisões encerradas, então um novo brief que trate a «lacuna não resolvida com uma abordagem diferente» é «permitido». Mas — ① descarte-o se for apenas uma nova proposta da «mesma hipótese/mesma abordagem» (a abordagem deve «diferir» — não repita a mesma tentativa). ② se já existir no backlog acima uma proposta «viva» sobre o mesmo tema (proposto/em espera/aprovado/em andamento), ela tem prioridade, então não crie uma nova.",
    ru: "- **Правило повторной попытки для «не оправдавшихся»**: Перечисленные выше пункты выпущены, но их «гипотеза не оправдалась» — проблема (пробел) осталась. Это не закрытые решения, поэтому новый бриф, который решает «нерешённый пробел другим подходом», «допустим». Но — ① отклоните его, если это лишь повторное предложение «той же гипотезы/того же подхода» (подход должен «отличаться» — не повторяйте ту же попытку). ② если в бэклоге выше уже есть «живое» предложение по той же теме (предложено/отложено/одобрено/выполняется), приоритет у него, поэтому не создавайте новое.",
    "zh-Hans": "- **「未命中(missed)」重试规则**：上述条目虽已发布,但其「假设未命中」,问题(缺口)依旧存在。它们不是已关闭的决定,因此「用不同方法处理未解决缺口」的新简报是「允许」的。但 — ① 若只是「相同假设/相同方法」的简单再提案,则剔除(方法必须「不同」——不要重复同样的尝试)。② 若上方待办中已有同一主题的「存活」提案(提议/暂缓/已批准/进行中),则以那条为优先,不要新建。",
  },

  "backlog.densityCounterweight": {
    ar: "- اكتب عنوان·ملخّص الاقتراحات الجديدة ببساطة ومتمحورة حول نتيجة المستخدم/المنتج (بلا أسماء ملفات·رموز كود·اختصارات) — حتى لو كانت العناصر أعلاه مكثّفة، لا تقلّد «أسلوب عناوينها».",
    en: "- Write new proposals' title·summary plainly and centered on the user/product outcome (no filenames·code symbols·abbreviations) — even if the items above are dense, do not imitate their «title style».",
    es: "- Escribe el título·resumen de las nuevas propuestas de forma sencilla y centrada en el resultado de usuario/producto (sin nombres de archivo·símbolos de código·abreviaturas) — aunque los elementos de arriba sean densos, no imites su «estilo de título».",
    fr: "- Écris le titre·résumé des nouvelles propositions simplement et centré sur le résultat utilisateur/produit (sans noms de fichiers·symboles de code·abréviations) — même si les éléments ci-dessus sont denses, n'imite pas leur «style de titre».",
    hi: "- नए प्रस्तावों का शीर्षक·सारांश सरलता से और उपयोगकर्ता/उत्पाद परिणाम पर केंद्रित लिखें (बिना फ़ाइल नाम·कोड चिह्न·संक्षेपण) — भले ही ऊपर के आइटम घने हों, उनकी «शीर्षक शैली» की नकल न करें।",
    ja: "- 新提案の title·要約はユーザー/製品の結果を中心に平易に書け(ファイル名·コード記号·略語なし) — 上の項目が密でも、その「タイトル表現スタイル」を模倣するな。",
    ko: "- 새 제안의 title·요약은 사용자·제품 결과 중심으로 평이하게(파일명·코드 심볼·약어 없이) 써라 — 위 항목이 빽빽하더라도 그 «제목 표현 스타일» 은 모방하지 마라.",
    "pt-BR": "- Escreva o título·resumo das novas propostas de forma simples e centrada no resultado do usuário/produto (sem nomes de arquivo·símbolos de código·abreviações) — mesmo que os itens acima sejam densos, não imite o «estilo de título» deles.",
    ru: "- Пишите заголовок·резюме новых предложений просто и с упором на результат пользователя/продукта (без имён файлов·кодовых символов·аббревиатур) — даже если пункты выше плотные, не подражайте их «стилю заголовков».",
    "zh-Hans": "- 新提案的标题·摘要要写得平实并聚焦用户/产品结果(不含文件名·代码符号·缩写)——即便上方条目很密集,也不要模仿其「标题风格」。",
  },

  // ── dedup 자가분류 (DEDUP_INSTRUCTION / DEDUP_SCHEMA_FIELD) ──────────────────
  "dedup.instruction": {
    ar: '- **منع التكرار (بالمعنى، إلزامي)**: إن كانت الفرصة «نفسها» الموجودة في «السجل الحالي/السابق» أدناه — حتى لو اختلف نص العنوان، أو كانت قد «رُفضت» أو «أُطلقت» — فلا تقترحها مجدداً أبداً. املأ `dedup` في كل بريف للمقارنة الذاتية: إن كان عملاً منفصلاً «يوسّع» القائم بمعنى حقيقي فاكتب `{"relation":"refinement","ofTitle":"<العنوان القائم المتداخل>"}`، وإن كانت فرصة جديدة لا علاقة لها بالقائم فاكتب `{"relation":"new"}`. وإن رأيت أنها الفرصة نفسها فلا تُعلّمها بـ `dedup` بل «احذفها أصلاً من مصفوفة المخرجات».',
    en: '- **No duplicates (by meaning, strict)**: If it is the «same opportunity» as something in the «existing/past backlog» below — even if the title is worded differently, even if it was already «rejected» or «shipped» — never propose it again. Fill in `dedup` on each brief you produce to self-check: if it is a separate task that meaningfully «extends» an existing one, write `{"relation":"refinement","ofTitle":"<overlapping existing title>"}`; if it is a new opportunity unrelated to the existing ones, write `{"relation":"new"}`. If you judge it to be the same opportunity, do not flag it with `dedup` — «drop it from the output array in the first place».',
    es: '- **Sin duplicados (por significado, estricto)**: Si es la «misma oportunidad» que algo del «backlog existente/pasado» de abajo — aunque el título esté redactado de otra forma, aunque ya fuera «rechazado» o «lanzado» — nunca lo vuelvas a proponer. Rellena `dedup` en cada brief que produzcas para autocomprobarlo: si es una tarea aparte que «amplía» de forma significativa una existente, escribe `{"relation":"refinement","ofTitle":"<título existente que se solapa>"}`; si es una oportunidad nueva sin relación con las existentes, escribe `{"relation":"new"}`. Si juzgas que es la misma oportunidad, no la marques con `dedup` — «quítala del array de salida de entrada».',
    fr: '- **Pas de doublons (par le sens, strict)**: Si c\'est la «même opportunité» que quelque chose dans le «backlog existant/passé» ci-dessous — même si le titre est formulé différemment, même si elle a déjà été «rejetée» ou «livrée» — ne la propose jamais à nouveau. Renseigne `dedup` sur chaque brief que tu produis pour t\'auto-vérifier: si c\'est une tâche distincte qui «étend» de façon significative une existante, écris `{"relation":"refinement","ofTitle":"<titre existant qui se recoupe>"}`; si c\'est une nouvelle opportunité sans rapport avec les existantes, écris `{"relation":"new"}`. Si tu juges que c\'est la même opportunité, ne la marque pas avec `dedup` — «retire-la du tableau de sortie d\'emblée».',
    hi: '- **कोई डुप्लिकेट नहीं (अर्थ के आधार पर, सख़्त)**: यदि यह नीचे दिए «मौजूदा/पिछले बैकलॉग» की किसी चीज़ के साथ «समान अवसर» है — भले ही शीर्षक अलग शब्दों में हो, भले ही वह पहले ही «अस्वीकृत» या «जारी» हो चुका हो — तो इसे दोबारा कभी प्रस्तावित न करें। आत्म-जाँच के लिए हर ब्रीफ में `dedup` भरें: यदि यह एक अलग कार्य है जो किसी मौजूदा को सार्थक रूप से «विस्तारित» करता है, तो `{"relation":"refinement","ofTitle":"<जो मौजूदा शीर्षक ओवरलैप करता है>"}` लिखें; यदि यह मौजूदा से असंबंधित नया अवसर है, तो `{"relation":"new"}` लिखें। यदि आप इसे समान अवसर मानते हैं, तो इसे `dedup` से चिह्नित न करें — «इसे आउटपुट array से शुरू में ही हटा दें»।',
    ja: '- **重複禁止(意味基準、厳守)**: 下記の「既存・過去のバックログ」と「同じ機会」なら — 表現が違っても、すでに「却下」・「リリース」済みでも — 絶対に再提案するな。産出する各ブリーフに `dedup` を埋めて自己照合せよ: 既存を意味のある形で「拡張」する別作業なら `{"relation":"refinement","ofTitle":"<重なる既存タイトル>"}`、既存と無関係な新機会なら `{"relation":"new"}`。同じ機会と判断したら `dedup` で印を付けず「そもそも産出配列から外せ」。',
    ko: '- **중복 금지 (의미 기준, 엄수)**: 아래 «기존·과거 백로그» 와 «같은 기회» 면 — 제목 표현이 달라도, 이미 «기각»·«출시» 된 것이라도 — 절대 다시 제안하지 마라. 산출하는 각 브리프엔 `dedup` 을 채워 스스로 대조하라: 기존을 의미 있게 «확장» 하는 별개 작업이면 `{"relation":"refinement","ofTitle":"<겹치는 기존 제목>"}`, 기존과 무관한 새 기회면 `{"relation":"new"}`. 같은 기회라고 판단되면 `dedup` 으로 표시하지 말고 «애초에 산출 배열에서 빼라».',
    "pt-BR": '- **Sem duplicatas (por significado, rigoroso)**: Se for a «mesma oportunidade» que algo no «backlog existente/passado» abaixo — mesmo que o título esteja redigido de outra forma, mesmo que já tenha sido «rejeitado» ou «lançado» — nunca a proponha de novo. Preencha `dedup` em cada brief que produzir para autoconferência: se for uma tarefa separada que «amplia» de forma significativa uma existente, escreva `{"relation":"refinement","ofTitle":"<título existente que se sobrepõe>"}`; se for uma oportunidade nova sem relação com as existentes, escreva `{"relation":"new"}`. Se julgar que é a mesma oportunidade, não a marque com `dedup` — «remova-a do array de saída logo de início».',
    ru: '- **Без дублей (по смыслу, строго)**: Если это «та же возможность», что и что-то в «существующем/прошлом бэклоге» ниже — даже если заголовок сформулирован иначе, даже если она уже «отклонена» или «выпущена» — никогда не предлагайте её снова. Заполняйте `dedup` в каждом брифе для самопроверки: если это отдельная задача, которая осмысленно «расширяет» существующую, пишите `{"relation":"refinement","ofTitle":"<пересекающийся существующий заголовок>"}`; если это новая возможность, не связанная с существующими, пишите `{"relation":"new"}`. Если сочли, что это та же возможность, не помечайте её через `dedup` — «изначально уберите её из выходного массива».',
    "zh-Hans": '- **禁止重复(按含义,严格)**：若与下方「现有/过往待办」是「相同机会」——即便标题措辞不同,即便已被「拒绝」或「发布」——也绝不要再次提出。在产出的每条简报中填写 `dedup` 进行自查:若是有意义地「扩展」某条现有项的独立工作,写 `{"relation":"refinement","ofTitle":"<重叠的现有标题>"}`;若是与现有无关的新机会,写 `{"relation":"new"}`。若判断为相同机会,不要用 `dedup` 标注——「一开始就从产出数组中剔除」。',
  },
  "dedup.schemaField": {
    ar: '  "dedup": { "relation": "new|refinement", "ofTitle": "العنوان القائم المتداخل (عند refinement) أو سلسلة فارغة" }',
    en: '  "dedup": { "relation": "new|refinement", "ofTitle": "overlapping existing title (when refinement) or empty string" }',
    es: '  "dedup": { "relation": "new|refinement", "ofTitle": "título existente que se solapa (cuando es refinement) o cadena vacía" }',
    fr: '  "dedup": { "relation": "new|refinement", "ofTitle": "titre existant qui se recoupe (si refinement) ou chaîne vide" }',
    hi: '  "dedup": { "relation": "new|refinement", "ofTitle": "ओवरलैप करने वाला मौजूदा शीर्षक (refinement होने पर) या खाली स्ट्रिंग" }',
    ja: '  "dedup": { "relation": "new|refinement", "ofTitle": "重なる既存タイトル(refinement のとき)または空文字列" }',
    ko: '  "dedup": { "relation": "new|refinement", "ofTitle": "겹치는 기존 제목(refinement 일 때) 또는 빈 문자열" }',
    "pt-BR": '  "dedup": { "relation": "new|refinement", "ofTitle": "título existente que se sobrepõe (quando refinement) ou string vazia" }',
    ru: '  "dedup": { "relation": "new|refinement", "ofTitle": "пересекающийся существующий заголовок (при refinement) или пустая строка" }',
    "zh-Hans": '  "dedup": { "relation": "new|refinement", "ofTitle": "重叠的现有标题(为 refinement 时)或空字符串" }',
  },

  // ── 디자인 제약 섹션 (buildDesignContext) ───────────────────────────────────
  "design.context.header": {
    ar: "## قيود التصميم (الالتزام إلزامي)",
    en: "## Design constraints (mandatory)",
    es: "## Restricciones de diseño (obligatorio)",
    fr: "## Contraintes de design (obligatoire)",
    hi: "## डिज़ाइन प्रतिबंध (अनुपालन अनिवार्य)",
    ja: "## デザイン制約(遵守必須)",
    ko: "## 디자인 제약(준수 필수)",
    "pt-BR": "## Restrições de design (obrigatório)",
    ru: "## Ограничения дизайна (обязательно)",
    "zh-Hans": "## 设计约束(必须遵守)",
  },
  "design.context.declaredIntro": {
    ar: "هذا هو التزام التصميم الذي «أعلنه» المستودع — اتبعه كما هو، ولا تخلط بين «معنى» اللون والحالة واللغة وإمكانية الوصول:",
    en: "This is the design commitment the repo has «declared» — follow it as-is, and do not confuse the «meaning» of color, state, locale, and accessibility:",
    es: "Este es el compromiso de diseño que el repo ha «declarado» — síguelo tal cual y no confundas el «significado» de color, estado, configuración regional y accesibilidad:",
    fr: "Voici l'engagement de design que le dépôt a «déclaré» — suis-le tel quel et ne confonds pas le «sens» de la couleur, de l'état, de la locale et de l'accessibilité:",
    hi: "यह वह डिज़ाइन प्रतिबद्धता है जिसे रेपो ने «घोषित» किया है — इसे ज्यों का त्यों अपनाएँ, और रंग, स्थिति, लोकेल व एक्सेसिबिलिटी के «अर्थ» को न मिलाएँ:",
    ja: "これはこのリポジトリが「宣言」したデザイン約束だ — 下記をそのまま従い、色・状態・ロケール・アクセシビリティの「意味」を混同するな:",
    ko: "이 레포가 «선언» 한 디자인 약속이다 — 아래를 그대로 따르고, 색·상태·로케일·접근성의 «의미» 를 혼동하지 마라:",
    "pt-BR": "Este é o compromisso de design que o repositório «declarou» — siga-o como está e não confunda o «significado» de cor, estado, localidade e acessibilidade:",
    ru: "Это дизайн-обязательство, которое «объявил» репозиторий — следуйте ему как есть и не путайте «смысл» цвета, состояния, локали и доступности:",
    "zh-Hans": "这是本仓库「声明」的设计约定——照其执行,不要混淆颜色、状态、语言环境与无障碍的「含义」:",
  },
  "design.context.autodiscover": {
    ar: `ابحث أولاً «بنفسك» عن مصدر التصميم الوحيد (SSOT) الذي «حدّده» هذا المستودع واقرأه واتبعه — لا تفترض مسبقاً لوناً معيّناً أو عدداً معيّناً من اللغات (لكل مستودع لوحته وعهوده ولغاته المدعومة). استكشف المواقع المرشّحة بشكل محايد للتقنية (الموجود منها فقط):
- **رموز/سمات التصميم**: \`*Tokens*\`، \`theme.*\`، \`tokens.json\`، \`tailwind.config.*\`، خصائص CSS المخصّصة(\`--*\`)، متغيّرات \`*.css\`/\`*.scss\` — «عهد المعنى» للون والتباعد والطباعة وقواعد التسمية.
- **وثائق التصميم**: أقسام التصميم/اللون في \`CLAUDE.md\`/\`AGENTS.md\`، \`DESIGN*.md\`، \`docs/design*\`، Storybook(\`*.stories.*\`) — أي لون/رمز يعني «ماذا» وقواعد «لا تفعل».
- **كتالوج اللغات**: \`*.xcstrings\`، \`*.strings\`، \`messages/*.json\`، \`i18n/\`، \`locales/\`، \`*.po\` — استنتج منها «مجموعة اللغات المدعومة» في هذا المستودع (العدد والتكوين يختلفان بين المستودعات).

إن وجدتها فاتبع ذلك العهد: استخدم اللون «بمعناه» ولا تخلط بين المعاني أو تجمعها، وترجم النصوص المعروضة إلى «كامل مجموعة» اللغات المدعومة، وزوّد حالات الفارغ/الخطأ/التحميل/التعطيل/التركيز وإمكانية الوصول (التسميات·التباين). إن لم تجدها فطبّق معايير UX العامة فقط (حالات التفاعل·إمكانية الوصول·التباين) — لا «تخترع» سياسة.`,
    en: `First «find and read for yourself» the design SSOT that this repo has «set» and follow it — do not assume a particular color or a particular number of locales in advance (each repo has its own palette, commitments, and supported languages). Explore candidate locations in a stack-neutral way (only those that exist):
- **Design tokens/theme**: \`*Tokens*\`, \`theme.*\`, \`tokens.json\`, \`tailwind.config.*\`, CSS custom properties (\`--*\`), \`*.css\`/\`*.scss\` variables — the «meaning commitments» for color, spacing, and typography, and naming conventions.
- **Design docs**: the design/color sections of \`CLAUDE.md\`/\`AGENTS.md\`, \`DESIGN*.md\`, \`docs/design*\`, Storybook (\`*.stories.*\`) — which hue/token means «what» and the «do-not» rules.
- **Locale catalogs**: \`*.xcstrings\`, \`*.strings\`, \`messages/*.json\`, \`i18n/\`, \`locales/\`, \`*.po\` — infer this repo's «set of supported languages» from them (count and composition differ per repo).

Once found, follow that commitment: use color «by meaning» and do not confuse or overload meanings, translate user-facing strings into the «entire set» of supported locales, and provide empty/error/loading/disabled/focus states and accessibility (labels·contrast). If you cannot find any, apply only universal UX standards (interaction states·accessibility·contrast) — do not «invent» a policy.`,
    es: `Primero «busca y lee por ti mismo» el SSOT de diseño que este repo ha «definido» y síguelo — no asumas de antemano un color concreto ni un número concreto de locales (cada repo tiene su paleta, sus compromisos y sus idiomas admitidos). Explora las ubicaciones candidatas de forma neutral respecto al stack (solo las que existan):
- **Tokens/tema de diseño**: \`*Tokens*\`, \`theme.*\`, \`tokens.json\`, \`tailwind.config.*\`, propiedades personalizadas CSS (\`--*\`), variables \`*.css\`/\`*.scss\` — los «compromisos de significado» de color, espaciado y tipografía, y las convenciones de nombres.
- **Documentos de diseño**: las secciones de diseño/color de \`CLAUDE.md\`/\`AGENTS.md\`, \`DESIGN*.md\`, \`docs/design*\`, Storybook (\`*.stories.*\`) — qué hue/token significa «qué» y las reglas de «no hacer».
- **Catálogos de locales**: \`*.xcstrings\`, \`*.strings\`, \`messages/*.json\`, \`i18n/\`, \`locales/\`, \`*.po\` — infiere de ellos el «conjunto de idiomas admitidos» de este repo (el número y la composición varían por repo).

Si lo encuentras, sigue ese compromiso: usa el color «por su significado» y no confundas ni mezcles significados, traduce las cadenas visibles al «conjunto completo» de locales admitidos, y aporta estados vacío/error/carga/deshabilitado/foco y accesibilidad (etiquetas·contraste). Si no encuentras nada, aplica solo estándares de UX universales (estados de interacción·accesibilidad·contraste) — no «inventes» una política.`,
    fr: `Commence par «trouver et lire toi-même» le SSOT de design que ce dépôt a «défini» et suis-le — ne présume pas à l'avance une couleur particulière ni un nombre particulier de locales (chaque dépôt a sa palette, ses engagements et ses langues prises en charge). Explore les emplacements candidats de façon neutre vis-à-vis de la stack (uniquement ceux qui existent):
- **Tokens/thème de design**: \`*Tokens*\`, \`theme.*\`, \`tokens.json\`, \`tailwind.config.*\`, propriétés personnalisées CSS (\`--*\`), variables \`*.css\`/\`*.scss\` — les «engagements de sens» pour la couleur, l'espacement et la typographie, et les conventions de nommage.
- **Docs de design**: les sections design/couleur de \`CLAUDE.md\`/\`AGENTS.md\`, \`DESIGN*.md\`, \`docs/design*\`, Storybook (\`*.stories.*\`) — quelle teinte/quel token signifie «quoi» et les règles de «ne pas faire».
- **Catalogues de locales**: \`*.xcstrings\`, \`*.strings\`, \`messages/*.json\`, \`i18n/\`, \`locales/\`, \`*.po\` — déduis-en l'«ensemble des langues prises en charge» de ce dépôt (le nombre et la composition varient selon le dépôt).

Une fois trouvé, suis cet engagement: utilise la couleur «par son sens» et ne confonds ni ne cumule les sens, traduis les chaînes visibles dans l'«ensemble complet» des locales prises en charge, et fournis les états vide/erreur/chargement/désactivé/focus et l'accessibilité (libellés·contraste). Si tu n'en trouves aucun, applique seulement des standards UX universels (états d'interaction·accessibilité·contraste) — n'«invente» pas de politique.`,
    hi: `पहले «स्वयं ढूँढ़कर पढ़ें» कि इस रेपो ने जो डिज़ाइन SSOT «तय» किया है और उसका पालन करें — किसी विशेष रंग या लोकेल की विशेष संख्या को पहले से न मानें (हर रेपो की अपनी पैलेट, प्रतिबद्धताएँ व समर्थित भाषाएँ होती हैं)। उम्मीदवार स्थानों को स्टैक-तटस्थ ढंग से खोजें (केवल जो मौजूद हों):
- **डिज़ाइन टोकन/थीम**: \`*Tokens*\`, \`theme.*\`, \`tokens.json\`, \`tailwind.config.*\`, CSS कस्टम प्रॉपर्टीज़ (\`--*\`), \`*.css\`/\`*.scss\` वेरिएबल — रंग, स्पेसिंग व टाइपोग्राफी की «अर्थ प्रतिबद्धता» और नामकरण नियम।
- **डिज़ाइन दस्तावेज़**: \`CLAUDE.md\`/\`AGENTS.md\` के डिज़ाइन/रंग खंड, \`DESIGN*.md\`, \`docs/design*\`, Storybook (\`*.stories.*\`) — कौन-सा hue/टोकन «क्या» अर्थ रखता है और «मत करें» नियम।
- **लोकेल कैटलॉग**: \`*.xcstrings\`, \`*.strings\`, \`messages/*.json\`, \`i18n/\`, \`locales/\`, \`*.po\` — इनसे इस रेपो की «समर्थित भाषाओं का समुच्चय» अनुमानित करें (संख्या व संरचना हर रेपो में भिन्न)।

मिल जाए तो उस प्रतिबद्धता का पालन करें: रंग को «अर्थ» से प्रयोग करें और अर्थ को न मिलाएँ/न साझा करें, दिखने वाले स्ट्रिंग्स को समर्थित लोकेल के «पूरे समुच्चय» में अनुवाद करें, और खाली/त्रुटि/लोडिंग/निष्क्रिय/फोकस स्थितियाँ व एक्सेसिबिलिटी (लेबल·कंट्रास्ट) रखें। कुछ न मिले तो केवल सार्वभौमिक UX मानक लागू करें (इंटरैक्शन स्थितियाँ·एक्सेसिबिलिटी·कंट्रास्ट) — नीति «गढ़ें» नहीं।`,
    ja: `まずこのリポジトリが「定めた」デザインSSOTを「自分で探して読み」、それに従え — 特定の色や特定のロケール数を事前に仮定するな(リポジトリごとにパレット・約束・対応言語が異なる)。候補となる場所をスタック中立に探索せよ(あるものだけ):
- **デザイントークン/テーマ**: \`*Tokens*\`、\`theme.*\`、\`tokens.json\`、\`tailwind.config.*\`、CSSカスタムプロパティ(\`--*\`)、\`*.css\`/\`*.scss\` 変数 — 色・余白・タイポグラフィの「意味の約束」と命名規則。
- **デザイン文書**: \`CLAUDE.md\`/\`AGENTS.md\` のデザイン・色セクション、\`DESIGN*.md\`、\`docs/design*\`、Storybook(\`*.stories.*\`) — どの色相/トークンがどんな「意味」か、そして「やるな」のルール。
- **ロケールカタログ**: \`*.xcstrings\`、\`*.strings\`、\`messages/*.json\`、\`i18n/\`、\`locales/\`、\`*.po\` — このリポジトリの「対応言語の集合」を推論せよ(数・構成はリポジトリごとに異なる)。

見つけたらその約束に従え: 色は「意味」で使い、意味を混同・兼用するな。表示文字列は対応ロケール「集合すべて」に翻訳し、空/エラー/読み込み/無効/フォーカス状態とアクセシビリティ(ラベル・コントラスト)を備えよ。見つからなければ普遍的なUX基準のみ適用せよ(インタラクション状態・アクセシビリティ・コントラスト) — ポリシーを「発明」するな。`,
    ko: `이 레포가 «정한» 디자인 SSOT 를 먼저 «스스로 찾아 읽고» 따르라 — 특정 색이나 특정 로케일 수를 미리 가정하지 마라(레포마다 팔레트·약속·지원 언어가 다르다). 후보 위치를 스택-중립적으로 탐색하라(있는 것만):
- **디자인 토큰/테마**: \`*Tokens*\`, \`theme.*\`, \`tokens.json\`, \`tailwind.config.*\`, CSS custom properties(\`--*\`), \`*.css\`/\`*.scss\` 변수 — 색·간격·타이포의 «의미 약속» 과 명명 규칙.
- **디자인 문서**: \`CLAUDE.md\`/\`AGENTS.md\` 의 디자인·색 섹션, \`DESIGN*.md\`, \`docs/design*\`, Storybook(\`*.stories.*\`) — 어떤 hue/토큰이 어떤 «의미» 인지와 «하지 마라» 규칙.
- **로케일 카탈로그**: \`*.xcstrings\`, \`*.strings\`, \`messages/*.json\`, \`i18n/\`, \`locales/\`, \`*.po\` — 이 레포가 «지원하는 언어 집합» 을 추론한다(개수·구성은 레포마다 다르다).

찾았으면 그 약속을 따르라: 색은 «의미» 로 쓰고 의미를 혼동·겸용하지 마라, 노출 문자열은 지원 로케일 «집합 전부» 에 번역, 빈/오류/로딩/비활성/포커스 상태와 접근성(라벨·대비)을 갖춘다. 못 찾으면 보편 UX 기준만 적용하라(상호작용 상태·접근성·대비) — 정책을 «발명» 하지 마라.`,
    "pt-BR": `Primeiro «encontre e leia por conta própria» o SSOT de design que este repositório «definiu» e siga-o — não presuma de antemão uma cor específica nem um número específico de localidades (cada repo tem sua paleta, seus compromissos e seus idiomas suportados). Explore os locais candidatos de forma neutra quanto à stack (apenas os que existirem):
- **Tokens/tema de design**: \`*Tokens*\`, \`theme.*\`, \`tokens.json\`, \`tailwind.config.*\`, propriedades personalizadas CSS (\`--*\`), variáveis \`*.css\`/\`*.scss\` — os «compromissos de significado» de cor, espaçamento e tipografia, e as convenções de nomenclatura.
- **Documentos de design**: as seções de design/cor de \`CLAUDE.md\`/\`AGENTS.md\`, \`DESIGN*.md\`, \`docs/design*\`, Storybook (\`*.stories.*\`) — qual hue/token significa «o quê» e as regras de «não faça».
- **Catálogos de localidade**: \`*.xcstrings\`, \`*.strings\`, \`messages/*.json\`, \`i18n/\`, \`locales/\`, \`*.po\` — infira deles o «conjunto de idiomas suportados» deste repo (número e composição variam por repo).

Ao encontrar, siga esse compromisso: use a cor «pelo significado» e não confunda nem sobreponha significados, traduza as strings visíveis para o «conjunto inteiro» de localidades suportadas, e forneça estados vazio/erro/carregando/desabilitado/foco e acessibilidade (rótulos·contraste). Se não encontrar nenhum, aplique apenas padrões universais de UX (estados de interação·acessibilidade·contraste) — não «invente» uma política.`,
    ru: `Сначала «найдите и прочитайте сами» дизайн-SSOT, который «задал» этот репозиторий, и следуйте ему — не предполагайте заранее конкретный цвет или конкретное число локалей (у каждого репозитория своя палитра, обязательства и поддерживаемые языки). Исследуйте возможные расположения нейтрально к стеку (только существующие):
- **Дизайн-токены/тема**: \`*Tokens*\`, \`theme.*\`, \`tokens.json\`, \`tailwind.config.*\`, кастомные свойства CSS (\`--*\`), переменные \`*.css\`/\`*.scss\` — «обязательства смысла» для цвета, отступов и типографики, и правила именования.
- **Дизайн-документы**: разделы дизайна/цвета в \`CLAUDE.md\`/\`AGENTS.md\`, \`DESIGN*.md\`, \`docs/design*\`, Storybook (\`*.stories.*\`) — какой оттенок/токен что «значит» и правила «не делай».
- **Каталоги локалей**: \`*.xcstrings\`, \`*.strings\`, \`messages/*.json\`, \`i18n/\`, \`locales/\`, \`*.po\` — выведите из них «набор поддерживаемых языков» этого репозитория (число и состав различаются по репозиториям).

Найдя, следуйте этому обязательству: используйте цвет «по смыслу» и не путайте и не совмещайте смыслы, переводите видимые строки на «весь набор» поддерживаемых локалей и обеспечьте состояния пусто/ошибка/загрузка/отключено/фокус и доступность (подписи·контраст). Если ничего не найдёте, применяйте только универсальные стандарты UX (состояния взаимодействия·доступность·контраст) — не «изобретайте» политику.`,
    "zh-Hans": `先「自己查找并阅读」本仓库「设定」的设计 SSOT 并遵循它——不要预先假定某种特定颜色或特定的语言环境数量(每个仓库的调色板、约定与支持语言各不相同)。以技术栈中立的方式探查候选位置(仅限存在的):
- **设计令牌/主题**: \`*Tokens*\`、\`theme.*\`、\`tokens.json\`、\`tailwind.config.*\`、CSS 自定义属性(\`--*\`)、\`*.css\`/\`*.scss\` 变量——颜色、间距、排版的「含义约定」与命名规则。
- **设计文档**: \`CLAUDE.md\`/\`AGENTS.md\` 的设计/颜色章节、\`DESIGN*.md\`、\`docs/design*\`、Storybook(\`*.stories.*\`)——哪种色相/令牌代表「何种含义」以及「不要这样做」的规则。
- **语言环境目录**: \`*.xcstrings\`、\`*.strings\`、\`messages/*.json\`、\`i18n/\`、\`locales/\`、\`*.po\`——据此推断本仓库「支持的语言集合」(数量与构成因仓库而异)。

找到后请遵循该约定:颜色「按含义」使用,不要混淆或兼用含义;可见字符串须翻译到支持语言环境的「全部集合」;并具备空/错误/加载/禁用/聚焦状态与无障碍(标签·对比度)。若找不到,则仅应用通用 UX 标准(交互状态·无障碍·对比度)——不要「发明」策略。`,
  },
  // ── 산출 언어 지시 (localeOutputDirective) — 본문이 이미 대상 언어라도 «산출 파일» 의 ──────
  // 사람이 읽는 값은 그 언어로, JSON 키/경로/코드/URL 은 비번역으로 유지하라는 보강 지시. ko 는
  // localeOutputDirective 가 "" 를 돌려주므로 런타임 미사용(완전성 테스트용 채움).
  "shared.outputDirective": {
    ar: `

## لغة المخرجات (لغة تطبيق المستخدم — إلزامي)
لغة عرض تطبيق المستخدم هي «{{lang}}». اكتب حتماً بـ{{lang}} النصوص «التي يقرأها الإنسان» أعلاه — متن تقرير البحث، وكذلك title·problem·scope·spec لكل بريف وملخّص evidence. حتى لو كان مدخل المستخدم (الموضوع·التوجيه) بلغة أخرى فافهمه، لكن اكتب المخرجات بـ{{lang}}. لا تترجم مفاتيح JSON·قيم enum (kind·relation وغيرها)·مسارات الملفات·المعرّفات·الكود/الأوامر·الروابط واتركها كما هي.`,
    en: `

## Output language (the user's app language — required)
The user's app display language is «{{lang}}». You must write the «human-readable» text produced above — the research report body, and each brief's title·problem·scope·spec and evidence's summary — in {{lang}}. Even if the user input (topic·directive) is in another language, understand it but write the output in {{lang}}. Do not translate JSON keys·enum values (kind·relation, etc.)·file paths·identifiers·code/commands·URLs — leave them as-is.`,
    es: `

## Idioma de salida (el idioma de la app del usuario — obligatorio)
El idioma de visualización de la app del usuario es «{{lang}}». Debes escribir el texto «legible por humanos» producido arriba — el cuerpo del informe de investigación, y el title·problem·scope·spec de cada brief y el summary de evidence — en {{lang}}. Aunque la entrada del usuario (tema·directiva) esté en otro idioma, entiéndela pero escribe la salida en {{lang}}. No traduzcas claves JSON·valores enum (kind·relation, etc.)·rutas de archivo·identificadores·código/comandos·URLs — déjalos tal cual.`,
    fr: `

## Langue de sortie (la langue de l'app de l'utilisateur — obligatoire)
La langue d'affichage de l'app de l'utilisateur est «{{lang}}». Tu dois écrire le texte «lisible par un humain» produit ci-dessus — le corps du rapport de recherche, et le title·problem·scope·spec de chaque brief et le summary de evidence — en {{lang}}. Même si l'entrée utilisateur (sujet·directive) est dans une autre langue, comprends-la mais écris la sortie en {{lang}}. Ne traduis pas les clés JSON·valeurs enum (kind·relation, etc.)·chemins de fichiers·identifiants·code/commandes·URLs — laisse-les tels quels.`,
    hi: `

## आउटपुट भाषा (उपयोगकर्ता की ऐप भाषा — अनिवार्य)
उपयोगकर्ता की ऐप प्रदर्शन भाषा «{{lang}}» है। ऊपर उत्पन्न «मानव-पठनीय» पाठ — शोध रिपोर्ट का मुख्य भाग, और प्रत्येक ब्रीफ़ का title·problem·scope·spec तथा evidence का summary — अवश्य {{lang}} में लिखें। भले ही उपयोगकर्ता इनपुट (विषय·निर्देश) किसी अन्य भाषा में हो, उसे समझें पर आउटपुट {{lang}} में लिखें। JSON कुंजियाँ·enum मान (kind·relation आदि)·फ़ाइल पथ·पहचानकर्ता·कोड/कमांड·URL का अनुवाद न करें — उन्हें ज्यों का त्यों रखें।`,
    ja: `

## 産出言語(ユーザーのアプリ言語 — 必須)
ユーザーのアプリ表示言語は「{{lang}}」だ。上で産出する「人が読む」テキスト — リサーチ報告書の本文、および各ブリーフの title·problem·scope·spec と evidence の summary — を必ず {{lang}} で書け。ユーザー入力(主題·指示)が別の言語でも理解はするが、産出は {{lang}} で書く。JSON キー·enum 値(kind·relation など)·ファイルパス·識別子·コード/コマンド·URL は翻訳せずそのまま残す。`,
    ko: `

## 산출 언어 (사용자 앱 언어 — 필수)
사용자의 앱 표시 언어는 «{{lang}}» 다. 위에서 산출하는 «사람이 읽는» 텍스트 — 리서치 보고서 본문, 그리고 각 브리프의 title·problem·scope·spec 과 evidence 의 summary — 를 반드시 {{lang}} 로 작성하라. 사용자 입력(주제·지시)이 다른 언어여도 이해는 하되, 산출은 {{lang}} 로 쓴다. JSON 키·enum 값(kind·relation 등)·파일 경로·식별자·코드/명령·URL 은 번역하지 말고 그대로 둔다.`,
    "pt-BR": `

## Idioma de saída (o idioma do app do usuário — obrigatório)
O idioma de exibição do app do usuário é «{{lang}}». Você deve escrever o texto «legível por humanos» produzido acima — o corpo do relatório de pesquisa, e o title·problem·scope·spec de cada brief e o summary de evidence — em {{lang}}. Mesmo que a entrada do usuário (tema·diretiva) esteja em outro idioma, entenda-a mas escreva a saída em {{lang}}. Não traduza chaves JSON·valores enum (kind·relation, etc.)·caminhos de arquivo·identificadores·código/comandos·URLs — deixe-os como estão.`,
    ru: `

## Язык вывода (язык приложения пользователя — обязательно)
Язык отображения приложения пользователя — «{{lang}}». Вы обязаны писать «читаемый человеком» текст, создаваемый выше — тело отчёта исследования, а также title·problem·scope·spec каждого брифа и summary у evidence — на {{lang}}. Даже если ввод пользователя (тема·директива) на другом языке, поймите его, но пишите вывод на {{lang}}. Не переводите ключи JSON·значения enum (kind·relation и т. п.)·пути файлов·идентификаторы·код/команды·URL — оставляйте их как есть.`,
    "zh-Hans": `

## 产出语言(用户的应用语言——必需)
用户的应用显示语言为「{{lang}}」。你必须用 {{lang}} 书写上方产出的「人类可读」文本——调研报告正文,以及每条简报的 title·problem·scope·spec 与 evidence 的 summary。即便用户输入(主题·指示)为其他语言,也要理解它但用 {{lang}} 书写产出。不要翻译 JSON 键·enum 值(kind·relation 等)·文件路径·标识符·代码/命令·URL——原样保留。`,
  },

  "design.context.footer": {
    ar: `- ينطبق هذا القيد على البريفات «التي تمسّ واجهة المستخدم» فقط — لا تفرض معايير التصميم على ما لا سطح واجهة له كـ daemon·الشبكة·CLI·المخطط.
- إن كان البريف يمسّ واجهة المستخدم فادمج عهد «هذا المستودع» المُعلَن/المُكتشَف أعلاه في معايير قبول المخرجات (spec/prompt العقدة).`,
    en: `- This constraint applies only to briefs that «touch the UI» — do not force design standards on things with no UI surface, like daemon·network·CLI·schema.
- If the brief touches the UI, reflect «this repo's» declared/discovered commitment above in the acceptance criteria of the output (spec/node prompt).`,
    es: `- Esta restricción se aplica solo a los briefs que «tocan la UI» — no fuerces estándares de diseño en cosas sin superficie de UI, como daemon·red·CLI·esquema.
- Si el brief toca la UI, refleja el compromiso declarado/descubierto de «este repo» (arriba) en los criterios de aceptación de la salida (spec/prompt del nodo).`,
    fr: `- Cette contrainte ne s'applique qu'aux briefs qui «touchent l'UI» — n'impose pas de standards de design à ce qui n'a pas de surface UI, comme daemon·réseau·CLI·schéma.
- Si le brief touche l'UI, reflète l'engagement déclaré/découvert de «ce dépôt» ci-dessus dans les critères d'acceptation de la sortie (spec/prompt de nœud).`,
    hi: `- यह प्रतिबंध केवल उन ब्रीफ़ पर लागू होता है जो «UI को छूते» हैं — daemon·नेटवर्क·CLI·स्कीमा जैसी बिना UI सतह वाली चीज़ों पर डिज़ाइन मानक न थोपें।
- यदि ब्रीफ़ UI को छूता है, तो ऊपर घोषित/खोजी गई «इस रेपो की» प्रतिबद्धता को आउटपुट (spec/नोड prompt) के स्वीकृति मानदंड में दर्शाएँ।`,
    ja: `- この制約は「UIに触れる」ブリーフにのみ適用される — daemon·ネットワーク·CLI·スキーマのようにUI面のないものにデザイン基準を強要するな。
- UIに触れるブリーフなら、上で「宣言/発見」された「このリポジトリの」約束を産出(spec/ノードprompt)の受け入れ基準に反映せよ。`,
    ko: `- 이 제약은 «UI 가 닿는» 브리프에만 적용된다 — daemon·네트워크·CLI·스키마처럼 UI 표면이 없는 일에는 디자인 기준을 강요하지 마라.
- UI 가 닿는 브리프라면 위에서 «선언/발견» 된 «이 레포의» 약속을 산출(spec/노드 prompt)의 수용 기준에 반영하라.`,
    "pt-BR": `- Esta restrição se aplica apenas a briefs que «tocam a UI» — não force padrões de design em coisas sem superfície de UI, como daemon·rede·CLI·esquema.
- Se o brief tocar a UI, reflita o compromisso declarado/descoberto «deste repo» (acima) nos critérios de aceitação da saída (spec/prompt do nó).`,
    ru: `- Это ограничение применяется только к брифам, которые «касаются UI» — не навязывайте стандарты дизайна тому, у чего нет поверхности UI, например daemon·сеть·CLI·схема.
- Если бриф касается UI, отразите объявленное/обнаруженное обязательство «этого репозитория» (выше) в критериях приёмки результата (spec/prompt узла).`,
    "zh-Hans": `- 该约束仅适用于「触及 UI」的简报——不要对 daemon·网络·CLI·schema 等没有 UI 表面的事物强加设计标准。
- 若简报触及 UI,请将上方「声明/发现」的「本仓库」约定反映到产出(spec/节点 prompt)的验收标准中。`,
  },
} satisfies Record<string, Msg>;
