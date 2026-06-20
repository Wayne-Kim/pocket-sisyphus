// PO 프롬프트 다국어 카탈로그 — «전문가 관점»(렌즈) 머리말 (lens.ts).
//
// ko 는 SSOT — lens.ts 의 기존 리터럴과 byte-identical. «{{focus}}» 만 보간(디자인 초점 공유).

import type { Msg } from "./locale.js";

export const lensMessages = {
  // ── 디자인 렌즈 초점 (DESIGN_LENS_FOCUS) — 수집 designer 와 리서치 design 이 공유 ──────────
  "lens.designFocus": {
    ar: "انجراف الرموز (قيم حرفية·مثبّتة تتجاوز رموز المعنى)·خلط/تداخل معنى اللون·إمكانية الوصول (تسميات·تباين·النوع الديناميكي·هدف اللمس)·عدم اتساق الأنماط (تباعد/زوايا/حالات مفقودة)·سطح i18n",
    en: "token drift (literals/hardcoding bypassing meaning tokens)·color-meaning confusion/overloading·accessibility (labels·contrast·dynamic type·touch targets)·pattern inconsistency (spacing/corners/missing states)·i18n surface",
    es: "deriva de tokens (literales/hardcoding que evitan tokens de significado)·confusión/sobrecarga del significado del color·accesibilidad (etiquetas·contraste·tipo dinámico·objetivos táctiles)·inconsistencia de patrones (espaciado/esquinas/estados faltantes)·superficie i18n",
    fr: "dérive des tokens (littéraux/codage en dur contournant les tokens de sens)·confusion/cumul du sens des couleurs·accessibilité (libellés·contraste·type dynamique·cibles tactiles)·incohérence des motifs (espacement/coins/états manquants)·surface i18n",
    hi: "टोकन ड्रिफ़्ट (अर्थ-टोकन को बायपास करते लिटरल/हार्डकोडिंग)·रंग-अर्थ का भ्रम/दोहरा उपयोग·एक्सेसिबिलिटी (लेबल·कंट्रास्ट·डायनामिक टाइप·टच टार्गेट)·पैटर्न असंगति (स्पेसिंग/कोने/लुप्त स्थितियाँ)·i18n सतह",
    ja: "トークンドリフト(意味トークンを迂回するリテラル·ハードコーディング)·色の意味の混同/兼用·アクセシビリティ(ラベル·コントラスト·ダイナミックタイプ·タッチターゲット)·パターン不一致(余白/角/欠落した状態)·i18n 表面",
    ko: "토큰 드리프트(의미 토큰 우회 리터럴·하드코딩)·색 의미 혼동/겸용·접근성(라벨·대비·동적 타입·터치 타깃)·패턴 불일치(간격/모서리/상태 누락)·i18n 표면",
    "pt-BR": "deriva de tokens (literais/hardcoding que ignoram tokens de significado)·confusão/sobrecarga do significado da cor·acessibilidade (rótulos·contraste·tipo dinâmico·alvos de toque)·inconsistência de padrões (espaçamento/cantos/estados ausentes)·superfície i18n",
    ru: "дрейф токенов (литералы/хардкод в обход смысловых токенов)·путаница/совмещение смысла цвета·доступность (подписи·контраст·динамический тип·области касания)·несогласованность паттернов (отступы/углы/отсутствующие состояния)·поверхность i18n",
    "zh-Hans": "令牌漂移(绕过含义令牌的字面量·硬编码)·颜色含义混淆/兼用·无障碍(标签·对比度·动态字号·触控目标)·模式不一致(间距/圆角/缺失状态)·i18n 表面",
  },

  // ── 수집 렌즈 머리말 — bug (collectLensHeadmatter) ───────────────────────────
  "lens.collect.bug": {
    ar: `## منظور التجميع — خبير التصحيح·الموثوقية
يُجرى هذا التجميع بمنظور خبير «التصحيح·الموثوقية». اجمع الإشارات أولاً بعين «ما الذي يتعطّل وكيف».
- **الإشارات ذات الأولوية**: الأعطال·الاستثناءات·سجلات الفشل، تقارير الأخطاء القابلة لإعادة الإنتاج، الانحدارات (ما كان يعمل وتوقّف)، عيوب الموثوقية (انتهاء المهلة·التسابق·فقدان البيانات·الحالات الحدّية). انتقِ أولاً شكاوى «الاستقرار» من القضايا·المراجعات·إشارات الأعطال.
- **التركيب**: قدّم المشكلات التي «يتعطّل أو يتذبذب فيها التطبيق» على اقتراحات الميزات في البريفات، وضع في spec كل بريف «طريقة إعادة الإنتاج / طريقة التأكد بعد الإصلاح (اختبار الانحدار)». اكتب في ref ضمن evidence خطوات إعادة الإنتاج·السجلات·مرجع القضية/العطل.`,
    en: `## Collection perspective — debugging·reliability expert
This collection runs from a «debugging·reliability» expert's perspective. Gather signals first through the lens of «what breaks and how».
- **Priority signals**: crashes·exceptions·failure logs, reproducible bug reports, regressions (what used to work and stopped), reliability defects (timeouts·races·data loss·edge cases). Pick «stability» complaints first from issues·reviews·crash signals.
- **Synthesis**: prioritize problems where «the app crashes or is unstable» over feature proposals in briefs, and put in each brief's spec «how to reproduce / how to confirm after the fix (regression test)». In evidence's ref, write reproduction steps·logs·issue/crash references.`,
    es: `## Perspectiva de recopilación — experto en depuración·fiabilidad
Esta recopilación se realiza desde la perspectiva de un experto en «depuración·fiabilidad». Reúne señales primero a través de la lente de «qué se rompe y cómo».
- **Señales prioritarias**: fallos·excepciones·logs de error, reportes de bugs reproducibles, regresiones (lo que funcionaba y dejó de hacerlo), defectos de fiabilidad (timeouts·condiciones de carrera·pérdida de datos·casos límite). Elige primero las quejas de «estabilidad» de issues·reseñas·señales de fallo.
- **Síntesis**: prioriza en los briefs los problemas donde «la app se cierra o es inestable» sobre las propuestas de funciones, y pon en el spec de cada brief «cómo reproducir / cómo confirmar tras el arreglo (test de regresión)». En el ref de evidence, escribe pasos de reproducción·logs·referencias de issue/fallo.`,
    fr: `## Perspective de collecte — expert débogage·fiabilité
Cette collecte se fait du point de vue d'un expert «débogage·fiabilité». Rassemble d'abord les signaux à travers le prisme de «ce qui casse et comment».
- **Signaux prioritaires**: plantages·exceptions·logs d'échec, rapports de bugs reproductibles, régressions (ce qui marchait et ne marche plus), défauts de fiabilité (timeouts·concurrence·perte de données·cas limites). Choisis d'abord les plaintes de «stabilité» dans les issues·avis·signaux de plantage.
- **Synthèse**: priorise dans les briefs les problèmes où «l'app plante ou est instable» sur les propositions de fonctionnalités, et mets dans le spec de chaque brief «comment reproduire / comment confirmer après le correctif (test de régression)». Dans le ref de evidence, écris les étapes de reproduction·logs·références d'issue/plantage.`,
    hi: `## संग्रह दृष्टिकोण — डिबगिंग·विश्वसनीयता विशेषज्ञ
यह संग्रह «डिबगिंग·विश्वसनीयता» विशेषज्ञ के दृष्टिकोण से होता है। संकेतों को पहले «क्या और कैसे टूटता है» की दृष्टि से जुटाएँ।
- **प्राथमिकता संकेत**: क्रैश·अपवाद·विफलता लॉग, पुनरुत्पाद्य बग रिपोर्ट, रिग्रेशन (जो पहले चलता था और रुक गया), विश्वसनीयता दोष (टाइमआउट·रेस·डेटा हानि·किनारे के मामले)। issues·समीक्षाओं·क्रैश संकेतों से पहले «स्थिरता» शिकायतें चुनें।
- **संश्लेषण**: ब्रीफ़ में फ़ीचर प्रस्तावों से ऊपर उन समस्याओं को प्राथमिकता दें जहाँ «ऐप क्रैश या अस्थिर» होता है, और हर ब्रीफ़ के spec में «कैसे पुनरुत्पादित करें / फ़िक्स के बाद कैसे पुष्टि करें (रिग्रेशन टेस्ट)» डालें। evidence के ref में पुनरुत्पादन चरण·लॉग·issue/क्रैश संदर्भ लिखें।`,
    ja: `## 収集の観点 — デバッグ·信頼性の専門家
この収集は「デバッグ·信頼性」の専門家の観点で行う。信号をまず「何がどう壊れるか」の目で集めよ。
- **優先信号**: クラッシュ·例外·失敗ログ、再現するバグ報告、リグレッション(以前は動いたのに止まった)、信頼性欠陥(タイムアウト·競合·データ消失·エッジケース)。課題·レビュー·クラッシュ信号から「安定性」の不満を先に選べ。
- **統合**: ブリーフでは機能提案より「アプリが落ちる·不安定」な問題を優先し、各ブリーフの spec に「再現方法 / 修正後の確認(リグレッションテスト)方法」を入れよ。evidence の ref に再現手順·ログ·課題/クラッシュ参照を書け。`,
    ko: `## 수집 관점 — 디버깅·신뢰성 전문가
이 수집은 «디버깅·신뢰성» 전문가 관점으로 수행한다. 신호를 «무엇이 어떻게 깨지는가» 의 눈으로 우선 모아라.
- **우선 신호**: 크래시·예외·실패 로그, 재현되는 버그 리포트, 회귀(전엔 되던 게 안 됨), 신뢰성 결함(타임아웃·경합·데이터 유실·엣지케이스). 이슈·리뷰·크래시 신호에서 «안정성» 불만을 먼저 골라라.
- **종합**: 기능 제안보다 «앱이 깨지거나 불안정한» 문제를 우선해 브리프로 올리고, 각 브리프 spec 에 «재현 방법 / 수정 후 확인(회귀 테스트) 방법» 을 담아라. evidence 의 ref 에 재현 단계·로그·이슈/크래시 참조를 적어라.`,
    "pt-BR": `## Perspectiva de coleta — especialista em depuração·confiabilidade
Esta coleta é feita pela perspectiva de um especialista em «depuração·confiabilidade». Reúna sinais primeiro pela lente de «o que quebra e como».
- **Sinais prioritários**: crashes·exceções·logs de falha, relatórios de bugs reproduzíveis, regressões (o que funcionava e parou), defeitos de confiabilidade (timeouts·condições de corrida·perda de dados·casos de borda). Escolha primeiro as reclamações de «estabilidade» de issues·avaliações·sinais de crash.
- **Síntese**: priorize nos briefs os problemas em que «o app trava ou fica instável» acima de propostas de recursos, e coloque no spec de cada brief «como reproduzir / como confirmar após a correção (teste de regressão)». No ref de evidence, escreva passos de reprodução·logs·referências de issue/crash.`,
    ru: `## Перспектива сбора — эксперт по отладке·надёжности
Этот сбор ведётся с точки зрения эксперта по «отладке·надёжности». Собирайте сигналы прежде всего через призму «что и как ломается».
- **Приоритетные сигналы**: сбои·исключения·логи ошибок, воспроизводимые баг-репорты, регрессии (работало и перестало), дефекты надёжности (таймауты·гонки·потеря данных·краевые случаи). Сначала выбирайте жалобы на «стабильность» из issue·отзывов·сигналов сбоев.
- **Синтез**: в брифах приоритезируйте проблемы, где «приложение падает или нестабильно», над предложениями функций, и в spec каждого брифа укажите «как воспроизвести / как подтвердить после исправления (регрессионный тест)». В ref у evidence пишите шаги воспроизведения·логи·ссылки на issue/сбой.`,
    "zh-Hans": `## 收集视角 — 调试·可靠性专家
本次收集以「调试·可靠性」专家的视角进行。先以「什么会坏、怎么坏」的眼光收集信号。
- **优先信号**: 崩溃·异常·失败日志、可复现的 bug 报告、回归(以前能用现在不行)、可靠性缺陷(超时·竞态·数据丢失·边界情形)。先从 issue·评价·崩溃信号中挑出「稳定性」抱怨。
- **综合**: 在简报中将「应用崩溃或不稳定」的问题置于功能提案之上,并在每条简报的 spec 中写明「如何复现 / 修复后如何确认(回归测试)」。在 evidence 的 ref 中写复现步骤·日志·issue/崩溃引用。`,
  },

  // ── 리서치 렌즈 머리말 — design ──────────────────────────────────────────────
  "lens.research.design": {
    ar: `## منظور البحث — خبير التصميم
يُجرى هذا البحث بمنظور خبير «التصميم». ابحث الموضوع أولاً بعين التصميم — {{focus}} — (نفس عدسة شخصية «المصمم» في التجميع).
- **البحث ذو الأولوية**: إن كان الموضوع يمسّ سطح واجهة هذا المستودع، انظر أولاً إلى مواضع التعارض مع SSOT التصميم في «قيود التصميم» أعلاه، وإلى أفضل ممارسات التصميم/UX·إمكانية الوصول المتصلة بالموضوع.
- **تأكيد السند**: سند المستودع «ملف:سطر + رمز المعنى/اسم النمط المُنتهَك»، وسند الويب إرشادات إمكانية الوصول·التباين·أمثلة أنظمة التصميم (URL). احكم بـ«معنى» اللون والتباعد والطباعة وحالات التفاعل (فارغ/خطأ/تحميل/معطّل/تركيز)·إمكانية الوصول (لا تفترض لوناً معيّناً بل «المعنى الذي حدّده هذا المستودع»).
- إن لم يكن للمستودع المستهدف «سطح واجهة مرئي» فبيّن ذلك في التقرير، وبريف تصميم بعدد 0 (مصفوفة فارغة) إجابة صحيحة أيضاً.`,
    en: `## Research perspective — design expert
This research runs from a «design» expert's perspective. Investigate the topic first through a design eye — {{focus}} — (the same lens as collection's «designer» persona).
- **Priority investigation**: if the topic touches this repo's UI surface, look first at where it conflicts with the design SSOT in «Design constraints» above, and at design/UX·accessibility best practices related to the topic.
- **Evidence emphasis**: repo evidence is «file:line + the violated meaning token/pattern name», web evidence is accessibility·contrast guidelines·design-system examples (URL). Judge by the «meaning» of color, spacing, and typography and by interaction states (empty/error/loading/disabled/focus)·accessibility (do not assume a specific color — use «the meaning this repo defines»).
- If the target repo has no «rendered UI surface», state that in the report; zero design briefs (empty array) is also a correct answer.`,
    es: `## Perspectiva de investigación — experto en diseño
Esta investigación se realiza desde la perspectiva de un experto en «diseño». Investiga el tema primero con ojo de diseño — {{focus}} — (la misma lente que la persona «diseñador» de la recopilación).
- **Investigación prioritaria**: si el tema toca la superficie de UI de este repo, mira primero dónde entra en conflicto con el SSOT de diseño en «Restricciones de diseño» de arriba, y las mejores prácticas de diseño/UX·accesibilidad relacionadas con el tema.
- **Énfasis en evidencia**: la evidencia del repo es «archivo:línea + el token de significado/nombre de patrón violado», la evidencia web son guías de accesibilidad·contraste·ejemplos de sistemas de diseño (URL). Juzga por el «significado» del color, espaciado y tipografía y por los estados de interacción (vacío/error/carga/deshabilitado/foco)·accesibilidad (no asumas un color concreto — usa «el significado que define este repo»).
- Si el repo objetivo no tiene «superficie de UI renderizada», indícalo en el informe; cero briefs de diseño (array vacío) también es una respuesta correcta.`,
    fr: `## Perspective de recherche — expert design
Cette recherche se fait du point de vue d'un expert «design». Investigue le sujet d'abord avec un œil de design — {{focus}} — (la même lentille que la persona «designer» de la collecte).
- **Investigation prioritaire**: si le sujet touche la surface UI de ce dépôt, regarde d'abord où il entre en conflit avec le SSOT de design dans «Contraintes de design» ci-dessus, et les bonnes pratiques design/UX·accessibilité liées au sujet.
- **Emphase sur les preuves**: la preuve du dépôt est «fichier:ligne + le token de sens/nom de motif violé», la preuve web sont des guides d'accessibilité·contraste·exemples de design systems (URL). Juge par le «sens» de la couleur, de l'espacement et de la typographie et par les états d'interaction (vide/erreur/chargement/désactivé/focus)·accessibilité (n'assume pas une couleur précise — utilise «le sens que ce dépôt définit»).
- Si le dépôt cible n'a pas de «surface UI rendue», indique-le dans le rapport; zéro brief de design (tableau vide) est aussi une réponse correcte.`,
    hi: `## शोध दृष्टिकोण — डिज़ाइन विशेषज्ञ
यह शोध «डिज़ाइन» विशेषज्ञ के दृष्टिकोण से होता है। विषय को पहले डिज़ाइन की दृष्टि से जाँचें — {{focus}} — (संग्रह की «डिज़ाइनर» पर्सोना वाली ही लेंस)।
- **प्राथमिक जाँच**: यदि विषय इस रेपो की UI सतह को छूता है, तो पहले ऊपर «डिज़ाइन प्रतिबंध» के डिज़ाइन SSOT से टकराव के बिंदु देखें, और विषय से संबंधित डिज़ाइन/UX·एक्सेसिबिलिटी सर्वोत्तम अभ्यास देखें।
- **साक्ष्य ज़ोर**: रेपो साक्ष्य «फ़ाइल:लाइन + उल्लंघित अर्थ-टोकन/पैटर्न नाम», वेब साक्ष्य एक्सेसिबिलिटी·कंट्रास्ट दिशानिर्देश·डिज़ाइन सिस्टम उदाहरण (URL)। रंग·स्पेसिंग·टाइपोग्राफी के «अर्थ» और इंटरैक्शन स्थितियों (खाली/त्रुटि/लोडिंग/निष्क्रिय/फोकस)·एक्सेसिबिलिटी से निर्णय करें (किसी विशेष रंग को न मानें — «इस रेपो द्वारा तय अर्थ» से)।
- यदि लक्ष्य रेपो में «रेंडर होने वाली UI सतह» न हो तो रिपोर्ट में बताएँ; शून्य डिज़ाइन ब्रीफ़ (खाली array) भी सही उत्तर है।`,
    ja: `## 調査の観点 — デザインの専門家
この調査は「デザイン」専門家の観点で行う。主題をまずデザインの目で — {{focus}} — 優先して調査せよ(収集の「デザイナー」ペルソナと同じレンズだ)。
- **優先調査**: 主題がこのリポジトリの UI 表面に触れるなら、上の「デザイン制約」のデザイン SSOT と食い違う箇所、そして主題に関連するデザイン/UX·アクセシビリティのベストプラクティスを先に見る。
- **根拠の強調**: リポジトリ根拠は「ファイル:行 + 違反した意味トークン/パターン名」、ウェブ根拠はアクセシビリティ·コントラストのガイドライン·デザインシステム事例(URL)。色·余白·タイポグラフィの「意味」と相互作用状態(空/エラー/読み込み/無効/フォーカス)·アクセシビリティで判定せよ(特定の色を仮定せず「このリポジトリが定めた意味」で)。
- 対象リポジトリに「レンダリングされる UI 表面」がなければ、その事実を報告書に明示し、デザインブリーフ0件(空配列)も正解だ。`,
    ko: `## 조사 관점 — 디자인 전문가
이 리서치는 «디자인» 전문가 관점으로 수행한다. 주제를 디자인의 눈으로 — {{focus}} — 우선 조사하라 (수집의 «디자이너» 페르소나와 같은 렌즈다).
- **우선 조사**: 주제가 이 레포 UI 표면에 닿는다면 위 「디자인 제약」 의 디자인 SSOT 와 어긋나는 지점을, 그리고 주제와 관련된 디자인/UX·접근성 모범 사례를 먼저 본다.
- **근거 강조**: 레포 근거는 «파일:라인 + 위반한 의미 토큰/패턴명», 웹 근거는 접근성·대비 가이드라인·디자인 시스템 사례(URL). 색·간격·타이포의 «의미» 와 상호작용 상태(빈/오류/로딩/비활성/포커스)·접근성으로 판정하라 (특정 색을 가정하지 말고 «이 레포가 정한 의미» 로).
- 대상 레포에 «렌더되는 UI 표면» 이 없으면 그 사실을 보고서에 명시하고 디자인 브리프 0건(빈 배열)도 정답이다.`,
    "pt-BR": `## Perspectiva de pesquisa — especialista em design
Esta pesquisa é feita pela perspectiva de um especialista em «design». Investigue o tema primeiro com um olhar de design — {{focus}} — (a mesma lente da persona «designer» da coleta).
- **Investigação prioritária**: se o tema tocar a superfície de UI deste repo, olhe primeiro onde ele conflita com o SSOT de design em «Restrições de design» acima, e as melhores práticas de design/UX·acessibilidade relacionadas ao tema.
- **Ênfase em evidências**: a evidência do repo é «arquivo:linha + o token de significado/nome de padrão violado», a evidência web são diretrizes de acessibilidade·contraste·exemplos de design systems (URL). Julgue pelo «significado» de cor, espaçamento e tipografia e pelos estados de interação (vazio/erro/carregando/desabilitado/foco)·acessibilidade (não assuma uma cor específica — use «o significado que este repo define»).
- Se o repo alvo não tiver «superfície de UI renderizada», indique isso no relatório; zero briefs de design (array vazio) também é uma resposta correta.`,
    ru: `## Перспектива исследования — эксперт по дизайну
Это исследование ведётся с точки зрения эксперта по «дизайну». Исследуйте тему прежде всего глазом дизайна — {{focus}} — (та же линза, что у персоны «дизайнер» при сборе).
- **Приоритетное исследование**: если тема касается поверхности UI этого репозитория, смотрите сначала, где она конфликтует с дизайн-SSOT в «Ограничениях дизайна» выше, и на лучшие практики дизайна/UX·доступности, связанные с темой.
- **Акцент доказательств**: доказательство репозитория — «файл:строка + нарушенный смысловой токен/имя паттерна», веб-доказательство — руководства по доступности·контрасту·примеры дизайн-систем (URL). Судите по «смыслу» цвета, отступов и типографики и по состояниям взаимодействия (пусто/ошибка/загрузка/отключено/фокус)·доступности (не предполагайте конкретный цвет — используйте «смысл, который определяет этот репозиторий»).
- Если у целевого репозитория нет «отрисовываемой поверхности UI», укажите это в отчёте; ноль дизайн-брифов (пустой массив) — тоже правильный ответ.`,
    "zh-Hans": `## 调研视角 — 设计专家
本次调研以「设计」专家的视角进行。先以设计之眼调研主题 — {{focus}} —(与收集的「设计师」人格相同的视角)。
- **优先调研**: 若主题触及本仓库的 UI 表面,先看其与上方「设计约束」中设计 SSOT 冲突之处,以及与主题相关的设计/UX·无障碍最佳实践。
- **依据强调**: 仓库依据为「文件:行 + 被违反的含义令牌/模式名」,网络依据为无障碍·对比度指南·设计系统范例(URL)。以颜色·间距·排版的「含义」与交互状态(空/错误/加载/禁用/聚焦)·无障碍来判定(不要假定特定颜色——以「本仓库所定的含义」)。
- 若目标仓库没有「可渲染的 UI 表面」,在报告中说明;零条设计简报(空数组)也是正确答案。`,
  },

  // ── 리서치 렌즈 머리말 — bug ─────────────────────────────────────────────────
  "lens.research.bug": {
    ar: `## منظور البحث — خبير التصحيح
يُجرى هذا البحث بمنظور خبير «التصحيح». ابحث الموضوع أولاً بعين «ما الذي يتعطّل وكيف».
- **البحث ذو الأولوية**: مسارات إعادة الإنتاج·أنماط الفشل·الحالات الحدّية·مخاطر الانحدار، السجلات/تتبّع المكدّس/إشارات الخطأ ذات الصلة، و«القضايا المعروفة وتحليل أسبابها» المتصلة بالموضوع.
- **تأكيد السند**: سند المستودع حيث تظهر «ملف:سطر + خطوات إعادة الإنتاج/السجل/الانحدار»، وسند الويب أخطاء معروفة·تحليل أسباب·أفضل ممارسات الموثوقية (URL). قدّم السند «القابل لإعادة الإنتاج» على التخمين، وضع في spec كل بريف «طريقة إعادة الإنتاج / طريقة التأكد بعد الإصلاح (اختبار الانحدار)».`,
    en: `## Research perspective — debugging expert
This research runs from a «debugging» expert's perspective. Investigate the topic first through the lens of «what breaks and how».
- **Priority investigation**: reproduction paths·failure modes·edge cases·regression risk, related logs/stack traces/error signals, and «known issues and their root-cause analysis» related to the topic.
- **Evidence emphasis**: repo evidence is where «file:line + reproduction steps/log/regression» is visible, web evidence is known bugs·root-cause analysis·reliability best practices (URL). Prioritize «reproducible» evidence over conjecture, and put in each brief's spec «how to reproduce / how to confirm after the fix (regression test)».`,
    es: `## Perspectiva de investigación — experto en depuración
Esta investigación se realiza desde la perspectiva de un experto en «depuración». Investiga el tema primero a través de la lente de «qué se rompe y cómo».
- **Investigación prioritaria**: rutas de reproducción·modos de fallo·casos límite·riesgo de regresión, logs/stack traces/señales de error relacionados, y «issues conocidos y su análisis de causa raíz» relacionados con el tema.
- **Énfasis en evidencia**: la evidencia del repo es donde se ve «archivo:línea + pasos de reproducción/log/regresión», la evidencia web son bugs conocidos·análisis de causa raíz·mejores prácticas de fiabilidad (URL). Prioriza la evidencia «reproducible» sobre la conjetura, y pon en el spec de cada brief «cómo reproducir / cómo confirmar tras el arreglo (test de regresión)».`,
    fr: `## Perspective de recherche — expert débogage
Cette recherche se fait du point de vue d'un expert «débogage». Investigue le sujet d'abord à travers le prisme de «ce qui casse et comment».
- **Investigation prioritaire**: chemins de reproduction·modes de défaillance·cas limites·risque de régression, logs/stack traces/signaux d'erreur liés, et «issues connues et leur analyse de cause racine» liées au sujet.
- **Emphase sur les preuves**: la preuve du dépôt est là où «fichier:ligne + étapes de reproduction/log/régression» est visible, la preuve web sont des bugs connus·analyses de cause racine·bonnes pratiques de fiabilité (URL). Priorise la preuve «reproductible» sur la conjecture, et mets dans le spec de chaque brief «comment reproduire / comment confirmer après le correctif (test de régression)».`,
    hi: `## शोध दृष्टिकोण — डिबगिंग विशेषज्ञ
यह शोध «डिबगिंग» विशेषज्ञ के दृष्टिकोण से होता है। विषय को पहले «क्या और कैसे टूटता है» की दृष्टि से जाँचें।
- **प्राथमिक जाँच**: पुनरुत्पादन पथ·विफलता मोड·किनारे के मामले·रिग्रेशन जोखिम, संबंधित लॉग/स्टैक ट्रेस/त्रुटि संकेत, और विषय से संबंधित «ज्ञात issues व उनका मूल-कारण विश्लेषण»।
- **साक्ष्य ज़ोर**: रेपो साक्ष्य वहाँ जहाँ «फ़ाइल:लाइन + पुनरुत्पादन चरण/लॉग/रिग्रेशन» दिखे, वेब साक्ष्य ज्ञात बग·मूल-कारण विश्लेषण·विश्वसनीयता सर्वोत्तम अभ्यास (URL)। अनुमान से ऊपर «पुनरुत्पाद्य» साक्ष्य को प्राथमिकता दें, और हर ब्रीफ़ के spec में «कैसे पुनरुत्पादित करें / फ़िक्स के बाद कैसे पुष्टि करें (रिग्रेशन टेस्ट)» डालें।`,
    ja: `## 調査の観点 — デバッグの専門家
この調査は「デバッグ」専門家の観点で行う。主題をまず「何がどう壊れるか」の目で調査せよ。
- **優先調査**: 再現経路·失敗モード·エッジケース·リグレッションリスク、関連するログ/スタックトレース/エラー信号、そして主題に関連する「既知の課題とその原因分析」。
- **根拠の強調**: リポジトリ根拠は「ファイル:行 + 再現手順/ログ/リグレッション」が見える箇所、ウェブ根拠は既知のバグ·原因分析·信頼性のベストプラクティス(URL)。推測より「再現可能な」根拠を優先し、各ブリーフの spec に「再現方法 / 修正後の確認(リグレッションテスト)方法」を入れよ。`,
    ko: `## 조사 관점 — 디버깅 전문가
이 리서치는 «디버깅» 전문가 관점으로 수행한다. 주제를 «무엇이 어떻게 깨지는가» 의 눈으로 우선 조사하라.
- **우선 조사**: 재현 경로·실패 모드·엣지케이스·회귀 위험, 관련 로그/스택트레이스/에러 신호, 주제와 관련해 «알려진 이슈와 그 원인 분석».
- **근거 강조**: 레포 근거는 «파일:라인 + 재현 단계/로그/회귀» 가 보이는 곳, 웹 근거는 알려진 버그·원인 분석·신뢰성 모범 사례(URL). 추정보다 «재현 가능한» 근거를 우선하고, 각 브리프의 spec 에 «재현 방법 / 수정 후 확인(회귀 테스트) 방법» 을 담아라.`,
    "pt-BR": `## Perspectiva de pesquisa — especialista em depuração
Esta pesquisa é feita pela perspectiva de um especialista em «depuração». Investigue o tema primeiro pela lente de «o que quebra e como».
- **Investigação prioritária**: caminhos de reprodução·modos de falha·casos de borda·risco de regressão, logs/stack traces/sinais de erro relacionados, e «issues conhecidos e sua análise de causa raiz» relacionados ao tema.
- **Ênfase em evidências**: a evidência do repo é onde «arquivo:linha + passos de reprodução/log/regressão» é visível, a evidência web são bugs conhecidos·análise de causa raiz·melhores práticas de confiabilidade (URL). Priorize a evidência «reproduzível» sobre a conjectura, e coloque no spec de cada brief «como reproduzir / como confirmar após a correção (teste de regressão)».`,
    ru: `## Перспектива исследования — эксперт по отладке
Это исследование ведётся с точки зрения эксперта по «отладке». Исследуйте тему прежде всего через призму «что и как ломается».
- **Приоритетное исследование**: пути воспроизведения·режимы отказа·краевые случаи·риск регрессии, связанные логи/стек-трейсы/сигналы ошибок, и «известные проблемы и анализ их первопричин», связанные с темой.
- **Акцент доказательств**: доказательство репозитория — там, где видно «файл:строка + шаги воспроизведения/лог/регрессия», веб-доказательство — известные баги·анализ первопричин·лучшие практики надёжности (URL). Приоритезируйте «воспроизводимое» доказательство над домыслом и в spec каждого брифа укажите «как воспроизвести / как подтвердить после исправления (регрессионный тест)».`,
    "zh-Hans": `## 调研视角 — 调试专家
本次调研以「调试」专家的视角进行。先以「什么会坏、怎么坏」的眼光调研主题。
- **优先调研**: 复现路径·失败模式·边界情形·回归风险,相关日志/堆栈跟踪/错误信号,以及与主题相关的「已知问题及其根因分析」。
- **依据强调**: 仓库依据为可见「文件:行 + 复现步骤/日志/回归」之处,网络依据为已知 bug·根因分析·可靠性最佳实践(URL)。优先「可复现」依据而非臆测,并在每条简报的 spec 中写明「如何复现 / 修复后如何确认(回归测试)」。`,
  },

  // ── 리서치 렌즈 머리말 — qa ──────────────────────────────────────────────────
  "lens.research.qa": {
    ar: `## منظور البحث — خبير ضمان الجودة (QA)
يُجرى هذا البحث بمنظور خبير «ضمان الجودة (QA)». ابحث الموضوع أولاً بعين «ماذا نتحقق وكيف نضمن الجودة» (إن كان التصحيح «لماذا يتعطّل» فالـ QA «كيف نضمن ألا يتعطّل»).
- **البحث ذو الأولوية**: قابلية الاختبار·معايير القبول·حالات/سيناريوهات الاختبار (طبيعي·حدّي·فشل)·فجوات التغطية·تصميم اختبار الانحدار·بوابات الجودة، وأفضل ممارسات التحقق/QA المتصلة بالموضوع.
- **تأكيد السند**: سند المستودع «ملف:سطر + السلوك الواجب التحقق منه / وجود اختبار حالي»، وسند الويب استراتيجيات الاختبار·قوائم تحقق QA·أفضل ممارسات التحقق (URL). ضع في spec كل بريف «معايير القبول / حالات الاختبار (طبيعي·حدّي·فشل) / طريقة تأكيد الانحدار».`,
    en: `## Research perspective — QA expert
This research runs from a «QA (quality assurance)» expert's perspective. Investigate the topic first through the lens of «what to verify and how to guarantee quality» (if debugging is «why it breaks», QA is «how to guarantee it does not break»).
- **Priority investigation**: testability·acceptance criteria·test cases/scenarios (normal·boundary·failure)·coverage gaps·regression-test design·quality gates, and verification/QA best practices related to the topic.
- **Evidence emphasis**: repo evidence is «file:line + the behavior to verify / whether a current test exists», web evidence is test strategies·QA checklists·verification best practices (URL). Put in each brief's spec «acceptance criteria / test cases (normal·boundary·failure) / how to confirm regression».`,
    es: `## Perspectiva de investigación — experto en QA
Esta investigación se realiza desde la perspectiva de un experto en «QA (aseguramiento de calidad)». Investiga el tema primero a través de la lente de «qué verificar y cómo garantizar la calidad» (si la depuración es «por qué se rompe», QA es «cómo garantizar que no se rompa»).
- **Investigación prioritaria**: testabilidad·criterios de aceptación·casos/escenarios de prueba (normal·límite·fallo)·brechas de cobertura·diseño de tests de regresión·puertas de calidad, y mejores prácticas de verificación/QA relacionadas con el tema.
- **Énfasis en evidencia**: la evidencia del repo es «archivo:línea + el comportamiento a verificar / si existe un test actual», la evidencia web son estrategias de prueba·checklists de QA·mejores prácticas de verificación (URL). Pon en el spec de cada brief «criterios de aceptación / casos de prueba (normal·límite·fallo) / cómo confirmar la regresión».`,
    fr: `## Perspective de recherche — expert QA
Cette recherche se fait du point de vue d'un expert «QA (assurance qualité)». Investigue le sujet d'abord à travers le prisme de «quoi vérifier et comment garantir la qualité» (si le débogage est «pourquoi ça casse», la QA est «comment garantir que ça ne casse pas»).
- **Investigation prioritaire**: testabilité·critères d'acceptation·cas/scénarios de test (normal·limite·échec)·lacunes de couverture·conception de tests de régression·portes qualité, et bonnes pratiques de vérification/QA liées au sujet.
- **Emphase sur les preuves**: la preuve du dépôt est «fichier:ligne + le comportement à vérifier / si un test actuel existe», la preuve web sont des stratégies de test·checklists QA·bonnes pratiques de vérification (URL). Mets dans le spec de chaque brief «critères d'acceptation / cas de test (normal·limite·échec) / comment confirmer la régression».`,
    hi: `## शोध दृष्टिकोण — QA विशेषज्ञ
यह शोध «QA (गुणवत्ता आश्वासन)» विशेषज्ञ के दृष्टिकोण से होता है। विषय को पहले «क्या सत्यापित करें और गुणवत्ता कैसे सुनिश्चित करें» की दृष्टि से जाँचें (यदि डिबगिंग «क्यों टूटता है» है, तो QA «कैसे सुनिश्चित करें कि न टूटे»)।
- **प्राथमिक जाँच**: परीक्षण-योग्यता·स्वीकृति मानदंड·टेस्ट केस/परिदृश्य (सामान्य·सीमांत·विफलता)·कवरेज अंतराल·रिग्रेशन-टेस्ट डिज़ाइन·गुणवत्ता गेट, और विषय से संबंधित सत्यापन/QA सर्वोत्तम अभ्यास।
- **साक्ष्य ज़ोर**: रेपो साक्ष्य «फ़ाइल:लाइन + सत्यापित किया जाने वाला व्यवहार / वर्तमान टेस्ट है या नहीं», वेब साक्ष्य टेस्ट रणनीतियाँ·QA चेकलिस्ट·सत्यापन सर्वोत्तम अभ्यास (URL)। हर ब्रीफ़ के spec में «स्वीकृति मानदंड / टेस्ट केस (सामान्य·सीमांत·विफलता) / रिग्रेशन कैसे पुष्टि करें» डालें।`,
    ja: `## 調査の観点 — QA の専門家
この調査は「QA(品質保証)」専門家の観点で行う。主題をまず「何を検証し、どう品質を保証するか」の目で調査せよ(デバッグが「なぜ壊れるか」なら、QA は「壊れないことをどう保証するか」)。
- **優先調査**: テスト可能性·受け入れ基準·テストケース/シナリオ(正常·境界·失敗)·カバレッジの空白·リグレッションテスト設計·品質ゲート、そして主題に関連する検証/QA のベストプラクティス。
- **根拠の強調**: リポジトリ根拠は「ファイル:行 + 検証すべき挙動 / 現在テストの有無」、ウェブ根拠はテスト戦略·QA チェックリスト·検証のベストプラクティス(URL)。各ブリーフの spec に「受け入れ基準 / テストケース(正常·境界·失敗) / リグレッション確認方法」を入れよ。`,
    ko: `## 조사 관점 — QA 전문가
이 리서치는 «QA(품질 보증)» 전문가 관점으로 수행한다. 주제를 «무엇을 어떻게 검증하고 품질을 보장하는가» 의 눈으로 우선 조사하라 (디버깅이 «왜 깨지나» 라면 QA 는 «어떻게 깨지지 않음을 보증하나»).
- **우선 조사**: 테스트 가능성·수용 기준(acceptance criteria)·테스트 케이스/시나리오(정상·경계·실패)·커버리지 공백·회귀 테스트 설계·품질 게이트, 주제와 관련된 검증·QA 모범 사례.
- **근거 강조**: 레포 근거는 «파일:라인 + 검증해야 할 동작 / 현재 테스트 유무», 웹 근거는 테스트 전략·QA 체크리스트·검증 모범 사례(URL). 각 브리프의 spec 에 «수용 기준 / 테스트 케이스(정상·경계·실패) / 회귀 확인 방법» 을 담아라.`,
    "pt-BR": `## Perspectiva de pesquisa — especialista em QA
Esta pesquisa é feita pela perspectiva de um especialista em «QA (garantia de qualidade)». Investigue o tema primeiro pela lente de «o que verificar e como garantir a qualidade» (se a depuração é «por que quebra», QA é «como garantir que não quebre»).
- **Investigação prioritária**: testabilidade·critérios de aceitação·casos/cenários de teste (normal·limite·falha)·lacunas de cobertura·design de testes de regressão·portões de qualidade, e melhores práticas de verificação/QA relacionadas ao tema.
- **Ênfase em evidências**: a evidência do repo é «arquivo:linha + o comportamento a verificar / se existe um teste atual», a evidência web são estratégias de teste·checklists de QA·melhores práticas de verificação (URL). Coloque no spec de cada brief «critérios de aceitação / casos de teste (normal·limite·falha) / como confirmar a regressão».`,
    ru: `## Перспектива исследования — эксперт по QA
Это исследование ведётся с точки зрения эксперта по «QA (обеспечение качества)». Исследуйте тему прежде всего через призму «что проверять и как гарантировать качество» (если отладка — это «почему ломается», то QA — «как гарантировать, что не сломается»).
- **Приоритетное исследование**: тестируемость·критерии приёмки·тест-кейсы/сценарии (нормальный·граничный·отказ)·пробелы покрытия·проектирование регрессионных тестов·ворота качества, и лучшие практики верификации/QA, связанные с темой.
- **Акцент доказательств**: доказательство репозитория — «файл:строка + проверяемое поведение / наличие текущего теста», веб-доказательство — стратегии тестирования·чеклисты QA·лучшие практики верификации (URL). В spec каждого брифа укажите «критерии приёмки / тест-кейсы (нормальный·граничный·отказ) / как подтвердить регрессию».`,
    "zh-Hans": `## 调研视角 — QA 专家
本次调研以「QA(质量保证)」专家的视角进行。先以「验证什么、如何保证质量」的眼光调研主题(若调试是「为何会坏」,QA 则是「如何保证不坏」)。
- **优先调研**: 可测试性·验收标准·测试用例/场景(正常·边界·失败)·覆盖率空白·回归测试设计·质量门,以及与主题相关的验证/QA 最佳实践。
- **依据强调**: 仓库依据为「文件:行 + 需验证的行为 / 当前是否有测试」,网络依据为测试策略·QA 清单·验证最佳实践(URL)。在每条简报的 spec 中写明「验收标准 / 测试用例(正常·边界·失败) / 如何确认回归」。`,
  },

  // ── 리서치 렌즈 머리말 — security ────────────────────────────────────────────
  "lens.research.security": {
    ar: `## منظور البحث — خبير الأمن
يُجرى هذا البحث بمنظور خبير «الأمن». ابحث الموضوع أولاً بعين «ما الذي يُكشف وكيف يُستغل» (إن كان التصحيح «لماذا يتعطّل» وQA «كيف نضمن ألا يتعطّل»، فالأمن «كيف يُستغل وكيف نمنعه»).
- **البحث ذو الأولوية**: تدفقات المصادقة·التفويض، التعامل مع المفاتيح·الأسرار (الإنشاء·التخزين·التدوير·الإلغاء)، سطح التعرّض الشبكي (المنافذ المفتوحة·الربط·تشفير النقل)، تدفق بيانات الاعتماد (التخزين المحلي·النقل·الاقتران)، حدود الثقة ومقارنتها بنموذج التهديد (الافتراضات·التخفيفات·المخاطر المتبقية). و«الثغرات المعروفة واستغلالها·تخفيفها» المتصلة بالموضوع.
- **تأكيد السند**: سند المستودع «ملف:سطر + حدود الثقة (أين يتغيّر مستوى الثقة)·التحقق من المدخلات·التعامل مع الأسرار»، وسند الويب CVE·التنبيهات الأمنية·أفضل الممارسات الأمنية (URL). احكم بـ«سيناريو استغلال محدد وتخفيفه» بدل التخمين، وضع في spec كل بريف «التهديد (ماذا·مَن) / التخفيف / التحقق (كيف نتأكد من الأمان)».
- إن لم يكن للمستودع المستهدف «سطح متعلق بالأمن» فبيّن ذلك في التقرير، وبريف أمني بعدد 0 (مصفوفة فارغة) إجابة صحيحة أيضاً.`,
    en: `## Research perspective — security expert
This research runs from a «security» expert's perspective. Investigate the topic first through the lens of «what is exposed and how it can be exploited» (if debugging is «why it breaks» and QA is «how to guarantee it does not break», security is «how it can be exploited and how to prevent it»).
- **Priority investigation**: authentication·authorization flows, key·secret handling (generation·storage·rotation·revocation), network exposure surface (open ports·binding·transport encryption), credential flow (local storage·transmission·pairing), trust boundaries and comparison to the threat model (assumptions·mitigations·residual risk). And «known vulnerabilities and their exploitation·mitigation» related to the topic.
- **Evidence emphasis**: repo evidence is «file:line + trust boundary (where the trust level changes)·input validation·secret handling», web evidence is CVEs·security advisories·security best practices (URL). Judge by a «concrete exploitation scenario and its mitigation» rather than conjecture, and put in each brief's spec «threat (what·who) / mitigation / verification (how to confirm it is safe)».
- If the target repo has no «security-related surface», state that in the report; zero security briefs (empty array) is also a correct answer.`,
    es: `## Perspectiva de investigación — experto en seguridad
Esta investigación se realiza desde la perspectiva de un experto en «seguridad». Investiga el tema primero a través de la lente de «qué se expone y cómo puede explotarse» (si la depuración es «por qué se rompe» y QA es «cómo garantizar que no se rompa», la seguridad es «cómo puede explotarse y cómo prevenirlo»).
- **Investigación prioritaria**: flujos de autenticación·autorización, manejo de claves·secretos (generación·almacenamiento·rotación·revocación), superficie de exposición de red (puertos abiertos·binding·cifrado de transporte), flujo de credenciales (almacenamiento local·transmisión·emparejamiento), límites de confianza y comparación con el modelo de amenazas (supuestos·mitigaciones·riesgo residual). Y «vulnerabilidades conocidas y su explotación·mitigación» relacionadas con el tema.
- **Énfasis en evidencia**: la evidencia del repo es «archivo:línea + límite de confianza (dónde cambia el nivel de confianza)·validación de entrada·manejo de secretos», la evidencia web son CVEs·avisos de seguridad·mejores prácticas de seguridad (URL). Juzga por un «escenario de explotación concreto y su mitigación» en vez de conjeturas, y pon en el spec de cada brief «amenaza (qué·quién) / mitigación / verificación (cómo confirmar que es seguro)».
- Si el repo objetivo no tiene «superficie relacionada con la seguridad», indícalo en el informe; cero briefs de seguridad (array vacío) también es una respuesta correcta.`,
    fr: `## Perspective de recherche — expert sécurité
Cette recherche se fait du point de vue d'un expert «sécurité». Investigue le sujet d'abord à travers le prisme de «ce qui est exposé et comment cela peut être exploité» (si le débogage est «pourquoi ça casse» et la QA «comment garantir que ça ne casse pas», la sécurité est «comment cela peut être exploité et comment l'empêcher»).
- **Investigation prioritaire**: flux d'authentification·autorisation, gestion des clés·secrets (génération·stockage·rotation·révocation), surface d'exposition réseau (ports ouverts·binding·chiffrement de transport), flux d'identifiants (stockage local·transmission·appairage), frontières de confiance et comparaison au modèle de menaces (hypothèses·mitigations·risque résiduel). Et «vulnérabilités connues et leur exploitation·mitigation» liées au sujet.
- **Emphase sur les preuves**: la preuve du dépôt est «fichier:ligne + frontière de confiance (où le niveau de confiance change)·validation des entrées·gestion des secrets», la preuve web sont des CVE·avis de sécurité·bonnes pratiques de sécurité (URL). Juge par un «scénario d'exploitation concret et sa mitigation» plutôt que par conjecture, et mets dans le spec de chaque brief «menace (quoi·qui) / mitigation / vérification (comment confirmer que c'est sûr)».
- Si le dépôt cible n'a pas de «surface liée à la sécurité», indique-le dans le rapport; zéro brief de sécurité (tableau vide) est aussi une réponse correcte.`,
    hi: `## शोध दृष्टिकोण — सुरक्षा विशेषज्ञ
यह शोध «सुरक्षा» विशेषज्ञ के दृष्टिकोण से होता है। विषय को पहले «क्या उजागर होता है और कैसे इसका दुरुपयोग हो सकता है» की दृष्टि से जाँचें (यदि डिबगिंग «क्यों टूटता है» और QA «कैसे न टूटे की गारंटी» है, तो सुरक्षा «कैसे दुरुपयोग हो सकता है और कैसे रोकें» है)।
- **प्राथमिक जाँच**: प्रमाणीकरण·प्राधिकरण प्रवाह, कुंजी·सीक्रेट हैंडलिंग (निर्माण·भंडारण·रोटेशन·निरस्तीकरण), नेटवर्क एक्सपोज़र सतह (खुले पोर्ट·बाइंडिंग·ट्रांसपोर्ट एन्क्रिप्शन), क्रेडेंशियल प्रवाह (स्थानीय भंडारण·प्रेषण·पेयरिंग), विश्वास सीमाएँ और थ्रेट मॉडल से तुलना (धारणाएँ·शमन·अवशिष्ट जोखिम)। और विषय से संबंधित «ज्ञात कमज़ोरियाँ व उनका दुरुपयोग·शमन»।
- **साक्ष्य ज़ोर**: रेपो साक्ष्य «फ़ाइल:लाइन + विश्वास सीमा (कहाँ विश्वास स्तर बदलता है)·इनपुट सत्यापन·सीक्रेट हैंडलिंग», वेब साक्ष्य CVE·सुरक्षा परामर्श·सुरक्षा सर्वोत्तम अभ्यास (URL)। अनुमान के बजाय «ठोस दुरुपयोग परिदृश्य व उसका शमन» से निर्णय करें, और हर ब्रीफ़ के spec में «खतरा (क्या·कौन) / शमन / सत्यापन (सुरक्षा कैसे पुष्टि करें)» डालें।
- यदि लक्ष्य रेपो में «सुरक्षा-संबंधी सतह» न हो तो रिपोर्ट में बताएँ; शून्य सुरक्षा ब्रीफ़ (खाली array) भी सही उत्तर है।`,
    ja: `## 調査の観点 — セキュリティの専門家
この調査は「セキュリティ」専門家の観点で行う。主題をまず「何が露出し、どう悪用されうるか」の目で調査せよ(デバッグが「なぜ壊れるか」、QA が「壊れないことをどう保証するか」なら、セキュリティは「どう悪用されうるか、どう防ぐか」)。
- **優先調査**: 認証·認可フロー、鍵·シークレットの扱い(生成·保存·ローテーション·失効)、ネットワーク露出面(開放ポート·バインド·転送暗号化)、資格情報フロー(ローカル保管·伝達·ペアリング)、信頼境界と脅威モデルとの対比(前提·緩和策·残存リスク)。そして主題に関連する「既知の脆弱性とその悪用·緩和」。
- **根拠の強調**: リポジトリ根拠は「ファイル:行 + 信頼境界(どこで信頼レベルが変わるか)·入力検証·シークレットの扱い」、ウェブ根拠は CVE·セキュリティ勧告·セキュリティのベストプラクティス(URL)。推測より「具体的な悪用シナリオとその緩和策」で判定し、各ブリーフの spec に「脅威(何·誰) / 緩和策 / 検証(安全をどう確認)」を入れよ。
- 対象リポジトリに「セキュリティ関連の表面」がなければ、その事実を報告書に明示し、セキュリティブリーフ0件(空配列)も正解だ。`,
    ko: `## 조사 관점 — 보안 전문가
이 리서치는 «보안» 전문가 관점으로 수행한다. 주제를 «무엇이 노출되고 어떻게 악용될 수 있는가» 의 눈으로 우선 조사하라 (디버깅이 «왜 깨지나», QA 가 «어떻게 깨지지 않음을 보증하나» 라면, 보안은 «어떻게 악용될 수 있고 어떻게 막나»).
- **우선 조사**: 인증·인가 흐름, 키·시크릿 취급(생성·저장·회전·폐기), 네트워크 노출면(열린 포트·바인딩·전송 암호화), 자격증명 흐름(로컬 보관·전달·페어링), 신뢰 경계와 위협모델 대비(가정·완화책·잔여 위험). 주제와 관련된 «알려진 취약점과 그 악용·완화».
- **근거 강조**: 레포 근거는 «파일:라인 + 신뢰 경계(어디서 신뢰 수준이 바뀌나)·입력 검증·시크릿 취급», 웹 근거는 CVE·보안 권고·보안 모범 사례(URL). 추정보다 «구체적 악용 시나리오와 그 완화책» 으로 판정하고, 각 브리프의 spec 에 «위협(무엇을·누가) / 완화책 / 검증(안전을 어떻게 확인)» 을 담아라.
- 대상 레포에 «보안 관련 표면» 이 없으면 그 사실을 보고서에 명시하고 보안 브리프 0건(빈 배열)도 정답이다.`,
    "pt-BR": `## Perspectiva de pesquisa — especialista em segurança
Esta pesquisa é feita pela perspectiva de um especialista em «segurança». Investigue o tema primeiro pela lente de «o que é exposto e como pode ser explorado» (se a depuração é «por que quebra» e QA é «como garantir que não quebre», a segurança é «como pode ser explorado e como prevenir»).
- **Investigação prioritária**: fluxos de autenticação·autorização, manejo de chaves·segredos (geração·armazenamento·rotação·revogação), superfície de exposição de rede (portas abertas·binding·criptografia de transporte), fluxo de credenciais (armazenamento local·transmissão·pareamento), limites de confiança e comparação com o modelo de ameaças (suposições·mitigações·risco residual). E «vulnerabilidades conhecidas e sua exploração·mitigação» relacionadas ao tema.
- **Ênfase em evidências**: a evidência do repo é «arquivo:linha + limite de confiança (onde o nível de confiança muda)·validação de entrada·manejo de segredos», a evidência web são CVEs·avisos de segurança·melhores práticas de segurança (URL). Julgue por um «cenário de exploração concreto e sua mitigação» em vez de conjectura, e coloque no spec de cada brief «ameaça (o quê·quem) / mitigação / verificação (como confirmar que é seguro)».
- Se o repo alvo não tiver «superfície relacionada à segurança», indique isso no relatório; zero briefs de segurança (array vazio) também é uma resposta correta.`,
    ru: `## Перспектива исследования — эксперт по безопасности
Это исследование ведётся с точки зрения эксперта по «безопасности». Исследуйте тему прежде всего через призму «что раскрывается и как это может быть использовано» (если отладка — «почему ломается», а QA — «как гарантировать, что не сломается», то безопасность — «как это может быть использовано и как предотвратить»).
- **Приоритетное исследование**: потоки аутентификации·авторизации, обращение с ключами·секретами (создание·хранение·ротация·отзыв), поверхность сетевого раскрытия (открытые порты·привязка·шифрование передачи), поток учётных данных (локальное хранение·передача·сопряжение), границы доверия и сопоставление с моделью угроз (допущения·меры смягчения·остаточный риск). И «известные уязвимости и их эксплуатация·смягчение», связанные с темой.
- **Акцент доказательств**: доказательство репозитория — «файл:строка + граница доверия (где меняется уровень доверия)·валидация ввода·обращение с секретами», веб-доказательство — CVE·бюллетени безопасности·лучшие практики безопасности (URL). Судите по «конкретному сценарию эксплуатации и его смягчению», а не по домыслу, и в spec каждого брифа укажите «угроза (что·кто) / смягчение / верификация (как подтвердить безопасность)».
- Если у целевого репозитория нет «поверхности, связанной с безопасностью», укажите это в отчёте; ноль брифов по безопасности (пустой массив) — тоже правильный ответ.`,
    "zh-Hans": `## 调研视角 — 安全专家
本次调研以「安全」专家的视角进行。先以「什么会被暴露、如何被利用」的眼光调研主题(若调试是「为何会坏」、QA 是「如何保证不坏」,安全则是「如何被利用、如何防范」)。
- **优先调研**: 认证·授权流程,密钥·密文处理(生成·存储·轮换·吊销),网络暴露面(开放端口·绑定·传输加密),凭据流(本地保存·传递·配对),信任边界及与威胁模型的对照(假设·缓解·残余风险)。以及与主题相关的「已知漏洞及其利用·缓解」。
- **依据强调**: 仓库依据为「文件:行 + 信任边界(信任级别在何处改变)·输入校验·密文处理」,网络依据为 CVE·安全公告·安全最佳实践(URL)。以「具体的利用场景及其缓解」而非臆测来判定,并在每条简报的 spec 中写明「威胁(什么·谁) / 缓解 / 验证(如何确认安全)」。
- 若目标仓库没有「与安全相关的表面」,在报告中说明;零条安全简报(空数组)也是正确答案。`,
  },

  // ── 리서치 렌즈 머리말 — pm ──────────────────────────────────────────────────
  "lens.research.pm": {
    ar: `## منظور البحث — خبير التخطيط (PM/المنتج)
يُجرى هذا البحث بمنظور خبير «التخطيط (PM/المنتج)». ابحث الموضوع أولاً بعين «ماذا نبني أولاً ولماذا وماذا نؤجّل» (إن كان التصحيح «لماذا يتعطّل» وQA «كيف نضمن»، فالتخطيط «ماذا نبني وبأي ترتيب وبأي مقايضات»).
- **البحث ذو الأولوية**: مشكلات·احتياجات المستخدم وأولوياتها، خارطة الطريق/المعالم (الآن مقابل التالي مقابل لاحقاً)، مقايضات النطاق (قصّ النطاق·حدود MVP) وأسسها، تعريف النجاح (ما الذي يُعدّ «مُنجزاً»)، التبعيات·المخاطر. وأفضل ممارسات استراتيجية المنتج·تحديد الأولويات (مثل RICE·الفرصة/الأثر) المتصلة بالموضوع.
- **تأكيد السند**: سند المستودع «ملف:سطر + الحالة الحالية (موجود/غير موجود/جزئي) وحيث تمسّ مشكلة المستخدم»، وسند الويب طلب السوق·اختيارات أولويات المنافسين·أمثلة استراتيجية المنتج (URL). احكم بـ«الارتباط بمشكلة المستخدم» بدل التخمين، وضع في spec كل بريف «مشكلة المستخدم المحلولة / أساس الأولوية / النطاق (المُدرَج·المُستبعَد) / معيار النجاح».`,
    en: `## Research perspective — product (PM) expert
This research runs from a «product (PM)» expert's perspective. Investigate the topic first through the lens of «what to build first and why, and what to defer» (if debugging is «why it breaks» and QA is «how to guarantee», product is «what to build in what order, with what trade-offs»).
- **Priority investigation**: user problems·needs and their priority, roadmap/milestones (now vs next vs later), scope trade-offs (scope cut·MVP boundary) and their rationale, definition of success (what counts as «done»), dependencies·risks. And product-strategy·prioritization best practices (e.g., RICE·opportunity/impact) related to the topic.
- **Evidence emphasis**: repo evidence is «file:line + current state (present/absent/partial) and where it touches a user problem», web evidence is market demand·competitors' priority choices·product-strategy examples (URL). Judge by «connection to a user problem» rather than conjecture, and put in each brief's spec «the user problem solved / priority rationale / scope (in·out) / success criteria».`,
    es: `## Perspectiva de investigación — experto en producto (PM)
Esta investigación se realiza desde la perspectiva de un experto en «producto (PM)». Investiga el tema primero a través de la lente de «qué construir primero y por qué, y qué posponer» (si la depuración es «por qué se rompe» y QA es «cómo garantizar», producto es «qué construir, en qué orden, con qué compensaciones»).
- **Investigación prioritaria**: problemas·necesidades del usuario y su prioridad, roadmap/hitos (ahora vs siguiente vs después), compensaciones de alcance (recorte de alcance·límite de MVP) y su justificación, definición de éxito (qué cuenta como «hecho»), dependencias·riesgos. Y mejores prácticas de estrategia de producto·priorización (p. ej., RICE·oportunidad/impacto) relacionadas con el tema.
- **Énfasis en evidencia**: la evidencia del repo es «archivo:línea + estado actual (presente/ausente/parcial) y dónde toca un problema del usuario», la evidencia web son demanda de mercado·elecciones de prioridad de competidores·ejemplos de estrategia de producto (URL). Juzga por la «conexión con un problema del usuario» en vez de conjeturas, y pon en el spec de cada brief «el problema del usuario resuelto / justificación de prioridad / alcance (dentro·fuera) / criterios de éxito».`,
    fr: `## Perspective de recherche — expert produit (PM)
Cette recherche se fait du point de vue d'un expert «produit (PM)». Investigue le sujet d'abord à travers le prisme de «quoi construire d'abord et pourquoi, et quoi reporter» (si le débogage est «pourquoi ça casse» et la QA «comment garantir», le produit est «quoi construire, dans quel ordre, avec quels compromis»).
- **Investigation prioritaire**: problèmes·besoins de l'utilisateur et leur priorité, roadmap/jalons (maintenant vs ensuite vs plus tard), compromis de portée (coupe de portée·frontière MVP) et leur justification, définition du succès (qu'est-ce qui compte comme «fait»), dépendances·risques. Et bonnes pratiques de stratégie produit·priorisation (p. ex. RICE·opportunité/impact) liées au sujet.
- **Emphase sur les preuves**: la preuve du dépôt est «fichier:ligne + état actuel (présent/absent/partiel) et où cela touche un problème utilisateur», la preuve web sont demande du marché·choix de priorité des concurrents·exemples de stratégie produit (URL). Juge par la «connexion à un problème utilisateur» plutôt que par conjecture, et mets dans le spec de chaque brief «le problème utilisateur résolu / justification de priorité / portée (inclus·exclu) / critères de succès».`,
    hi: `## शोध दृष्टिकोण — उत्पाद (PM) विशेषज्ञ
यह शोध «उत्पाद (PM)» विशेषज्ञ के दृष्टिकोण से होता है। विषय को पहले «पहले क्या और क्यों बनाएँ, और क्या टालें» की दृष्टि से जाँचें (यदि डिबगिंग «क्यों टूटता है» और QA «कैसे गारंटी दें» है, तो उत्पाद «क्या, किस क्रम में, किन समझौतों के साथ बनाएँ» है)।
- **प्राथमिक जाँच**: उपयोगकर्ता समस्याएँ·ज़रूरतें और उनकी प्राथमिकता, रोडमैप/मील के पत्थर (अभी बनाम अगला बनाम बाद में), दायरा समझौते (स्कोप कट·MVP सीमा) और उनके कारण, सफलता की परिभाषा (क्या «हो गया» माना जाए), निर्भरताएँ·जोखिम। और विषय से संबंधित उत्पाद रणनीति·प्राथमिकता-निर्धारण सर्वोत्तम अभ्यास (जैसे RICE·अवसर/प्रभाव)।
- **साक्ष्य ज़ोर**: रेपो साक्ष्य «फ़ाइल:लाइन + वर्तमान स्थिति (मौजूद/अनुपस्थित/आंशिक) और कहाँ उपयोगकर्ता समस्या को छूता है», वेब साक्ष्य बाज़ार माँग·प्रतिस्पर्धियों के प्राथमिकता चयन·उत्पाद रणनीति उदाहरण (URL)। अनुमान के बजाय «उपयोगकर्ता समस्या से जुड़ाव» से निर्णय करें, और हर ब्रीफ़ के spec में «हल की गई उपयोगकर्ता समस्या / प्राथमिकता का कारण / दायरा (अंदर·बाहर) / सफलता मानदंड» डालें।`,
    ja: `## 調査の観点 — 企画(PM/プロダクト)の専門家
この調査は「企画(PM/プロダクト)」専門家の観点で行う。主題をまず「何をなぜ先に作り、何を後回しにするか」の目で調査せよ(デバッグが「なぜ壊れるか」、QA が「どう保証するか」なら、企画は「何をどの順で·どんなトレードオフで作るか」)。
- **優先調査**: ユーザーの問題·ニーズとその優先度、ロードマップ/マイルストーン(今 vs 次 vs 後)、スコープのトレードオフ(スコープカット·MVP 境界)とその根拠、成功の定義(何が「完了」か)、依存·リスク。そして主題に関連するプロダクト戦略·優先順位付け(例: RICE·機会/インパクト)のベストプラクティス。
- **根拠の強調**: リポジトリ根拠は「ファイル:行 + 現状(ある/ない/部分)とユーザー問題に触れる箇所」、ウェブ根拠は市場需要·競合の優先順位選択·プロダクト戦略事例(URL)。推測より「ユーザー問題とのつながり」で判定し、各ブリーフの spec に「解決するユーザー問題 / 優先順位の根拠 / 範囲(含む·除く) / 成功基準」を入れよ。`,
    ko: `## 조사 관점 — 기획(PM/제품) 전문가
이 리서치는 «기획(PM/제품)» 전문가 관점으로 수행한다. 주제를 «무엇을 왜 먼저 만들고 무엇을 미루나» 의 눈으로 우선 조사하라 (디버깅이 «왜 깨지나», QA 가 «어떻게 보증하나» 라면, 기획은 «무엇을 어떤 순서로·어떤 트레이드오프로 만드나»).
- **우선 조사**: 사용자 문제·요구(니즈)와 우선순위, 로드맵/마일스톤(지금 vs 다음 vs 나중), 범위 트레이드오프(scope cut·MVP 경계)와 그 근거, 성공 정의(무엇이 «된 것»인가), 의존성·리스크. 주제와 관련된 제품 전략·우선순위화(예: RICE·기회/임팩트) 모범 사례.
- **근거 강조**: 레포 근거는 «파일:라인 + 현재 상태(있다/없다/부분) 와 그것이 사용자 문제에 닿는 지점», 웹 근거는 시장 수요·경쟁 제품의 우선순위 선택·제품 전략 사례(URL). 추정보다 «사용자 문제와의 연결» 로 판정하고, 각 브리프의 spec 에 «해결하는 사용자 문제 / 우선순위 근거 / 범위(포함·제외) / 성공 기준» 을 담아라.`,
    "pt-BR": `## Perspectiva de pesquisa — especialista em produto (PM)
Esta pesquisa é feita pela perspectiva de um especialista em «produto (PM)». Investigue o tema primeiro pela lente de «o que construir primeiro e por quê, e o que adiar» (se a depuração é «por que quebra» e QA é «como garantir», produto é «o que construir, em que ordem, com quais trade-offs»).
- **Investigação prioritária**: problemas·necessidades do usuário e sua prioridade, roadmap/marcos (agora vs próximo vs depois), trade-offs de escopo (corte de escopo·limite de MVP) e sua justificativa, definição de sucesso (o que conta como «feito»), dependências·riscos. E melhores práticas de estratégia de produto·priorização (ex.: RICE·oportunidade/impacto) relacionadas ao tema.
- **Ênfase em evidências**: a evidência do repo é «arquivo:linha + estado atual (presente/ausente/parcial) e onde toca um problema do usuário», a evidência web são demanda de mercado·escolhas de prioridade dos concorrentes·exemplos de estratégia de produto (URL). Julgue pela «conexão com um problema do usuário» em vez de conjectura, e coloque no spec de cada brief «o problema do usuário resolvido / justificativa de prioridade / escopo (dentro·fora) / critérios de sucesso».`,
    ru: `## Перспектива исследования — эксперт по продукту (PM)
Это исследование ведётся с точки зрения эксперта по «продукту (PM)». Исследуйте тему прежде всего через призму «что строить первым и почему, и что отложить» (если отладка — «почему ломается», а QA — «как гарантировать», то продукт — «что строить, в каком порядке, с какими компромиссами»).
- **Приоритетное исследование**: проблемы·потребности пользователя и их приоритет, дорожная карта/вехи (сейчас vs далее vs позже), компромиссы охвата (срез охвата·граница MVP) и их обоснование, определение успеха (что считается «готовым»), зависимости·риски. И лучшие практики продуктовой стратегии·приоритизации (напр., RICE·возможность/влияние), связанные с темой.
- **Акцент доказательств**: доказательство репозитория — «файл:строка + текущее состояние (есть/нет/частично) и где это касается проблемы пользователя», веб-доказательство — рыночный спрос·выбор приоритетов конкурентов·примеры продуктовой стратегии (URL). Судите по «связи с проблемой пользователя», а не по домыслу, и в spec каждого брифа укажите «решаемая проблема пользователя / обоснование приоритета / охват (вкл·искл) / критерии успеха».`,
    "zh-Hans": `## 调研视角 — 产品(PM)专家
本次调研以「产品(PM)」专家的视角进行。先以「先做什么、为何、推迟什么」的眼光调研主题(若调试是「为何会坏」、QA 是「如何保证」,产品则是「以何种顺序·何种取舍做什么」)。
- **优先调研**: 用户问题·需求及其优先级,路线图/里程碑(现在 vs 下一步 vs 以后),范围取舍(范围裁剪·MVP 边界)及其依据,成功定义(何为「完成」),依赖·风险。以及与主题相关的产品战略·优先级排定最佳实践(如 RICE·机会/影响)。
- **依据强调**: 仓库依据为「文件:行 + 当前状态(有/无/部分)及其触及用户问题之处」,网络依据为市场需求·竞品的优先级选择·产品战略范例(URL)。以「与用户问题的关联」而非臆测来判定,并在每条简报的 spec 中写明「所解决的用户问题 / 优先级依据 / 范围(纳入·排除) / 成功标准」。`,
  },

  // ── 리서치 렌즈 머리말 — marketing ──────────────────────────────────────────
  "lens.research.marketing": {
    ar: `## منظور البحث — خبير التسويق
يُجرى هذا البحث بمنظور خبير «التسويق». ابحث الموضوع أولاً بعين «لمن·ماذا·أين·كيف نوصل» (إن كان التخطيط «ماذا نبني»، فالتسويق «كيف نُعرّف قيمته ونوصلها»).
- **البحث ذو الأولوية**: الجمهور·الشخصيات، عرض القيمة الأساسي والرسائل (ماذا وبأي كلمات)، التموضع·التمايز (أين نقف مقابل المنافسين)، القنوات (أين نلتقي) ومسارات الاكتساب·التحويل، سطح «الكلمات» مثل النصوص الإعلانية/التهيئة. وأفضل ممارسات الرسائل·التموضع·GTM (الانطلاق للسوق) المتصلة بالموضوع.
- **تأكيد السند**: سند المستودع «ملف:سطر + النصوص/التعريف/التهيئة المرئية للمستخدم وكيف توصل القيمة», وسند الويب أمثلة تموضع·رسائل·قنوات المنافسين (URL). احكم بـ«ما يصل للجمهور» بدل التخمين، وضع في spec كل بريف «الجمهور / الرسالة الأساسية / التموضع (التمايز) / القناة·مسار التحويل».`,
    en: `## Research perspective — marketing expert
This research runs from a «marketing» expert's perspective. Investigate the topic first through the lens of «to whom·what·where·how to convey» (if product is «what to build», marketing is «how to make its value perceived and reach people»).
- **Priority investigation**: target·personas, core value proposition and messaging (what, in what words), positioning·differentiation (where to stand vs competitors), channels (where to meet) and acquisition·conversion paths, the «words» surface like copy/onboarding text. And messaging·positioning·GTM (go-to-market) best practices related to the topic.
- **Evidence emphasis**: repo evidence is «file:line + user-facing copy/intro/onboarding text and how it conveys value», web evidence is competitors' positioning·messaging·channel examples (URL). Judge by «what resonates with the target» rather than conjecture, and put in each brief's spec «target / core message / positioning (differentiation) / channel·conversion path».`,
    es: `## Perspectiva de investigación — experto en marketing
Esta investigación se realiza desde la perspectiva de un experto en «marketing». Investiga el tema primero a través de la lente de «a quién·qué·dónde·cómo transmitir» (si producto es «qué construir», marketing es «cómo hacer percibir su valor y llegar a la gente»).
- **Investigación prioritaria**: target·personas, propuesta de valor central y mensajería (qué, con qué palabras), posicionamiento·diferenciación (dónde situarse vs competidores), canales (dónde encontrarse) y rutas de adquisición·conversión, la superficie de «palabras» como copy/texto de onboarding. Y mejores prácticas de mensajería·posicionamiento·GTM (go-to-market) relacionadas con el tema.
- **Énfasis en evidencia**: la evidencia del repo es «archivo:línea + copy/intro/texto de onboarding visible al usuario y cómo transmite valor», la evidencia web son ejemplos de posicionamiento·mensajería·canales de competidores (URL). Juzga por «lo que resuena con el target» en vez de conjeturas, y pon en el spec de cada brief «target / mensaje central / posicionamiento (diferenciación) / canal·ruta de conversión».`,
    fr: `## Perspective de recherche — expert marketing
Cette recherche se fait du point de vue d'un expert «marketing». Investigue le sujet d'abord à travers le prisme de «à qui·quoi·où·comment transmettre» (si le produit est «quoi construire», le marketing est «comment faire percevoir sa valeur et atteindre les gens»).
- **Investigation prioritaire**: cible·personas, proposition de valeur centrale et messaging (quoi, avec quels mots), positionnement·différenciation (où se situer vs concurrents), canaux (où se rencontrer) et parcours d'acquisition·conversion, la surface des «mots» comme le copy/texte d'onboarding. Et bonnes pratiques de messaging·positionnement·GTM (go-to-market) liées au sujet.
- **Emphase sur les preuves**: la preuve du dépôt est «fichier:ligne + copy/intro/texte d'onboarding visible par l'utilisateur et comment cela transmet la valeur», la preuve web sont des exemples de positionnement·messaging·canaux des concurrents (URL). Juge par «ce qui résonne avec la cible» plutôt que par conjecture, et mets dans le spec de chaque brief «cible / message central / positionnement (différenciation) / canal·parcours de conversion».`,
    hi: `## शोध दृष्टिकोण — मार्केटिंग विशेषज्ञ
यह शोध «मार्केटिंग» विशेषज्ञ के दृष्टिकोण से होता है। विषय को पहले «किसे·क्या·कहाँ·कैसे पहुँचाएँ» की दृष्टि से जाँचें (यदि उत्पाद «क्या बनाएँ» है, तो मार्केटिंग «उसके मूल्य को कैसे महसूस कराएँ और लोगों तक पहुँचाएँ» है)।
- **प्राथमिक जाँच**: टार्गेट·पर्सोना, मूल मूल्य-प्रस्ताव और मैसेजिंग (क्या, किन शब्दों में), पोज़िशनिंग·विभेदन (प्रतिस्पर्धियों के मुक़ाबले कहाँ खड़े हों), चैनल (कहाँ मिलें) और अधिग्रहण·रूपांतरण पथ, copy/ऑनबोर्डिंग टेक्स्ट जैसी «शब्दों» की सतह। और विषय से संबंधित मैसेजिंग·पोज़िशनिंग·GTM (गो-टू-मार्केट) सर्वोत्तम अभ्यास।
- **साक्ष्य ज़ोर**: रेपो साक्ष्य «फ़ाइल:लाइन + उपयोगकर्ता-दृश्य copy/परिचय/ऑनबोर्डिंग टेक्स्ट और वह मूल्य कैसे संप्रेषित करता है», वेब साक्ष्य प्रतिस्पर्धियों के पोज़िशनिंग·मैसेजिंग·चैनल उदाहरण (URL)। अनुमान के बजाय «टार्गेट तक जो पहुँचे» से निर्णय करें, और हर ब्रीफ़ के spec में «टार्गेट / मूल संदेश / पोज़िशनिंग (विभेदन) / चैनल·रूपांतरण पथ» डालें।`,
    ja: `## 調査の観点 — マーケティングの専門家
この調査は「マーケティング」専門家の観点で行う。主題をまず「誰に·何を·どこで·どう伝えるか」の目で調査せよ(企画が「何を作るか」なら、マーケティングは「その価値をどう認識させ届けるか」)。
- **優先調査**: ターゲット·ペルソナ、中核の価値提案とメッセージング(何を·どんな言葉で)、ポジショニング·差別化(競合に対しどこに立つか)、チャネル(どこで出会うか)と獲得·転換の経路、コピー/オンボーディング文言のような「言葉」の表面。そして主題に関連するメッセージング·ポジショニング·GTM(go-to-market)のベストプラクティス。
- **根拠の強調**: リポジトリ根拠は「ファイル:行 + ユーザーに見えるコピー/紹介/オンボーディング文言とその価値伝達」、ウェブ根拠は競合のポジショニング·メッセージング·チャネル事例(URL)。推測より「ターゲットに刺さる根拠」で判定し、各ブリーフの spec に「ターゲット / 中核メッセージ / ポジショニング(差別化) / チャネル·転換経路」を入れよ。`,
    ko: `## 조사 관점 — 마케팅 전문가
이 리서치는 «마케팅» 전문가 관점으로 수행한다. 주제를 «누구에게·무엇을·어디서 어떻게 전하나» 의 눈으로 우선 조사하라 (기획이 «무엇을 만드나» 라면, 마케팅은 «그 가치를 어떻게 인식시키고 닿게 하나»).
- **우선 조사**: 타깃·페르소나, 핵심 가치 제안과 메시징(무엇을 어떤 말로), 포지셔닝·차별점(경쟁 대비 어디에 서나), 채널(어디서 만나나)과 획득·전환 경로, 카피/온보딩 문구 같은 «말» 의 표면. 주제와 관련된 메시징·포지셔닝·GTM(go-to-market) 모범 사례.
- **근거 강조**: 레포 근거는 «파일:라인 + 사용자에게 보이는 카피/소개/온보딩 문구와 그 가치 전달», 웹 근거는 경쟁 제품의 포지셔닝·메시징·채널 사례(URL). 추정보다 «타깃에게 와닿는 근거» 로 판정하고, 각 브리프의 spec 에 «타깃 / 핵심 메시지 / 포지셔닝(차별점) / 채널·전환 경로» 를 담아라.`,
    "pt-BR": `## Perspectiva de pesquisa — especialista em marketing
Esta pesquisa é feita pela perspectiva de um especialista em «marketing». Investigue o tema primeiro pela lente de «para quem·o quê·onde·como transmitir» (se produto é «o que construir», marketing é «como fazer perceber seu valor e alcançar as pessoas»).
- **Investigação prioritária**: público·personas, proposta de valor central e mensagem (o quê, com quais palavras), posicionamento·diferenciação (onde se posicionar vs concorrentes), canais (onde encontrar) e caminhos de aquisição·conversão, a superfície de «palavras» como copy/texto de onboarding. E melhores práticas de mensagem·posicionamento·GTM (go-to-market) relacionadas ao tema.
- **Ênfase em evidências**: a evidência do repo é «arquivo:linha + copy/introdução/texto de onboarding visível ao usuário e como transmite valor», a evidência web são exemplos de posicionamento·mensagem·canais dos concorrentes (URL). Julgue por «o que ressoa com o público» em vez de conjectura, e coloque no spec de cada brief «público / mensagem central / posicionamento (diferenciação) / canal·caminho de conversão».`,
    ru: `## Перспектива исследования — эксперт по маркетингу
Это исследование ведётся с точки зрения эксперта по «маркетингу». Исследуйте тему прежде всего через призму «кому·что·где·как донести» (если продукт — «что строить», то маркетинг — «как сделать его ценность ощутимой и достичь людей»).
- **Приоритетное исследование**: аудитория·персоны, ключевое ценностное предложение и месседжинг (что, какими словами), позиционирование·дифференциация (где стоять относительно конкурентов), каналы (где встречаться) и пути привлечения·конверсии, поверхность «слов» вроде текста/онбординга. И лучшие практики месседжинга·позиционирования·GTM (выход на рынок), связанные с темой.
- **Акцент доказательств**: доказательство репозитория — «файл:строка + видимый пользователю текст/вступление/онбординг и как он доносит ценность», веб-доказательство — примеры позиционирования·месседжинга·каналов конкурентов (URL). Судите по «тому, что откликается у аудитории», а не по домыслу, и в spec каждого брифа укажите «аудитория / ключевое сообщение / позиционирование (дифференциация) / канал·путь конверсии».`,
    "zh-Hans": `## 调研视角 — 市场营销专家
本次调研以「市场营销」专家的视角进行。先以「向谁·传达什么·在哪里·如何传达」的眼光调研主题(若产品是「做什么」,营销则是「如何让其价值被感知并触达用户」)。
- **优先调研**: 目标·人物画像,核心价值主张与信息传达(传达什么·用什么措辞),定位·差异化(相对竞品站在何处),渠道(在哪里相遇)与获取·转化路径,文案/引导文案这类「文字」表面。以及与主题相关的信息传达·定位·GTM(进入市场)最佳实践。
- **依据强调**: 仓库依据为「文件:行 + 用户可见的文案/介绍/引导文案及其如何传达价值」,网络依据为竞品的定位·信息传达·渠道范例(URL)。以「能打动目标受众的依据」而非臆测来判定,并在每条简报的 spec 中写明「目标 / 核心信息 / 定位(差异化) / 渠道·转化路径」。`,
  },

  // ── 리서치 렌즈 머리말 — analytics ──────────────────────────────────────────
  "lens.research.analytics": {
    ar: `## منظور البحث — خبير التحليلات (analytics)
يُجرى هذا البحث بمنظور خبير «التحليلات (analytics)». ابحث الموضوع أولاً بعين «ماذا نقيس وماذا نقرأ من الأرقام» (إن كان التخطيط «ماذا نبني»، فالتحليلات «كيف نعرف أنه نجح»).
- **البحث ذو الأولوية**: المقاييس الأساسية (KPI·نجم الشمال) وتعريفاتها، القمع (الدخول→التفعيل→الاحتفاظ→التحويل) ونقاط التسرّب، وجود/فجوات القياس (الأحداث·التتبّع)، الفئات/الشرائح·الرؤى (لماذا تقوله الأرقام)، تصميم الفرضيات·التجارب (A/B). وأفضل ممارسات المقاييس·القياس·التجارب المتصلة بالموضوع.
- **تأكيد السند**: سند المستودع «ملف:سطر + نقاط القياس (موجودة/غير موجودة)·الأحداث·التسجيل وأي مقياس تمسّ», وسند الويب تعريف المقاييس·تحليل القمع·أفضل ممارسات تصميم التجارب (URL). احكم بـ«سند قابل للقياس» بدل التخمين، وضع في spec كل بريف «المقياس المُراد قياسه / طريقة القياس (الأحداث) / معيار النجاح (قيمة·اتجاه الهدف) / طريقة التحليل (القمع·الفئة)».`,
    en: `## Research perspective — analytics expert
This research runs from an «analytics» expert's perspective. Investigate the topic first through the lens of «what to measure and what the numbers tell us» (if product is «what to build», analytics is «how do we know it works»).
- **Priority investigation**: core metrics (KPI·north star) and their definitions, the funnel (acquisition→activation→retention→conversion) and drop-off points, presence·gaps of instrumentation (events·tracking), cohorts/segments·insights (the «why» the numbers say), hypothesis·experiment (A/B) design. And metric·instrumentation·experiment best practices related to the topic.
- **Evidence emphasis**: repo evidence is «file:line + measurement points (present/absent)·events·logging and which metric they touch», web evidence is metric definitions·funnel analysis·experiment-design best practices (URL). Judge by «measurable evidence» rather than conjecture, and put in each brief's spec «the metric to measure / instrumentation method (events) / success criteria (target value·direction) / analysis (funnel·cohort) method».`,
    es: `## Perspectiva de investigación — experto en analítica
Esta investigación se realiza desde la perspectiva de un experto en «analítica». Investiga el tema primero a través de la lente de «qué medir y qué nos dicen los números» (si producto es «qué construir», analítica es «cómo sabemos que funciona»).
- **Investigación prioritaria**: métricas centrales (KPI·north star) y sus definiciones, el embudo (adquisición→activación→retención→conversión) y puntos de abandono, presencia·brechas de instrumentación (eventos·tracking), cohortes/segmentos·insights (el «porqué» que dicen los números), diseño de hipótesis·experimentos (A/B). Y mejores prácticas de métricas·instrumentación·experimentos relacionadas con el tema.
- **Énfasis en evidencia**: la evidencia del repo es «archivo:línea + puntos de medición (presente/ausente)·eventos·logging y qué métrica tocan», la evidencia web son definiciones de métricas·análisis de embudo·mejores prácticas de diseño de experimentos (URL). Juzga por «evidencia medible» en vez de conjeturas, y pon en el spec de cada brief «la métrica a medir / método de instrumentación (eventos) / criterios de éxito (valor·dirección objetivo) / método de análisis (embudo·cohorte)».`,
    fr: `## Perspective de recherche — expert analytics
Cette recherche se fait du point de vue d'un expert «analytics». Investigue le sujet d'abord à travers le prisme de «quoi mesurer et ce que les chiffres nous disent» (si le produit est «quoi construire», l'analytics est «comment savoir si ça marche»).
- **Investigation prioritaire**: métriques centrales (KPI·north star) et leurs définitions, l'entonnoir (acquisition→activation→rétention→conversion) et points d'abandon, présence·lacunes de l'instrumentation (événements·tracking), cohortes/segments·insights (le «pourquoi» que disent les chiffres), conception d'hypothèses·d'expériences (A/B). Et bonnes pratiques de métriques·instrumentation·expériences liées au sujet.
- **Emphase sur les preuves**: la preuve du dépôt est «fichier:ligne + points de mesure (présent/absent)·événements·logging et quelle métrique ils touchent», la preuve web sont des définitions de métriques·analyse d'entonnoir·bonnes pratiques de conception d'expériences (URL). Juge par «preuve mesurable» plutôt que par conjecture, et mets dans le spec de chaque brief «la métrique à mesurer / méthode d'instrumentation (événements) / critères de succès (valeur·direction cible) / méthode d'analyse (entonnoir·cohorte)».`,
    hi: `## शोध दृष्टिकोण — एनालिटिक्स विशेषज्ञ
यह शोध «एनालिटिक्स (analytics)» विशेषज्ञ के दृष्टिकोण से होता है। विषय को पहले «क्या मापें और संख्याएँ क्या बताती हैं» की दृष्टि से जाँचें (यदि उत्पाद «क्या बनाएँ» है, तो एनालिटिक्स «कैसे जानें कि यह कारगर है» है)।
- **प्राथमिक जाँच**: मूल मेट्रिक (KPI·नॉर्थ स्टार) और उनकी परिभाषाएँ, फ़नल (अधिग्रहण→सक्रियण→प्रतिधारण→रूपांतरण) और छोड़ने के बिंदु, इंस्ट्रुमेंटेशन की उपस्थिति·अंतराल (इवेंट·ट्रैकिंग), कोहोर्ट/सेगमेंट·अंतर्दृष्टि (संख्याएँ जो «क्यों» कहती हैं), परिकल्पना·प्रयोग (A/B) डिज़ाइन। और विषय से संबंधित मेट्रिक·इंस्ट्रुमेंटेशन·प्रयोग सर्वोत्तम अभ्यास।
- **साक्ष्य ज़ोर**: रेपो साक्ष्य «फ़ाइल:लाइन + माप बिंदु (मौजूद/अनुपस्थित)·इवेंट·लॉगिंग और वे किस मेट्रिक को छूते हैं», वेब साक्ष्य मेट्रिक परिभाषाएँ·फ़नल विश्लेषण·प्रयोग-डिज़ाइन सर्वोत्तम अभ्यास (URL)। अनुमान के बजाय «मापने योग्य साक्ष्य» से निर्णय करें, और हर ब्रीफ़ के spec में «मापी जाने वाली मेट्रिक / इंस्ट्रुमेंटेशन विधि (इवेंट) / सफलता मानदंड (लक्ष्य मान·दिशा) / विश्लेषण (फ़नल·कोहोर्ट) विधि» डालें।`,
    ja: `## 調査の観点 — 分析(analytics)の専門家
この調査は「分析(analytics)」専門家の観点で行う。主題をまず「何を測り、その数字から何を読むか」の目で調査せよ(企画が「何を作るか」なら、分析は「それが効くかどうかをどう知るか」)。
- **優先調査**: 中核指標(KPI·北極星)とその定義、ファネル(獲得→アクティベーション→継続→転換)と離脱点、計測(イベント·トラッキング)の有無·空白、コホート/セグメント·インサイト(数字が言う「なぜ」)、仮説·実験(A/B)設計。そして主題に関連する指標·計測·実験のベストプラクティス。
- **根拠の強調**: リポジトリ根拠は「ファイル:行 + 計測点(ある/ない)·イベント·ロギングとそれがどの指標に触れるか」、ウェブ根拠は指標定義·ファネル分析·実験設計のベストプラクティス(URL)。推測より「測定可能な根拠」で判定し、各ブリーフの spec に「測る指標 / 計測方法(イベント) / 成功基準(目標値·方向) / 分析(ファネル·コホート)方法」を入れよ。`,
    ko: `## 조사 관점 — 분석(analytics) 전문가
이 리서치는 «분석(analytics)» 전문가 관점으로 수행한다. 주제를 «무엇을 측정하고 그 숫자에서 무엇을 읽나» 의 눈으로 우선 조사하라 (기획이 «무엇을 만드나» 라면, 분석은 «그게 효과가 있는지 어떻게 아나»).
- **우선 조사**: 핵심 지표(KPI·북극성)와 그 정의, 퍼널(유입→활성화→유지→전환)과 이탈 지점, 계측(이벤트·트래킹)의 유무·공백, 코호트/세그먼트·인사이트(숫자가 말하는 «왜»), 가설·실험(A/B) 설계. 주제와 관련된 지표·계측·실험 모범 사례.
- **근거 강조**: 레포 근거는 «파일:라인 + 측정 지점(있다/없다)·이벤트·로깅과 그것이 어떤 지표에 닿나», 웹 근거는 지표 정의·퍼널 분석·실험 설계 모범 사례(URL). 추정보다 «측정 가능한 근거» 로 판정하고, 각 브리프의 spec 에 «측정할 지표 / 계측 방법(이벤트) / 성공 기준(목표 수치·방향) / 분석(퍼널·코호트) 방법» 을 담아라.`,
    "pt-BR": `## Perspectiva de pesquisa — especialista em analytics
Esta pesquisa é feita pela perspectiva de um especialista em «analytics». Investigue o tema primeiro pela lente de «o que medir e o que os números nos dizem» (se produto é «o que construir», analytics é «como sabemos que funciona»).
- **Investigação prioritária**: métricas centrais (KPI·north star) e suas definições, o funil (aquisição→ativação→retenção→conversão) e pontos de abandono, presença·lacunas de instrumentação (eventos·tracking), coortes/segmentos·insights (o «porquê» que os números dizem), design de hipóteses·experimentos (A/B). E melhores práticas de métricas·instrumentação·experimentos relacionadas ao tema.
- **Ênfase em evidências**: a evidência do repo é «arquivo:linha + pontos de medição (presente/ausente)·eventos·logging e qual métrica tocam», a evidência web são definições de métricas·análise de funil·melhores práticas de design de experimentos (URL). Julgue por «evidência mensurável» em vez de conjectura, e coloque no spec de cada brief «a métrica a medir / método de instrumentação (eventos) / critérios de sucesso (valor·direção alvo) / método de análise (funil·coorte)».`,
    ru: `## Перспектива исследования — эксперт по аналитике
Это исследование ведётся с точки зрения эксперта по «аналитике». Исследуйте тему прежде всего через призму «что измерять и что говорят цифры» (если продукт — «что строить», то аналитика — «как мы узнаём, что это работает»).
- **Приоритетное исследование**: ключевые метрики (KPI·полярная звезда) и их определения, воронка (привлечение→активация→удержание→конверсия) и точки оттока, наличие·пробелы инструментирования (события·трекинг), когорты/сегменты·инсайты («почему», о котором говорят цифры), дизайн гипотез·экспериментов (A/B). И лучшие практики метрик·инструментирования·экспериментов, связанные с темой.
- **Акцент доказательств**: доказательство репозитория — «файл:строка + точки измерения (есть/нет)·события·логирование и какой метрики они касаются», веб-доказательство — определения метрик·анализ воронки·лучшие практики дизайна экспериментов (URL). Судите по «измеримому доказательству», а не по домыслу, и в spec каждого брифа укажите «измеряемая метрика / метод инструментирования (события) / критерии успеха (целевое значение·направление) / метод анализа (воронка·когорта)».`,
    "zh-Hans": `## 调研视角 — 分析(analytics)专家
本次调研以「分析(analytics)」专家的视角进行。先以「测量什么、从数字中读出什么」的眼光调研主题(若产品是「做什么」,分析则是「如何知道它有效」)。
- **优先调研**: 核心指标(KPI·北极星)及其定义,漏斗(获取→激活→留存→转化)与流失点,埋点(事件·追踪)的有无·空白,群组/分群·洞察(数字所述的「为什么」),假设·实验(A/B)设计。以及与主题相关的指标·埋点·实验最佳实践。
- **依据强调**: 仓库依据为「文件:行 + 测量点(有/无)·事件·日志及其触及哪项指标」,网络依据为指标定义·漏斗分析·实验设计最佳实践(URL)。以「可测量的依据」而非臆测来判定,并在每条简报的 spec 中写明「要测量的指标 / 埋点方法(事件) / 成功标准(目标数值·方向) / 分析(漏斗·群组)方法」。`,
  },

  // ── 리서치 렌즈 머리말 — ops ─────────────────────────────────────────────────
  "lens.research.ops": {
    ar: `## منظور البحث — خبير التشغيل (ops)
يُجرى هذا البحث بمنظور خبير «التشغيل (ops)». ابحث الموضوع أولاً بعين «كيف ننشر ونشغّل ونبقيه مستقراً ورخيصاً» (إن كان QA «كيف نضمن قبل الإطلاق»، فالتشغيل «كيف نديره ونتحمّله بعد الإطلاق»).
- **البحث ذو الأولوية**: مسار النشر·الإصدار (البناء·الطرح·التراجع)، الموثوقية (التوفّر·أنماط الفشل·الاسترداد·المراقبة/التنبيه)، عبء التشغيل (الإجراءات اليدوية·مجال الأتمتة)، التكلفة (الموارد·الرسوم·الزيادة مع التوسّع) والكفاءة، السعة·قابلية التوسّع. وأفضل ممارسات النشر·SRE·تحسين التكلفة المتصلة بالموضوع.
- **تأكيد السند**: سند المستودع «ملف:سطر + النشر/السكربتات/الإعدادات وأثرها التشغيلي (ماذا عند الفشل·طريقة الاسترداد)», وسند الويب استراتيجيات النشر·الموثوقية (SRE)·أمثلة تحسين التكلفة (URL). احكم بـ«سند قابل للتشغيل·الاسترداد» بدل التخمين، وضع في spec كل بريف «طريقة النشر·التراجع / الموثوقية (أنماط الفشل·المراقبة·الاسترداد) / أثر التكلفة·التوسّع».`,
    en: `## Research perspective — operations (ops) expert
This research runs from an «operations (ops)» expert's perspective. Investigate the topic first through the lens of «how to deploy·operate and keep it stable·cheap» (if QA is «how to guarantee before launch», ops is «how to run and endure it after launch»).
- **Priority investigation**: deploy·release path (build·rollout·rollback), reliability (availability·failure modes·recovery·monitoring/alerting), operational load (manual procedures·room for automation), cost (resources·fees·growth with scaling) and efficiency, capacity·scalability. And deploy·SRE·cost-optimization best practices related to the topic.
- **Evidence emphasis**: repo evidence is «file:line + deploy/scripts/config and their operational impact (what on failure·recovery method)», web evidence is deploy strategies·reliability (SRE)·cost-optimization examples (URL). Judge by «operable·recoverable evidence» rather than conjecture, and put in each brief's spec «deploy·rollback method / reliability (failure modes·monitoring·recovery) / cost·scaling impact».`,
    es: `## Perspectiva de investigación — experto en operaciones (ops)
Esta investigación se realiza desde la perspectiva de un experto en «operaciones (ops)». Investiga el tema primero a través de la lente de «cómo desplegar·operar y mantenerlo estable·barato» (si QA es «cómo garantizar antes del lanzamiento», ops es «cómo ejecutarlo y soportarlo tras el lanzamiento»).
- **Investigación prioritaria**: ruta de despliegue·release (build·rollout·rollback), fiabilidad (disponibilidad·modos de fallo·recuperación·monitoreo/alertas), carga operativa (procedimientos manuales·margen de automatización), coste (recursos·tarifas·aumento con escalado) y eficiencia, capacidad·escalabilidad. Y mejores prácticas de despliegue·SRE·optimización de costes relacionadas con el tema.
- **Énfasis en evidencia**: la evidencia del repo es «archivo:línea + despliegue/scripts/config y su impacto operativo (qué ante fallo·método de recuperación)», la evidencia web son estrategias de despliegue·fiabilidad (SRE)·ejemplos de optimización de costes (URL). Juzga por «evidencia operable·recuperable» en vez de conjeturas, y pon en el spec de cada brief «método de despliegue·rollback / fiabilidad (modos de fallo·monitoreo·recuperación) / impacto de coste·escalado».`,
    fr: `## Perspective de recherche — expert opérations (ops)
Cette recherche se fait du point de vue d'un expert «opérations (ops)». Investigue le sujet d'abord à travers le prisme de «comment déployer·exploiter et le garder stable·peu coûteux» (si la QA est «comment garantir avant le lancement», l'ops est «comment l'exécuter et le tenir après le lancement»).
- **Investigation prioritaire**: chemin de déploiement·release (build·rollout·rollback), fiabilité (disponibilité·modes de défaillance·récupération·monitoring/alerting), charge opérationnelle (procédures manuelles·marge d'automatisation), coût (ressources·frais·augmentation avec la montée en charge) et efficacité, capacité·scalabilité. Et bonnes pratiques de déploiement·SRE·optimisation des coûts liées au sujet.
- **Emphase sur les preuves**: la preuve du dépôt est «fichier:ligne + déploiement/scripts/config et leur impact opérationnel (quoi en cas d'échec·méthode de récupération)», la preuve web sont des stratégies de déploiement·fiabilité (SRE)·exemples d'optimisation des coûts (URL). Juge par «preuve exploitable·récupérable» plutôt que par conjecture, et mets dans le spec de chaque brief «méthode de déploiement·rollback / fiabilité (modes de défaillance·monitoring·récupération) / impact coût·montée en charge».`,
    hi: `## शोध दृष्टिकोण — ऑपरेशंस (ops) विशेषज्ञ
यह शोध «ऑपरेशंस (ops)» विशेषज्ञ के दृष्टिकोण से होता है। विषय को पहले «कैसे तैनात·संचालित करें और इसे स्थिर·सस्ता रखें» की दृष्टि से जाँचें (यदि QA «लॉन्च से पहले कैसे गारंटी» है, तो ops «लॉन्च के बाद कैसे चलाएँ और टिकाएँ» है)।
- **प्राथमिक जाँच**: तैनाती·रिलीज़ पथ (बिल्ड·रोलआउट·रोलबैक), विश्वसनीयता (उपलब्धता·विफलता मोड·पुनर्प्राप्ति·निगरानी/अलर्ट), परिचालन भार (मैनुअल प्रक्रियाएँ·स्वचालन की गुंजाइश), लागत (संसाधन·शुल्क·स्केलिंग के साथ वृद्धि) और दक्षता, क्षमता·स्केलेबिलिटी। और विषय से संबंधित तैनाती·SRE·लागत-अनुकूलन सर्वोत्तम अभ्यास।
- **साक्ष्य ज़ोर**: रेपो साक्ष्य «फ़ाइल:लाइन + तैनाती/स्क्रिप्ट/कॉन्फ़िग और उनका परिचालन प्रभाव (विफलता पर क्या·पुनर्प्राप्ति विधि)», वेब साक्ष्य तैनाती रणनीतियाँ·विश्वसनीयता (SRE)·लागत-अनुकूलन उदाहरण (URL)। अनुमान के बजाय «संचालन-योग्य·पुनर्प्राप्य साक्ष्य» से निर्णय करें, और हर ब्रीफ़ के spec में «तैनाती·रोलबैक विधि / विश्वसनीयता (विफलता मोड·निगरानी·पुनर्प्राप्ति) / लागत·स्केलिंग प्रभाव» डालें।`,
    ja: `## 調査の観点 — 運用(ops)の専門家
この調査は「運用(ops)」専門家の観点で行う。主題をまず「どうデプロイ·運用し、安定·安価に保つか」の目で調査せよ(QA が「リリース前にどう保証するか」なら、運用は「リリース後にどう回し、耐えるか」)。
- **優先調査**: デプロイ·リリース経路(ビルド·ロールアウト·ロールバック)、信頼性(可用性·障害モード·復旧·監視/アラート)、運用負荷(手動手順·自動化の余地)、コスト(リソース·料金·スケールに伴う増加)と効率、容量·スケーラビリティ。そして主題に関連するデプロイ·SRE·コスト最適化のベストプラクティス。
- **根拠の強調**: リポジトリ根拠は「ファイル:行 + デプロイ/スクリプト/設定とその運用影響(失敗時に何が·復旧方法)」、ウェブ根拠はデプロイ戦略·信頼性(SRE)·コスト最適化事例(URL)。推測より「運用可能·復旧可能な根拠」で判定し、各ブリーフの spec に「デプロイ·ロールバック方法 / 信頼性(障害モード·監視·復旧) / コスト·スケール影響」を入れよ。`,
    ko: `## 조사 관점 — 운영(ops) 전문가
이 리서치는 «운영(ops)» 전문가 관점으로 수행한다. 주제를 «어떻게 배포·운영하고 안정적으로·싸게 유지하나» 의 눈으로 우선 조사하라 (QA 가 «출시 전 어떻게 보증하나» 라면, 운영은 «출시 후 어떻게 굴리고 견디나»).
- **우선 조사**: 배포·릴리스 경로(빌드·롤아웃·롤백), 신뢰성(가용성·장애 모드·복구·모니터링/알림), 운영 부하(수동 절차·자동화 여지), 비용(자원·요금·확장에 따른 증가)과 효율, 용량·확장성. 주제와 관련된 배포·SRE·비용 최적화 모범 사례.
- **근거 강조**: 레포 근거는 «파일:라인 + 배포/스크립트/설정과 그 운영 영향(실패 시 무엇이·복구 방법)», 웹 근거는 배포 전략·신뢰성(SRE)·비용 최적화 사례(URL). 추정보다 «운영 가능·복구 가능한 근거» 로 판정하고, 각 브리프의 spec 에 «배포·롤백 방법 / 신뢰성(장애 모드·모니터링·복구) / 비용·확장 영향» 을 담아라.`,
    "pt-BR": `## Perspectiva de pesquisa — especialista em operações (ops)
Esta pesquisa é feita pela perspectiva de um especialista em «operações (ops)». Investigue o tema primeiro pela lente de «como implantar·operar e mantê-lo estável·barato» (se QA é «como garantir antes do lançamento», ops é «como executá-lo e suportá-lo após o lançamento»).
- **Investigação prioritária**: caminho de deploy·release (build·rollout·rollback), confiabilidade (disponibilidade·modos de falha·recuperação·monitoramento/alertas), carga operacional (procedimentos manuais·espaço para automação), custo (recursos·taxas·aumento com escala) e eficiência, capacidade·escalabilidade. E melhores práticas de deploy·SRE·otimização de custos relacionadas ao tema.
- **Ênfase em evidências**: a evidência do repo é «arquivo:linha + deploy/scripts/config e seu impacto operacional (o que na falha·método de recuperação)», a evidência web são estratégias de deploy·confiabilidade (SRE)·exemplos de otimização de custos (URL). Julgue por «evidência operável·recuperável» em vez de conjectura, e coloque no spec de cada brief «método de deploy·rollback / confiabilidade (modos de falha·monitoramento·recuperação) / impacto de custo·escala».`,
    ru: `## Перспектива исследования — эксперт по эксплуатации (ops)
Это исследование ведётся с точки зрения эксперта по «эксплуатации (ops)». Исследуйте тему прежде всего через призму «как развёртывать·эксплуатировать и держать стабильным·дешёвым» (если QA — «как гарантировать до запуска», то ops — «как запускать и выдерживать после запуска»).
- **Приоритетное исследование**: путь развёртывания·релиза (сборка·раскатка·откат), надёжность (доступность·режимы отказа·восстановление·мониторинг/оповещения), операционная нагрузка (ручные процедуры·потенциал автоматизации), стоимость (ресурсы·тарифы·рост при масштабировании) и эффективность, ёмкость·масштабируемость. И лучшие практики развёртывания·SRE·оптимизации затрат, связанные с темой.
- **Акцент доказательств**: доказательство репозитория — «файл:строка + развёртывание/скрипты/конфигурация и их операционное влияние (что при сбое·метод восстановления)», веб-доказательство — стратегии развёртывания·надёжность (SRE)·примеры оптимизации затрат (URL). Судите по «эксплуатируемому·восстанавливаемому доказательству», а не по домыслу, и в spec каждого брифа укажите «метод развёртывания·отката / надёжность (режимы отказа·мониторинг·восстановление) / влияние на стоимость·масштабирование».`,
    "zh-Hans": `## 调研视角 — 运维(ops)专家
本次调研以「运维(ops)」专家的视角进行。先以「如何部署·运行并保持稳定·低成本」的眼光调研主题(若 QA 是「发布前如何保证」,运维则是「发布后如何运行并支撑」)。
- **优先调研**: 部署·发布路径(构建·灰度·回滚),可靠性(可用性·故障模式·恢复·监控/告警),运维负担(手动流程·自动化空间),成本(资源·费用·随扩展增长)与效率,容量·可扩展性。以及与主题相关的部署·SRE·成本优化最佳实践。
- **依据强调**: 仓库依据为「文件:行 + 部署/脚本/配置及其运维影响(失败时如何·恢复方法)」,网络依据为部署策略·可靠性(SRE)·成本优化范例(URL)。以「可运维·可恢复的依据」而非臆测来判定,并在每条简报的 spec 中写明「部署·回滚方法 / 可靠性(故障模式·监控·恢复) / 成本·扩展影响」。`,
  },

  // ── 리서치 렌즈 머리말 — logic ───────────────────────────────────────────────
  "lens.research.logic": {
    ar: `## منظور البحث — خبير المنطق (المجال·الاتساق)
يُجرى هذا البحث بمنظور خبير «المنطق (المجال·الاتساق)». ابحث الموضوع أولاً بعين «هل يتوافق منطق العمل القائم مع قواعد المجال وهل يمكن جعله أبسط·أوضح» (إن كان التصحيح «لماذا يتعطّل»، وQA «كيف نضمن ألا يتعطّل»، والأمن «كيف يُستغل»، والتشغيل «كيف ندير»، فالمنطق «حتى لو عمل بشكل سليم، هل ذلك المنطق متّسق مع المجال·بسيط·قابل للصيانة» — ليس خطأً بل الصحة·البساطة·قابلية الصيانة).
- **البحث ذو الأولوية**: اتساق قواعد المجال·انتقالات الحالة (دورة حياة مثل آلة الحالة·status·عقد سير العمل·الاستحقاقات·استئناف/تفريع الجلسة) وهل يُفرَض الثابت (الشرط الذي يجب أن يكون صحيحاً دائماً) في الكود، التكرار (تشتّت القاعدة نفسها في أماكن عدّة وانجرافها)، الكود الميت (غير القابل للوصول·فروع غير مستخدمة·آثار تثير إعادة الاقتراح)، التعقيد المفرط (شروط·وساطة·فروع خاصة غير ضرورية)·عدم الوضوح (أسماء تخالف القصد). وأفضل ممارسات نمذجة المجال·الثوابت·إعادة الهيكلة·تبسيط الكود المتصلة بالموضوع.
- **مُخرَج الفهم (إلزامي)**: لـ«تحسين» المنطق يجب أولاً أن يكون «ما الذي يعمل الآن وكيف» صريحاً — ضمّن في التقرير حتماً «خريطة قواعد المجال/آلة الحالة» للمجال المبحوث كـ«قسم واحد». نظّم كل **حالة** و**انتقال** (من أين→إلى أين) و**شرط الانتقال** و**الثابت** و**المُطلِق** (مَن·متى·ما الذي يغيّر الحالة) في جدول/خريطة، ليتمكّن الـ triage·المطوّر اللاحق من تقييم الاقتراح دون إعادة هندسة الكود من جديد. (يُدرَج في markdown التقرير القائم دون مستودع منفصل·عارض UI·رسم بياني — «مُخرَج فهم» قابل لإعادة الاستخدام يمنع نبش المجال نفسه من الصفر مرة أخرى.)
- **تأكيد السند**: سند المستودع «ملف:سطر + أي قاعدة مجال/ثابت يُفرَض (أو يُغفَل) أين·أين التكرار/الكود الميت/التعقيد المفرط», وسند الويب أمثلة التصميم المدفوع بالمجال·الثوابت·إعادة الهيكلة·تبسيط الكود (URL). احكم بـ«الموضع المحدد» للاتساق·التكرار·التعقيد «الذي يعمل بشكل سليم لكنه خطر» بدل التخمين (ليس بلاغ خطأ — يُحفظ السلوك)، وضمّن في spec كل بريف ما يلي «دون نقصان» ليرى الـ triage خطر «التحسين» غير المُتحقَّق ويقرّر الاعتماد/التعليق/الرفض — «المنطق·الثابت الحالي (ما الذي أين·ماذا يضمن) / مشكلة الاتساق·الثابت·التكرار·التعقيد / شكل أبسط·أكثر اتساقاً (حفظ السلوك) / التحقق من حفظ السلوك (كيف نتأكد بالانحدار·الاختبارات القائمة/المضافة) / blast-radius (الملفات·الاختبارات المتأثرة)». لا ترفع «تحسيناً» لا يمكن التحقق من حفظه للسلوك كبريف.
- إن كان المستودع المستهدف يكاد يخلو من «منطق مجال يُقيَّم اتساقه» فبيّن ذلك في التقرير، وبريف منطق بعدد 0 (مصفوفة فارغة) إجابة صحيحة أيضاً.`,
    en: `## Research perspective — logic (domain·consistency) expert
This research runs from a «logic (domain·consistency)» expert's perspective. Investigate the topic first through the lens of «does the existing business logic match domain rules, and can it be made simpler·clearer» (if debugging is «why it breaks», QA is «how to guarantee it does not break», security is «how it is exploited», ops is «how to run it», then logic is «even if it works correctly, is that logic consistent with the domain·simple·maintainable» — not a bug, but correctness·simplicity·maintainability).
- **Priority investigation**: consistency of domain rules·state transitions (lifecycles like state machines·status·workflow nodes·entitlements·session resume/fork) and whether invariants (conditions that must always hold) are enforced in code, duplication (the same rule scattered across places and drifting), dead code (unreachable·unused branches·traces that trigger re-proposals), over-complexity (unnecessary conditions·indirection·special branches)·obscurity (names at odds with intent). And domain-modeling·invariant·refactoring·code-simplification best practices related to the topic.
- **Understanding artifact (required)**: to «improve» logic, «what currently works and how» must first be explicit — you must include in the report a «domain rules / state-machine map» of the area you investigated as a «section». Organize each **state**, **transition** (from→to), **transition condition**, **invariant**, and **trigger** (who·when·what changes the state) into a table/map so that follow-up triage·developers can evaluate the proposal without re-reverse-engineering the code. (Put it in the existing report markdown without a separate store·UI viewer·graph — a reusable «understanding artifact» that prevents digging into the same area from scratch again.)
- **Evidence emphasis**: repo evidence is «file:line + which domain rule/invariant is enforced (or missing) where·where is the duplication/dead code/over-complexity», web evidence is domain-driven design·invariant·refactoring·code-simplification examples (URL). Judge by the «concrete location» of consistency·duplication·complexity that «works correctly but is risky» rather than conjecture (this is not a bug report — behavior is preserved), and include in each brief's spec the following «without omission» so triage can see the risk of an unverified «improvement» and decide approve/hold/reject — «current logic·invariant (what is where·what it guarantees) / consistency·invariant·duplication·complexity problem / a simpler·more consistent form (behavior-preserving) / behavior-preservation verification (how to confirm via existing/added regression·tests) / blast-radius (affected files·tests)». Do not raise an «improvement» whose behavior preservation cannot be verified as a brief.
- If the target repo has almost no «domain logic whose consistency can be judged», state that in the report; zero logic briefs (empty array) is also a correct answer.`,
    es: `## Perspectiva de investigación — experto en lógica (dominio·consistencia)
Esta investigación se realiza desde la perspectiva de un experto en «lógica (dominio·consistencia)». Investiga el tema primero a través de la lente de «¿la lógica de negocio existente coincide con las reglas del dominio y puede hacerse más simple·clara?» (si la depuración es «por qué se rompe», QA es «cómo garantizar que no se rompa», seguridad es «cómo se explota», ops es «cómo ejecutarlo», entonces lógica es «aunque funcione correctamente, ¿es esa lógica consistente con el dominio·simple·mantenible?» — no un bug, sino corrección·simplicidad·mantenibilidad).
- **Investigación prioritaria**: consistencia de reglas del dominio·transiciones de estado (ciclos de vida como máquinas de estado·status·nodos de workflow·entitlements·resume/fork de sesión) y si los invariantes (condiciones que siempre deben cumplirse) se imponen en el código, duplicación (la misma regla dispersa en varios lugares y derivando), código muerto (inalcanzable·ramas sin usar·rastros que disparan re-propuestas), sobrecomplejidad (condiciones·indirección·ramas especiales innecesarias)·oscuridad (nombres reñidos con la intención). Y mejores prácticas de modelado de dominio·invariantes·refactorización·simplificación de código relacionadas con el tema.
- **Artefacto de comprensión (obligatorio)**: para «mejorar» la lógica, primero debe ser explícito «qué funciona actualmente y cómo» — debes incluir en el informe un «mapa de reglas del dominio / máquina de estados» del área investigada como una «sección». Organiza cada **estado**, **transición** (de→a), **condición de transición**, **invariante** y **disparador** (quién·cuándo·qué cambia el estado) en una tabla/mapa para que el triage·desarrolladores posteriores puedan evaluar la propuesta sin volver a hacer ingeniería inversa del código. (Ponlo en el markdown del informe existente sin un store·visor de UI·grafo aparte — un «artefacto de comprensión» reutilizable que evita escarbar la misma área desde cero otra vez.)
- **Énfasis en evidencia**: la evidencia del repo es «archivo:línea + qué regla de dominio/invariante se impone (o falta) dónde·dónde está la duplicación/código muerto/sobrecomplejidad», la evidencia web son ejemplos de diseño dirigido por dominio·invariantes·refactorización·simplificación de código (URL). Juzga por la «ubicación concreta» de consistencia·duplicación·complejidad que «funciona correctamente pero es riesgosa» en vez de conjeturas (esto no es un reporte de bug — se preserva el comportamiento), e incluye en el spec de cada brief lo siguiente «sin omisión» para que el triage vea el riesgo de una «mejora» no verificada y decida aprobar/retener/rechazar — «lógica·invariante actual (qué está dónde·qué garantiza) / problema de consistencia·invariante·duplicación·complejidad / una forma más simple·consistente (que preserve el comportamiento) / verificación de preservación del comportamiento (cómo confirmar vía regresión·tests existentes/añadidos) / blast-radius (archivos·tests afectados)». No eleves como brief una «mejora» cuya preservación del comportamiento no pueda verificarse.
- Si el repo objetivo casi no tiene «lógica de dominio cuya consistencia pueda juzgarse», indícalo en el informe; cero briefs de lógica (array vacío) también es una respuesta correcta.`,
    fr: `## Perspective de recherche — expert logique (domaine·cohérence)
Cette recherche se fait du point de vue d'un expert «logique (domaine·cohérence)». Investigue le sujet d'abord à travers le prisme de «la logique métier existante correspond-elle aux règles du domaine, et peut-on la rendre plus simple·claire» (si le débogage est «pourquoi ça casse», la QA «comment garantir que ça ne casse pas», la sécurité «comment c'est exploité», l'ops «comment l'exécuter», alors la logique est «même si ça marche correctement, cette logique est-elle cohérente avec le domaine·simple·maintenable» — pas un bug, mais correction·simplicité·maintenabilité).
- **Investigation prioritaire**: cohérence des règles du domaine·transitions d'état (cycles de vie comme machines à états·status·nœuds de workflow·entitlements·resume/fork de session) et si les invariants (conditions toujours vraies) sont imposés dans le code, duplication (la même règle éparpillée à plusieurs endroits et dérivant), code mort (inatteignable·branches inutilisées·traces déclenchant des re-propositions), sur-complexité (conditions·indirection·branches spéciales inutiles)·obscurité (noms en désaccord avec l'intention). Et bonnes pratiques de modélisation de domaine·invariants·refactorisation·simplification de code liées au sujet.
- **Artefact de compréhension (obligatoire)**: pour «améliorer» la logique, «ce qui fonctionne actuellement et comment» doit d'abord être explicite — tu dois inclure dans le rapport une «carte des règles du domaine / machine à états» de la zone investiguée comme une «section». Organise chaque **état**, **transition** (de→vers), **condition de transition**, **invariant** et **déclencheur** (qui·quand·quoi change l'état) en un tableau/carte pour que le triage·les développeurs ultérieurs puissent évaluer la proposition sans re-rétro-ingénierer le code. (Mets-le dans le markdown du rapport existant sans store·visionneuse UI·graphe séparés — un «artefact de compréhension» réutilisable qui évite de creuser la même zone à partir de zéro à nouveau.)
- **Emphase sur les preuves**: la preuve du dépôt est «fichier:ligne + quelle règle de domaine/invariant est imposé (ou manquant) où·où est la duplication/le code mort/la sur-complexité», la preuve web sont des exemples de conception pilotée par le domaine·invariants·refactorisation·simplification de code (URL). Juge par l'«emplacement concret» de cohérence·duplication·complexité qui «fonctionne correctement mais est risquée» plutôt que par conjecture (ce n'est pas un rapport de bug — le comportement est préservé), et inclus dans le spec de chaque brief ce qui suit «sans omission» pour que le triage voie le risque d'une «amélioration» non vérifiée et décide approuver/suspendre/rejeter — «logique·invariant actuel (quoi est où·ce qu'il garantit) / problème de cohérence·invariant·duplication·complexité / une forme plus simple·cohérente (préservant le comportement) / vérification de préservation du comportement (comment confirmer via régression·tests existants/ajoutés) / blast-radius (fichiers·tests affectés)». Ne soumets pas comme brief une «amélioration» dont la préservation du comportement ne peut être vérifiée.
- Si le dépôt cible n'a presque pas de «logique de domaine dont la cohérence peut être jugée», indique-le dans le rapport; zéro brief de logique (tableau vide) est aussi une réponse correcte.`,
    hi: `## शोध दृष्टिकोण — लॉजिक (डोमेन·संगति) विशेषज्ञ
यह शोध «लॉजिक (डोमेन·संगति)» विशेषज्ञ के दृष्टिकोण से होता है। विषय को पहले «क्या मौजूदा बिज़नेस लॉजिक डोमेन नियमों से मेल खाता है और क्या इसे अधिक सरल·स्पष्ट बनाया जा सकता है» की दृष्टि से जाँचें (यदि डिबगिंग «क्यों टूटता है», QA «कैसे न टूटे की गारंटी», सुरक्षा «कैसे दुरुपयोग», ops «कैसे चलाएँ» है, तो लॉजिक «भले ही सही चले, क्या वह लॉजिक डोमेन-संगत·सरल·रखरखाव-योग्य है» — बग नहीं, बल्कि शुद्धता·सरलता·रखरखाव-योग्यता)।
- **प्राथमिक जाँच**: डोमेन नियमों·स्थिति संक्रमण (स्टेट मशीन·status·workflow नोड·entitlement·सत्र resume/fork जैसी जीवनचक्र) की संगति और क्या इनवेरिएंट (जो शर्तें सदा सत्य होनी चाहिए) कोड में लागू हैं, दोहराव (वही नियम कई जगह बिखरा और ड्रिफ़्ट करता), मृत कोड (अप्राप्य·अप्रयुक्त शाखाएँ·पुनः-प्रस्ताव भड़काने वाले निशान), अति-जटिलता (अनावश्यक शर्तें·अप्रत्यक्षता·विशेष शाखाएँ)·अस्पष्टता (आशय से विपरीत नाम)। और विषय से संबंधित डोमेन मॉडलिंग·इनवेरिएंट·रीफैक्टरिंग·कोड सरलीकरण सर्वोत्तम अभ्यास।
- **समझ-कलाकृति (अनिवार्य)**: लॉजिक को «सुधारने» के लिए पहले «अभी क्या और कैसे काम करता है» स्पष्ट होना चाहिए — रिपोर्ट में जाँचे गए क्षेत्र का «डोमेन नियम / स्टेट मशीन मैप» एक «खंड» के रूप में अवश्य शामिल करें। प्रत्येक **स्थिति**, **संक्रमण** (कहाँ से→कहाँ), **संक्रमण शर्त**, **इनवेरिएंट**, और **ट्रिगर** (कौन·कब·क्या स्थिति बदलता है) को तालिका/मैप में व्यवस्थित करें ताकि बाद का triage·डेवलपर कोड की पुनः रिवर्स-इंजीनियरिंग किए बिना प्रस्ताव का मूल्यांकन कर सके। (अलग स्टोर·UI व्यूअर·ग्राफ़ के बिना मौजूदा रिपोर्ट markdown में डालें — एक पुन:प्रयोज्य «समझ-कलाकृति» जो उसी क्षेत्र को फिर शून्य से खोदने से बचाती है।)
- **साक्ष्य ज़ोर**: रेपो साक्ष्य «फ़ाइल:लाइन + कौन सा डोमेन नियम/इनवेरिएंट कहाँ लागू (या लुप्त) है·कहाँ दोहराव/मृत कोड/अति-जटिलता है», वेब साक्ष्य डोमेन-संचालित डिज़ाइन·इनवेरिएंट·रीफैक्टरिंग·कोड सरलीकरण उदाहरण (URL)। अनुमान के बजाय «सही चलता पर जोखिमपूर्ण» संगति·दोहराव·जटिलता के «ठोस स्थान» से निर्णय करें (यह बग रिपोर्ट नहीं है — व्यवहार संरक्षित), और हर ब्रीफ़ के spec में निम्न «बिना छोड़े» शामिल करें ताकि triage बिना सत्यापित «सुधार» का जोखिम देखकर स्वीकृति/रोक/अस्वीकृति तय कर सके — «वर्तमान लॉजिक·इनवेरिएंट (क्या कहाँ·क्या गारंटी देता है) / संगति·इनवेरिएंट·दोहराव·जटिलता समस्या / अधिक सरल·संगत रूप (व्यवहार-संरक्षी) / व्यवहार-संरक्षण सत्यापन (मौजूदा/जोड़े गए रिग्रेशन·टेस्ट से कैसे पुष्टि) / blast-radius (प्रभावित फ़ाइलें·टेस्ट)»। जिस «सुधार» का व्यवहार-संरक्षण सत्यापित न हो सके उसे ब्रीफ़ के रूप में न उठाएँ।
- यदि लक्ष्य रेपो में «संगति आँकने योग्य डोमेन लॉजिक» लगभग न हो तो रिपोर्ट में बताएँ; शून्य लॉजिक ब्रीफ़ (खाली array) भी सही उत्तर है।`,
    ja: `## 調査の観点 — ロジック(ドメイン·整合性)の専門家
この調査は「ロジック(ドメイン·整合性)」専門家の観点で行う。主題をまず「既存のビジネスロジックがドメイン規則と合致し、より単純·明瞭にできるか」の目で調査せよ(デバッグが「なぜ壊れるか」、QA が「壊れないことをどう保証するか」、セキュリティが「どう悪用されるか」、運用が「どう回すか」なら、ロジックは「正常に動いても、そのロジックはドメインに整合し·単純で·保守可能か」 — バグではなく正確性·単純性·保守性)。
- **優先調査**: ドメイン規則·状態遷移(状態機械·status·ワークフローノード·エンタイトルメント·セッションの resume/fork のようなライフサイクル)の整合性と、不変条件(常に真であるべき条件)がコードで強制されているか、重複(同じ規則が複数箇所に散らばりドリフト)、デッドコード(到達不能·未使用分岐·再提案を誘発する痕跡)、過複雑(不要な条件·間接·特殊分岐)·不明瞭(意図に反する命名)。そして主題に関連するドメインモデリング·不変条件·リファクタリング·コード単純化のベストプラクティス。
- **理解の成果物(必須)**: ロジックを「改善」するには「今何がどう動くか」がまず明示的でなければならない — 報告書に調査領域の「ドメイン規則/状態機械マップ」を「1節」として必ず含めよ。各**状態**·**遷移**(どこから→どこへ)·**遷移条件**·**不変条件**·**トリガー**(誰·いつ·何が状態を変えるか)を表/マップに整理し、後続の triage·開発者がコードを再びリバースエンジニアリングせずに提案を評価できるようにせよ。(別ストア·UI ビューア·グラフなしで既存の報告書 markdown に節として入れる — 同じ領域を次にまた一から掘り起こさせない再利用可能な「理解の成果物」。)
- **根拠の強調**: リポジトリ根拠は「ファイル:行 + どのドメイン規則/不変条件がどこで強制(または欠落)されるか·どこが重複/デッドコード/過複雑か」、ウェブ根拠はドメイン駆動設計·不変条件·リファクタリング·コード単純化の事例(URL)。推測より「正常に動くが危険な」整合性·重複·複雑性の「具体的な位置」で判定し(バグ報告ではない — 動作は保存)、各ブリーフの spec に次を「漏れなく」含めて、triage が未検証の「改善」のリスクを見て承認/保留/却下を判断できるようにせよ — 「現在のロジック·不変条件(何がどこに·何を保証するか) / 整合性·不変条件·重複·複雑性の問題 / より単純·整合した形(動作保存) / 動作保存の検証(既存/追加の回帰·テストでどう確認するか) / blast-radius(影響を受けるファイル·テスト)」。動作保存を検証できない「改善」はブリーフに上げるな。
- 対象リポジトリに「整合性を問うドメインロジック」がほとんどなければ、その事実を報告書に明示し、ロジックブリーフ0件(空配列)も正解だ。`,
    ko: `## 조사 관점 — 로직(도메인·정합성) 전문가
이 리서치는 «로직(도메인·정합성)» 전문가 관점으로 수행한다. 주제를 «기존 비즈니스 로직이 도메인 규칙과 맞고 더 단순·명료하게 만들 수 있는가» 의 눈으로 우선 조사하라 (디버깅이 «왜 깨지나», QA 가 «어떻게 깨지지 않음을 보증하나», 보안이 «어떻게 악용되나», 운영이 «어떻게 굴리나» 라면, 로직은 «정상 동작하더라도 그 로직이 도메인에 정합하고·단순하고·유지보수 가능한가» — 버그가 아니라 정확성·단순성·유지보수성).
- **우선 조사**: 도메인 규칙·상태 전이(상태머신·status·워크플로우 노드·엔타이틀먼트·세션 resume/fork 같은 수명주기)의 정합성과 불변식(언제나 참이어야 하는 조건)이 코드로 강제되는가, 중복(같은 규칙이 여러 곳에 흩어져 드리프트), 죽은 코드(도달 불가·미사용 분기·재제안 유발 흔적), 과복잡(불필요한 조건·간접·특수분기)·불명료(의도와 어긋난 이름). 주제와 관련된 도메인 모델링·불변식·리팩토링·코드 단순화 모범 사례.
- **이해 산출물 (필수)**: 로직을 «개선» 하려면 «현재 무엇이 어떻게 동작하나» 가 먼저 명시적이어야 한다 — 보고서에 조사한 영역의 «도메인 규칙/상태머신 맵» 을 «1절» 로 반드시 포함하라. 각 **상태**, **전이**(어디서→어디로), **전이 조건**, **불변식**, **트리거**(누가·언제·무엇이 상태를 바꾸나)를 표/맵으로 정리해, 후속 triage·개발자가 코드를 다시 reverse-engineering 하지 않고 제안을 평가할 수 있게 한다. (별도 저장소·UI 뷰어·그래프 없이 기존 보고서 마크다운에 절로 담는다 — 같은 영역을 다음에 또 처음부터 파헤치지 않게 하는 재사용 가능한 «이해 산출물».)
- **근거 강조**: 레포 근거는 «파일:라인 + 어떤 도메인 규칙/불변식이 어디서 강제(또는 누락)되나·어디가 중복/죽은 코드/과복잡인가», 웹 근거는 도메인 주도 설계·불변식·리팩토링·코드 단순화 사례(URL). 추정보다 «정상 동작하지만 위험한» 정합성·중복·복잡성의 «구체적 위치» 로 판정하고(버그 신고가 아님 — 동작은 보존), 각 브리프의 spec 에 다음을 «빠짐없이» 담아 triage 가 검증 안 된 «개선» 의 위험을 보고 승인/보류/기각을 판단할 수 있게 하라 — «현재 로직·불변식(무엇이 어디에·무엇을 보장하나) / 정합성·불변식·중복·복잡성 문제 / 더 단순·정합한 형태(동작 보존) / 동작 보존 검증(기존/추가 회귀·테스트로 어떻게 확인하나) / blast-radius(영향 받는 파일·테스트)». 동작 보존을 검증할 수 없는 «개선» 은 브리프로 올리지 마라.
- 대상 레포에 «정합성을 따질 도메인 로직» 이 거의 없으면 그 사실을 보고서에 명시하고 로직 브리프 0건(빈 배열)도 정답이다.`,
    "pt-BR": `## Perspectiva de pesquisa — especialista em lógica (domínio·consistência)
Esta pesquisa é feita pela perspectiva de um especialista em «lógica (domínio·consistência)». Investigue o tema primeiro pela lente de «a lógica de negócio existente corresponde às regras do domínio e pode ser tornada mais simples·clara?» (se a depuração é «por que quebra», QA é «como garantir que não quebre», segurança é «como é explorada», ops é «como executá-la», então lógica é «mesmo que funcione corretamente, essa lógica é consistente com o domínio·simples·sustentável?» — não um bug, mas correção·simplicidade·manutenibilidade).
- **Investigação prioritária**: consistência das regras do domínio·transições de estado (ciclos de vida como máquinas de estado·status·nós de workflow·entitlements·resume/fork de sessão) e se os invariantes (condições que sempre devem valer) são impostos no código, duplicação (a mesma regra espalhada em vários lugares e derivando), código morto (inalcançável·ramos não usados·rastros que disparam re-propostas), complexidade excessiva (condições·indireção·ramos especiais desnecessários)·obscuridade (nomes em desacordo com a intenção). E melhores práticas de modelagem de domínio·invariantes·refatoração·simplificação de código relacionadas ao tema.
- **Artefato de compreensão (obrigatório)**: para «melhorar» a lógica, primeiro «o que funciona atualmente e como» deve ser explícito — você deve incluir no relatório um «mapa de regras do domínio / máquina de estados» da área investigada como uma «seção». Organize cada **estado**, **transição** (de→para), **condição de transição**, **invariante** e **gatilho** (quem·quando·o que muda o estado) em uma tabela/mapa para que o triage·desenvolvedores posteriores possam avaliar a proposta sem refazer a engenharia reversa do código. (Coloque-o no markdown do relatório existente sem um store·visualizador de UI·grafo separados — um «artefato de compreensão» reutilizável que evita escavar a mesma área do zero novamente.)
- **Ênfase em evidências**: a evidência do repo é «arquivo:linha + qual regra de domínio/invariante é imposta (ou ausente) onde·onde está a duplicação/código morto/complexidade excessiva», a evidência web são exemplos de design orientado a domínio·invariantes·refatoração·simplificação de código (URL). Julgue pela «localização concreta» de consistência·duplicação·complexidade que «funciona corretamente mas é arriscada» em vez de conjectura (isto não é um relatório de bug — o comportamento é preservado), e inclua no spec de cada brief o seguinte «sem omissão» para que o triage veja o risco de uma «melhoria» não verificada e decida aprovar/reter/rejeitar — «lógica·invariante atual (o que está onde·o que garante) / problema de consistência·invariante·duplicação·complexidade / uma forma mais simples·consistente (que preserve o comportamento) / verificação de preservação do comportamento (como confirmar via regressão·testes existentes/adicionados) / blast-radius (arquivos·testes afetados)». Não eleve como brief uma «melhoria» cuja preservação do comportamento não possa ser verificada.
- Se o repo alvo quase não tiver «lógica de domínio cuja consistência possa ser julgada», indique isso no relatório; zero briefs de lógica (array vazio) também é uma resposta correta.`,
    ru: `## Перспектива исследования — эксперт по логике (домен·согласованность)
Это исследование ведётся с точки зрения эксперта по «логике (домен·согласованность)». Исследуйте тему прежде всего через призму «соответствует ли существующая бизнес-логика правилам домена и можно ли сделать её проще·яснее» (если отладка — «почему ломается», QA — «как гарантировать, что не сломается», безопасность — «как эксплуатируется», ops — «как запускать», то логика — «даже если работает корректно, согласована ли эта логика с доменом·проста·сопровождаема» — не баг, а корректность·простота·сопровождаемость).
- **Приоритетное исследование**: согласованность правил домена·переходов состояний (жизненные циклы вроде машин состояний·status·узлов workflow·прав·resume/fork сессии) и принуждаются ли инварианты (условия, которые всегда должны выполняться) в коде, дублирование (одно правило разбросано по местам и дрейфует), мёртвый код (недостижимый·неиспользуемые ветви·следы, провоцирующие повторные предложения), избыточная сложность (ненужные условия·косвенность·особые ветви)·неясность (имена, противоречащие намерению). И лучшие практики доменного моделирования·инвариантов·рефакторинга·упрощения кода, связанные с темой.
- **Артефакт понимания (обязательно)**: чтобы «улучшить» логику, сначала должно быть явно «что сейчас работает и как» — вы обязаны включить в отчёт «карту правил домена / машины состояний» исследованной области как «раздел». Организуйте каждое **состояние**, **переход** (откуда→куда), **условие перехода**, **инвариант** и **триггер** (кто·когда·что меняет состояние) в таблицу/карту, чтобы последующий triage·разработчики могли оценить предложение без повторного реверс-инжиниринга кода. (Поместите это в существующий markdown отчёта без отдельного хранилища·UI-просмотрщика·графа — переиспользуемый «артефакт понимания», который избавляет от повторного раскапывания той же области с нуля.)
- **Акцент доказательств**: доказательство репозитория — «файл:строка + какое правило домена/инвариант принуждается (или отсутствует) где·где дублирование/мёртвый код/избыточная сложность», веб-доказательство — примеры предметно-ориентированного проектирования·инвариантов·рефакторинга·упрощения кода (URL). Судите по «конкретному местоположению» согласованности·дублирования·сложности, которая «работает корректно, но рискованна», а не по домыслу (это не баг-репорт — поведение сохраняется), и включите в spec каждого брифа следующее «без пропусков», чтобы triage увидел риск непроверенного «улучшения» и решил одобрить/отложить/отклонить — «текущая логика·инвариант (что где·что гарантирует) / проблема согласованности·инварианта·дублирования·сложности / более простая·согласованная форма (сохраняющая поведение) / проверка сохранения поведения (как подтвердить через существующие/добавленные регрессионные·тесты) / blast-radius (затронутые файлы·тесты)». Не поднимайте как бриф «улучшение», сохранение поведения которого нельзя проверить.
- Если у целевого репозитория почти нет «доменной логики, чью согласованность можно оценить», укажите это в отчёте; ноль логических брифов (пустой массив) — тоже правильный ответ.`,
    "zh-Hans": `## 调研视角 — 逻辑(领域·一致性)专家
本次调研以「逻辑(领域·一致性)」专家的视角进行。先以「现有业务逻辑是否符合领域规则、能否更简单·更清晰」的眼光调研主题(若调试是「为何会坏」、QA 是「如何保证不坏」、安全是「如何被利用」、运维是「如何运行」,逻辑则是「即便正常运行,该逻辑是否与领域一致·简单·可维护」——不是 bug,而是正确性·简洁性·可维护性)。
- **优先调研**: 领域规则·状态转移(状态机·status·workflow 节点·权限·会话 resume/fork 等生命周期)的一致性,以及不变式(必须始终为真的条件)是否在代码中被强制,重复(同一规则散落多处并漂移),死代码(不可达·未使用分支·诱发再提案的痕迹),过度复杂(不必要的条件·间接·特殊分支)·不清晰(与意图相悖的命名)。以及与主题相关的领域建模·不变式·重构·代码简化最佳实践。
- **理解产物(必需)**: 要「改进」逻辑,必须先把「当前什么在运行、如何运行」显式化——必须在报告中以「一节」包含所调研区域的「领域规则/状态机映射」。将每个**状态**、**转移**(从→到)、**转移条件**、**不变式**、**触发器**(谁·何时·什么改变状态)整理为表/映射,使后续 triage·开发者无需再次逆向工程代码即可评估提案。(放入现有报告 markdown 中,不另设存储·UI 查看器·图——一个可复用的「理解产物」,避免下次再从零挖掘同一区域。)
- **依据强调**: 仓库依据为「文件:行 + 哪条领域规则/不变式在何处被强制(或缺失)·何处有重复/死代码/过度复杂」,网络依据为领域驱动设计·不变式·重构·代码简化范例(URL)。以「正常运行但有风险」的一致性·重复·复杂性的「具体位置」而非臆测来判定(这不是 bug 报告——行为予以保留),并在每条简报的 spec 中「无遗漏」地包含以下内容,以便 triage 看清未经验证的「改进」之风险并决定批准/暂缓/拒绝——「当前逻辑·不变式(什么在何处·保证什么) / 一致性·不变式·重复·复杂性问题 / 更简单·更一致的形态(保留行为) / 行为保留验证(如何通过现有/新增回归·测试确认) / blast-radius(受影响的文件·测试)」。无法验证行为保留的「改进」不要作为简报提出。
- 若目标仓库几乎没有「可评判一致性的领域逻辑」,在报告中说明;零条逻辑简报(空数组)也是正确答案。`,
  },

  // ── 리서치 렌즈 머리말 — ux (base) ───────────────────────────────────────────
  "lens.research.ux": {
    ar: `## منظور البحث — خبير تجربة المستخدم (UX·قابلية الاستخدام)
يُجرى هذا البحث بمنظور خبير «تجربة المستخدم (UX·قابلية الاستخدام)». ابحث الموضوع أولاً بعين «أين يتعثّر المستخدم ولماذا لا يُكمل». **هذا ليس رموز·ألوان·تباعد عدسة design (البصرية) بل «احتكاك التدفّق·الفهم (التعرّف مقابل الاستذكار)·الإكمال»** — ليس مراجعة تصميم بصرية بل تقييم استدلالات UX (كما تميّز الصناعة بينهما بمنهجيتين؛ إن كان design «كيف يبدو» فالـ ux «كيف يُستخدم»).
- **البحث ذو الأولوية**: اتّخذ استدلالات Nielsen العشرة معياراً «للبحث ذي الأولوية» — ① رؤية حالة النظام، ② تطابق النظام-الواقع (لغة المستخدم)، ③ تحكّم·حرية المستخدم (الإلغاء·التراجع)، ④ الاتساق·المعايير، ⑤ منع الأخطاء، ⑥ التعرّف مقابل الاستذكار (تقليل عبء الذاكرة)، ⑦ المرونة·كفاءة الاستخدام (الاختصار·التخصيص)، ⑧ التصميم الجمالي·الأدنى، ⑨ دعم إدراك·تشخيص·استرداد الأخطاء، ⑩ المساعدة·الوثائق. ونقاط الاحتكاك·نقاط التوقّف (التسرّب)·مناطق تكرّر الأخطاء في تدفّق المستخدم المتصل بالموضوع، وأفضل ممارسات قابلية الاستخدام·التفاعل.
- **تأكيد السند**: سند المستودع «ملف:سطر + التدفّق حيث يتعثّر المستخدم (في أي خطوة·لماذا)·الاستدلال المُنتهَك», وسند الويب إرشادات قابلية الاستخدام·التقييم الاستدلالي·أفضل ممارسات UX (URL). احكم بـ«سيناريو استخدام محدد واحتكاكه» بدل التخمين، وضع في spec كل بريف «الاستدلال المُنتهَك / الخطورة (cosmetic·minor·major·catastrophic) / سيناريو الاستخدام (ما الذي يحاول المستخدم فعله وأين يتعثّر) / المقترح للتحسين» (مثلما يحوي spec التصحيح «إعادة الإنتاج·التحقق»، والأمن «التهديد·التخفيف»، والمنطق «الاتساق·حفظ السلوك»).
- إن لم يكن للمستودع المستهدف «تدفّق/سطح تفاعل يمرّ به المستخدم» فبيّن ذلك في التقرير، وبريف UX بعدد 0 (مصفوفة فارغة) إجابة صحيحة أيضاً.`,
    en: `## Research perspective — UX (usability) expert
This research runs from a «UX (usability)» expert's perspective. Investigate the topic first through the lens of «where the user gets stuck and why they cannot finish». **This is not the design (visual) lens's tokens·colors·spacing but «flow friction·understanding (recognition vs recall)·completion»** — not a visual design review but a UX heuristic evaluation (just as the industry separates the two with different methodologies; if design is «how it looks», ux is «how it is used»).
- **Priority investigation**: take Nielsen's 10 usability heuristics as the «priority investigation criteria» — ① visibility of system status, ② match between system and the real world (user language), ③ user control·freedom (cancel·undo), ④ consistency·standards, ⑤ error prevention, ⑥ recognition vs recall (reduce memory load), ⑦ flexibility·efficiency of use (shortcuts·customization), ⑧ aesthetic·minimalist design, ⑨ error recognition·diagnosis·recovery support, ⑩ help·documentation. And the friction points·drop-off (abandonment) points·error-prone areas of the user flow related to the topic, and usability·interaction best practices.
- **Evidence emphasis**: repo evidence is «file:line + the flow where the user gets stuck (at which step·why)·the violated heuristic», web evidence is usability guidelines·heuristic evaluation·UX best practices (URL). Judge by a «concrete usage scenario and its friction» rather than conjecture, and put in each brief's spec «the violated heuristic / severity (cosmetic·minor·major·catastrophic) / usage scenario (what the user tried to do and where they got stuck) / improvement» (just as debugging's spec contains «reproduction·verification», security's «threat·mitigation», logic's «consistency·behavior preservation»).
- If the target repo has no «flow/interaction surface that the user goes through», state that in the report; zero UX briefs (empty array) is also a correct answer.`,
    es: `## Perspectiva de investigación — experto en UX (usabilidad)
Esta investigación se realiza desde la perspectiva de un experto en «UX (usabilidad)». Investiga el tema primero a través de la lente de «dónde se atasca el usuario y por qué no puede terminar». **Esto no son los tokens·colores·espaciado de la lente design (visual) sino «fricción de flujo·comprensión (reconocimiento vs recuerdo)·finalización»** — no una revisión de diseño visual sino una evaluación heurística de UX (igual que la industria las separa con metodologías distintas; si design es «cómo se ve», ux es «cómo se usa»).
- **Investigación prioritaria**: toma las 10 heurísticas de usabilidad de Nielsen como «criterios de investigación prioritaria» — ① visibilidad del estado del sistema, ② correspondencia entre el sistema y el mundo real (lenguaje del usuario), ③ control·libertad del usuario (cancelar·deshacer), ④ consistencia·estándares, ⑤ prevención de errores, ⑥ reconocimiento vs recuerdo (reducir carga de memoria), ⑦ flexibilidad·eficiencia de uso (atajos·personalización), ⑧ diseño estético·minimalista, ⑨ apoyo a reconocer·diagnosticar·recuperar errores, ⑩ ayuda·documentación. Y los puntos de fricción·puntos de abandono·zonas propensas a errores del flujo de usuario relacionados con el tema, y mejores prácticas de usabilidad·interacción.
- **Énfasis en evidencia**: la evidencia del repo es «archivo:línea + el flujo donde el usuario se atasca (en qué paso·por qué)·la heurística violada», la evidencia web son guías de usabilidad·evaluación heurística·mejores prácticas de UX (URL). Juzga por un «escenario de uso concreto y su fricción» en vez de conjeturas, y pon en el spec de cada brief «la heurística violada / severidad (cosmetic·minor·major·catastrophic) / escenario de uso (qué intentaba hacer el usuario y dónde se atascó) / mejora» (igual que el spec de depuración contiene «reproducción·verificación», el de seguridad «amenaza·mitigación», el de lógica «consistencia·preservación del comportamiento»).
- Si el repo objetivo no tiene «flujo/superficie de interacción que el usuario recorra», indícalo en el informe; cero briefs de UX (array vacío) también es una respuesta correcta.`,
    fr: `## Perspective de recherche — expert UX (utilisabilité)
Cette recherche se fait du point de vue d'un expert «UX (utilisabilité)». Investigue le sujet d'abord à travers le prisme de «où l'utilisateur se bloque et pourquoi il n'arrive pas à finir». **Ce ne sont pas les tokens·couleurs·espacement de la lentille design (visuelle) mais «friction de flux·compréhension (reconnaissance vs rappel)·achèvement»** — pas une revue de design visuel mais une évaluation heuristique UX (tout comme l'industrie sépare les deux avec des méthodologies différentes; si design est «à quoi ça ressemble», ux est «comment c'est utilisé»).
- **Investigation prioritaire**: prends les 10 heuristiques d'utilisabilité de Nielsen comme «critères d'investigation prioritaire» — ① visibilité de l'état du système, ② correspondance entre le système et le monde réel (langage utilisateur), ③ contrôle·liberté de l'utilisateur (annuler·défaire), ④ cohérence·standards, ⑤ prévention des erreurs, ⑥ reconnaissance vs rappel (réduire la charge mémoire), ⑦ flexibilité·efficacité d'usage (raccourcis·personnalisation), ⑧ design esthétique·minimaliste, ⑨ aide à reconnaître·diagnostiquer·récupérer des erreurs, ⑩ aide·documentation. Et les points de friction·points d'abandon·zones sujettes aux erreurs du flux utilisateur liés au sujet, et bonnes pratiques d'utilisabilité·interaction.
- **Emphase sur les preuves**: la preuve du dépôt est «fichier:ligne + le flux où l'utilisateur se bloque (à quelle étape·pourquoi)·l'heuristique violée», la preuve web sont des guides d'utilisabilité·évaluation heuristique·bonnes pratiques UX (URL). Juge par un «scénario d'usage concret et sa friction» plutôt que par conjecture, et mets dans le spec de chaque brief «l'heuristique violée / sévérité (cosmetic·minor·major·catastrophic) / scénario d'usage (ce que l'utilisateur essayait de faire et où il s'est bloqué) / amélioration» (tout comme le spec du débogage contient «reproduction·vérification», celui de la sécurité «menace·mitigation», celui de la logique «cohérence·préservation du comportement»).
- Si le dépôt cible n'a pas de «flux/surface d'interaction que l'utilisateur traverse», indique-le dans le rapport; zéro brief UX (tableau vide) est aussi une réponse correcte.`,
    hi: `## शोध दृष्टिकोण — UX (उपयोगिता) विशेषज्ञ
यह शोध «UX (उपयोगिता)» विशेषज्ञ के दृष्टिकोण से होता है। विषय को पहले «उपयोगकर्ता कहाँ अटकता है और क्यों पूरा नहीं कर पाता» की दृष्टि से जाँचें। **यह design (दृश्य) लेंस के टोकन·रंग·स्पेसिंग नहीं बल्कि «फ़्लो घर्षण·समझ (पहचान बनाम स्मरण)·पूर्णता» है** — दृश्य डिज़ाइन समीक्षा नहीं बल्कि UX ह्यूरिस्टिक मूल्यांकन (जैसे उद्योग दोनों को भिन्न पद्धतियों से अलग करता है; यदि design «कैसा दिखता है» है तो ux «कैसे उपयोग होता है» है)।
- **प्राथमिक जाँच**: Nielsen की 10 उपयोगिता ह्यूरिस्टिक्स को «प्राथमिक जाँच मानदंड» बनाएँ — ① सिस्टम स्थिति की दृश्यता, ② सिस्टम-वास्तविकता मेल (उपयोगकर्ता भाषा), ③ उपयोगकर्ता नियंत्रण·स्वतंत्रता (रद्द·पूर्ववत), ④ संगति·मानक, ⑤ त्रुटि रोकथाम, ⑥ पहचान बनाम स्मरण (स्मृति भार कम करना), ⑦ लचीलापन·उपयोग दक्षता (शॉर्टकट·अनुकूलन), ⑧ सौंदर्य·न्यूनतम डिज़ाइन, ⑨ त्रुटि पहचान·निदान·पुनर्प्राप्ति समर्थन, ⑩ सहायता·दस्तावेज़। और विषय से संबंधित उपयोगकर्ता फ़्लो के घर्षण बिंदु·छोड़ने (ड्रॉप-ऑफ़) बिंदु·त्रुटि-प्रवण क्षेत्र, तथा उपयोगिता·इंटरैक्शन सर्वोत्तम अभ्यास।
- **साक्ष्य ज़ोर**: रेपो साक्ष्य «फ़ाइल:लाइन + वह फ़्लो जहाँ उपयोगकर्ता अटकता है (किस चरण में·क्यों)·उल्लंघित ह्यूरिस्टिक», वेब साक्ष्य उपयोगिता दिशानिर्देश·ह्यूरिस्टिक मूल्यांकन·UX सर्वोत्तम अभ्यास (URL)। अनुमान के बजाय «ठोस उपयोग परिदृश्य व उसका घर्षण» से निर्णय करें, और हर ब्रीफ़ के spec में «उल्लंघित ह्यूरिस्टिक / गंभीरता (cosmetic·minor·major·catastrophic) / उपयोग परिदृश्य (उपयोगकर्ता क्या करने जा रहा था और कहाँ अटका) / सुधार» डालें (जैसे डिबगिंग का spec «पुनरुत्पादन·सत्यापन», सुरक्षा का «खतरा·शमन», लॉजिक का «संगति·व्यवहार-संरक्षण» रखता है)।
- यदि लक्ष्य रेपो में «उपयोगकर्ता द्वारा गुज़रने वाला फ़्लो/इंटरैक्शन सतह» न हो तो रिपोर्ट में बताएँ; शून्य UX ब्रीफ़ (खाली array) भी सही उत्तर है।`,
    ja: `## 調査の観点 — UX(ユーザビリティ)の専門家
この調査は「UX(ユーザビリティ)」専門家の観点で行う。主題をまず「ユーザーがどこで詰まり、なぜ完了できないか」の目で調査せよ。**これは design(視覚)レンズのトークン·色·余白ではなく「フローの摩擦·理解(認識 vs 想起)·完了」だ** — 視覚デザインレビューではなく UX ヒューリスティック評価だ(業界が両者を別の方法論で区別するとおり; design が「どう見えるか」なら ux は「どう使われるか」)。
- **優先調査**: Nielsen の10大ユーザビリティヒューリスティックを「優先調査基準」とせよ — ① システム状態の可視性、② システムと現実の一致(ユーザー言語)、③ ユーザーの制御·自由(取消·やり直し)、④ 一貫性·標準、⑤ エラー予防、⑥ 認識 vs 想起(記憶負荷を減らす)、⑦ 柔軟性·使用効率(ショートカット·カスタム)、⑧ 美的·ミニマルデザイン、⑨ エラーの認知·診断·回復の支援、⑩ ヘルプ·ドキュメント。そして主題に関連するユーザーフローの摩擦点·中断(離脱)点·エラー多発区間、そしてユーザビリティ·インタラクションのベストプラクティス。
- **根拠の強調**: リポジトリ根拠は「ファイル:行 + ユーザーが詰まるフロー(どの段階で·なぜ)·違反したヒューリスティック」、ウェブ根拠はユーザビリティガイドライン·ヒューリスティック評価·UX のベストプラクティス(URL)。推測より「具体的な使用シナリオとその摩擦」で判定し、各ブリーフの spec に「違反したヒューリスティック / 重大度(cosmetic·minor·major·catastrophic) / 使用シナリオ(ユーザーが何をしようとしてどこで詰まったか) / 改善案」を入れよ(デバッグの spec が「再現·検証」、セキュリティが「脅威·緩和」、ロジックが「整合性·動作保存」を含むのと同型)。
- 対象リポジトリに「ユーザーが通るフロー/相互作用の表面」がなければ、その事実を報告書に明示し、UX ブリーフ0件(空配列)も正解だ。`,
    ko: `## 조사 관점 — UX(사용성) 전문가
이 리서치는 «UX(사용성)» 전문가 관점으로 수행한다. 주제를 «사용자가 어디서 막히고 왜 못 끝내나» 의 눈으로 우선 조사하라. **이건 design(시각) 렌즈의 토큰·색·간격이 아니라 «플로우 마찰·이해(인식 vs 회상)·완수» 다** — 시각 디자인 리뷰가 아니라 UX 휴리스틱 평가다(업계가 둘을 다른 방법론으로 구분하는 그대로; design 이 «어떻게 보이나» 라면 ux 는 «어떻게 쓰이나»).
- **우선 조사**: Nielsen 의 10대 사용성 휴리스틱을 «우선 조사 기준» 으로 삼아라 — ① 시스템 상태 가시성, ② 시스템-현실 일치(사용자 언어), ③ 사용자 제어·자유(취소·되돌리기), ④ 일관성·표준, ⑤ 오류 예방, ⑥ 인식 vs 회상(기억 부담 줄이기), ⑦ 유연성·사용 효율(단축·맞춤), ⑧ 미적·미니멀 디자인, ⑨ 오류 인지·진단·복구 지원, ⑩ 도움말·문서. 주제와 관련된 사용자 플로우의 마찰점·중단(이탈) 지점·오류 빈발 구간, 그리고 사용성·인터랙션 모범 사례.
- **근거 강조**: 레포 근거는 «파일:라인 + 사용자가 막히는 플로우(어느 단계에서·왜)·위반한 휴리스틱», 웹 근거는 사용성 가이드라인·휴리스틱 평가·UX 모범 사례(URL). 추정보다 «구체적 사용 시나리오와 그 마찰» 로 판정하고, 각 브리프의 spec 에 «위반한 휴리스틱 / 심각도(cosmetic·minor·major·catastrophic) / 사용 시나리오(사용자가 무엇을 하려다 어디서 막히나) / 개선안» 을 담아라 (디버깅이 spec 에 «재현·검증», 보안이 «위협·완화», 로직이 «정합성·동작 보존» 을 담는 것과 동형).
- 대상 레포에 «사용자가 거치는 플로우/상호작용 표면» 이 없으면 그 사실을 보고서에 명시하고 UX 브리프 0건(빈 배열)도 정답이다.`,
    "pt-BR": `## Perspectiva de pesquisa — especialista em UX (usabilidade)
Esta pesquisa é feita pela perspectiva de um especialista em «UX (usabilidade)». Investigue o tema primeiro pela lente de «onde o usuário trava e por que não consegue terminar». **Isto não são os tokens·cores·espaçamento da lente design (visual), mas «atrito de fluxo·compreensão (reconhecimento vs recordação)·conclusão»** — não uma revisão de design visual, mas uma avaliação heurística de UX (assim como a indústria separa as duas com metodologias diferentes; se design é «como parece», ux é «como é usado»).
- **Investigação prioritária**: tome as 10 heurísticas de usabilidade de Nielsen como «critérios de investigação prioritária» — ① visibilidade do estado do sistema, ② correspondência entre o sistema e o mundo real (linguagem do usuário), ③ controle·liberdade do usuário (cancelar·desfazer), ④ consistência·padrões, ⑤ prevenção de erros, ⑥ reconhecimento vs recordação (reduzir carga de memória), ⑦ flexibilidade·eficiência de uso (atalhos·personalização), ⑧ design estético·minimalista, ⑨ apoio a reconhecer·diagnosticar·recuperar de erros, ⑩ ajuda·documentação. E os pontos de atrito·pontos de abandono·áreas propensas a erro do fluxo do usuário relacionados ao tema, e melhores práticas de usabilidade·interação.
- **Ênfase em evidências**: a evidência do repo é «arquivo:linha + o fluxo onde o usuário trava (em qual passo·por quê)·a heurística violada», a evidência web são diretrizes de usabilidade·avaliação heurística·melhores práticas de UX (URL). Julgue por um «cenário de uso concreto e seu atrito» em vez de conjectura, e coloque no spec de cada brief «a heurística violada / severidade (cosmetic·minor·major·catastrophic) / cenário de uso (o que o usuário tentava fazer e onde travou) / melhoria» (assim como o spec da depuração contém «reprodução·verificação», o da segurança «ameaça·mitigação», o da lógica «consistência·preservação do comportamento»).
- Se o repo alvo não tiver «fluxo/superfície de interação que o usuário percorre», indique isso no relatório; zero briefs de UX (array vazio) também é uma resposta correta.`,
    ru: `## Перспектива исследования — эксперт по UX (юзабилити)
Это исследование ведётся с точки зрения эксперта по «UX (юзабилити)». Исследуйте тему прежде всего через призму «где пользователь застревает и почему не может завершить». **Это не токены·цвета·отступы линзы design (визуальной), а «трение потока·понимание (узнавание vs припоминание)·завершение»** — не визуальный дизайн-ревью, а эвристическая оценка UX (как индустрия и разделяет их разными методологиями; если design — «как выглядит», то ux — «как используется»).
- **Приоритетное исследование**: возьмите 10 эвристик юзабилити Нильсена как «критерии приоритетного исследования» — ① видимость состояния системы, ② соответствие системы реальному миру (язык пользователя), ③ контроль·свобода пользователя (отмена·возврат), ④ согласованность·стандарты, ⑤ предотвращение ошибок, ⑥ узнавание vs припоминание (снижение нагрузки на память), ⑦ гибкость·эффективность использования (сокращения·настройка), ⑧ эстетичный·минималистичный дизайн, ⑨ поддержка распознавания·диагностики·восстановления ошибок, ⑩ помощь·документация. И точки трения·точки оттока·подверженные ошибкам зоны пользовательского потока, связанные с темой, и лучшие практики юзабилити·взаимодействия.
- **Акцент доказательств**: доказательство репозитория — «файл:строка + поток, где пользователь застревает (на каком шаге·почему)·нарушенная эвристика», веб-доказательство — руководства по юзабилити·эвристическая оценка·лучшие практики UX (URL). Судите по «конкретному сценарию использования и его трению», а не по домыслу, и в spec каждого брифа укажите «нарушенная эвристика / серьёзность (cosmetic·minor·major·catastrophic) / сценарий использования (что пользователь пытался сделать и где застрял) / улучшение» (как spec отладки содержит «воспроизведение·верификацию», безопасности — «угроза·смягчение», логики — «согласованность·сохранение поведения»).
- Если у целевого репозитория нет «потока/поверхности взаимодействия, через которые проходит пользователь», укажите это в отчёте; ноль UX-брифов (пустой массив) — тоже правильный ответ.`,
    "zh-Hans": `## 调研视角 — UX(可用性)专家
本次调研以「UX(可用性)」专家的视角进行。先以「用户在哪里卡住、为何无法完成」的眼光调研主题。**这不是 design(视觉)视角的令牌·颜色·间距,而是「流程摩擦·理解(识别 vs 回忆)·完成」**——不是视觉设计评审,而是 UX 启发式评估(正如业界以不同方法论区分二者;若 design 是「看起来如何」,ux 则是「如何被使用」)。
- **优先调研**: 以 Nielsen 的十大可用性启发式作为「优先调研标准」——① 系统状态可见性,② 系统与现实一致(用户语言),③ 用户控制·自由(取消·撤销),④ 一致性·标准,⑤ 错误预防,⑥ 识别 vs 回忆(减轻记忆负担),⑦ 灵活性·使用效率(快捷·定制),⑧ 美观·极简设计,⑨ 帮助识别·诊断·从错误中恢复,⑩ 帮助·文档。以及与主题相关的用户流程摩擦点·中断(流失)点·易错区段,以及可用性·交互最佳实践。
- **依据强调**: 仓库依据为「文件:行 + 用户卡住的流程(在哪一步·为何)·被违反的启发式」,网络依据为可用性指南·启发式评估·UX 最佳实践(URL)。以「具体使用场景及其摩擦」而非臆测来判定,并在每条简报的 spec 中写明「被违反的启发式 / 严重度(cosmetic·minor·major·catastrophic) / 使用场景(用户想做什么、在哪里卡住) / 改进方案」(正如调试的 spec 含「复现·验证」、安全含「威胁·缓解」、逻辑含「一致性·行为保留」)。
- 若目标仓库没有「用户经过的流程/交互表面」,在报告中说明;零条 UX 简报(空数组)也是正确答案。`,
  },

  // ── UX 렌즈 «화면 포함» 추가 머리말 (UX_SCREENS_HEADMATTER) ──────────────────
  "lens.research.uxScreens": {
    ar: `## تضمين الشاشات — احكم بالاستدلالات عبر شاشات مُصيَّرة
طُلب هذا البحث UX مع «تضمين الشاشات». تلتقط استدلالات قابلية الاستخدام مشكلات أكثر حين تُحكَم بـ«شاشات مرئية فعلاً» مقارنةً بالكود·النص فقط (تفوّق التقييم متعدّد الوسائط) — لذا استخدم «الشاشات المُصيَّرة» كسند من الدرجة الأولى ما أمكن.
- **صيِّر والتقط بوسيلة المستودع «القائمة»**: لا تخترع وسيلة التقاط جديدة (تختلف التقنية·طريقة الالتقاط بين المستودعات). اقرأ \`.claude/\`·CLAUDE.md·AGENTS.md·\`scripts/\`·README لتجد بنفسك كيف «يصيّر هذا المستودع الشاشة ويحفظها كلقطة» (الموجود فقط): سكربت تحقّق/لقطة UI (محاكي·جهاز حقيقي·التقاط تطبيق المحاكي — يطبع عادةً مسار اللقطة في السطر الأخير)، كتالوج المكوّنات (نوع Storybook \`*.stories.*\`)، أو للويب خادم dev + لقطة متصفح headless. صيّر الشاشة (الشاشات) التي يمسّها الموضوع بتلك الوسيلة واحفظ اللقطات.
- **احكم بالنظر «بالعين» إلى الشاشة**: تعمل هذه الجلسة كوكيل قادر على قراءة الصور — افتح ملف اللقطة بنفسك واحكم على انتهاكات استدلالات Nielsen بمعيار تلك الشاشة (لا تستنتج من الكود بل من الشاشة «المرئية» — التباين·التباعد·الحالة·التدفّق تظهر بالتصيير).
- **سند الشاشة (evidence)**: للانتهاك المُلتقَط بالشاشة اترك مرجع الشاشة في evidence — { "kind": "screenshot", "ref": "<مسار ملف اللقطة أو اسم الشاشة>", "summary": "ما الذي في تلك الشاشة خالف أي استدلال (وإن أمكن إحداثيات معيارية x,y,w,h)" }. وبيّن في التقرير أيضاً «أي شاشة رأيت».
- **إن تعذّر الحصول على الشاشة، تراجع رشيق (يعمل حتى بغياب الشاشة)**: إن لم يكن للمستودع المستهدف سطح UI يُصيَّر (ليس هدف التقاط)·لم تجد وسيلة الالتقاط·فشل الالتقاط — قيّم الاستدلالات بالكود+الويب دون شاشة، لكن «بيّن» في التقرير «حُكم بالاستنتاج من الكود·الويب فقط لتعذّر رؤية الشاشة (قد تكون فاتت مشكلات قابلية الاستخدام التي لا تظهر إلا في الشاشة الفعلية بهذا القيد)». يجب أن ينتهي البحث دون انكسار حتى لو تعذّرت الشاشة.`,
    en: `## Screen inclusion — judge heuristics with rendered screens
This UX research was requested with «screen inclusion». Usability heuristics catch more problems when judged with «actually visible screens» than with code·text only (multimodal evaluation advantage) — so use «rendered screens» as first-class evidence whenever possible.
- **Render·capture with this repo's «existing» means**: do not invent a new capture means (stack·capture method differ per repo). Read \`.claude/\`·CLAUDE.md·AGENTS.md·\`scripts/\`·README to find for yourself how this repo «renders a screen and saves it as a screenshot» (only what exists): UI verification/screenshot scripts (simulator·real device·emulator app capture — usually printing the screenshot path on the last line), a component catalog (Storybook-like \`*.stories.*\`), or for web a dev server + headless browser screenshot. Render the screen(s) the topic touches with that means and save the screenshots.
- **Judge by looking at the screen «with your eyes»**: this session runs as an image-capable agent — open the captured screenshot file directly and judge Nielsen-heuristic violations by that screen (do not infer from code — by the «visible» screen; contrast·spacing·state·flow only become visible when rendered).
- **Screen evidence (evidence)**: for a violation caught by the screen, leave a screen reference in evidence — { "kind": "screenshot", "ref": "<screenshot file path or screen name>", "summary": "what on that screen violated which heuristic (normalized coordinates x,y,w,h if possible)" }. Also state in the report «which screens you saw».
- **Graceful fallback if you cannot get screens (works even without screens)**: if the target repo has no rendered UI surface (not a capture target)·you cannot find a capture means·capture fails — evaluate heuristics with code+web without screens, but «state» in the report «judged by code·web inference only because the screen could not be seen (usability problems that surface only on the real screen may have been missed due to this limitation)». The research must finish without breaking even if screens cannot be obtained.`,
    es: `## Inclusión de pantallas — juzga las heurísticas con pantallas renderizadas
Esta investigación de UX se solicitó con «inclusión de pantallas». Las heurísticas de usabilidad detectan más problemas cuando se juzgan con «pantallas realmente visibles» que solo con código·texto (ventaja de la evaluación multimodal) — así que usa «pantallas renderizadas» como evidencia de primera clase siempre que sea posible.
- **Renderiza·captura con los medios «existentes» de este repo**: no inventes un medio de captura nuevo (el stack·método de captura difieren por repo). Lee \`.claude/\`·CLAUDE.md·AGENTS.md·\`scripts/\`·README para encontrar por ti mismo cómo este repo «renderiza una pantalla y la guarda como captura» (solo lo que exista): scripts de verificación/captura de UI (simulador·dispositivo real·captura de app de emulador — normalmente imprimiendo la ruta de la captura en la última línea), un catálogo de componentes (tipo Storybook \`*.stories.*\`), o para web un servidor dev + captura de navegador headless. Renderiza la(s) pantalla(s) que toca el tema con ese medio y guarda las capturas.
- **Juzga mirando la pantalla «con tus ojos»**: esta sesión se ejecuta como un agente capaz de leer imágenes — abre el archivo de captura directamente y juzga las violaciones de las heurísticas de Nielsen por esa pantalla (no infieras desde el código — por la pantalla «visible»; contraste·espaciado·estado·flujo solo se hacen visibles al renderizar).
- **Evidencia de pantalla (evidence)**: para una violación captada por la pantalla, deja una referencia de pantalla en evidence — { "kind": "screenshot", "ref": "<ruta del archivo de captura o nombre de pantalla>", "summary": "qué en esa pantalla violó qué heurística (coordenadas normalizadas x,y,w,h si es posible)" }. Indica también en el informe «qué pantallas viste».
- **Fallback elegante si no puedes obtener pantallas (funciona incluso sin pantallas)**: si el repo objetivo no tiene superficie de UI renderizada (no es objetivo de captura)·no encuentras un medio de captura·la captura falla — evalúa las heurísticas con código+web sin pantallas, pero «indica» en el informe «juzgado solo por inferencia de código·web porque no se pudo ver la pantalla (pueden haberse perdido problemas de usabilidad que solo aparecen en la pantalla real por esta limitación)». La investigación debe terminar sin romperse aunque no se puedan obtener pantallas.`,
    fr: `## Inclusion d'écrans — juge les heuristiques avec des écrans rendus
Cette recherche UX a été demandée avec «inclusion d'écrans». Les heuristiques d'utilisabilité détectent plus de problèmes quand on les juge avec des «écrans réellement visibles» qu'avec du code·texte seul (avantage de l'évaluation multimodale) — alors utilise des «écrans rendus» comme preuve de première classe quand c'est possible.
- **Rends·capture avec les moyens «existants» de ce dépôt**: n'invente pas un nouveau moyen de capture (la stack·méthode de capture diffèrent selon le dépôt). Lis \`.claude/\`·CLAUDE.md·AGENTS.md·\`scripts/\`·README pour trouver toi-même comment ce dépôt «rend un écran et l'enregistre en capture» (seulement ce qui existe): scripts de vérification/capture d'UI (simulateur·appareil réel·capture d'app d'émulateur — affichant généralement le chemin de la capture sur la dernière ligne), un catalogue de composants (type Storybook \`*.stories.*\`), ou pour le web un serveur dev + capture de navigateur headless. Rends le(s) écran(s) que le sujet touche avec ce moyen et enregistre les captures.
- **Juge en regardant l'écran «avec tes yeux»**: cette session s'exécute comme un agent capable de lire des images — ouvre le fichier de capture directement et juge les violations des heuristiques de Nielsen par cet écran (n'infère pas depuis le code — par l'écran «visible»; contraste·espacement·état·flux ne deviennent visibles qu'une fois rendus).
- **Preuve d'écran (evidence)**: pour une violation captée par l'écran, laisse une référence d'écran dans evidence — { "kind": "screenshot", "ref": "<chemin du fichier de capture ou nom d'écran>", "summary": "ce qui sur cet écran a violé quelle heuristique (coordonnées normalisées x,y,w,h si possible)" }. Indique aussi dans le rapport «quels écrans tu as vus».
- **Repli gracieux si tu ne peux pas obtenir d'écrans (fonctionne même sans écrans)**: si le dépôt cible n'a pas de surface UI rendue (pas une cible de capture)·tu ne trouves pas de moyen de capture·la capture échoue — évalue les heuristiques avec code+web sans écrans, mais «indique» dans le rapport «jugé uniquement par inférence code·web car l'écran n'a pas pu être vu (des problèmes d'utilisabilité n'apparaissant que sur l'écran réel ont pu être manqués à cause de cette limite)». La recherche doit se terminer sans casser même si les écrans ne peuvent pas être obtenus.`,
    hi: `## स्क्रीन समावेश — रेंडर की गई स्क्रीन से ह्यूरिस्टिक्स आँकें
यह UX शोध «स्क्रीन समावेश» के साथ माँगा गया। उपयोगिता ह्यूरिस्टिक्स «वास्तव में दिखने वाली स्क्रीन» से आँके जाने पर केवल कोड·टेक्स्ट की तुलना में अधिक समस्याएँ पकड़ती हैं (मल्टीमॉडल मूल्यांकन की श्रेष्ठता) — इसलिए जब संभव हो «रेंडर की गई स्क्रीन» को प्रथम-श्रेणी साक्ष्य बनाएँ।
- **इस रेपो के «मौजूदा» साधन से रेंडर·कैप्चर करें**: नया कैप्चर साधन न गढ़ें (स्टैक·कैप्चर विधि हर रेपो में भिन्न)। \`.claude/\`·CLAUDE.md·AGENTS.md·\`scripts/\`·README पढ़कर स्वयं खोजें कि यह रेपो «स्क्रीन रेंडर कर स्क्रीनशॉट के रूप में कैसे सहेजता है» (केवल जो मौजूद हो): UI सत्यापन/स्क्रीनशॉट स्क्रिप्ट (सिम्युलेटर·वास्तविक डिवाइस·एमुलेटर ऐप कैप्चर — आमतौर पर अंतिम पंक्ति में स्क्रीनशॉट पथ छापता है), कंपोनेंट कैटलॉग (Storybook जैसा \`*.stories.*\`), या वेब के लिए dev सर्वर + headless ब्राउज़र स्क्रीनशॉट। विषय जिन स्क्रीन को छूता है उन्हें उस साधन से रेंडर कर स्क्रीनशॉट सहेजें।
- **स्क्रीन को «आँखों से» देखकर आँकें**: यह सत्र छवि पढ़ने में सक्षम एजेंट के रूप में चलता है — कैप्चर की गई स्क्रीनशॉट फ़ाइल सीधे खोलें, और उस स्क्रीन के आधार पर Nielsen ह्यूरिस्टिक उल्लंघन आँकें (कोड से अनुमान न लगाएँ — «दिखने वाली» स्क्रीन से; कंट्रास्ट·स्पेसिंग·स्थिति·फ़्लो रेंडर होने पर ही दिखते हैं)।
- **स्क्रीन साक्ष्य (evidence)**: स्क्रीन से पकड़े उल्लंघन के लिए evidence में स्क्रीन संदर्भ छोड़ें — { "kind": "screenshot", "ref": "<स्क्रीनशॉट फ़ाइल पथ या स्क्रीन नाम>", "summary": "उस स्क्रीन में किसने किस ह्यूरिस्टिक का उल्लंघन किया (यदि संभव हो तो सामान्यीकृत निर्देशांक x,y,w,h)" }। रिपोर्ट में भी «कौन-सी स्क्रीन देखीं» बताएँ।
- **स्क्रीन न मिले तो graceful fallback (स्क्रीन अनुपस्थिति में भी काम करे)**: यदि लक्ष्य रेपो में रेंडर होने वाली UI सतह न हो (कैप्चर लक्ष्य नहीं)·कैप्चर साधन न मिले·कैप्चर विफल हो — स्क्रीन के बिना कोड+वेब से ह्यूरिस्टिक्स आँकें, पर रिपोर्ट में «स्क्रीन न देख पाने के कारण केवल कोड·वेब अनुमान से आँका (इस सीमा से वास्तविक स्क्रीन पर ही दिखने वाली उपयोगिता समस्याएँ छूट सकती हैं)» «बताएँ»। स्क्रीन न मिलने पर भी शोध बिना टूटे समाप्त होना चाहिए।`,
    ja: `## 画面を含める — レンダリングされた画面でヒューリスティックを判定
この UX リサーチは「画面を含める」で要求された。ユーザビリティヒューリスティックは「実際に見える画面」で判定するとき、コード·テキストのみより多くの問題を捉える(マルチモーダル評価の優位) — だから可能なら「レンダリングされた画面」を一級の根拠として使え。
- **このリポジトリの「既存」手段でレンダリング·キャプチャ**: 新しいキャプチャ手段を発明するな(スタック·キャプチャ方法はリポジトリごとに異なる)。\`.claude/\`·CLAUDE.md·AGENTS.md·\`scripts/\`·README を読み、このリポジトリが「画面をレンダリングしてスクリーンショットとして残す」方法を自分で探せ(あるものだけ): UI 検証/スクリーンショットスクリプト(シミュレーター·実機·エミュレーターのアプリキャプチャ — 通常は最終行にスクリーンショットのパスを出力)、コンポーネントカタログ(Storybook 系 \`*.stories.*\`)、ウェブなら dev サーバー + ヘッドレスブラウザのスクリーンショット。主題が触れる画面をその手段でレンダリングしてスクリーンショットを残せ。
- **画面を「目で」見て判定**: このセッションは画像を読めるエージェントで動く — キャプチャしたスクリーンショットファイルを直接開き、その画面を基準に Nielsen ヒューリスティック違反を判定せよ(コードから推論せず「見える」画面で — コントラスト·余白·状態·フローはレンダリングされて初めて見える)。
- **画面の根拠 (evidence)**: 画面で捉えた違反は evidence に画面参照を残せ — { "kind": "screenshot", "ref": "<スクリーンショットのファイルパスまたは画面名>", "summary": "その画面の何がどのヒューリスティックに反したか(可能なら正規化座標 x,y,w,h)" }。報告書にも「どの画面を見たか」を明示せよ。
- **画面が得られなければ graceful fallback(画面不在でも正常動作)**: 対象リポジトリにレンダリングされる UI 表面がない(キャプチャ対象でない)·キャプチャ手段が見つからない·キャプチャが失敗する場合 — 画面なしでコード+ウェブでヒューリスティックを評価しつつ、報告書に「画面を見られず、コード·ウェブ推論のみで判定した(この制約で実画面でしか表れないユーザビリティ問題を見落とした可能性)」を「明示」せよ。画面が得られなくてもリサーチは壊れず終わらねばならない。`,
    ko: `## 화면 포함 — 렌더된 화면으로 휴리스틱 판정
이 UX 리서치는 «화면 포함» 으로 요청됐다. 사용성 휴리스틱은 «실제로 보이는 화면» 으로 판정할 때 코드·텍스트만 볼 때보다 더 많은 문제를 잡는다(멀티모달 평가 우위) — 그러니 가능하면 «렌더된 화면» 을 1급 근거로 써라.
- **이 레포의 «기존» 캡처 수단으로 렌더·캡처**: 새 캡처 수단을 발명하지 마라(레포마다 스택·캡처 방법이 다르다). \`.claude/\`·CLAUDE.md·AGENTS.md·\`scripts/\`·README 를 읽어 이 레포가 «화면을 렌더해 스크린샷으로 남기는» 방법을 스스로 찾아 써라(있는 것만): UI 검증/스크린샷 스크립트(시뮬레이터·실기기·에뮬레이터 앱 캡처 — 보통 마지막 줄에 스크린샷 경로를 출력), 컴포넌트 카탈로그(Storybook 류 \`*.stories.*\`), 웹이면 dev 서버 + 헤드리스 브라우저 스크린샷. 주제가 닿는 화면(들)을 그 수단으로 렌더해 스크린샷을 남겨라.
- **화면을 «눈으로» 보고 판정**: 이 세션은 이미지를 읽을 수 있는 에이전트로 돈다 — 캡처한 스크린샷 파일을 직접 열어, 그 화면 기준으로 Nielsen 휴리스틱 위반을 판정하라(코드에서 추론하지 말고 «보이는» 화면으로 — 대비·간격·상태·흐름은 렌더돼야 보인다).
- **화면 근거 (evidence)**: 화면으로 잡은 위반은 evidence 에 화면 참조를 남겨라 — { "kind": "screenshot", "ref": "<스크린샷 파일 경로 또는 화면명>", "summary": "그 화면의 무엇이 어떤 휴리스틱을 어겼나 (가능하면 정규화 좌표 x,y,w,h)" }. 보고서에도 «어떤 화면을 봤는지» 를 명시하라.
- **화면을 못 얻으면 graceful fallback (화면 부재 시에도 정상 동작)**: 대상 레포에 렌더되는 UI 표면이 없거나(캡처 대상 아님)·캡처 수단을 못 찾거나·캡처가 실패하면 — 화면 없이 코드+웹으로 휴리스틱을 평가하되, 보고서에 «화면을 보지 못해 코드·웹 추론으로만 판정함 (이 한계로 실제 화면에서만 드러나는 사용성 문제는 놓쳤을 수 있음)» 을 «명시» 하라. 화면을 못 얻어도 리서치는 깨지지 않고 끝나야 한다.`,
    "pt-BR": `## Inclusão de telas — julgue as heurísticas com telas renderizadas
Esta pesquisa de UX foi solicitada com «inclusão de telas». As heurísticas de usabilidade captam mais problemas quando julgadas com «telas realmente visíveis» do que só com código·texto (vantagem da avaliação multimodal) — então use «telas renderizadas» como evidência de primeira classe sempre que possível.
- **Renderize·capture com os meios «existentes» deste repo**: não invente um novo meio de captura (a stack·método de captura diferem por repo). Leia \`.claude/\`·CLAUDE.md·AGENTS.md·\`scripts/\`·README para descobrir por conta própria como este repo «renderiza uma tela e a salva como captura» (apenas o que existir): scripts de verificação/captura de UI (simulador·dispositivo real·captura de app de emulador — geralmente imprimindo o caminho da captura na última linha), um catálogo de componentes (tipo Storybook \`*.stories.*\`), ou para web um servidor dev + captura de navegador headless. Renderize a(s) tela(s) que o tema toca com esse meio e salve as capturas.
- **Julgue olhando para a tela «com seus olhos»**: esta sessão roda como um agente capaz de ler imagens — abra o arquivo de captura diretamente e julgue as violações das heurísticas de Nielsen por aquela tela (não infira a partir do código — pela tela «visível»; contraste·espaçamento·estado·fluxo só ficam visíveis quando renderizados).
- **Evidência de tela (evidence)**: para uma violação captada pela tela, deixe uma referência de tela em evidence — { "kind": "screenshot", "ref": "<caminho do arquivo de captura ou nome da tela>", "summary": "o que nessa tela violou qual heurística (coordenadas normalizadas x,y,w,h se possível)" }. Indique também no relatório «quais telas você viu».
- **Fallback gracioso se não conseguir telas (funciona mesmo sem telas)**: se o repo alvo não tiver superfície de UI renderizada (não é alvo de captura)·você não encontrar um meio de captura·a captura falhar — avalie as heurísticas com código+web sem telas, mas «indique» no relatório «julgado apenas por inferência de código·web porque a tela não pôde ser vista (problemas de usabilidade que só aparecem na tela real podem ter sido perdidos por esta limitação)». A pesquisa deve terminar sem quebrar mesmo que as telas não possam ser obtidas.`,
    ru: `## Включение экранов — оценивайте эвристики по отрисованным экранам
Это UX-исследование запрошено с «включением экранов». Эвристики юзабилити ловят больше проблем при оценке по «реально видимым экранам», чем только по коду·тексту (преимущество мультимодальной оценки) — поэтому используйте «отрисованные экраны» как доказательство первого класса, когда это возможно.
- **Отрисуйте·захватите средствами «существующими» в этом репозитории**: не изобретайте новое средство захвата (стек·метод захвата различаются по репозиториям). Прочитайте \`.claude/\`·CLAUDE.md·AGENTS.md·\`scripts/\`·README, чтобы самостоятельно найти, как этот репозиторий «отрисовывает экран и сохраняет его как скриншот» (только существующее): скрипты проверки/скриншотов UI (симулятор·реальное устройство·захват приложения эмулятора — обычно выводят путь скриншота в последней строке), каталог компонентов (вроде Storybook \`*.stories.*\`), или для веба dev-сервер + скриншот headless-браузера. Отрисуйте экран(ы), которых касается тема, этим средством и сохраните скриншоты.
- **Оценивайте, глядя на экран «своими глазами»**: эта сессия работает как агент, способный читать изображения — откройте файл скриншота напрямую и судите о нарушениях эвристик Нильсена по этому экрану (не выводите из кода — по «видимому» экрану; контраст·отступы·состояние·поток становятся видимы только при отрисовке).
- **Экранное доказательство (evidence)**: для нарушения, пойманного по экрану, оставьте экранную ссылку в evidence — { "kind": "screenshot", "ref": "<путь к файлу скриншота или имя экрана>", "summary": "что на этом экране нарушило какую эвристику (нормализованные координаты x,y,w,h при возможности)" }. Также укажите в отчёте «какие экраны вы видели».
- **Изящный откат, если не получить экраны (работает даже без экранов)**: если у целевого репозитория нет отрисовываемой поверхности UI (не объект захвата)·вы не нашли средство захвата·захват не удался — оцените эвристики по коду+вебу без экранов, но «укажите» в отчёте «оценено только по выводу из кода·веба, так как экран увидеть не удалось (проблемы юзабилити, проявляющиеся только на реальном экране, могли быть упущены из-за этого ограничения)». Исследование должно завершиться без сбоя, даже если экраны получить нельзя.`,
    "zh-Hans": `## 包含画面 — 用渲染后的画面判定启发式
本次 UX 调研以「包含画面」请求。可用性启发式以「真正可见的画面」判定时,比仅看代码·文本能捕捉更多问题(多模态评估优势)——因此尽量将「渲染后的画面」作为一级依据。
- **用本仓库「既有」手段渲染·截图**: 不要发明新的截图手段(技术栈·截图方法因仓库而异)。阅读 \`.claude/\`·CLAUDE.md·AGENTS.md·\`scripts/\`·README,自行找出本仓库「如何渲染画面并保存为截图」(仅限存在的): UI 验证/截图脚本(模拟器·真机·模拟器应用截图——通常在最后一行输出截图路径)、组件目录(Storybook 类 \`*.stories.*\`),或网页则 dev 服务器 + 无头浏览器截图。用该手段渲染主题触及的画面并保存截图。
- **用「眼睛」看画面来判定**: 本会话以可读图像的智能体运行——直接打开截取的截图文件,以该画面为准判定 Nielsen 启发式违反(不要从代码推断——以「可见」画面为准;对比度·间距·状态·流程须渲染后才可见)。
- **画面依据 (evidence)**: 对于由画面捕捉的违反,在 evidence 中留下画面引用——{ "kind": "screenshot", "ref": "<截图文件路径或画面名>", "summary": "该画面的什么违反了哪条启发式(可能时给出归一化坐标 x,y,w,h)" }。并在报告中说明「看了哪些画面」。
- **若无法获得画面则优雅降级(无画面也正常运行)**: 若目标仓库没有可渲染的 UI 表面(非截图对象)·找不到截图手段·截图失败——则在无画面情况下用代码+网页评估启发式,但在报告中「说明」「因无法看到画面,仅凭代码·网页推断判定(因此局限,可能遗漏仅在真实画面才显现的可用性问题)」。即便无法获得画面,调研也必须不崩溃地完成。`,
  },

  // ── 전문가 페르소나 (lensPersona) — 프롬프트 첫 정체성 문장 (po_brief_lens_v1) ──
  "persona.default": {
    ar: "أنت وكيل مالك المنتج (PO) لهذا المستودع.",
    en: "You are this repository's Product Owner (PO) agent.",
    es: "Eres el agente Product Owner (PO) de este repositorio.",
    fr: "Tu es l'agent Product Owner (PO) de ce dépôt.",
    hi: "आप इस रिपॉज़िटरी के Product Owner (PO) एजेंट हैं।",
    ja: "あなたはこのリポジトリのプロダクトオーナー(PO)エージェントだ。",
    ko: "너는 이 저장소의 프로덕트 오너(PO) 에이전트다.",
    "pt-BR": "Você é o agente Product Owner (PO) deste repositório.",
    ru: "Ты — агент Product Owner (PO) этого репозитория.",
    "zh-Hans": "你是本仓库的产品负责人(PO)智能体。",
  },
  "persona.design": {
    ar: "أنت «خبير التصميم» لهذا المستودع.",
    en: "You are this repository's «design expert».",
    es: "Eres el «experto en diseño» de este repositorio.",
    fr: "Tu es l'«expert design» de ce dépôt.",
    hi: "आप इस रिपॉज़िटरी के «डिज़ाइन विशेषज्ञ» हैं।",
    ja: "あなたはこのリポジトリの「デザイン専門家」だ。",
    ko: "너는 이 저장소의 «디자인 전문가» 다.",
    "pt-BR": "Você é o «especialista em design» deste repositório.",
    ru: "Ты — «эксперт по дизайну» этого репозитория.",
    "zh-Hans": "你是本仓库的「设计专家」。",
  },
  "persona.bug": {
    ar: "أنت «خبير التصحيح·الموثوقية» لهذا المستودع.",
    en: "You are this repository's «debugging·reliability expert».",
    es: "Eres el «experto en depuración·fiabilidad» de este repositorio.",
    fr: "Tu es l'«expert débogage·fiabilité» de ce dépôt.",
    hi: "आप इस रिपॉज़िटरी के «डिबगिंग·विश्वसनीयता विशेषज्ञ» हैं।",
    ja: "あなたはこのリポジトリの「デバッグ·信頼性の専門家」だ。",
    ko: "너는 이 저장소의 «디버깅·신뢰성 전문가» 다.",
    "pt-BR": "Você é o «especialista em depuração·confiabilidade» deste repositório.",
    ru: "Ты — «эксперт по отладке·надёжности» этого репозитория.",
    "zh-Hans": "你是本仓库的「调试·可靠性专家」。",
  },
  "persona.qa": {
    ar: "أنت «خبير ضمان الجودة (QA)» لهذا المستودع.",
    en: "You are this repository's «QA (quality assurance) expert».",
    es: "Eres el «experto en QA (aseguramiento de calidad)» de este repositorio.",
    fr: "Tu es l'«expert QA (assurance qualité)» de ce dépôt.",
    hi: "आप इस रिपॉज़िटरी के «QA (गुणवत्ता आश्वासन) विशेषज्ञ» हैं।",
    ja: "あなたはこのリポジトリの「QA(品質保証)の専門家」だ。",
    ko: "너는 이 저장소의 «QA(품질 보증) 전문가» 다.",
    "pt-BR": "Você é o «especialista em QA (garantia de qualidade)» deste repositório.",
    ru: "Ты — «эксперт по QA (обеспечению качества)» этого репозитория.",
    "zh-Hans": "你是本仓库的「QA(质量保证)专家」。",
  },
  "persona.security": {
    ar: "أنت «خبير الأمن» لهذا المستودع.",
    en: "You are this repository's «security expert».",
    es: "Eres el «experto en seguridad» de este repositorio.",
    fr: "Tu es l'«expert sécurité» de ce dépôt.",
    hi: "आप इस रिपॉज़िटरी के «सुरक्षा विशेषज्ञ» हैं।",
    ja: "あなたはこのリポジトリの「セキュリティの専門家」だ。",
    ko: "너는 이 저장소의 «보안 전문가» 다.",
    "pt-BR": "Você é o «especialista em segurança» deste repositório.",
    ru: "Ты — «эксперт по безопасности» этого репозитория.",
    "zh-Hans": "你是本仓库的「安全专家」。",
  },
  "persona.pm": {
    ar: "أنت «خبير التخطيط (PM/المنتج)» لهذا المستودع.",
    en: "You are this repository's «product (PM) expert».",
    es: "Eres el «experto en producto (PM)» de este repositorio.",
    fr: "Tu es l'«expert produit (PM)» de ce dépôt.",
    hi: "आप इस रिपॉज़िटरी के «उत्पाद (PM) विशेषज्ञ» हैं।",
    ja: "あなたはこのリポジトリの「企画(PM/プロダクト)の専門家」だ。",
    ko: "너는 이 저장소의 «기획(PM/제품) 전문가» 다.",
    "pt-BR": "Você é o «especialista em produto (PM)» deste repositório.",
    ru: "Ты — «эксперт по продукту (PM)» этого репозитория.",
    "zh-Hans": "你是本仓库的「产品(PM)专家」。",
  },
  "persona.marketing": {
    ar: "أنت «خبير التسويق» لهذا المستودع.",
    en: "You are this repository's «marketing expert».",
    es: "Eres el «experto en marketing» de este repositorio.",
    fr: "Tu es l'«expert marketing» de ce dépôt.",
    hi: "आप इस रिपॉज़िटरी के «मार्केटिंग विशेषज्ञ» हैं।",
    ja: "あなたはこのリポジトリの「マーケティングの専門家」だ。",
    ko: "너는 이 저장소의 «마케팅 전문가» 다.",
    "pt-BR": "Você é o «especialista em marketing» deste repositório.",
    ru: "Ты — «эксперт по маркетингу» этого репозитория.",
    "zh-Hans": "你是本仓库的「市场营销专家」。",
  },
  "persona.analytics": {
    ar: "أنت «خبير التحليلات (analytics)» لهذا المستودع.",
    en: "You are this repository's «analytics expert».",
    es: "Eres el «experto en analítica» de este repositorio.",
    fr: "Tu es l'«expert analytics» de ce dépôt.",
    hi: "आप इस रिपॉज़िटरी के «एनालिटिक्स (analytics) विशेषज्ञ» हैं।",
    ja: "あなたはこのリポジトリの「分析(analytics)の専門家」だ。",
    ko: "너는 이 저장소의 «분석(analytics) 전문가» 다.",
    "pt-BR": "Você é o «especialista em analytics» deste repositório.",
    ru: "Ты — «эксперт по аналитике» этого репозитория.",
    "zh-Hans": "你是本仓库的「分析(analytics)专家」。",
  },
  "persona.ops": {
    ar: "أنت «خبير التشغيل (ops)» لهذا المستودع.",
    en: "You are this repository's «operations (ops) expert».",
    es: "Eres el «experto en operaciones (ops)» de este repositorio.",
    fr: "Tu es l'«expert opérations (ops)» de ce dépôt.",
    hi: "आप इस रिपॉज़िटरी के «ऑपरेशंस (ops) विशेषज्ञ» हैं।",
    ja: "あなたはこのリポジトリの「運用(ops)の専門家」だ。",
    ko: "너는 이 저장소의 «운영(ops) 전문가» 다.",
    "pt-BR": "Você é o «especialista em operações (ops)» deste repositório.",
    ru: "Ты — «эксперт по эксплуатации (ops)» этого репозитория.",
    "zh-Hans": "你是本仓库的「运维(ops)专家」。",
  },
  "persona.logic": {
    ar: "أنت «خبير المنطق (المجال·الاتساق)» لهذا المستودع.",
    en: "You are this repository's «logic (domain·consistency) expert».",
    es: "Eres el «experto en lógica (dominio·consistencia)» de este repositorio.",
    fr: "Tu es l'«expert logique (domaine·cohérence)» de ce dépôt.",
    hi: "आप इस रिपॉज़िटरी के «लॉजिक (डोमेन·संगति) विशेषज्ञ» हैं।",
    ja: "あなたはこのリポジトリの「ロジック(ドメイン·整合性)の専門家」だ。",
    ko: "너는 이 저장소의 «로직(도메인·정합성) 전문가» 다.",
    "pt-BR": "Você é o «especialista em lógica (domínio·consistência)» deste repositório.",
    ru: "Ты — «эксперт по логике (домен·согласованность)» этого репозитория.",
    "zh-Hans": "你是本仓库的「逻辑(领域·一致性)专家」。",
  },
  "persona.ux": {
    ar: "أنت «خبير تجربة المستخدم (UX·قابلية الاستخدام)» لهذا المستودع.",
    en: "You are this repository's «UX (usability) expert».",
    es: "Eres el «experto en UX (usabilidad)» de este repositorio.",
    fr: "Tu es l'«expert UX (utilisabilité)» de ce dépôt.",
    hi: "आप इस रिपॉज़िटरी के «UX (उपयोगिता) विशेषज्ञ» हैं।",
    ja: "あなたはこのリポジトリの「UX(ユーザビリティ)の専門家」だ。",
    ko: "너는 이 저장소의 «UX(사용성) 전문가» 다.",
    "pt-BR": "Você é o «especialista em UX (usabilidade)» deste repositório.",
    ru: "Ты — «эксперт по UX (юзабилити)» этого репозитория.",
    "zh-Hans": "你是本仓库的「UX(可用性)专家」。",
  },

  // ── 수집 렌즈 머리말 — security/qa/pm/marketing/analytics/ops/logic/ux (po_collect_lens_v2·v3) ──
  "lens.collect.security": {
    ar: `## منظور التجميع — خبير الأمن
يُجرى هذا التجميع بمنظور خبير «الأمن». اجمع الإشارات أولاً بعين «ما الذي يُكشف وكيف يُستغل» (نفس تركيز عدسة «الأمن» في البحث — lens.ts SSOT).
- **الإشارات ذات الأولوية**: تدفقات المصادقة·التفويض، التعامل مع المفاتيح·الأسرار (الإنشاء·التخزين·التدوير·الإلغاء)، سطح التعرّض الشبكي (المنافذ المفتوحة·الربط·تشفير النقل)، تدفق بيانات الاعتماد (التخزين المحلي·النقل·الاقتران)، حدود الثقة ومقارنتها بنموذج التهديد (الافتراضات·التخفيفات·المخاطر المتبقية). انتقِ هذه الإشارة أولاً من الكود·الإعدادات·تدفق بيانات الاعتماد — الأمن إشارة كود·تدفق بيانات اعتماد فيعمل حتى دون «سطح واجهة مرئي» (daemon/CLI فقط).
- **التركيب**: قدّم «دين الأمن» (سطح التعرّض·تدفقات اعتماد/شبكة هشّة·عدم مقابلة نموذج التهديد) على اقتراح الميزات في البريفات، وضع في spec كل بريف «التهديد (ماذا·مَن) / التخفيف / التحقق (كيف نتأكد من الأمان)» (نفس صيغة spec عدسة الأمن في البحث). اكتب في ref ضمن evidence «ملف:سطر»·كوميت تظهر فيه حدود الثقة·التعامل مع الأسرار. لا «تحجب» دين الأمن تلقائياً — الحكم·الاعتماد للإنسان (يُرفع جنباً إلى جنب مع غيره في الباكلوج للاعتماد).`,
    en: `## Collection perspective — security expert
This collection runs from a «security» expert's perspective. Gather signals first through the lens of «what is exposed and how it can be exploited» (the same focus as research's «security» lens — lens.ts SSOT).
- **Priority signals**: authentication·authorization flows, key·secret handling (generation·storage·rotation·revocation), network exposure surface (open ports·binding·transport encryption), credential flow (local storage·transmission·pairing), trust boundaries and comparison to the threat model (assumptions·mitigations·residual risk). Pick these signals first from code·config·credential flows — security is a code·credential-flow signal, so it works even with no «rendered UI surface» (daemon/CLI only).
- **Synthesis**: prioritize «security debt» (exposure surface·weak credential/network flows·threat-model gaps) over feature proposals in briefs, and put in each brief's spec «threat (what·who) / mitigation / verification (how to confirm it is safe)» (the same shape as research's security-lens spec). In evidence's ref, write «file:line»·commits where trust boundaries·secret handling are visible. Do not auto-«block» security debt — judgment·approval is the human's (raise it side by side with other briefs in the backlog for approval).`,
    es: `## Perspectiva de recopilación — experto en seguridad
Esta recopilación se realiza desde la perspectiva de un experto en «seguridad». Reúne señales primero a través de la lente de «qué se expone y cómo puede explotarse» (el mismo foco que la lente «seguridad» de la investigación — lens.ts SSOT).
- **Señales prioritarias**: flujos de autenticación·autorización, manejo de claves·secretos (generación·almacenamiento·rotación·revocación), superficie de exposición de red (puertos abiertos·binding·cifrado de transporte), flujo de credenciales (almacenamiento local·transmisión·emparejamiento), límites de confianza y comparación con el modelo de amenazas (supuestos·mitigaciones·riesgo residual). Elige estas señales primero del código·config·flujos de credenciales — la seguridad es una señal de código·flujo de credenciales, así que funciona incluso sin «superficie de UI renderizada» (solo daemon/CLI).
- **Síntesis**: prioriza la «deuda de seguridad» (superficie de exposición·flujos de credenciales/red débiles·brechas del modelo de amenazas) sobre propuestas de funciones en los briefs, y pon en el spec de cada brief «amenaza (qué·quién) / mitigación / verificación (cómo confirmar que es seguro)» (la misma forma que el spec de la lente de seguridad de la investigación). En el ref de evidence, escribe «archivo:línea»·commits donde se vean límites de confianza·manejo de secretos. No «bloquees» automáticamente la deuda de seguridad — el juicio·aprobación es del humano (elévala junto a otros briefs en el backlog para aprobación).`,
    fr: `## Perspective de collecte — expert sécurité
Cette collecte se fait du point de vue d'un expert «sécurité». Rassemble les signaux d'abord à travers le prisme de «ce qui est exposé et comment cela peut être exploité» (le même focus que la lentille «sécurité» de la recherche — lens.ts SSOT).
- **Signaux prioritaires**: flux d'authentification·autorisation, gestion des clés·secrets (génération·stockage·rotation·révocation), surface d'exposition réseau (ports ouverts·binding·chiffrement de transport), flux d'identifiants (stockage local·transmission·appairage), frontières de confiance et comparaison au modèle de menaces (hypothèses·mitigations·risque résiduel). Choisis ces signaux d'abord dans le code·config·flux d'identifiants — la sécurité est un signal de code·flux d'identifiants, donc cela fonctionne même sans «surface UI rendue» (daemon/CLI seulement).
- **Synthèse**: priorise la «dette de sécurité» (surface d'exposition·flux d'identifiants/réseau faibles·lacunes du modèle de menaces) sur les propositions de fonctionnalités dans les briefs, et mets dans le spec de chaque brief «menace (quoi·qui) / mitigation / vérification (comment confirmer que c'est sûr)» (la même forme que le spec de la lentille sécurité de la recherche). Dans le ref de evidence, écris «fichier:ligne»·commits où les frontières de confiance·la gestion des secrets sont visibles. Ne «bloque» pas automatiquement la dette de sécurité — le jugement·l'approbation est à l'humain (élève-la côte à côte avec d'autres briefs dans le backlog pour approbation).`,
    hi: `## संग्रह दृष्टिकोण — सुरक्षा विशेषज्ञ
यह संग्रह «सुरक्षा» विशेषज्ञ के दृष्टिकोण से होता है। संकेतों को पहले «क्या उजागर होता है और कैसे दुरुपयोग हो सकता है» की दृष्टि से जुटाएँ (शोध की «सुरक्षा» लेंस जैसा ही फोकस — lens.ts SSOT)।
- **प्राथमिकता संकेत**: प्रमाणीकरण·प्राधिकरण प्रवाह, कुंजी·सीक्रेट हैंडलिंग (निर्माण·भंडारण·रोटेशन·निरस्तीकरण), नेटवर्क एक्सपोज़र सतह (खुले पोर्ट·बाइंडिंग·ट्रांसपोर्ट एन्क्रिप्शन), क्रेडेंशियल प्रवाह (स्थानीय भंडारण·प्रेषण·पेयरिंग), विश्वास सीमाएँ और थ्रेट मॉडल से तुलना (धारणाएँ·शमन·अवशिष्ट जोखिम)। इन संकेतों को पहले कोड·config·क्रेडेंशियल प्रवाह से चुनें — सुरक्षा कोड·क्रेडेंशियल प्रवाह संकेत है, अतः «रेंडर होने वाली UI सतह» न होने पर भी (केवल daemon/CLI) काम करती है।
- **संश्लेषण**: ब्रीफ़ में फ़ीचर प्रस्तावों से ऊपर «सुरक्षा ऋण» (एक्सपोज़र सतह·कमज़ोर क्रेडेंशियल/नेटवर्क प्रवाह·थ्रेट मॉडल की अनदेखी) को प्राथमिकता दें, और हर ब्रीफ़ के spec में «खतरा (क्या·कौन) / शमन / सत्यापन (सुरक्षा कैसे पुष्टि करें)» डालें (शोध सुरक्षा लेंस के spec जैसा ही रूप)। evidence के ref में विश्वास सीमा·सीक्रेट हैंडलिंग दिखाने वाली «फ़ाइल:लाइन»·commit लिखें। सुरक्षा ऋण को स्वतः «अवरुद्ध» न करें — निर्णय·स्वीकृति मानव का काम है (अनुमोदन हेतु बैकलॉग में अन्य ब्रीफ़ के साथ-साथ उठाएँ)।`,
    ja: `## 収集の観点 — セキュリティの専門家
この収集は「セキュリティ」専門家の観点で行う。信号をまず「何が露出し、どう悪用されうるか」の目で集めよ(リサーチの「セキュリティ」レンズと同じ焦点 — lens.ts SSOT)。
- **優先信号**: 認証·認可フロー、鍵·シークレットの扱い(生成·保存·ローテーション·失効)、ネットワーク露出面(開放ポート·バインド·転送暗号化)、資格情報フロー(ローカル保管·伝達·ペアリング)、信頼境界と脅威モデルとの対比(前提·緩和策·残存リスク)。これらの信号をコード·設定·資格情報フローから先に選べ — セキュリティはコード·資格情報フローの信号なので「レンダリングされる UI 表面」がなくても(daemon/CLI 専用)そのまま動く。
- **統合**: ブリーフでは機能提案より「セキュリティ負債」(露出面·脆弱な資格情報/ネットワークフロー·脅威モデル未対応)を優先して上げ、各ブリーフの spec に「脅威(何·誰) / 緩和策 / 検証(安全をどう確認)」を入れよ(リサーチ security レンズの spec と同型)。evidence の ref に信頼境界·シークレットの扱いが見える「ファイル:行」·コミットを書け。セキュリティ負債を自動「ブロック」するな — 判定·決裁は人の仕事だ(バックログで他のブリーフと並べて決裁を受ける)。`,
    ko: `## 수집 관점 — 보안 전문가
이 수집은 «보안» 전문가 관점으로 수행한다. 신호를 «무엇이 노출되고 어떻게 악용될 수 있는가» 의 눈으로 우선 모아라 (리서치의 «보안» 렌즈와 같은 초점 — lens.ts SSOT).
- **우선 신호**: 인증·인가 흐름, 키·시크릿 취급(생성·저장·회전·폐기), 네트워크 노출면(열린 포트·바인딩·전송 암호화), 자격증명 흐름(로컬 보관·전달·페어링), 신뢰 경계와 위협모델 대비(가정·완화책·잔여 위험). 코드·설정·자격증명 흐름에서 이 신호를 먼저 골라라 — 보안은 코드·자격증명 흐름 신호라 «렌더되는 UI 표면» 이 없어도(daemon/CLI 전용) 그대로 동작한다.
- **종합**: 기능 제안보다 «보안 부채»(노출면·취약한 자격증명/네트워크 흐름·위협모델 미대비)를 우선해 브리프로 올리고, 각 브리프 spec 에 «위협(무엇을·누가) / 완화책 / 검증(안전을 어떻게 확인)» 을 담아라 (리서치 security 렌즈의 spec 과 같은 형). evidence 의 ref 에 신뢰 경계·시크릿 취급이 보이는 «파일:라인»·커밋을 적어라. 보안 부채를 자동 «차단» 하지 마라 — 판정·결재는 사람 몫이다(같은 백로그에 다른 브리프와 나란히 올려 결재받는다).`,
    "pt-BR": `## Perspectiva de coleta — especialista em segurança
Esta coleta é feita pela perspectiva de um especialista em «segurança». Reúna sinais primeiro pela lente de «o que é exposto e como pode ser explorado» (o mesmo foco da lente «segurança» da pesquisa — lens.ts SSOT).
- **Sinais prioritários**: fluxos de autenticação·autorização, manejo de chaves·segredos (geração·armazenamento·rotação·revogação), superfície de exposição de rede (portas abertas·binding·criptografia de transporte), fluxo de credenciais (armazenamento local·transmissão·pareamento), limites de confiança e comparação com o modelo de ameaças (suposições·mitigações·risco residual). Escolha esses sinais primeiro do código·config·fluxos de credenciais — segurança é um sinal de código·fluxo de credenciais, então funciona mesmo sem «superfície de UI renderizada» (apenas daemon/CLI).
- **Síntese**: priorize a «dívida de segurança» (superfície de exposição·fluxos de credenciais/rede fracos·lacunas do modelo de ameaças) sobre propostas de recursos nos briefs, e coloque no spec de cada brief «ameaça (o quê·quem) / mitigação / verificação (como confirmar que é seguro)» (a mesma forma do spec da lente de segurança da pesquisa). No ref de evidence, escreva «arquivo:linha»·commits onde limites de confiança·manejo de segredos sejam visíveis. Não «bloqueie» automaticamente a dívida de segurança — o julgamento·aprovação é do humano (eleve-a lado a lado com outros briefs no backlog para aprovação).`,
    ru: `## Перспектива сбора — эксперт по безопасности
Этот сбор ведётся с точки зрения эксперта по «безопасности». Собирайте сигналы прежде всего через призму «что раскрывается и как это может быть использовано» (тот же фокус, что у линзы «безопасность» в исследовании — lens.ts SSOT).
- **Приоритетные сигналы**: потоки аутентификации·авторизации, обращение с ключами·секретами (создание·хранение·ротация·отзыв), поверхность сетевого раскрытия (открытые порты·привязка·шифрование передачи), поток учётных данных (локальное хранение·передача·сопряжение), границы доверия и сопоставление с моделью угроз (допущения·меры смягчения·остаточный риск). Выбирайте эти сигналы сначала из кода·конфигурации·потоков учётных данных — безопасность это сигнал кода·потока учётных данных, поэтому работает даже без «отрисовываемой поверхности UI» (только daemon/CLI).
- **Синтез**: приоритезируйте «долг безопасности» (поверхность раскрытия·слабые потоки учётных данных/сети·пробелы модели угроз) над предложениями функций в брифах, и в spec каждого брифа укажите «угроза (что·кто) / смягчение / верификация (как подтвердить безопасность)» (та же форма, что spec линзы безопасности в исследовании). В ref у evidence пишите «файл:строка»·коммиты, где видны границы доверия·обращение с секретами. Не «блокируйте» автоматически долг безопасности — суждение·одобрение за человеком (поднимайте его наряду с другими брифами в бэклоге для одобрения).`,
    "zh-Hans": `## 收集视角 — 安全专家
本次收集以「安全」专家的视角进行。先以「什么会被暴露、如何被利用」的眼光收集信号(与调研的「安全」视角同一焦点 — lens.ts SSOT)。
- **优先信号**: 认证·授权流程,密钥·密文处理(生成·存储·轮换·吊销),网络暴露面(开放端口·绑定·传输加密),凭据流(本地保存·传递·配对),信任边界及与威胁模型的对照(假设·缓解·残余风险)。先从代码·配置·凭据流中挑出这些信号——安全是代码·凭据流信号,故即便没有「可渲染的 UI 表面」(仅 daemon/CLI)也照常运作。
- **综合**: 在简报中将「安全债」(暴露面·脆弱的凭据/网络流·威胁模型未应对)置于功能提案之上,并在每条简报的 spec 中写明「威胁(什么·谁) / 缓解 / 验证(如何确认安全)」(与调研安全视角的 spec 同形)。在 evidence 的 ref 中写出可见信任边界·密文处理的「文件:行」·提交。不要自动「拦截」安全债——判定·审批是人的职责(在待办中与其他简报并列提交审批)。`,
  },
  "lens.collect.qa": {
    ar: `## منظور التجميع — خبير ضمان الجودة (QA)
يُجرى هذا التجميع بمنظور خبير «ضمان الجودة (QA)». اجمع الإشارات أولاً بعين «ماذا نتحقق وكيف نضمن الجودة» (إن كان التصحيح «لماذا يتعطّل» فالـ QA «كيف نضمن ألا يتعطّل»).
- **الإشارات ذات الأولوية**: المناطق بلا اختبار أو ضعيفته، المواضع التي يتكرّر فيها الانحدار (قضايا·مراجعات·أعطال «أُصلح ثم عاد»)، الميزات ذات معايير القبول غير الواضحة، الكود الذي لم تُختبر مساراته الحدّية·الفاشلة، فجوات بوابة الجودة. انتقِ «فجوة التحقق» من الكود·القضايا·المراجعات.
- **التركيب**: قدّم المناطق «الخطرة لعدم التحقق» على اقتراح الميزات في البريفات، وضع في spec كل بريف «معايير القبول / حالات الاختبار (طبيعي·حدّي·فشل) / طريقة تأكيد الانحدار». اكتب في ref ضمن evidence ملف:سطر·قضية·إشارة إعادة إنتاج. إن لم يوجد سطح يستحق التحقق فبريف بعدد 0 (مصفوفة فارغة) إجابة صحيحة.`,
    en: `## Collection perspective — QA (quality assurance) expert
This collection runs from a «QA (quality assurance)» expert's perspective. Gather signals first through the lens of «what to verify and how to guarantee quality» (if debugging is «why it breaks», QA is «how to guarantee it does not break»).
- **Priority signals**: areas with no or weak tests, places where regressions recur (issues·reviews·crashes' «fixed but back again»), features with unclear acceptance criteria, code whose boundary·failure paths are unverified, quality-gate gaps. Pick the «verification gap» from code·issues·reviews.
- **Synthesis**: prioritize areas «risky because unverified» over feature proposals in briefs, and put in each brief's spec «acceptance criteria / test cases (normal·boundary·failure) / how to confirm regression». In evidence's ref, write file:line·issue·reproduction signal. If there is no surface worth verifying, zero briefs (empty array) is a correct answer.`,
    es: `## Perspectiva de recopilación — experto en QA (aseguramiento de calidad)
Esta recopilación se realiza desde la perspectiva de un experto en «QA (aseguramiento de calidad)». Reúne señales primero a través de la lente de «qué verificar y cómo garantizar la calidad» (si la depuración es «por qué se rompe», QA es «cómo garantizar que no se rompa»).
- **Señales prioritarias**: áreas sin tests o con tests débiles, lugares donde recurren regresiones (issues·reseñas·fallos «arreglado pero volvió»), funciones con criterios de aceptación poco claros, código cuyos caminos límite·de fallo no están verificados, brechas de puertas de calidad. Elige la «brecha de verificación» del código·issues·reseñas.
- **Síntesis**: prioriza las áreas «riesgosas por no verificadas» sobre propuestas de funciones en los briefs, y pon en el spec de cada brief «criterios de aceptación / casos de prueba (normal·límite·fallo) / cómo confirmar la regresión». En el ref de evidence, escribe archivo:línea·issue·señal de reproducción. Si no hay superficie que valga la pena verificar, cero briefs (array vacío) es una respuesta correcta.`,
    fr: `## Perspective de collecte — expert QA (assurance qualité)
Cette collecte se fait du point de vue d'un expert «QA (assurance qualité)». Rassemble les signaux d'abord à travers le prisme de «quoi vérifier et comment garantir la qualité» (si le débogage est «pourquoi ça casse», la QA est «comment garantir que ça ne casse pas»).
- **Signaux prioritaires**: zones sans tests ou aux tests faibles, endroits où les régressions reviennent (issues·avis·plantages «corrigé mais revenu»), fonctionnalités aux critères d'acceptation flous, code dont les chemins limites·d'échec ne sont pas vérifiés, lacunes de portes qualité. Choisis la «lacune de vérification» dans le code·issues·avis.
- **Synthèse**: priorise les zones «risquées car non vérifiées» sur les propositions de fonctionnalités dans les briefs, et mets dans le spec de chaque brief «critères d'acceptation / cas de test (normal·limite·échec) / comment confirmer la régression». Dans le ref de evidence, écris fichier:ligne·issue·signal de reproduction. S'il n'y a pas de surface qui vaille la vérification, zéro brief (tableau vide) est une réponse correcte.`,
    hi: `## संग्रह दृष्टिकोण — QA (गुणवत्ता आश्वासन) विशेषज्ञ
यह संग्रह «QA (गुणवत्ता आश्वासन)» विशेषज्ञ के दृष्टिकोण से होता है। संकेतों को पहले «क्या सत्यापित करें और गुणवत्ता कैसे सुनिश्चित करें» की दृष्टि से जुटाएँ (यदि डिबगिंग «क्यों टूटता है» है, तो QA «कैसे सुनिश्चित करें कि न टूटे» है)।
- **प्राथमिकता संकेत**: बिना टेस्ट या कमज़ोर टेस्ट वाले क्षेत्र, जहाँ रिग्रेशन दोहराता है (issues·समीक्षाएँ·क्रैश का «ठीक किया फिर लौटा»), अस्पष्ट स्वीकृति मानदंड वाले फ़ीचर, जिनके सीमांत·विफलता पथ असत्यापित हैं, गुणवत्ता गेट अंतराल। कोड·issues·समीक्षाओं से «सत्यापन अंतराल» चुनें।
- **संश्लेषण**: ब्रीफ़ में फ़ीचर प्रस्तावों से ऊपर «असत्यापित होने से जोखिमपूर्ण» क्षेत्रों को प्राथमिकता दें, और हर ब्रीफ़ के spec में «स्वीकृति मानदंड / टेस्ट केस (सामान्य·सीमांत·विफलता) / रिग्रेशन कैसे पुष्टि करें» डालें। evidence के ref में फ़ाइल:लाइन·issue·पुनरुत्पादन संकेत लिखें। सत्यापन योग्य सतह न हो तो शून्य ब्रीफ़ (खाली array) सही उत्तर है।`,
    ja: `## 収集の観点 — QA(品質保証)の専門家
この収集は「QA(品質保証)」専門家の観点で行う。信号をまず「何を検証し、どう品質を保証するか」の目で集めよ(デバッグが「なぜ壊れるか」なら、QA は「壊れないことをどう保証するか」)。
- **優先信号**: テストがない·弱い領域、リグレッションが繰り返す箇所(課題·レビュー·クラッシュの「直したのにまた」)、受け入れ基準が不明確な機能、境界·失敗経路が未検証のコード、品質ゲートの空白。コード·課題·レビューから「検証の空白」を選べ。
- **統合**: ブリーフでは機能提案より「未検証ゆえに危険な」領域を優先して上げ、各ブリーフの spec に「受け入れ基準 / テストケース(正常·境界·失敗) / 回帰確認方法」を入れよ。evidence の ref にファイル:行·課題·再現信号を書け。検証する価値のある表面がなければブリーフ0件(空配列)も正解だ。`,
    ko: `## 수집 관점 — QA(품질 보증) 전문가
이 수집은 «QA(품질 보증)» 전문가 관점으로 수행한다. 신호를 «무엇을 어떻게 검증하고 품질을 보장하는가» 의 눈으로 우선 모아라 (디버깅이 «왜 깨지나» 라면 QA 는 «어떻게 깨지지 않음을 보증하나»).
- **우선 신호**: 테스트가 없거나 약한 영역, 회귀가 반복되는 자리(이슈·리뷰·크래시의 «고쳤는데 또»), 수용 기준이 불명확한 기능, 경계·실패 경로가 검증 안 된 코드, 품질 게이트 공백. 코드·이슈·리뷰에서 «검증 공백» 을 골라라.
- **종합**: 기능 제안보다 «검증되지 않아 위험한» 영역을 우선해 브리프로 올리고, 각 브리프 spec 에 «수용 기준 / 테스트 케이스(정상·경계·실패) / 회귀 확인 방법» 을 담아라. evidence 의 ref 에 파일:라인·이슈·재현 신호를 적어라. 검증할 표면이 마땅치 않으면 0건(빈 배열)도 정답이다.`,
    "pt-BR": `## Perspectiva de coleta — especialista em QA (garantia de qualidade)
Esta coleta é feita pela perspectiva de um especialista em «QA (garantia de qualidade)». Reúna sinais primeiro pela lente de «o que verificar e como garantir a qualidade» (se a depuração é «por que quebra», QA é «como garantir que não quebre»).
- **Sinais prioritários**: áreas sem testes ou com testes fracos, lugares onde regressões recorrem (issues·avaliações·crashes do «corrigido mas voltou»), recursos com critérios de aceitação pouco claros, código cujos caminhos de borda·falha não estão verificados, lacunas de portões de qualidade. Escolha a «lacuna de verificação» do código·issues·avaliações.
- **Síntese**: priorize áreas «arriscadas por não verificadas» sobre propostas de recursos nos briefs, e coloque no spec de cada brief «critérios de aceitação / casos de teste (normal·limite·falha) / como confirmar a regressão». No ref de evidence, escreva arquivo:linha·issue·sinal de reprodução. Se não houver superfície que valha a verificação, zero briefs (array vazio) é uma resposta correta.`,
    ru: `## Перспектива сбора — эксперт QA (обеспечение качества)
Этот сбор ведётся с точки зрения эксперта по «QA (обеспечению качества)». Собирайте сигналы прежде всего через призму «что проверять и как гарантировать качество» (если отладка — «почему ломается», то QA — «как гарантировать, что не сломается»).
- **Приоритетные сигналы**: области без тестов или со слабыми тестами, места повторяющихся регрессий (issue·отзывы·сбои «исправили, но вернулось»), функции с неясными критериями приёмки, код, чьи граничные·отказные пути не проверены, пробелы ворот качества. Выбирайте «пробел проверки» из кода·issue·отзывов.
- **Синтез**: приоритезируйте области, «рискованные из-за непроверенности», над предложениями функций в брифах, и в spec каждого брифа укажите «критерии приёмки / тест-кейсы (нормальный·граничный·отказ) / как подтвердить регрессию». В ref у evidence пишите файл:строка·issue·сигнал воспроизведения. Если нет поверхности, достойной проверки, ноль брифов (пустой массив) — правильный ответ.`,
    "zh-Hans": `## 收集视角 — QA(质量保证)专家
本次收集以「QA(质量保证)」专家的视角进行。先以「验证什么、如何保证质量」的眼光收集信号(若调试是「为何会坏」,QA 则是「如何保证不坏」)。
- **优先信号**: 无测试或测试薄弱的区域、回归反复出现之处(issue·评价·崩溃的「修了又犯」)、验收标准不清的功能、边界·失败路径未验证的代码、质量门空白。从代码·issue·评价中挑出「验证空白」。
- **综合**: 在简报中将「因未验证而有风险」的区域置于功能提案之上,并在每条简报的 spec 中写明「验收标准 / 测试用例(正常·边界·失败) / 如何确认回归」。在 evidence 的 ref 中写文件:行·issue·复现信号。若没有值得验证的表面,则零条简报(空数组)是正确答案。`,
  },
  "lens.collect.pm": {
    ar: `## منظور التجميع — خبير التخطيط (PM/المنتج)
يُجرى هذا التجميع بمنظور خبير «التخطيط (PM/المنتج)». اجمع الإشارات أولاً بعين «ماذا نبني أولاً ولماذا وماذا نؤجّل».
- **الإشارات ذات الأولوية**: مشكلات·احتياجات المستخدم (قضايا·مراجعات «أريد لكن لا يمكن»)، الميزات الناقصة·نصف المكتملة، الخطوة التالية التي تشير إليها وثائق خارطة الطريق·TODO، المواضع التي تحتاج مقايضة نطاق. انتقِ مشكلة المستخدم من القضايا·المراجعات·الوثائق·TODO في الكود.
- **التركيب**: اجمع الإشارات في وحدات «مشكلة المستخدم» وارفعها كبريفات أولوية، وضع في spec كل بريف «مشكلة المستخدم المحلولة / أساس الأولوية / النطاق (المُدرَج·المُستبعَد) / معيار النجاح». اكتب في ref ضمن evidence القضية·المراجعة·ملف:سطر.`,
    en: `## Collection perspective — product (PM) expert
This collection runs from a «product (PM)» expert's perspective. Gather signals first through the lens of «what to build first and why, and what to defer».
- **Priority signals**: user problems·needs (issues·reviews' «want to but can't»), unfinished·half features, the next step that roadmap docs·TODOs point to, places that need a scope trade-off. Pick the user problem from issues·reviews·docs·code TODOs.
- **Synthesis**: group signals into «user problem» units and raise them as priority briefs, and put in each brief's spec «the user problem solved / priority rationale / scope (in·out) / success criteria». In evidence's ref, write the issue·review·file:line.`,
    es: `## Perspectiva de recopilación — experto en producto (PM)
Esta recopilación se realiza desde la perspectiva de un experto en «producto (PM)». Reúne señales primero a través de la lente de «qué construir primero y por qué, y qué posponer».
- **Señales prioritarias**: problemas·necesidades del usuario (issues·reseñas del «quiero pero no puedo»), funciones inacabadas·a medias, el siguiente paso que señalan los docs de roadmap·TODOs, lugares que necesitan una compensación de alcance. Elige el problema del usuario de issues·reseñas·docs·TODOs del código.
- **Síntesis**: agrupa las señales en unidades de «problema del usuario» y elévalas como briefs de prioridad, y pon en el spec de cada brief «el problema del usuario resuelto / justificación de prioridad / alcance (dentro·fuera) / criterios de éxito». En el ref de evidence, escribe el issue·reseña·archivo:línea.`,
    fr: `## Perspective de collecte — expert produit (PM)
Cette collecte se fait du point de vue d'un expert «produit (PM)». Rassemble les signaux d'abord à travers le prisme de «quoi construire d'abord et pourquoi, et quoi reporter».
- **Signaux prioritaires**: problèmes·besoins de l'utilisateur (issues·avis du «je voudrais mais je ne peux pas»), fonctionnalités inachevées·à moitié, l'étape suivante que pointent les docs de roadmap·TODOs, endroits nécessitant un compromis de portée. Choisis le problème utilisateur dans les issues·avis·docs·TODOs du code.
- **Synthèse**: regroupe les signaux en unités de «problème utilisateur» et élève-les en briefs de priorité, et mets dans le spec de chaque brief «le problème utilisateur résolu / justification de priorité / portée (inclus·exclu) / critères de succès». Dans le ref de evidence, écris l'issue·avis·fichier:ligne.`,
    hi: `## संग्रह दृष्टिकोण — उत्पाद (PM) विशेषज्ञ
यह संग्रह «उत्पाद (PM)» विशेषज्ञ के दृष्टिकोण से होता है। संकेतों को पहले «पहले क्या और क्यों बनाएँ, और क्या टालें» की दृष्टि से जुटाएँ।
- **प्राथमिकता संकेत**: उपयोगकर्ता समस्याएँ·ज़रूरतें (issues·समीक्षाओं का «करना चाहता पर नहीं हो रहा»), अधूरी·आधी फ़ीचर, रोडमैप दस्तावेज़·TODO जो अगला कदम बताते हैं, दायरा समझौते की ज़रूरत वाले स्थान। issues·समीक्षाओं·दस्तावेज़·कोड TODO से उपयोगकर्ता समस्या चुनें।
- **संश्लेषण**: संकेतों को «उपयोगकर्ता समस्या» इकाइयों में समूहित कर प्राथमिकता ब्रीफ़ के रूप में उठाएँ, और हर ब्रीफ़ के spec में «हल की गई उपयोगकर्ता समस्या / प्राथमिकता का कारण / दायरा (अंदर·बाहर) / सफलता मानदंड» डालें। evidence के ref में issue·समीक्षा·फ़ाइल:लाइन लिखें।`,
    ja: `## 収集の観点 — 企画(PM/プロダクト)の専門家
この収集は「企画(PM/プロダクト)」専門家の観点で行う。信号をまず「何をなぜ先に作り、何を後回しにするか」の目で集めよ。
- **優先信号**: ユーザーの問題·要望(課題·レビューの「やりたいのにできない」)、未完·半端な機能、ロードマップ文書·TODO が指す次の一歩、範囲トレードオフが要る箇所。課題·レビュー·文書·コードの TODO からユーザー問題を選べ。
- **統合**: 信号を「ユーザー問題」単位でまとめ優先ブリーフに上げ、各ブリーフの spec に「解決するユーザー問題 / 優先順位の根拠 / 範囲(含む·除く) / 成功基準」を入れよ。evidence の ref に課題·レビュー·ファイル:行を書け。`,
    ko: `## 수집 관점 — 기획(PM/제품) 전문가
이 수집은 «기획(PM/제품)» 전문가 관점으로 수행한다. 신호를 «무엇을 왜 먼저 만들고 무엇을 미루나» 의 눈으로 우선 모아라.
- **우선 신호**: 사용자 문제·요구(이슈·리뷰의 «하고 싶은데 안 됨»), 미완·반쪽 기능, 로드맵 문서·TODO 가 가리키는 다음 단계, 범위 트레이드오프가 필요한 자리. 이슈·리뷰·문서·코드 TODO 에서 사용자 문제를 골라라.
- **종합**: 신호를 «사용자 문제» 단위로 묶어 우선순위 브리프로 올리고, 각 브리프 spec 에 «해결하는 사용자 문제 / 우선순위 근거 / 범위(포함·제외) / 성공 기준» 을 담아라. evidence 의 ref 에 이슈·리뷰·파일:라인을 적어라.`,
    "pt-BR": `## Perspectiva de coleta — especialista em produto (PM)
Esta coleta é feita pela perspectiva de um especialista em «produto (PM)». Reúna sinais primeiro pela lente de «o que construir primeiro e por quê, e o que adiar».
- **Sinais prioritários**: problemas·necessidades do usuário (issues·avaliações do «quero mas não consigo»), recursos inacabados·pela metade, o próximo passo que docs de roadmap·TODOs apontam, lugares que precisam de um trade-off de escopo. Escolha o problema do usuário de issues·avaliações·docs·TODOs do código.
- **Síntese**: agrupe os sinais em unidades de «problema do usuário» e eleve-os como briefs prioritários, e coloque no spec de cada brief «o problema do usuário resolvido / justificativa de prioridade / escopo (dentro·fora) / critérios de sucesso». No ref de evidence, escreva o issue·avaliação·arquivo:linha.`,
    ru: `## Перспектива сбора — эксперт по продукту (PM)
Этот сбор ведётся с точки зрения эксперта по «продукту (PM)». Собирайте сигналы прежде всего через призму «что строить первым и почему, и что отложить».
- **Приоритетные сигналы**: проблемы·потребности пользователя (issue·отзывы «хочу, но не могу»), незаконченные·половинчатые функции, следующий шаг, на который указывают документы дорожной карты·TODO, места, требующие компромисса охвата. Выбирайте проблему пользователя из issue·отзывов·документов·TODO в коде.
- **Синтез**: сгруппируйте сигналы в единицы «проблема пользователя» и поднимите их как приоритетные брифы, и в spec каждого брифа укажите «решаемая проблема пользователя / обоснование приоритета / охват (вкл·искл) / критерии успеха». В ref у evidence пишите issue·отзыв·файл:строка.`,
    "zh-Hans": `## 收集视角 — 产品(PM)专家
本次收集以「产品(PM)」专家的视角进行。先以「先做什么、为何、推迟什么」的眼光收集信号。
- **优先信号**: 用户问题·需求(issue·评价的「想做却做不到」)、未完成·半成品功能、路线图文档·TODO 指向的下一步、需要范围取舍之处。从 issue·评价·文档·代码 TODO 中挑出用户问题。
- **综合**: 将信号归并为「用户问题」单元并作为优先简报提出,并在每条简报的 spec 中写明「所解决的用户问题 / 优先级依据 / 范围(纳入·排除) / 成功标准」。在 evidence 的 ref 中写 issue·评价·文件:行。`,
  },
  "lens.collect.marketing": {
    ar: `## منظور التجميع — خبير التسويق
يُجرى هذا التجميع بمنظور خبير «التسويق». اجمع الإشارات أولاً بعين «لمن·ماذا·أين·كيف نوصل».
- **الإشارات ذات الأولوية**: النصوص·التعريف·التهيئة المرئية للمستخدم (النصوص المعروضة·README)، مراجعات·قضايا تقول إن توصيل القيمة ضعيف أو مربك، المواضع التي لا يظهر فيها التموضع·التمايز. انتقِ سطح «الكلمات» من النصوص المعروضة·الوثائق·المراجعات.
- **التركيب**: اجمع الإشارات كـ«فرصة رسالة/تموضع» وارفعها كبريفات، وضع في spec كل بريف «الجمهور / الرسالة الأساسية / التموضع (التمايز) / القناة·مسار التحويل». اكتب في ref ضمن evidence ملف:سطر·مراجعة·وثيقة. إن لم يوجد سطح تسويقي مناسب فبريف بعدد 0 (مصفوفة فارغة) إجابة صحيحة.`,
    en: `## Collection perspective — marketing expert
This collection runs from a «marketing» expert's perspective. Gather signals first through the lens of «to whom·what·where·how to convey».
- **Priority signals**: user-facing copy·intro·onboarding text (user-facing strings·README), reviews·issues saying value delivery is weak or confusing, places where positioning·differentiation does not show. Pick the «words» surface from user-facing strings·docs·reviews.
- **Synthesis**: group signals as a «message/positioning opportunity» and raise them as briefs, and put in each brief's spec «target / core message / positioning (differentiation) / channel·conversion path». In evidence's ref, write file:line·review·doc. If there is no fitting marketing surface, zero briefs (empty array) is a correct answer.`,
    es: `## Perspectiva de recopilación — experto en marketing
Esta recopilación se realiza desde la perspectiva de un experto en «marketing». Reúne señales primero a través de la lente de «a quién·qué·dónde·cómo transmitir».
- **Señales prioritarias**: copy·intro·texto de onboarding visible al usuario (cadenas visibles·README), reseñas·issues que dicen que la entrega de valor es débil o confusa, lugares donde el posicionamiento·diferenciación no se muestra. Elige la superficie de «palabras» de las cadenas visibles·docs·reseñas.
- **Síntesis**: agrupa las señales como una «oportunidad de mensaje/posicionamiento» y elévalas como briefs, y pon en el spec de cada brief «target / mensaje central / posicionamiento (diferenciación) / canal·ruta de conversión». En el ref de evidence, escribe archivo:línea·reseña·doc. Si no hay superficie de marketing adecuada, cero briefs (array vacío) es una respuesta correcta.`,
    fr: `## Perspective de collecte — expert marketing
Cette collecte se fait du point de vue d'un expert «marketing». Rassemble les signaux d'abord à travers le prisme de «à qui·quoi·où·comment transmettre».
- **Signaux prioritaires**: copy·intro·texte d'onboarding visible par l'utilisateur (chaînes visibles·README), avis·issues disant que la transmission de valeur est faible ou confuse, endroits où le positionnement·la différenciation ne ressort pas. Choisis la surface des «mots» dans les chaînes visibles·docs·avis.
- **Synthèse**: regroupe les signaux comme une «opportunité de message/positionnement» et élève-les en briefs, et mets dans le spec de chaque brief «cible / message central / positionnement (différenciation) / canal·parcours de conversion». Dans le ref de evidence, écris fichier:ligne·avis·doc. S'il n'y a pas de surface marketing adaptée, zéro brief (tableau vide) est une réponse correcte.`,
    hi: `## संग्रह दृष्टिकोण — मार्केटिंग विशेषज्ञ
यह संग्रह «मार्केटिंग» विशेषज्ञ के दृष्टिकोण से होता है। संकेतों को पहले «किसे·क्या·कहाँ·कैसे पहुँचाएँ» की दृष्टि से जुटाएँ।
- **प्राथमिकता संकेत**: उपयोगकर्ता-दृश्य copy·परिचय·ऑनबोर्डिंग टेक्स्ट (दिखने वाले स्ट्रिंग्स·README), मूल्य-प्रेषण कमज़ोर या भ्रामक बताने वाली समीक्षाएँ·issues, जहाँ पोज़िशनिंग·विभेदन नहीं दिखता। दिखने वाले स्ट्रिंग्स·दस्तावेज़·समीक्षाओं से «शब्दों» की सतह चुनें।
- **संश्लेषण**: संकेतों को «संदेश/पोज़िशनिंग अवसर» के रूप में समूहित कर ब्रीफ़ बनाएँ, और हर ब्रीफ़ के spec में «टार्गेट / मूल संदेश / पोज़िशनिंग (विभेदन) / चैनल·रूपांतरण पथ» डालें। evidence के ref में फ़ाइल:लाइन·समीक्षा·दस्तावेज़ लिखें। उपयुक्त मार्केटिंग सतह न हो तो शून्य ब्रीफ़ (खाली array) सही उत्तर है।`,
    ja: `## 収集の観点 — マーケティングの専門家
この収集は「マーケティング」専門家の観点で行う。信号をまず「誰に·何を·どこで·どう伝えるか」の目で集めよ。
- **優先信号**: ユーザーに見えるコピー·紹介·オンボーディング文言(表示文字列·README)、価値伝達が弱い·紛らわしいというレビュー·課題、ポジショニング·差別化が表れていない箇所。表示文字列·文書·レビューから「言葉」の表面を選べ。
- **統合**: 信号を「メッセージ/ポジショニングの機会」としてまとめブリーフに上げ、各ブリーフの spec に「ターゲット / 中核メッセージ / ポジショニング(差別化) / チャネル·転換経路」を入れよ。evidence の ref にファイル:行·レビュー·文書を書け。適したマーケティング表面がなければブリーフ0件(空配列)も正解だ。`,
    ko: `## 수집 관점 — 마케팅 전문가
이 수집은 «마케팅» 전문가 관점으로 수행한다. 신호를 «누구에게·무엇을·어디서 어떻게 전하나» 의 눈으로 우선 모아라.
- **우선 신호**: 사용자에게 보이는 카피·소개·온보딩 문구(노출 문자열·README), 가치 전달이 약하거나 헷갈린다는 리뷰·이슈, 포지셔닝·차별점이 안 드러나는 자리. 노출 문자열·문서·리뷰에서 «말» 의 표면을 골라라.
- **종합**: 신호를 «메시지/포지셔닝 기회» 로 묶어 브리프로 올리고, 각 브리프 spec 에 «타깃 / 핵심 메시지 / 포지셔닝(차별점) / 채널·전환 경로» 를 담아라. evidence 의 ref 에 파일:라인·리뷰·문서를 적어라. 마케팅 표면이 마땅치 않으면 0건(빈 배열)도 정답이다.`,
    "pt-BR": `## Perspectiva de coleta — especialista em marketing
Esta coleta é feita pela perspectiva de um especialista em «marketing». Reúna sinais primeiro pela lente de «para quem·o quê·onde·como transmitir».
- **Sinais prioritários**: copy·introdução·texto de onboarding visível ao usuário (strings visíveis·README), avaliações·issues dizendo que a entrega de valor é fraca ou confusa, lugares onde o posicionamento·diferenciação não aparece. Escolha a superfície de «palavras» das strings visíveis·docs·avaliações.
- **Síntese**: agrupe os sinais como uma «oportunidade de mensagem/posicionamento» e eleve-os como briefs, e coloque no spec de cada brief «público / mensagem central / posicionamento (diferenciação) / canal·caminho de conversão». No ref de evidence, escreva arquivo:linha·avaliação·doc. Se não houver superfície de marketing adequada, zero briefs (array vazio) é uma resposta correta.`,
    ru: `## Перспектива сбора — эксперт по маркетингу
Этот сбор ведётся с точки зрения эксперта по «маркетингу». Собирайте сигналы прежде всего через призму «кому·что·где·как донести».
- **Приоритетные сигналы**: видимый пользователю текст·вступление·онбординг (видимые строки·README), отзывы·issue о слабой или путаной передаче ценности, места, где не видно позиционирования·дифференциации. Выбирайте поверхность «слов» из видимых строк·документов·отзывов.
- **Синтез**: сгруппируйте сигналы как «возможность сообщения/позиционирования» и поднимите их как брифы, и в spec каждого брифа укажите «аудитория / ключевое сообщение / позиционирование (дифференциация) / канал·путь конверсии». В ref у evidence пишите файл:строка·отзыв·документ. Если подходящей маркетинговой поверхности нет, ноль брифов (пустой массив) — правильный ответ.`,
    "zh-Hans": `## 收集视角 — 市场营销专家
本次收集以「市场营销」专家的视角进行。先以「向谁·传达什么·在哪里·如何传达」的眼光收集信号。
- **优先信号**: 用户可见的文案·介绍·引导文案(可见字符串·README)、评价·issue 称价值传达薄弱或令人困惑、定位·差异化未显现之处。从可见字符串·文档·评价中挑出「文字」表面。
- **综合**: 将信号归并为「信息/定位机会」并作为简报提出,并在每条简报的 spec 中写明「目标 / 核心信息 / 定位(差异化) / 渠道·转化路径」。在 evidence 的 ref 中写文件:行·评价·文档。若没有合适的营销表面,则零条简报(空数组)是正确答案。`,
  },
  "lens.collect.analytics": {
    ar: `## منظور التجميع — خبير التحليلات (analytics)
يُجرى هذا التجميع بمنظور خبير «التحليلات (analytics)». اجمع الإشارات أولاً بعين «ماذا نقيس وماذا نقرأ من الأرقام».
- **الإشارات ذات الأولوية**: هل عُرّفت/قِيست المقاييس·القمع الأساسية، فجوات القياس (مواضع بلا نقطة قياس في الكود)، ميزات صُنعت «دون معرفة الأثر»، تدفقات منخفضة القابلية للقياس. انتقِ فجوة القياس من الكود (grep)·الوثائق·القضايا.
- **التركيب**: اجمع الإشارات كـ«فرصة قياس/أدوات قياس» وارفعها كبريفات، وضع في spec كل بريف «المقياس المُراد قياسه / طريقة القياس (الأحداث) / معيار النجاح (قيمة·اتجاه الهدف) / طريقة التحليل (القمع·الفئة)». اكتب في ref ضمن evidence ملف:سطر·قضية. إن لم يوجد سطح يُقاس فبريف بعدد 0 (مصفوفة فارغة) إجابة صحيحة.`,
    en: `## Collection perspective — analytics expert
This collection runs from an «analytics» expert's perspective. Gather signals first through the lens of «what to measure and what to read from the numbers».
- **Priority signals**: whether core metrics·funnels are defined/instrumented, instrumentation gaps (places in code with no measurement point), features made «without knowing the effect», flows with low measurability. Pick the instrumentation gap from code (grep)·docs·issues.
- **Synthesis**: group signals as a «measurement/instrumentation opportunity» and raise them as briefs, and put in each brief's spec «the metric to measure / instrumentation method (events) / success criteria (target value·direction) / analysis (funnel·cohort) method». In evidence's ref, write file:line·issue. If there is no surface to measure, zero briefs (empty array) is a correct answer.`,
    es: `## Perspectiva de recopilación — experto en analítica
Esta recopilación se realiza desde la perspectiva de un experto en «analítica». Reúne señales primero a través de la lente de «qué medir y qué leer de los números».
- **Señales prioritarias**: si las métricas·embudos centrales están definidas/instrumentadas, brechas de instrumentación (lugares en el código sin punto de medición), funciones hechas «sin conocer el efecto», flujos con baja medibilidad. Elige la brecha de instrumentación del código (grep)·docs·issues.
- **Síntesis**: agrupa las señales como una «oportunidad de medición/instrumentación» y elévalas como briefs, y pon en el spec de cada brief «la métrica a medir / método de instrumentación (eventos) / criterios de éxito (valor·dirección objetivo) / método de análisis (embudo·cohorte)». En el ref de evidence, escribe archivo:línea·issue. Si no hay superficie que medir, cero briefs (array vacío) es una respuesta correcta.`,
    fr: `## Perspective de collecte — expert analytics
Cette collecte se fait du point de vue d'un expert «analytics». Rassemble les signaux d'abord à travers le prisme de «quoi mesurer et quoi lire des chiffres».
- **Signaux prioritaires**: si les métriques·entonnoirs centraux sont définis/instrumentés, les lacunes d'instrumentation (endroits du code sans point de mesure), les fonctionnalités faites «sans connaître l'effet», les flux à faible mesurabilité. Choisis la lacune d'instrumentation dans le code (grep)·docs·issues.
- **Synthèse**: regroupe les signaux comme une «opportunité de mesure/instrumentation» et élève-les en briefs, et mets dans le spec de chaque brief «la métrique à mesurer / méthode d'instrumentation (événements) / critères de succès (valeur·direction cible) / méthode d'analyse (entonnoir·cohorte)». Dans le ref de evidence, écris fichier:ligne·issue. S'il n'y a pas de surface à mesurer, zéro brief (tableau vide) est une réponse correcte.`,
    hi: `## संग्रह दृष्टिकोण — एनालिटिक्स (analytics) विशेषज्ञ
यह संग्रह «एनालिटिक्स (analytics)» विशेषज्ञ के दृष्टिकोण से होता है। संकेतों को पहले «क्या मापें और संख्याओं से क्या पढ़ें» की दृष्टि से जुटाएँ।
- **प्राथमिकता संकेत**: मूल मेट्रिक·फ़नल परिभाषित/इंस्ट्रुमेंटेड हैं या नहीं, इंस्ट्रुमेंटेशन अंतराल (कोड में बिना माप-बिंदु वाले स्थान), «प्रभाव जाने बिना» बनी फ़ीचर, कम मापन-योग्यता वाले प्रवाह। कोड (grep)·दस्तावेज़·issues से इंस्ट्रुमेंटेशन अंतराल चुनें।
- **संश्लेषण**: संकेतों को «मापन/इंस्ट्रुमेंटेशन अवसर» के रूप में समूहित कर ब्रीफ़ बनाएँ, और हर ब्रीफ़ के spec में «मापी जाने वाली मेट्रिक / इंस्ट्रुमेंटेशन विधि (इवेंट) / सफलता मानदंड (लक्ष्य मान·दिशा) / विश्लेषण (फ़नल·कोहोर्ट) विधि» डालें। evidence के ref में फ़ाइल:लाइन·issue लिखें। मापने योग्य सतह न हो तो शून्य ब्रीफ़ (खाली array) सही उत्तर है।`,
    ja: `## 収集の観点 — 分析(analytics)の専門家
この収集は「分析(analytics)」専門家の観点で行う。信号をまず「何を測り、その数字から何を読むか」の目で集めよ。
- **優先信号**: 中核指標·ファネルが定義/計測されているか、計測の空白(コードに測定点がない箇所)、「効果を知らずに」作られた機能、測定可能性の低いフロー。コード(grep)·文書·課題から計測の空白を選べ。
- **統合**: 信号を「測定·計測の機会」としてまとめブリーフに上げ、各ブリーフの spec に「測る指標 / 計測方法(イベント) / 成功基準(目標値·方向) / 分析(ファネル·コホート)方法」を入れよ。evidence の ref にファイル:行·課題を書け。測る表面がなければブリーフ0件(空配列)も正解だ。`,
    ko: `## 수집 관점 — 분석(analytics) 전문가
이 수집은 «분석(analytics)» 전문가 관점으로 수행한다. 신호를 «무엇을 측정하고 그 숫자에서 무엇을 읽나» 의 눈으로 우선 모아라.
- **우선 신호**: 핵심 지표·퍼널이 정의/계측됐는지, 이벤트·트래킹의 공백(코드에 측정 지점이 없는 자리), 「효과를 모른 채」 만들어진 기능, 측정 가능성이 낮은 흐름. 코드(grep)·문서·이슈에서 계측 공백을 골라라.
- **종합**: 신호를 «측정·계측 기회» 로 묶어 브리프로 올리고, 각 브리프 spec 에 «측정할 지표 / 계측 방법(이벤트) / 성공 기준(목표 수치·방향) / 분석(퍼널·코호트) 방법» 을 담아라. evidence 의 ref 에 파일:라인·이슈를 적어라. 측정할 표면이 마땅치 않으면 0건(빈 배열)도 정답이다.`,
    "pt-BR": `## Perspectiva de coleta — especialista em analytics
Esta coleta é feita pela perspectiva de um especialista em «analytics». Reúna sinais primeiro pela lente de «o que medir e o que ler dos números».
- **Sinais prioritários**: se métricas·funis centrais estão definidos/instrumentados, lacunas de instrumentação (lugares no código sem ponto de medição), recursos feitos «sem conhecer o efeito», fluxos com baixa mensurabilidade. Escolha a lacuna de instrumentação do código (grep)·docs·issues.
- **Síntese**: agrupe os sinais como uma «oportunidade de medição/instrumentação» e eleve-os como briefs, e coloque no spec de cada brief «a métrica a medir / método de instrumentação (eventos) / critérios de sucesso (valor·direção alvo) / método de análise (funil·coorte)». No ref de evidence, escreva arquivo:linha·issue. Se não houver superfície a medir, zero briefs (array vazio) é uma resposta correta.`,
    ru: `## Перспектива сбора — эксперт по аналитике
Этот сбор ведётся с точки зрения эксперта по «аналитике». Собирайте сигналы прежде всего через призму «что измерять и что читать из цифр».
- **Приоритетные сигналы**: определены/инструментированы ли ключевые метрики·воронки, пробелы инструментирования (места в коде без точки измерения), функции, сделанные «без знания эффекта», потоки с низкой измеримостью. Выбирайте пробел инструментирования из кода (grep)·документов·issue.
- **Синтез**: сгруппируйте сигналы как «возможность измерения/инструментирования» и поднимите их как брифы, и в spec каждого брифа укажите «измеряемая метрика / метод инструментирования (события) / критерии успеха (целевое значение·направление) / метод анализа (воронка·когорта)». В ref у evidence пишите файл:строка·issue. Если поверхности для измерения нет, ноль брифов (пустой массив) — правильный ответ.`,
    "zh-Hans": `## 收集视角 — 分析(analytics)专家
本次收集以「分析(analytics)」专家的视角进行。先以「测量什么、从数字中读出什么」的眼光收集信号。
- **优先信号**: 核心指标·漏斗是否已定义/埋点、埋点空白(代码中无测量点之处)、「不知效果」就做的功能、可测量性低的流程。从代码(grep)·文档·issue 中挑出埋点空白。
- **综合**: 将信号归并为「测量/埋点机会」并作为简报提出,并在每条简报的 spec 中写明「要测量的指标 / 埋点方法(事件) / 成功标准(目标数值·方向) / 分析(漏斗·群组)方法」。在 evidence 的 ref 中写文件:行·issue。若没有可测量的表面,则零条简报(空数组)是正确答案。`,
  },
  "lens.collect.ops": {
    ar: `## منظور التجميع — خبير التشغيل (ops)
يُجرى هذا التجميع بمنظور خبير «التشغيل (ops)». اجمع الإشارات أولاً بعين «كيف ننشر ونشغّل ونبقيه مستقراً ورخيصاً».
- **الإشارات ذات الأولوية**: مسار النشر·الإصدار (سكربتات البناء·الطرح·التراجع·CI)، الموثوقية (أنماط الفشل·الاسترداد·المراقبة/التنبيه)، الإجراءات اليدوية (مجال الأتمتة)، التكلفة·السعة·التوسّع. انتقِ إشارة التشغيل من السكربتات·الإعدادات·الوثائق·القضايا·الأعطال.
- **التركيب**: اجمع الإشارات كـ«فرصة تشغيل·موثوقية» وارفعها كبريفات، وضع في spec كل بريف «طريقة النشر·التراجع / الموثوقية (أنماط الفشل·المراقبة·الاسترداد) / أثر التكلفة·التوسّع». اكتب في ref ضمن evidence ملف:سطر·قضية. إن لم يوجد سطح تشغيلي مناسب فبريف بعدد 0 (مصفوفة فارغة) إجابة صحيحة.`,
    en: `## Collection perspective — operations (ops) expert
This collection runs from an «operations (ops)» expert's perspective. Gather signals first through the lens of «how to deploy·operate and keep it stable·cheap».
- **Priority signals**: deploy·release path (build·rollout·rollback scripts·CI), reliability (failure modes·recovery·monitoring/alerting), manual procedures (room for automation), cost·capacity·scaling. Pick the ops signal from scripts·config·docs·issues·crashes.
- **Synthesis**: group signals as an «ops·reliability opportunity» and raise them as briefs, and put in each brief's spec «deploy·rollback method / reliability (failure modes·monitoring·recovery) / cost·scaling impact». In evidence's ref, write file:line·issue. If there is no fitting ops surface, zero briefs (empty array) is a correct answer.`,
    es: `## Perspectiva de recopilación — experto en operaciones (ops)
Esta recopilación se realiza desde la perspectiva de un experto en «operaciones (ops)». Reúne señales primero a través de la lente de «cómo desplegar·operar y mantenerlo estable·barato».
- **Señales prioritarias**: ruta de despliegue·release (scripts de build·rollout·rollback·CI), fiabilidad (modos de fallo·recuperación·monitoreo/alertas), procedimientos manuales (margen de automatización), coste·capacidad·escalado. Elige la señal de ops de scripts·config·docs·issues·fallos.
- **Síntesis**: agrupa las señales como una «oportunidad de ops·fiabilidad» y elévalas como briefs, y pon en el spec de cada brief «método de despliegue·rollback / fiabilidad (modos de fallo·monitoreo·recuperación) / impacto de coste·escalado». En el ref de evidence, escribe archivo:línea·issue. Si no hay superficie de ops adecuada, cero briefs (array vacío) es una respuesta correcta.`,
    fr: `## Perspective de collecte — expert opérations (ops)
Cette collecte se fait du point de vue d'un expert «opérations (ops)». Rassemble les signaux d'abord à travers le prisme de «comment déployer·exploiter et le garder stable·peu coûteux».
- **Signaux prioritaires**: chemin de déploiement·release (scripts de build·rollout·rollback·CI), fiabilité (modes de défaillance·récupération·monitoring/alerting), procédures manuelles (marge d'automatisation), coût·capacité·scalabilité. Choisis le signal ops dans les scripts·config·docs·issues·plantages.
- **Synthèse**: regroupe les signaux comme une «opportunité ops·fiabilité» et élève-les en briefs, et mets dans le spec de chaque brief «méthode de déploiement·rollback / fiabilité (modes de défaillance·monitoring·récupération) / impact coût·montée en charge». Dans le ref de evidence, écris fichier:ligne·issue. S'il n'y a pas de surface ops adaptée, zéro brief (tableau vide) est une réponse correcte.`,
    hi: `## संग्रह दृष्टिकोण — ऑपरेशंस (ops) विशेषज्ञ
यह संग्रह «ऑपरेशंस (ops)» विशेषज्ञ के दृष्टिकोण से होता है। संकेतों को पहले «कैसे तैनात·संचालित करें और इसे स्थिर·सस्ता रखें» की दृष्टि से जुटाएँ।
- **प्राथमिकता संकेत**: तैनाती·रिलीज़ पथ (बिल्ड·रोलआउट·रोलबैक स्क्रिप्ट·CI), विश्वसनीयता (विफलता मोड·पुनर्प्राप्ति·निगरानी/अलर्ट), मैनुअल प्रक्रियाएँ (स्वचालन गुंजाइश), लागत·क्षमता·स्केलिंग। स्क्रिप्ट·config·दस्तावेज़·issues·क्रैश से ops संकेत चुनें।
- **संश्लेषण**: संकेतों को «ops·विश्वसनीयता अवसर» के रूप में समूहित कर ब्रीफ़ बनाएँ, और हर ब्रीफ़ के spec में «तैनाती·रोलबैक विधि / विश्वसनीयता (विफलता मोड·निगरानी·पुनर्प्राप्ति) / लागत·स्केलिंग प्रभाव» डालें। evidence के ref में फ़ाइल:लाइन·issue लिखें। उपयुक्त ops सतह न हो तो शून्य ब्रीफ़ (खाली array) सही उत्तर है।`,
    ja: `## 収集の観点 — 運用(ops)の専門家
この収集は「運用(ops)」専門家の観点で行う。信号をまず「どうデプロイ·運用し、安定·安価に保つか」の目で集めよ。
- **優先信号**: デプロイ·リリース経路(ビルド·ロールアウト·ロールバックのスクリプト·CI)、信頼性(障害モード·復旧·監視/アラート)、手動手順(自動化の余地)、コスト·容量·スケール。スクリプト·設定·文書·課題·クラッシュから運用信号を選べ。
- **統合**: 信号を「運用·信頼性の機会」としてまとめブリーフに上げ、各ブリーフの spec に「デプロイ·ロールバック方法 / 信頼性(障害モード·監視·復旧) / コスト·スケール影響」を入れよ。evidence の ref にファイル:行·課題を書け。適した運用表面がなければブリーフ0件(空配列)も正解だ。`,
    ko: `## 수집 관점 — 운영(ops) 전문가
이 수집은 «운영(ops)» 전문가 관점으로 수행한다. 신호를 «어떻게 배포·운영하고 안정적으로·싸게 유지하나» 의 눈으로 우선 모아라.
- **우선 신호**: 배포·릴리스 경로(빌드·롤아웃·롤백 스크립트·CI), 신뢰성(장애 모드·복구·모니터링/알림), 수동 절차(자동화 여지), 비용·용량·확장. 스크립트·설정·문서·이슈·크래시에서 운영 신호를 골라라.
- **종합**: 신호를 «운영·신뢰성 기회» 로 묶어 브리프로 올리고, 각 브리프 spec 에 «배포·롤백 방법 / 신뢰성(장애 모드·모니터링·복구) / 비용·확장 영향» 을 담아라. evidence 의 ref 에 파일:라인·이슈를 적어라. 운영 표면이 마땅치 않으면 0건(빈 배열)도 정답이다.`,
    "pt-BR": `## Perspectiva de coleta — especialista em operações (ops)
Esta coleta é feita pela perspectiva de um especialista em «operações (ops)». Reúna sinais primeiro pela lente de «como implantar·operar e mantê-lo estável·barato».
- **Sinais prioritários**: caminho de deploy·release (scripts de build·rollout·rollback·CI), confiabilidade (modos de falha·recuperação·monitoramento/alertas), procedimentos manuais (espaço para automação), custo·capacidade·escala. Escolha o sinal de ops de scripts·config·docs·issues·crashes.
- **Síntese**: agrupe os sinais como uma «oportunidade de ops·confiabilidade» e eleve-os como briefs, e coloque no spec de cada brief «método de deploy·rollback / confiabilidade (modos de falha·monitoramento·recuperação) / impacto de custo·escala». No ref de evidence, escreva arquivo:linha·issue. Se não houver superfície de ops adequada, zero briefs (array vazio) é uma resposta correta.`,
    ru: `## Перспектива сбора — эксперт по эксплуатации (ops)
Этот сбор ведётся с точки зрения эксперта по «эксплуатации (ops)». Собирайте сигналы прежде всего через призму «как развёртывать·эксплуатировать и держать стабильным·дешёвым».
- **Приоритетные сигналы**: путь развёртывания·релиза (скрипты сборки·раскатки·отката·CI), надёжность (режимы отказа·восстановление·мониторинг/оповещения), ручные процедуры (потенциал автоматизации), стоимость·ёмкость·масштабирование. Выбирайте сигнал ops из скриптов·конфигурации·документов·issue·сбоев.
- **Синтез**: сгруппируйте сигналы как «возможность ops·надёжности» и поднимите их как брифы, и в spec каждого брифа укажите «метод развёртывания·отката / надёжность (режимы отказа·мониторинг·восстановление) / влияние на стоимость·масштабирование». В ref у evidence пишите файл:строка·issue. Если подходящей поверхности ops нет, ноль брифов (пустой массив) — правильный ответ.`,
    "zh-Hans": `## 收集视角 — 运维(ops)专家
本次收集以「运维(ops)」专家的视角进行。先以「如何部署·运行并保持稳定·低成本」的眼光收集信号。
- **优先信号**: 部署·发布路径(构建·灰度·回滚脚本·CI)、可靠性(故障模式·恢复·监控/告警)、手动流程(自动化空间)、成本·容量·扩展。从脚本·配置·文档·issue·崩溃中挑出运维信号。
- **综合**: 将信号归并为「运维·可靠性机会」并作为简报提出,并在每条简报的 spec 中写明「部署·回滚方法 / 可靠性(故障模式·监控·恢复) / 成本·扩展影响」。在 evidence 的 ref 中写文件:行·issue。若没有合适的运维表面,则零条简报(空数组)是正确答案。`,
  },
  "lens.collect.logic": {
    ar: `## منظور التجميع — خبير المنطق (المجال·الاتساق)
يُجرى هذا التجميع بمنظور خبير «المنطق (المجال·الاتساق)». اجمع الإشارات أولاً بعين «هل يتوافق منطق العمل القائم مع قواعد المجال وهل يمكن جعله أبسط·أوضح» (ليس خطأً بل الصحة·البساطة·قابلية الصيانة — يُحفظ السلوك).
- **الإشارات ذات الأولوية**: هل تُفرَض في الكود اتساق آلة الحالة·status·دورة الحياة وثوابتها، تكرار القاعدة نفسها (الانجراف)، الكود الميت·آثار تثير إعادة الاقتراح، التعقيد المفرط·عدم الوضوح. انتقِ إشارة اتساق المجال من الكود (grep)·الوثائق.
- **التركيب**: اجمع الإشارات كـ«فرصة اتساق·تبسيط» وارفعها كبريفات لكن لا ترفع «تحسيناً» لا يمكن التحقق من حفظه للسلوك. ضع في spec كل بريف «المنطق·الثابت الحالي / مشكلة الاتساق·التكرار·التعقيد / شكل أبسط·أكثر اتساقاً (حفظ السلوك) / طريقة التحقق من حفظ السلوك / blast-radius». اكتب في ref ضمن evidence ملف:سطر. إن كان المنطق المجالي القابل لتقييم الاتساق نادراً فبريف بعدد 0 (مصفوفة فارغة) إجابة صحيحة.`,
    en: `## Collection perspective — logic (domain·consistency) expert
This collection runs from a «logic (domain·consistency)» expert's perspective. Gather signals first through the lens of «does the existing business logic match domain rules, and can it be made simpler·clearer» (not a bug, but correctness·simplicity·maintainability — behavior preserved).
- **Priority signals**: whether the consistency of state machines·status·lifecycles and their invariants are enforced in code, duplication of the same rule (drift), dead code·traces that trigger re-proposals, over-complexity·obscurity. Pick the domain-consistency signal from code (grep)·docs.
- **Synthesis**: group signals as a «consistency·simplification opportunity» and raise them as briefs, but do not raise an «improvement» whose behavior preservation cannot be verified. Put in each brief's spec «current logic·invariant / consistency·duplication·complexity problem / a simpler·more consistent form (behavior-preserving) / behavior-preservation verification method / blast-radius». In evidence's ref, write file:line. If there is almost no domain logic whose consistency can be judged, zero briefs (empty array) is a correct answer.`,
    es: `## Perspectiva de recopilación — experto en lógica (dominio·consistencia)
Esta recopilación se realiza desde la perspectiva de un experto en «lógica (dominio·consistencia)». Reúne señales primero a través de la lente de «¿la lógica de negocio existente coincide con las reglas del dominio y puede hacerse más simple·clara?» (no un bug, sino corrección·simplicidad·mantenibilidad — comportamiento preservado).
- **Señales prioritarias**: si la consistencia de máquinas de estado·status·ciclos de vida y sus invariantes se imponen en el código, duplicación de la misma regla (deriva), código muerto·rastros que disparan re-propuestas, sobrecomplejidad·oscuridad. Elige la señal de consistencia de dominio del código (grep)·docs.
- **Síntesis**: agrupa las señales como una «oportunidad de consistencia·simplificación» y elévalas como briefs, pero no eleves una «mejora» cuya preservación del comportamiento no pueda verificarse. Pon en el spec de cada brief «lógica·invariante actual / problema de consistencia·duplicación·complejidad / una forma más simple·consistente (que preserve el comportamiento) / método de verificación de preservación del comportamiento / blast-radius». En el ref de evidence, escribe archivo:línea. Si casi no hay lógica de dominio cuya consistencia pueda juzgarse, cero briefs (array vacío) es una respuesta correcta.`,
    fr: `## Perspective de collecte — expert logique (domaine·cohérence)
Cette collecte se fait du point de vue d'un expert «logique (domaine·cohérence)». Rassemble les signaux d'abord à travers le prisme de «la logique métier existante correspond-elle aux règles du domaine, et peut-on la rendre plus simple·claire» (pas un bug, mais correction·simplicité·maintenabilité — comportement préservé).
- **Signaux prioritaires**: si la cohérence des machines à états·status·cycles de vie et leurs invariants sont imposés dans le code, duplication de la même règle (dérive), code mort·traces déclenchant des re-propositions, sur-complexité·obscurité. Choisis le signal de cohérence de domaine dans le code (grep)·docs.
- **Synthèse**: regroupe les signaux comme une «opportunité de cohérence·simplification» et élève-les en briefs, mais ne soumets pas une «amélioration» dont la préservation du comportement ne peut être vérifiée. Mets dans le spec de chaque brief «logique·invariant actuel / problème de cohérence·duplication·complexité / une forme plus simple·cohérente (préservant le comportement) / méthode de vérification de préservation du comportement / blast-radius». Dans le ref de evidence, écris fichier:ligne. S'il n'y a presque pas de logique de domaine dont la cohérence peut être jugée, zéro brief (tableau vide) est une réponse correcte.`,
    hi: `## संग्रह दृष्टिकोण — लॉजिक (डोमेन·संगति) विशेषज्ञ
यह संग्रह «लॉजिक (डोमेन·संगति)» विशेषज्ञ के दृष्टिकोण से होता है। संकेतों को पहले «क्या मौजूदा बिज़नेस लॉजिक डोमेन नियमों से मेल खाता है और क्या इसे अधिक सरल·स्पष्ट बनाया जा सकता है» की दृष्टि से जुटाएँ (बग नहीं, बल्कि शुद्धता·सरलता·रखरखाव-योग्यता — व्यवहार संरक्षित)।
- **प्राथमिकता संकेत**: क्या स्टेट मशीन·status·जीवनचक्र की संगति व इनवेरिएंट कोड में लागू हैं, वही नियम का दोहराव (ड्रिफ़्ट), मृत कोड·पुनः-प्रस्ताव भड़काने वाले निशान, अति-जटिलता·अस्पष्टता। कोड (grep)·दस्तावेज़ से डोमेन संगति संकेत चुनें।
- **संश्लेषण**: संकेतों को «संगति·सरलीकरण अवसर» के रूप में समूहित कर ब्रीफ़ बनाएँ, पर जिस «सुधार» का व्यवहार-संरक्षण सत्यापित न हो उसे न उठाएँ। हर ब्रीफ़ के spec में «वर्तमान लॉजिक·इनवेरिएंट / संगति·दोहराव·जटिलता समस्या / अधिक सरल·संगत रूप (व्यवहार-संरक्षी) / व्यवहार-संरक्षण सत्यापन विधि / blast-radius» डालें। evidence के ref में फ़ाइल:लाइन लिखें। संगति आँकने योग्य डोमेन लॉजिक लगभग न हो तो शून्य ब्रीफ़ (खाली array) सही उत्तर है।`,
    ja: `## 収集の観点 — ロジック(ドメイン·整合性)の専門家
この収集は「ロジック(ドメイン·整合性)」専門家の観点で行う。信号をまず「既存のビジネスロジックがドメイン規則と合致し、より単純·明瞭にできるか」の目で集めよ(バグではなく正確性·単純性·保守性 — 動作は保存)。
- **優先信号**: 状態機械·status·ライフサイクルの整合性と不変条件がコードで強制されているか、同じ規則の重複(ドリフト)、デッドコード·再提案を誘発する痕跡、過複雑·不明瞭。コード(grep)·文書からドメイン整合性の信号を選べ。
- **統合**: 信号を「整合性·単純化の機会」としてまとめブリーフに上げるが、動作保存を検証できない「改善」は上げるな。各ブリーフの spec に「現在のロジック·不変条件 / 整合性·重複·複雑性の問題 / より単純·整合した形(動作保存) / 動作保存の検証方法 / blast-radius」を入れよ。evidence の ref にファイル:行を書け。整合性を問うドメインロジックがほとんどなければブリーフ0件(空配列)も正解だ。`,
    ko: `## 수집 관점 — 로직(도메인·정합성) 전문가
이 수집은 «로직(도메인·정합성)» 전문가 관점으로 수행한다. 신호를 «기존 비즈니스 로직이 도메인 규칙과 맞고 더 단순·명료하게 만들 수 있는가» 의 눈으로 우선 모아라 (버그가 아니라 정확성·단순성·유지보수성 — 동작은 보존).
- **우선 신호**: 상태머신·status·수명주기의 정합성과 불변식이 코드로 강제되는가, 같은 규칙의 중복(드리프트), 죽은 코드·재제안 유발 흔적, 과복잡·불명료. 코드(grep)·문서에서 도메인 정합성 신호를 골라라.
- **종합**: 신호를 «정합성·단순화 기회» 로 묶어 브리프로 올리되 동작 보존을 검증할 수 없는 «개선» 은 올리지 마라. 각 브리프 spec 에 «현재 로직·불변식 / 정합성·중복·복잡성 문제 / 더 단순·정합한 형태(동작 보존) / 동작 보존 검증 방법 / blast-radius» 를 담아라. evidence 의 ref 에 파일:라인을 적어라. 정합성을 따질 도메인 로직이 거의 없으면 0건(빈 배열)도 정답이다.`,
    "pt-BR": `## Perspectiva de coleta — especialista em lógica (domínio·consistência)
Esta coleta é feita pela perspectiva de um especialista em «lógica (domínio·consistência)». Reúna sinais primeiro pela lente de «a lógica de negócio existente corresponde às regras do domínio e pode ser tornada mais simples·clara?» (não um bug, mas correção·simplicidade·manutenibilidade — comportamento preservado).
- **Sinais prioritários**: se a consistência de máquinas de estado·status·ciclos de vida e seus invariantes são impostos no código, duplicação da mesma regra (deriva), código morto·rastros que disparam re-propostas, complexidade excessiva·obscuridade. Escolha o sinal de consistência de domínio do código (grep)·docs.
- **Síntese**: agrupe os sinais como uma «oportunidade de consistência·simplificação» e eleve-os como briefs, mas não eleve uma «melhoria» cuja preservação do comportamento não possa ser verificada. Coloque no spec de cada brief «lógica·invariante atual / problema de consistência·duplicação·complexidade / uma forma mais simples·consistente (que preserve o comportamento) / método de verificação de preservação do comportamento / blast-radius». No ref de evidence, escreva arquivo:linha. Se quase não houver lógica de domínio cuja consistência possa ser julgada, zero briefs (array vazio) é uma resposta correta.`,
    ru: `## Перспектива сбора — эксперт по логике (домен·согласованность)
Этот сбор ведётся с точки зрения эксперта по «логике (домен·согласованность)». Собирайте сигналы прежде всего через призму «соответствует ли существующая бизнес-логика правилам домена и можно ли сделать её проще·яснее» (не баг, а корректность·простота·сопровождаемость — поведение сохраняется).
- **Приоритетные сигналы**: принуждаются ли в коде согласованность машин состояний·status·жизненных циклов и их инварианты, дублирование одного правила (дрейф), мёртвый код·следы, провоцирующие повторные предложения, избыточная сложность·неясность. Выбирайте сигнал согласованности домена из кода (grep)·документов.
- **Синтез**: сгруппируйте сигналы как «возможность согласованности·упрощения» и поднимите их как брифы, но не поднимайте «улучшение», сохранение поведения которого нельзя проверить. В spec каждого брифа укажите «текущая логика·инвариант / проблема согласованности·дублирования·сложности / более простая·согласованная форма (сохраняющая поведение) / метод проверки сохранения поведения / blast-radius». В ref у evidence пишите файл:строка. Если доменной логики, чью согласованность можно оценить, почти нет, ноль брифов (пустой массив) — правильный ответ.`,
    "zh-Hans": `## 收集视角 — 逻辑(领域·一致性)专家
本次收集以「逻辑(领域·一致性)」专家的视角进行。先以「现有业务逻辑是否符合领域规则、能否更简单·更清晰」的眼光收集信号(不是 bug,而是正确性·简洁性·可维护性——行为予以保留)。
- **优先信号**: 状态机·status·生命周期的一致性与不变式是否在代码中被强制、同一规则的重复(漂移)、死代码·诱发再提案的痕迹、过度复杂·不清晰。从代码(grep)·文档中挑出领域一致性信号。
- **综合**: 将信号归并为「一致性·简化机会」并作为简报提出,但无法验证行为保留的「改进」不要提出。在每条简报的 spec 中写明「当前逻辑·不变式 / 一致性·重复·复杂性问题 / 更简单·更一致的形态(保留行为) / 行为保留验证方法 / blast-radius」。在 evidence 的 ref 中写文件:行。若几乎没有可评判一致性的领域逻辑,则零条简报(空数组)是正确答案。`,
  },
  "lens.collect.ux": {
    ar: `## منظور التجميع — خبير تجربة المستخدم (UX·قابلية الاستخدام)
يُجرى هذا التجميع بمنظور خبير «تجربة المستخدم (UX·قابلية الاستخدام)». اجمع الإشارات أولاً بعين «أين يتعثّر المستخدم ولماذا لا يُكمل» (ليس رموز·ألوان·تباعد design البصرية بل احتكاك التدفّق·الفهم·الإكمال — استدلالات Nielsen).
- **الإشارات ذات الأولوية**: نقاط الاحتكاك·التوقّف (التسرّب) في تدفّق المستخدم، مناطق تكرّر الأخطاء، المواضع سيئة رؤية الحالة·التراجع·الاتساق·عبء الذاكرة، شكاوى المراجعات·القضايا «مربك·لا أجد·صعب». انتقِ إشارة قابلية الاستخدام من الكود (العروض/التدفّقات)·المراجعات·القضايا.
- **التركيب**: اجمع الإشارات كـ«فرصة قابلية استخدام» وارفعها كبريفات، وضع في spec كل بريف «الاستدلال المُنتهَك / الخطورة (cosmetic·minor·major·catastrophic) / سيناريو الاستخدام (ما الذي يحاوله ثم يتعثّر أين) / المقترح للتحسين». اكتب في ref ضمن evidence ملف:سطر·مراجعة·قضية. إن لم يوجد سطح تدفّق للمستخدم فبريف بعدد 0 (مصفوفة فارغة) إجابة صحيحة.`,
    en: `## Collection perspective — UX (usability) expert
This collection runs from a «UX (usability)» expert's perspective. Gather signals first through the lens of «where the user gets stuck and why they cannot finish» (not the design (visual) tokens·colors·spacing but flow friction·understanding·completion — Nielsen heuristics).
- **Priority signals**: friction·drop-off (abandonment) points in the user flow, error-prone areas, places with poor system-status visibility·undo·consistency·memory load, reviews·issues' «confusing·can't find·hard» complaints. Pick the usability signal from code (views/flows)·reviews·issues.
- **Synthesis**: group signals as a «usability opportunity» and raise them as briefs, and put in each brief's spec «the violated heuristic / severity (cosmetic·minor·major·catastrophic) / usage scenario (what they tried and where they got stuck) / improvement». In evidence's ref, write file:line·review·issue. If there is no user-flow surface, zero briefs (empty array) is a correct answer.`,
    es: `## Perspectiva de recopilación — experto en UX (usabilidad)
Esta recopilación se realiza desde la perspectiva de un experto en «UX (usabilidad)». Reúne señales primero a través de la lente de «dónde se atasca el usuario y por qué no puede terminar» (no los tokens·colores·espaciado del design (visual) sino fricción de flujo·comprensión·finalización — heurísticas de Nielsen).
- **Señales prioritarias**: puntos de fricción·abandono en el flujo del usuario, zonas propensas a errores, lugares con mala visibilidad del estado del sistema·deshacer·consistencia·carga de memoria, quejas de reseñas·issues del «confuso·no encuentro·difícil». Elige la señal de usabilidad del código (vistas/flujos)·reseñas·issues.
- **Síntesis**: agrupa las señales como una «oportunidad de usabilidad» y elévalas como briefs, y pon en el spec de cada brief «la heurística violada / severidad (cosmetic·minor·major·catastrophic) / escenario de uso (qué intentaron y dónde se atascaron) / mejora». En el ref de evidence, escribe archivo:línea·reseña·issue. Si no hay superficie de flujo de usuario, cero briefs (array vacío) es una respuesta correcta.`,
    fr: `## Perspective de collecte — expert UX (utilisabilité)
Cette collecte se fait du point de vue d'un expert «UX (utilisabilité)». Rassemble les signaux d'abord à travers le prisme de «où l'utilisateur se bloque et pourquoi il n'arrive pas à finir» (pas les tokens·couleurs·espacement du design (visuel) mais friction de flux·compréhension·achèvement — heuristiques de Nielsen).
- **Signaux prioritaires**: points de friction·abandon dans le flux utilisateur, zones sujettes aux erreurs, endroits à mauvaise visibilité de l'état du système·annulation·cohérence·charge mémoire, plaintes des avis·issues du «confus·je ne trouve pas·difficile». Choisis le signal d'utilisabilité dans le code (vues/flux)·avis·issues.
- **Synthèse**: regroupe les signaux comme une «opportunité d'utilisabilité» et élève-les en briefs, et mets dans le spec de chaque brief «l'heuristique violée / sévérité (cosmetic·minor·major·catastrophic) / scénario d'usage (ce qu'ils ont essayé et où ils se sont bloqués) / amélioration». Dans le ref de evidence, écris fichier:ligne·avis·issue. S'il n'y a pas de surface de flux utilisateur, zéro brief (tableau vide) est une réponse correcte.`,
    hi: `## संग्रह दृष्टिकोण — UX (उपयोगिता) विशेषज्ञ
यह संग्रह «UX (उपयोगिता)» विशेषज्ञ के दृष्टिकोण से होता है। संकेतों को पहले «उपयोगकर्ता कहाँ अटकता है और क्यों पूरा नहीं कर पाता» की दृष्टि से जुटाएँ (design (दृश्य) के टोकन·रंग·स्पेसिंग नहीं बल्कि फ़्लो घर्षण·समझ·पूर्णता — Nielsen ह्यूरिस्टिक्स)।
- **प्राथमिकता संकेत**: उपयोगकर्ता फ़्लो में घर्षण·छोड़ने (ड्रॉप-ऑफ़) बिंदु, त्रुटि-प्रवण क्षेत्र, सिस्टम स्थिति दृश्यता·पूर्ववत·संगति·स्मृति भार में खराब स्थान, समीक्षाओं·issues की «भ्रामक·नहीं मिलता·कठिन» शिकायतें। कोड (व्यू/फ़्लो)·समीक्षाओं·issues से उपयोगिता संकेत चुनें।
- **संश्लेषण**: संकेतों को «उपयोगिता अवसर» के रूप में समूहित कर ब्रीफ़ बनाएँ, और हर ब्रीफ़ के spec में «उल्लंघित ह्यूरिस्टिक / गंभीरता (cosmetic·minor·major·catastrophic) / उपयोग परिदृश्य (क्या करने जा रहा था और कहाँ अटका) / सुधार» डालें। evidence के ref में फ़ाइल:लाइन·समीक्षा·issue लिखें। उपयोगकर्ता फ़्लो सतह न हो तो शून्य ब्रीफ़ (खाली array) सही उत्तर है।`,
    ja: `## 収集の観点 — UX(ユーザビリティ)の専門家
この収集は「UX(ユーザビリティ)」専門家の観点で行う。信号をまず「ユーザーがどこで詰まり、なぜ完了できないか」の目で集めよ(design(視覚)のトークン·色·余白ではなくフローの摩擦·理解·完了 — Nielsen ヒューリスティック)。
- **優先信号**: ユーザーフローの摩擦·中断(離脱)点、エラー多発区間、システム状態の可視性·取り消し·一貫性·記憶負荷が悪い箇所、レビュー·課題の「紛らわしい·見つからない·難しい」不満。コード(ビュー/フロー)·レビュー·課題からユーザビリティ信号を選べ。
- **統合**: 信号を「ユーザビリティの機会」としてまとめブリーフに上げ、各ブリーフの spec に「違反したヒューリスティック / 重大度(cosmetic·minor·major·catastrophic) / 使用シナリオ(何をしようとしてどこで詰まったか) / 改善案」を入れよ。evidence の ref にファイル:行·レビュー·課題を書け。ユーザーフローの表面がなければブリーフ0件(空配列)も正解だ。`,
    ko: `## 수집 관점 — UX(사용성) 전문가
이 수집은 «UX(사용성)» 전문가 관점으로 수행한다. 신호를 «사용자가 어디서 막히고 왜 못 끝내나» 의 눈으로 우선 모아라 (design(시각)의 토큰·색·간격이 아니라 플로우 마찰·이해·완수 — Nielsen 휴리스틱).
- **우선 신호**: 사용자 플로우의 마찰·중단(이탈) 지점, 오류 빈발 구간, 상태 가시성·되돌리기·일관성·기억 부담이 나쁜 자리, 리뷰·이슈의 «헷갈린다·못 찾겠다·어렵다» 불만. 코드(뷰/플로우)·리뷰·이슈에서 사용성 신호를 골라라.
- **종합**: 신호를 «사용성 기회» 로 묶어 브리프로 올리고, 각 브리프 spec 에 «위반한 휴리스틱 / 심각도(cosmetic·minor·major·catastrophic) / 사용 시나리오(무엇을 하려다 어디서 막히나) / 개선안» 을 담아라. evidence 의 ref 에 파일:라인·리뷰·이슈를 적어라. 사용자 플로우 표면이 없으면 0건(빈 배열)도 정답이다.`,
    "pt-BR": `## Perspectiva de coleta — especialista em UX (usabilidade)
Esta coleta é feita pela perspectiva de um especialista em «UX (usabilidade)». Reúna sinais primeiro pela lente de «onde o usuário trava e por que não consegue terminar» (não os tokens·cores·espaçamento do design (visual), mas atrito de fluxo·compreensão·conclusão — heurísticas de Nielsen).
- **Sinais prioritários**: pontos de atrito·abandono no fluxo do usuário, áreas propensas a erro, lugares com má visibilidade do estado do sistema·desfazer·consistência·carga de memória, reclamações de avaliações·issues do «confuso·não acho·difícil». Escolha o sinal de usabilidade do código (views/fluxos)·avaliações·issues.
- **Síntese**: agrupe os sinais como uma «oportunidade de usabilidade» e eleve-os como briefs, e coloque no spec de cada brief «a heurística violada / severidade (cosmetic·minor·major·catastrophic) / cenário de uso (o que tentaram e onde travaram) / melhoria». No ref de evidence, escreva arquivo:linha·avaliação·issue. Se não houver superfície de fluxo do usuário, zero briefs (array vazio) é uma resposta correta.`,
    ru: `## Перспектива сбора — эксперт по UX (юзабилити)
Этот сбор ведётся с точки зрения эксперта по «UX (юзабилити)». Собирайте сигналы прежде всего через призму «где пользователь застревает и почему не может завершить» (не токены·цвета·отступы design (визуального), а трение потока·понимание·завершение — эвристики Нильсена).
- **Приоритетные сигналы**: точки трения·оттока (отказа) в пользовательском потоке, подверженные ошибкам зоны, места с плохой видимостью состояния системы·отменой·согласованностью·нагрузкой на память, жалобы отзывов·issue «путано·не найти·сложно». Выбирайте сигнал юзабилити из кода (вью/потоки)·отзывов·issue.
- **Синтез**: сгруппируйте сигналы как «возможность юзабилити» и поднимите их как брифы, и в spec каждого брифа укажите «нарушенная эвристика / серьёзность (cosmetic·minor·major·catastrophic) / сценарий использования (что пытались и где застряли) / улучшение». В ref у evidence пишите файл:строка·отзыв·issue. Если поверхности пользовательского потока нет, ноль брифов (пустой массив) — правильный ответ.`,
    "zh-Hans": `## 收集视角 — UX(可用性)专家
本次收集以「UX(可用性)」专家的视角进行。先以「用户在哪里卡住、为何无法完成」的眼光收集信号(不是 design(视觉)的令牌·颜色·间距,而是流程摩擦·理解·完成——Nielsen 启发式)。
- **优先信号**: 用户流程中的摩擦·流失(放弃)点、易错区域、系统状态可见性·撤销·一致性·记忆负担差的地方、评价·issue 的「困惑·找不到·难」抱怨。从代码(视图/流程)·评价·issue 中挑出可用性信号。
- **综合**: 将信号归并为「可用性机会」并作为简报提出,并在每条简报的 spec 中写明「被违反的启发式 / 严重度(cosmetic·minor·major·catastrophic) / 使用场景(想做什么、在哪里卡住) / 改进方案」。在 evidence 的 ref 中写文件:行·评价·issue。若没有用户流程表面,则零条简报(空数组)是正确答案。`,
  },
} satisfies Record<string, Msg>;
