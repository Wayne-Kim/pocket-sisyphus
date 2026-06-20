// PO 프롬프트 다국어 카탈로그 — «수집(collect)» 빌더 (buildPoCollectPrompt).
//
// ko 는 SSOT — prompt.ts 의 기존 리터럴과 byte-identical (prompt.test.ts ko 단언이 회귀 가드).
// «{{name}}» 은 format() 보간 자리. 빌더가 조건부 섹션/리스트를 t() 조각으로 만들어 본문 템플릿에 끼운다.

import type { Msg } from "./locale.js";

export const collectMessages = {
  // ── 조건부 섹션 ────────────────────────────────────────────────────────────
  "collect.profile": {
    ar: `
## أسلوب البحث (ملف المشروع — مشترك لكل تجميع)
{{profileDirective}}

- اضبط نطاق/طريقة تجميع الإشارات في المرحلة 1 ومنظور البريف في المرحلة 2 وفق هذا التوجيه.
- إن وُجد «توجيه المستخدم (هذه الجولة)» أدناه فهو أولى من هذا الملف.
`,
    en: `
## Research method (project profile — shared across every collection)
{{profileDirective}}

- Align the scope/method of signal collection in step 1 and the brief perspective in step 2 to this guidance.
- If there is a «user directive (this round)» below, it takes priority over this profile.
`,
    es: `
## Método de investigación (perfil del proyecto — compartido en cada recopilación)
{{profileDirective}}

- Alinea el alcance/método de la recopilación de señales del paso 1 y la perspectiva del brief del paso 2 con esta guía.
- Si abajo hay una «directiva del usuario (esta ronda)», tiene prioridad sobre este perfil.
`,
    fr: `
## Méthode de recherche (profil du projet — commun à chaque collecte)
{{profileDirective}}

- Aligne la portée/méthode de la collecte de signaux à l'étape 1 et la perspective du brief à l'étape 2 sur ces indications.
- S'il y a une «directive utilisateur (ce tour)» ci-dessous, elle prime sur ce profil.
`,
    hi: `
## शोध पद्धति (प्रोजेक्ट प्रोफ़ाइल — हर संग्रह में साझा)
{{profileDirective}}

- चरण 1 के संकेत-संग्रह के दायरे/विधि और चरण 2 के ब्रीफ़ दृष्टिकोण को इस मार्गदर्शन के अनुरूप करें।
- यदि नीचे «उपयोगकर्ता निर्देश (इस दौर का)» है, तो वह इस प्रोफ़ाइल पर प्राथमिकता रखता है।
`,
    ja: `
## 調査方法(プロジェクトプロファイル — 各収集で共通)
{{profileDirective}}

- ステップ1の信号収集の範囲/方法と、ステップ2のブリーフの観点をこの指針に合わせよ。
- 下に「ユーザー指示(今回)」があれば、それがこのプロファイルより優先する。
`,
    ko: `
## 조사 방식 (프로젝트 프로필 — 매 수집 공통)
{{profileDirective}}

- 1단계의 신호 수집 범위/방법과 2단계의 브리프 관점을 이 지침에 맞춰라.
- 아래 «사용자 지시(이번 회차)» 가 있으면 그것이 이 프로필보다 우선한다.
`,
    "pt-BR": `
## Método de pesquisa (perfil do projeto — compartilhado em cada coleta)
{{profileDirective}}

- Alinhe o escopo/método da coleta de sinais do passo 1 e a perspectiva do brief do passo 2 a esta orientação.
- Se houver uma «diretiva do usuário (esta rodada)» abaixo, ela tem prioridade sobre este perfil.
`,
    ru: `
## Метод исследования (профиль проекта — общий для каждого сбора)
{{profileDirective}}

- Согласуйте охват/метод сбора сигналов на шаге 1 и ракурс брифа на шаге 2 с этим руководством.
- Если ниже есть «директива пользователя (этот раунд)», она имеет приоритет над этим профилем.
`,
    "zh-Hans": `
## 调研方式(项目档案——每次收集通用)
{{profileDirective}}

- 将第 1 步信号收集的范围/方法与第 2 步简报视角对齐到本指引。
- 若下方有「用户指示(本轮)」,则其优先于本档案。
`,
  },

  "collect.directive": {
    ar: `
## توجيه المستخدم (هذه الجولة — الأولوية القصوى)
{{instruction}}

- اصنع البريفات «حول» هذا التوجيه. قلّل الاقتراحات الشاملة غير المتصلة بالتوجيه.
- التوجيه نفسه إشارة مشروعة (مدخل صاحب المصلحة). ابحث في المستودع عن سند داعم وأضفه، وإن لم يوجد فأضف في evidence
  { "kind": "user_directive", "ref": "توجيه المستخدم", "summary": "<خلاصة التوجيه في سطر>" }
  وأنشئ البريف — لا تتخلَّ عن فكرة موجَّهة لقلة السند.
- إن كان التوجيه ميزة محددة واحدة فاجعله بريفاً واحداً وافياً، وإن كان اتجاهاً فاجعله عدة مرشحات في ذلك الاتجاه.
`,
    en: `
## User directive (this round — top priority)
{{instruction}}

- Build the briefs «around» this directive. Reduce broad, directive-unrelated proposals.
- The directive itself is a legitimate signal (stakeholder input). Find supporting evidence in the repo and attach it, but even without it add to evidence
  { "kind": "user_directive", "ref": "user directive", "summary": "<one-line gist of the directive>" }
  and create the brief — do not discard a directed idea for lack of evidence.
- If the directive is one concrete feature, make it one solid brief; if it is a direction, make several candidates in that direction.
`,
    es: `
## Directiva del usuario (esta ronda — máxima prioridad)
{{instruction}}

- Construye los briefs «en torno a» esta directiva. Reduce las propuestas amplias no relacionadas con la directiva.
- La directiva en sí es una señal legítima (aporte del interesado). Busca evidencia de apoyo en el repo y adjúntala, pero aun sin ella añade a evidence
  { "kind": "user_directive", "ref": "directiva del usuario", "summary": "<resumen de una línea de la directiva>" }
  y crea el brief — no descartes una idea dirigida por falta de evidencia.
- Si la directiva es una función concreta, hazla un brief sólido; si es una dirección, haz varios candidatos en esa dirección.
`,
    fr: `
## Directive utilisateur (ce tour — priorité absolue)
{{instruction}}

- Construis les briefs «autour de» cette directive. Réduis les propositions larges sans rapport avec la directive.
- La directive est elle-même un signal légitime (apport de la partie prenante). Trouve des preuves d'appui dans le dépôt et joins-les, mais même sans elles ajoute à evidence
  { "kind": "user_directive", "ref": "directive utilisateur", "summary": "<résumé en une ligne de la directive>" }
  et crée le brief — n'écarte pas une idée dirigée faute de preuves.
- Si la directive est une fonctionnalité concrète, fais-en un brief solide; si c'est une direction, fais plusieurs candidats dans cette direction.
`,
    hi: `
## उपयोगकर्ता निर्देश (इस दौर — सर्वोच्च प्राथमिकता)
{{instruction}}

- ब्रीफ़ इस निर्देश के «इर्द-गिर्द» बनाएँ। निर्देश से असंबंधित व्यापक प्रस्ताव कम करें।
- निर्देश स्वयं एक वैध संकेत है (हितधारक इनपुट)। रेपो में समर्थक साक्ष्य खोजकर जोड़ें, पर उसके बिना भी evidence में
  { "kind": "user_directive", "ref": "उपयोगकर्ता निर्देश", "summary": "<निर्देश का एक-पंक्ति सार>" }
  जोड़कर ब्रीफ़ बनाएँ — साक्ष्य की कमी के कारण निर्देशित विचार को न छोड़ें।
- यदि निर्देश एक ठोस फ़ीचर है तो उसे एक सुदृढ़ ब्रीफ़ बनाएँ; यदि दिशा है तो उस दिशा में कई उम्मीदवार बनाएँ।
`,
    ja: `
## ユーザー指示(今回 — 最優先)
{{instruction}}

- ブリーフはこの指示を「中心に」作れ。指示と無関係な全方位の提案は減らす。
- 指示そのものが正当な信号だ(ステークホルダー入力)。リポジトリで裏付け根拠を探して付けるが、なくても evidence に
  { "kind": "user_directive", "ref": "ユーザー指示", "summary": "<指示の要旨を一行で>" }
  を入れてブリーフを作れ — 指示されたアイデアを根拠不足で捨てるな。
- 指示が具体的な機能一つなら充実した1件のブリーフに、方向性ならその方向の候補を複数に。
`,
    ko: `
## 사용자 지시 (이번 회차 — 최우선)
{{instruction}}

- 브리프는 이 지시를 «중심으로» 만들어라. 지시와 무관한 전방위 제안은 줄인다.
- 지시 자체가 정당한 신호다(이해관계자 입력). 레포에서 뒷받침 근거를 찾아 붙이되, 없어도
  evidence 에 { "kind": "user_directive", "ref": "사용자 지시", "summary": "<지시 요지 한 줄>" }
  을 넣어 브리프를 만들어라 — 지시받은 아이디어를 근거 부족으로 버리지 마라.
- 지시가 구체적 기능 하나면 그것을 1건의 충실한 브리프로, 방향성이면 그 방향의 후보 여러 건으로.
`,
    "pt-BR": `
## Diretiva do usuário (esta rodada — prioridade máxima)
{{instruction}}

- Construa os briefs «em torno de» esta diretiva. Reduza propostas amplas não relacionadas à diretiva.
- A diretiva em si é um sinal legítimo (entrada do stakeholder). Encontre evidências de apoio no repo e anexe, mas mesmo sem elas adicione ao evidence
  { "kind": "user_directive", "ref": "diretiva do usuário", "summary": "<resumo de uma linha da diretiva>" }
  e crie o brief — não descarte uma ideia direcionada por falta de evidência.
- Se a diretiva for um recurso concreto, faça um brief sólido; se for uma direção, faça vários candidatos nessa direção.
`,
    ru: `
## Директива пользователя (этот раунд — высший приоритет)
{{instruction}}

- Стройте брифы «вокруг» этой директивы. Сократите широкие предложения, не связанные с директивой.
- Сама директива — законный сигнал (вход заинтересованной стороны). Найдите в репозитории подтверждающие данные и приложите их, но даже без них добавьте в evidence
  { "kind": "user_directive", "ref": "директива пользователя", "summary": "<суть директивы в одну строку>" }
  и создайте бриф — не отбрасывайте заданную идею из-за нехватки данных.
- Если директива — одна конкретная функция, сделайте один основательный бриф; если это направление — несколько кандидатов в нём.
`,
    "zh-Hans": `
## 用户指示(本轮——最高优先级)
{{instruction}}

- 简报要「围绕」该指示来构建。减少与指示无关的全方位提案。
- 指示本身就是正当信号(干系人输入)。在仓库中寻找支撑依据并附上,但即便没有也要在 evidence 中加入
  { "kind": "user_directive", "ref": "用户指示", "summary": "<指示要点一行>" }
  并创建简报——不要因依据不足而丢弃被指示的想法。
- 若指示是一个具体功能,就做成一条充实的简报;若是方向,就在该方向上做多个候选。
`,
  },

  "collect.verificationItem": {
    ar: `- id: {{id}}\n  title: {{title}}\n  الفرضية (problem): {{problem}}`,
    en: `- id: {{id}}\n  title: {{title}}\n  hypothesis (problem): {{problem}}`,
    es: `- id: {{id}}\n  title: {{title}}\n  hipótesis (problem): {{problem}}`,
    fr: `- id: {{id}}\n  title: {{title}}\n  hypothèse (problem): {{problem}}`,
    hi: `- id: {{id}}\n  title: {{title}}\n  परिकल्पना (problem): {{problem}}`,
    ja: `- id: {{id}}\n  title: {{title}}\n  仮説(problem): {{problem}}`,
    ko: `- id: {{id}}\n  title: {{title}}\n  가설(problem): {{problem}}`,
    "pt-BR": `- id: {{id}}\n  title: {{title}}\n  hipótese (problem): {{problem}}`,
    ru: `- id: {{id}}\n  title: {{title}}\n  гипотеза (problem): {{problem}}`,
    "zh-Hans": `- id: {{id}}\n  title: {{title}}\n  假设(problem): {{problem}}`,
  },

  "collect.verification": {
    ar: `
## التحقق بعد الإطلاق (نفّذه حتماً بمعزل عن كتابة البريف)
أدناه بريفات سابقة اكتمل تنفيذها وحالتها «مُطلق (shipped)». قارن بإشارات المرحلة 1 ما إذا حُلّت فعلاً فرضية كل منها (الإزعاج الذي يصفه problem):
{{shippedList}}

معايير الحكم:
- "verified" = تظهر أدلة على حلّ الفرضية (إغلاق القضية المرتبطة، وجود كوميت/وثيقة للميزة، عدم ظهور نفس إشارة الشكوى بعد الآن).
- "missed" = رغم التنفيذ تستمر نفس الشكوى/الإشارة، أو حلّ التنفيذ مشكلة مختلفة عن الفرضية.
- إن لم تكفِ الأدلة للحكم فـ«احذف» ذلك البريف من قائمة الأحكام — ستعيد النظر فيه الدورة التالية. ممنوع الحكم بالتخمين.

اكتب الأحكام في المسار التالي كـ«مصفوفة» JSON (مصفوفة فارغة إن لم يوجد حكم):
{{verdictFile}}

كل عنصر: { "id": "<نفس المعرّف أعلاه>", "verdict": "verified" | "missed", "note": "سبب الحكم في سطر (يشمل مرجعاً قابلاً للتحقق)" }
`,
    en: `
## Post-launch verification (do this regardless of writing briefs)
Below are past briefs already implemented and in «shipped» status. Cross-check, using the signals gathered in step 1, whether each hypothesis (the pain the problem describes) was actually resolved:
{{shippedList}}

Verdict criteria:
- "verified" = there is evidence the hypothesis was resolved (related issue closed, a commit/doc for the feature exists, the same complaint signal is no longer seen).
- "missed" = despite implementation the same complaint/signal persists, or the implementation solved a different problem than the hypothesis.
- If evidence is insufficient to judge, «drop» that brief from the verdict list — the next cycle will look again. No guess verdicts.

Write the verdicts to the following path as a JSON «array» (empty array if no verdicts):
{{verdictFile}}

Each element: { "id": "<the id above as-is>", "verdict": "verified" | "missed", "note": "one-line verdict rationale (including a verifiable reference)" }
`,
    es: `
## Verificación posterior al lanzamiento (hazla aparte de escribir briefs)
Abajo hay briefs anteriores ya implementados y en estado «lanzado (shipped)». Contrasta, con las señales del paso 1, si cada hipótesis (la molestia que describe problem) se resolvió realmente:
{{shippedList}}

Criterios de veredicto:
- "verified" = hay evidencia de que la hipótesis se resolvió (issue relacionado cerrado, existe un commit/doc de la función, ya no se ve la misma señal de queja).
- "missed" = pese a la implementación persiste la misma queja/señal, o la implementación resolvió un problema distinto al de la hipótesis.
- Si la evidencia es insuficiente para juzgar, «quita» ese brief de la lista de veredictos — el próximo ciclo lo revisará. Prohibido veredicto por conjetura.

Escribe los veredictos en la siguiente ruta como un «array» JSON (array vacío si no hay veredictos):
{{verdictFile}}

Cada elemento: { "id": "<el id de arriba tal cual>", "verdict": "verified" | "missed", "note": "razón del veredicto en una línea (incluyendo una referencia verificable)" }
`,
    fr: `
## Vérification post-lancement (à faire indépendamment de l'écriture des briefs)
Ci-dessous des briefs passés déjà implémentés et en statut «livré (shipped)». Vérifie, à l'aide des signaux de l'étape 1, si chaque hypothèse (la gêne décrite par problem) a réellement été résolue:
{{shippedList}}

Critères de verdict:
- "verified" = il y a des preuves que l'hypothèse a été résolue (issue liée fermée, un commit/doc de la fonctionnalité existe, le même signal de plainte n'apparaît plus).
- "missed" = malgré l'implémentation, la même plainte/signal persiste, ou l'implémentation a résolu un problème différent de l'hypothèse.
- Si les preuves sont insuffisantes pour juger, «retire» ce brief de la liste des verdicts — le prochain cycle réexaminera. Pas de verdict par conjecture.

Écris les verdicts au chemin suivant sous forme de «tableau» JSON (tableau vide s'il n'y a pas de verdict):
{{verdictFile}}

Chaque élément: { "id": "<l'id ci-dessus tel quel>", "verdict": "verified" | "missed", "note": "raison du verdict en une ligne (avec une référence vérifiable)" }
`,
    hi: `
## लॉन्च-पश्चात सत्यापन (ब्रीफ़ लिखने से अलग, अवश्य करें)
नीचे पहले के ब्रीफ़ हैं जो लागू हो चुके हैं और «जारी (shipped)» स्थिति में हैं। चरण 1 में जुटाए संकेतों से जाँचें कि क्या हर परिकल्पना (जो असुविधा problem बताता है) वास्तव में हल हुई:
{{shippedList}}

निर्णय मानदंड:
- "verified" = परिकल्पना के हल होने के साक्ष्य दिखें (संबंधित issue बंद, फ़ीचर का commit/doc मौजूद, वही शिकायत-संकेत अब न दिखे)।
- "missed" = लागू होने के बावजूद वही शिकायत/संकेत बना रहे, या लागूकरण ने परिकल्पना से भिन्न समस्या हल की।
- यदि निर्णय हेतु साक्ष्य अपर्याप्त हों तो उस ब्रीफ़ को निर्णय-सूची से «हटा दें» — अगला चक्र फिर देखेगा। अनुमान से निर्णय न करें।

निर्णय निम्न पथ पर JSON «array» के रूप में लिखें (कोई निर्णय न हो तो खाली array):
{{verdictFile}}

प्रत्येक तत्व: { "id": "<ऊपर वाला id ज्यों का त्यों>", "verdict": "verified" | "missed", "note": "एक-पंक्ति निर्णय-कारण (सत्यापन-योग्य संदर्भ सहित)" }
`,
    ja: `
## リリース後検証(ブリーフ作成とは別に必ず実施)
以下はすでに実装が終わり「リリース済み(shipped)」状態の過去ブリーフだ。各々の仮説(problem が言う不便)が実際に解消したかを、ステップ1で集めた信号で照合せよ:
{{shippedList}}

判定基準:
- "verified" = 仮説が解消した根拠が見える(関連 issue がクローズ、当該機能のコミット/文書が存在、同じ不満信号が見えなくなった)。
- "missed" = 実装したのに同じ不満/信号が続く、または実装が仮説と異なる問題を解いた。
- 根拠が不十分で判断できなければ、そのブリーフは判定リストから「外せ」 — 次のサイクルが再び見る。推測判定は禁止。

判定を次のパスに JSON「配列」で書け(判定がなければ空配列):
{{verdictFile}}

各要素: { "id": "<上の id をそのまま>", "verdict": "verified" | "missed", "note": "判定根拠を一行(確認可能な参照を含む)" }
`,
    ko: `
## 출시 후 검증 (브리프 작성과 별개로 반드시 수행)
아래는 이미 구현이 끝나 «출시됨(shipped)» 상태인 과거 브리프들이다. 각각의 가설(problem 이 말하는 불편)이 실제로 해소됐는지 1단계에서 모은 신호로 대조하라:
{{shippedList}}

판정 기준:
- "verified" = 가설이 해소된 근거가 보인다 (관련 이슈 닫힘, 해당 기능 커밋/문서 존재, 같은 불만 신호가 더 안 보임).
- "missed" = 구현됐는데도 같은 불만/신호가 계속 보이거나, 구현이 가설과 다른 문제를 풀었다.
- 근거가 불충분해 판단할 수 없으면 그 브리프는 판정 목록에서 «빼라» — 다음 사이클이 다시 본다. 추측 판정 금지.

판정을 다음 경로에 JSON «배열» 로 써라 (판정 없으면 빈 배열):
{{verdictFile}}

각 원소: { "id": "<위의 id 그대로>", "verdict": "verified" | "missed", "note": "판정 근거 한 줄 (확인 가능한 참조 포함)" }
`,
    "pt-BR": `
## Verificação pós-lançamento (faça isto independentemente de escrever briefs)
Abaixo estão briefs anteriores já implementados e em status «lançado (shipped)». Confira, com os sinais reunidos no passo 1, se cada hipótese (o incômodo que problem descreve) foi de fato resolvida:
{{shippedList}}

Critérios de veredito:
- "verified" = há evidências de que a hipótese foi resolvida (issue relacionada fechada, existe um commit/doc do recurso, o mesmo sinal de reclamação não aparece mais).
- "missed" = apesar da implementação o mesmo sinal/reclamação persiste, ou a implementação resolveu um problema diferente da hipótese.
- Se a evidência for insuficiente para julgar, «remova» esse brief da lista de vereditos — o próximo ciclo verá de novo. Proibido veredito por suposição.

Escreva os vereditos no seguinte caminho como um «array» JSON (array vazio se não houver vereditos):
{{verdictFile}}

Cada elemento: { "id": "<o id acima como está>", "verdict": "verified" | "missed", "note": "motivo do veredito em uma linha (incluindo uma referência verificável)" }
`,
    ru: `
## Проверка после выпуска (выполните независимо от написания брифов)
Ниже — прошлые брифы, уже реализованные и в статусе «выпущено (shipped)». Сверьте по сигналам, собранным на шаге 1, действительно ли разрешена гипотеза каждого (неудобство, описанное в problem):
{{shippedList}}

Критерии вердикта:
- "verified" = есть доказательства разрешения гипотезы (связанная задача закрыта, существует коммит/документ функции, тот же сигнал жалобы больше не виден).
- "missed" = несмотря на реализацию, та же жалоба/сигнал сохраняется, или реализация решила иную проблему, чем гипотеза.
- Если доказательств недостаточно для суждения, «уберите» этот бриф из списка вердиктов — следующий цикл рассмотрит снова. Вердикты-догадки запрещены.

Запишите вердикты по следующему пути как JSON-«массив» (пустой массив, если вердиктов нет):
{{verdictFile}}

Каждый элемент: { "id": "<id выше как есть>", "verdict": "verified" | "missed", "note": "обоснование вердикта в одну строку (с проверяемой ссылкой)" }
`,
    "zh-Hans": `
## 发布后验证(与撰写简报分开,务必执行)
以下是已实现并处于「已发布(shipped)」状态的过往简报。用第 1 步收集的信号核对每条的假设(problem 所述的不便)是否真正解决:
{{shippedList}}

判定标准:
- "verified" = 有证据表明假设已解决(相关 issue 关闭、存在该功能的提交/文档、同类抱怨信号不再出现)。
- "missed" = 尽管已实现但同类抱怨/信号仍持续,或实现解决的是与假设不同的问题。
- 若证据不足以判断,则将该简报「从判定列表中移除」——下一周期会再看。禁止凭猜测判定。

将判定以 JSON「数组」写入以下路径(无判定则写空数组):
{{verdictFile}}

每个元素: { "id": "<上面的 id 原样>", "verdict": "verified" | "missed", "note": "判定依据一行(含可核实的引用)" }
`,
  },

  "collect.storeReviews": {
    ar: `
## إشارة مراجعات المتجر (App Store)
أحدث {{count}} مراجعة من عملاء App Store لتطبيق هذا المستودع موجودة في ملف JSON أدناه (كل عنصر: id·rating·title·body·territory·createdDate):
{{file}}
- في تجميع المرحلة 1 اقرأ هذا الملف حتماً وأدرج شكاوى/طلبات المستخدمين كإشارة. إن كانت المراجعات متعددة اللغات فلخّص/ترجم جوهرها.
- ضع الأدلة المستمدة من المراجعات في evidence بصيغة { "kind": "asc_review", "ref": "<مُعرّف المراجعة> ★<التقييم> <territory>", "summary": "<ما تقوله المراجعة في سطر>" }.
- إن تكررت الشكوى نفسها في عدة مراجعات فارفع impact بقدرها — واكتب عدد التكرارات في problem.
`,
    en: `
## Store review signal (App Store)
The most recent {{count}} App Store customer reviews for this repo's app are in the JSON file below (each element: id·rating·title·body·territory·createdDate):
{{file}}
- In step-1 signal collection you must read this file and include user complaints/requests as signals. If reviews are multilingual, summarize/translate the gist.
- Put evidence derived from reviews into evidence as { "kind": "asc_review", "ref": "<review id> ★<rating> <territory>", "summary": "<what the review says, one line>" }.
- If the same complaint repeats across reviews, raise impact accordingly — note the repeat count in problem.
`,
    es: `
## Señal de reseñas de la tienda (App Store)
Las {{count}} reseñas de clientes más recientes en App Store de la app de este repo están en el archivo JSON de abajo (cada elemento: id·rating·title·body·territory·createdDate):
{{file}}
- En la recopilación de señales del paso 1 debes leer este archivo e incluir quejas/solicitudes de usuarios como señales. Si las reseñas son multilingües, resume/traduce lo esencial.
- Pon la evidencia derivada de reseñas en evidence como { "kind": "asc_review", "ref": "<id de reseña> ★<calificación> <territory>", "summary": "<lo que dice la reseña, una línea>" }.
- Si la misma queja se repite en varias reseñas, sube impact en consecuencia — anota el número de repeticiones en problem.
`,
    fr: `
## Signal des avis de la boutique (App Store)
Les {{count}} avis clients App Store les plus récents pour l'app de ce dépôt sont dans le fichier JSON ci-dessous (chaque élément: id·rating·title·body·territory·createdDate):
{{file}}
- Dans la collecte de signaux de l'étape 1, tu dois lire ce fichier et inclure les plaintes/demandes des utilisateurs comme signaux. Si les avis sont multilingues, résume/traduis l'essentiel.
- Place les preuves issues des avis dans evidence sous forme { "kind": "asc_review", "ref": "<id avis> ★<note> <territory>", "summary": "<ce que dit l'avis, une ligne>" }.
- Si la même plainte se répète dans plusieurs avis, augmente impact en conséquence — note le nombre de répétitions dans problem.
`,
    hi: `
## स्टोर समीक्षा संकेत (App Store)
इस रेपो की ऐप की {{count}} नवीनतम App Store ग्राहक समीक्षाएँ नीचे दी JSON फ़ाइल में हैं (प्रत्येक तत्व: id·rating·title·body·territory·createdDate):
{{file}}
- चरण-1 संकेत संग्रह में यह फ़ाइल अवश्य पढ़ें और उपयोगकर्ता शिकायतों/अनुरोधों को संकेत के रूप में शामिल करें। यदि समीक्षाएँ बहुभाषी हों तो सार का संक्षेपण/अनुवाद करें।
- समीक्षाओं से प्राप्त साक्ष्य को evidence में { "kind": "asc_review", "ref": "<समीक्षा id> ★<रेटिंग> <territory>", "summary": "<समीक्षा क्या कहती है, एक पंक्ति>" } रूप में डालें।
- यदि वही शिकायत कई समीक्षाओं में दोहराई जाए तो impact उतना बढ़ाएँ — दोहराव की संख्या problem में लिखें।
`,
    ja: `
## ストアレビュー信号(App Store)
このリポジトリのアプリの最新 {{count}} 件の App Store 顧客レビューが下の JSON ファイルにある(各要素: id·rating·title·body·territory·createdDate):
{{file}}
- ステップ1の信号収集でこのファイルを必ず読み、ユーザーの不満/要望を信号として含めよ。レビューが多言語なら要旨を要約/翻訳して扱え。
- レビュー由来の根拠は evidence に { "kind": "asc_review", "ref": "<レビュー id> ★<評価> <territory>", "summary": "<レビューが言うことを一行>" } の形式で入れよ。
- 同じ不満が複数レビューで繰り返されるならその分 impact を高く見よ — 繰り返し回数を problem に書け。
`,
    ko: `
## 스토어 리뷰 신호 (App Store)
이 레포 앱의 최근 App Store 고객 리뷰 {{count}}건이 아래 JSON 파일에 있다 (각 원소: id·rating·title·body·territory·createdDate):
{{file}}
- 1단계 신호 수집에서 이 파일을 반드시 읽어 사용자 불만/요청을 신호로 포함하라. 리뷰가 다국어면 요지를 요약/번역해 다뤄라.
- 리뷰에서 비롯한 근거는 { "kind": "asc_review", "ref": "<리뷰 id> ★<별점> <territory>", "summary": "<리뷰가 말하는 것 한 줄>" } 형식으로 evidence 에 넣어라.
- 같은 불만이 여러 리뷰에 반복되면 그만큼 impact 를 높게 봐라 — 반복 횟수를 problem 에 적어라.
`,
    "pt-BR": `
## Sinal de avaliações da loja (App Store)
As {{count}} avaliações de clientes mais recentes na App Store do app deste repo estão no arquivo JSON abaixo (cada elemento: id·rating·title·body·territory·createdDate):
{{file}}
- Na coleta de sinais do passo 1, você deve ler este arquivo e incluir reclamações/pedidos dos usuários como sinais. Se as avaliações forem multilíngues, resuma/traduza o essencial.
- Coloque as evidências derivadas das avaliações em evidence como { "kind": "asc_review", "ref": "<id da avaliação> ★<nota> <territory>", "summary": "<o que a avaliação diz, uma linha>" }.
- Se a mesma reclamação se repetir em várias avaliações, aumente impact proporcionalmente — anote a contagem de repetições em problem.
`,
    ru: `
## Сигнал отзывов магазина (App Store)
Самые свежие {{count}} отзывов клиентов App Store о приложении этого репозитория — в JSON-файле ниже (каждый элемент: id·rating·title·body·territory·createdDate):
{{file}}
- На шаге 1 сбора сигналов обязательно прочитайте этот файл и включите жалобы/запросы пользователей как сигналы. Если отзывы многоязычны, обобщите/переведите суть.
- Доказательства из отзывов помещайте в evidence как { "kind": "asc_review", "ref": "<id отзыва> ★<оценка> <territory>", "summary": "<что говорит отзыв, одна строка>" }.
- Если та же жалоба повторяется в нескольких отзывах, поднимите impact соответственно — укажите число повторов в problem.
`,
    "zh-Hans": `
## 商店评价信号(App Store)
本仓库应用最近的 {{count}} 条 App Store 客户评价位于下方 JSON 文件中(每个元素: id·rating·title·body·territory·createdDate):
{{file}}
- 在第 1 步信号收集中必须读取此文件,并将用户抱怨/请求纳入为信号。若评价为多语言,请概括/翻译其要点。
- 将源自评价的依据以 { "kind": "asc_review", "ref": "<评价 id> ★<评分> <territory>", "summary": "<评价所述,一行>" } 形式放入 evidence。
- 若同一抱怨在多条评价中重复,则相应提高 impact——并在 problem 中写明重复次数。
`,
  },

  "collect.crashSignals": {
    ar: `
## إشارة الأعطال (App Store — استقرار التطبيق المُطلق)
أحدث تجميع للأعطال لتطبيق هذا المستودع ({{from}} ~ {{to}}، الإجمالي {{totalCrashes}}، تقرير ASC Analytics «App Crashes») موجود في ملف JSON أدناه (from·to·totalCrashes·groups[]: appVersion·device·platformVersion·crashes·uniqueDevices):
{{file}}
- في تجميع المرحلة 1 اقرأ هذا الملف حتماً. العطل أسرع إشارة شكوى «قبل» أن يخبر المستخدم بمراجعة — المجموعات الكبيرة مرشّحة بحد ذاتها لبريف فرصة، و«تعطُّل التطبيق» أولى من اقتراح الميزات.
- ضع الأدلة المستمدة من الأعطال في evidence بصيغة { "kind": "crash", "ref": "<appVersion> <device> <from>..<to>", "summary": "<حجم/اتجاه العطل في سطر>" }.
- إن تركّزت الأعطال في إصدار/جهاز معيّن فارفع impact — اكتب العدد ونمط التركّز في problem. وإن لاحت فرضية سبب بالتقاطع مع كوميتات/مراجعات حديثة فضعها في spec.
`,
    en: `
## Crash signal (App Store — shipped app stability)
The most recent crash aggregation for this repo's app ({{from}} ~ {{to}}, {{totalCrashes}} total, ASC Analytics «App Crashes» report) is in the JSON file below (from·to·totalCrashes·groups[]: appVersion·device·platformVersion·crashes·uniqueDevices):
{{file}}
- In step-1 signal collection you must read this file. A crash is the fastest complaint signal «before» a user tells you via a review — a large-count group is itself an opportunity-brief candidate, and «the app crashing» takes priority over feature proposals.
- Put evidence derived from crashes into evidence as { "kind": "crash", "ref": "<appVersion> <device> <from>..<to>", "summary": "<crash scale/trend, one line>" }.
- If crashes concentrate on a specific version/device, raise impact — note the count and concentration pattern in problem. If a cause hypothesis appears by cross-referencing recent commits/reviews, put it in spec.
`,
    es: `
## Señal de fallos (App Store — estabilidad de la app lanzada)
La agregación de fallos más reciente de la app de este repo ({{from}} ~ {{to}}, {{totalCrashes}} en total, informe ASC Analytics «App Crashes») está en el archivo JSON de abajo (from·to·totalCrashes·groups[]: appVersion·device·platformVersion·crashes·uniqueDevices):
{{file}}
- En la recopilación de señales del paso 1 debes leer este archivo. Un fallo es la señal de queja más rápida «antes» de que un usuario lo diga por una reseña — un grupo de alto recuento es por sí mismo candidato a brief de oportunidad, y «que la app se cierre» tiene prioridad sobre propuestas de funciones.
- Pon la evidencia derivada de fallos en evidence como { "kind": "crash", "ref": "<appVersion> <device> <from>..<to>", "summary": "<escala/tendencia del fallo, una línea>" }.
- Si los fallos se concentran en una versión/dispositivo específico, sube impact — anota el recuento y el patrón de concentración en problem. Si aparece una hipótesis de causa al cruzar commits/reseñas recientes, ponla en spec.
`,
    fr: `
## Signal de plantage (App Store — stabilité de l'app livrée)
L'agrégation de plantages la plus récente pour l'app de ce dépôt ({{from}} ~ {{to}}, {{totalCrashes}} au total, rapport ASC Analytics «App Crashes») est dans le fichier JSON ci-dessous (from·to·totalCrashes·groups[]: appVersion·device·platformVersion·crashes·uniqueDevices):
{{file}}
- Dans la collecte de signaux de l'étape 1, tu dois lire ce fichier. Un plantage est le signal de plainte le plus rapide «avant» qu'un utilisateur ne le dise par un avis — un groupe à fort comptage est en soi un candidat de brief d'opportunité, et «l'app qui plante» prime sur les propositions de fonctionnalités.
- Place les preuves issues des plantages dans evidence sous forme { "kind": "crash", "ref": "<appVersion> <device> <from>..<to>", "summary": "<ampleur/tendance du plantage, une ligne>" }.
- Si les plantages se concentrent sur une version/un appareil précis, augmente impact — note le comptage et le motif de concentration dans problem. Si une hypothèse de cause apparaît en recoupant commits/avis récents, mets-la dans spec.
`,
    hi: `
## क्रैश संकेत (App Store — जारी ऐप की स्थिरता)
इस रेपो की ऐप का नवीनतम क्रैश समुच्चय ({{from}} ~ {{to}}, कुल {{totalCrashes}}, ASC Analytics «App Crashes» रिपोर्ट) नीचे दी JSON फ़ाइल में है (from·to·totalCrashes·groups[]: appVersion·device·platformVersion·crashes·uniqueDevices):
{{file}}
- चरण-1 संकेत संग्रह में यह फ़ाइल अवश्य पढ़ें। क्रैश वह सबसे तेज़ शिकायत-संकेत है जो उपयोगकर्ता द्वारा समीक्षा से बताने «से पहले» मिलता है — बड़े-गणना वाला समूह स्वयं एक अवसर-ब्रीफ़ उम्मीदवार है, और «ऐप का क्रैश होना» फ़ीचर प्रस्तावों पर प्राथमिकता रखता है।
- क्रैश से प्राप्त साक्ष्य को evidence में { "kind": "crash", "ref": "<appVersion> <device> <from>..<to>", "summary": "<क्रैश का पैमाना/प्रवृत्ति, एक पंक्ति>" } रूप में डालें।
- यदि क्रैश किसी विशेष संस्करण/डिवाइस पर केंद्रित हों तो impact बढ़ाएँ — गणना व केंद्रीकरण पैटर्न problem में लिखें। हाल के commits/समीक्षाओं से क्रॉस करने पर कारण-परिकल्पना दिखे तो उसे spec में डालें।
`,
    ja: `
## クラッシュ信号(App Store — リリース済みアプリの安定性)
このリポジトリのアプリの最新クラッシュ集計({{from}} ~ {{to}}、合計 {{totalCrashes}} 件、ASC Analytics「App Crashes」レポート)が下の JSON ファイルにある(from·to·totalCrashes·groups[]: appVersion·device·platformVersion·crashes·uniqueDevices):
{{file}}
- ステップ1の信号収集でこのファイルを必ず読め。クラッシュはユーザーがレビューで言う「前」の最速の不満信号だ — 集計の大きいグループはそれ自体が機会ブリーフの候補であり、「アプリが落ちる問題」は機能提案より優先する。
- クラッシュ由来の根拠は evidence に { "kind": "crash", "ref": "<appVersion> <device> <from>..<to>", "summary": "<クラッシュの規模/傾向を一行>" } の形式で入れよ。
- 特定のバージョン·デバイスにクラッシュが集中していれば impact を高く見よ — 件数と集中パターンを problem に書け。最近のコミット/レビューと突き合わせて原因仮説が見えれば spec に入れよ。
`,
    ko: `
## 크래시 신호 (App Store — 출시 앱 안정성)
이 레포 앱의 최근 크래시 집계({{from}} ~ {{to}}, 총 {{totalCrashes}}건, ASC Analytics «App Crashes» 보고서)가 아래 JSON 파일에 있다 (from·to·totalCrashes·groups[]: appVersion·device·platformVersion·crashes·uniqueDevices):
{{file}}
- 1단계 신호 수집에서 이 파일을 반드시 읽어라. 크래시는 사용자가 리뷰로 말하기 «전» 의 가장 빠른 불만 신호다 — 집계가 큰 그룹은 그 자체로 기회 브리프 후보이며, «앱이 죽는 문제» 는 기능 제안보다 우선한다.
- 크래시에서 비롯한 근거는 { "kind": "crash", "ref": "<appVersion> <device> <from>..<to>", "summary": "<크래시 규모/경향 한 줄>" } 형식으로 evidence 에 넣어라.
- 특정 버전·디바이스에 크래시가 몰려 있으면 impact 를 높게 봐라 — 건수와 집중 패턴을 problem 에 적어라. 최근 커밋/리뷰와 교차해 원인 가설이 보이면 spec 에 담아라.
`,
    "pt-BR": `
## Sinal de crash (App Store — estabilidade do app lançado)
A agregação de crashes mais recente do app deste repo ({{from}} ~ {{to}}, {{totalCrashes}} no total, relatório ASC Analytics «App Crashes») está no arquivo JSON abaixo (from·to·totalCrashes·groups[]: appVersion·device·platformVersion·crashes·uniqueDevices):
{{file}}
- Na coleta de sinais do passo 1, você deve ler este arquivo. Um crash é o sinal de reclamação mais rápido «antes» de o usuário avisar por uma avaliação — um grupo de alta contagem é por si só candidato a brief de oportunidade, e «o app travar» tem prioridade sobre propostas de recursos.
- Coloque as evidências derivadas de crashes em evidence como { "kind": "crash", "ref": "<appVersion> <device> <from>..<to>", "summary": "<escala/tendência do crash, uma linha>" }.
- Se os crashes se concentrarem em uma versão/dispositivo específico, aumente impact — anote a contagem e o padrão de concentração em problem. Se surgir uma hipótese de causa ao cruzar commits/avaliações recentes, coloque-a em spec.
`,
    ru: `
## Сигнал сбоев (App Store — стабильность выпущенного приложения)
Самая свежая агрегация сбоев приложения этого репозитория ({{from}} ~ {{to}}, всего {{totalCrashes}}, отчёт ASC Analytics «App Crashes») — в JSON-файле ниже (from·to·totalCrashes·groups[]: appVersion·device·platformVersion·crashes·uniqueDevices):
{{file}}
- На шаге 1 сбора сигналов обязательно прочитайте этот файл. Сбой — самый быстрый сигнал жалобы «до» того, как пользователь скажет в отзыве — группа с большим числом сама по себе кандидат на бриф возможности, а «падение приложения» приоритетнее предложений функций.
- Доказательства из сбоев помещайте в evidence как { "kind": "crash", "ref": "<appVersion> <device> <from>..<to>", "summary": "<масштаб/тенденция сбоя, одна строка>" }.
- Если сбои концентрируются на конкретной версии/устройстве, поднимите impact — укажите число и характер концентрации в problem. Если при сопоставлении с недавними коммитами/отзывами видна гипотеза причины, поместите её в spec.
`,
    "zh-Hans": `
## 崩溃信号(App Store — 已发布应用稳定性)
本仓库应用最近的崩溃汇总({{from}} ~ {{to}},共 {{totalCrashes}} 起,ASC Analytics「App Crashes」报告)位于下方 JSON 文件中(from·to·totalCrashes·groups[]: appVersion·device·platformVersion·crashes·uniqueDevices):
{{file}}
- 在第 1 步信号收集中必须读取此文件。崩溃是用户通过评价告知「之前」最快的抱怨信号——计数大的分组本身就是机会简报候选,而「应用崩溃」优先于功能提案。
- 将源自崩溃的依据以 { "kind": "crash", "ref": "<appVersion> <device> <from>..<to>", "summary": "<崩溃规模/趋势,一行>" } 形式放入 evidence。
- 若崩溃集中在特定版本·设备上,则提高 impact——并在 problem 中写明数量与集中模式。若与近期提交/评价交叉后出现原因假设,请写入 spec。
`,
  },

  "collect.history": {
    ar: `
## ملخص القرارات السابقة (سجل إنجاز هذا المستودع التراكمي — تعديل الدرجات/الاتجاه)
أدناه بريفات سابقة قرّرها الإنسان فعلاً أو جرى التحقق منها بعد الإطلاق. كل سطر: [القرار/النتيجة] impact/effort · العنوان (· السند). عدّل درجات واتجاه الاقتراحات الجديدة وفق هذا التقييم التراكمي:
{{historyList}}

إرشادات التعديل:
- لا تقترح أنواعاً تشبه ما «رُفض». وإن كان هناك سبب للاقتراح رغم ذلك فبيّن في problem «بماذا يختلف عن الرفض السابق» في سطر.
- اقترح بحماسة أكبر الأنواع التي نجحت بـ«التحقق»، وقدّر impact بسخاء وفق تقييم الإنسان السابق.
- «الإخفاق» نوع اعتُمد لكن فرضيته أخفقت — لا تكرر الخطأ نفسه وقدّر الاقتراحات المشابهة بحذر.
- اضبط impact/effort للاقتراحات الجديدة على مستوى الدرجات التي منحها الإنسان «للحالات المشابهة» أعلاه — لا تقدّر بالحدس.
- لكن إن تعارض «توجيه المستخدم (هذه الجولة)» أعلاه مع الأنماط السابقة، فتوجيه هذه الجولة هو الأولى.
`,
    en: `
## Past-decision summary (this repo's cumulative scorecard — score/direction calibration)
Below are past briefs a human already decided on or that were verified post-launch. Each line: [decision/result] impact/effort · title (· rationale). Calibrate the score and direction of new proposals to this cumulative assessment:
{{historyList}}

Calibration guidance:
- Do not propose kinds similar to what was «rejected». If you still have a reason to propose, state in problem in one line «how it differs from the past rejection».
- Propose more actively the kinds that succeeded as «verified», and score impact generously in line with the past human assessment.
- «Missed» is a kind that was approved but whose hypothesis missed — do not repeat the same mistake, and score similar proposals cautiously.
- Set impact/effort of new proposals at the level the human gave to the «similar cases» above — do not score by gut.
- However, if the «user directive (this round)» above conflicts with past patterns, this round's directive takes priority.
`,
    es: `
## Resumen de decisiones pasadas (tarjeta de resultados acumulada de este repo — calibración de puntaje/dirección)
Abajo hay briefs pasados que un humano ya decidió o que se verificaron tras el lanzamiento. Cada línea: [decisión/resultado] impact/effort · título (· justificación). Calibra el puntaje y la dirección de las nuevas propuestas a esta evaluación acumulada:
{{historyList}}

Guía de calibración:
- No propongas tipos similares a lo «rechazado». Si aun así tienes razón para proponer, indica en problem en una línea «en qué difiere del rechazo pasado».
- Propón más activamente los tipos que tuvieron éxito como «verificado», y puntúa impact con generosidad acorde a la evaluación humana pasada.
- «Fallido» es un tipo que se aprobó pero cuya hipótesis falló — no repitas el mismo error y puntúa con cautela las propuestas similares.
- Fija impact/effort de las nuevas propuestas al nivel que el humano dio a los «casos similares» de arriba — no puntúes por intuición.
- No obstante, si la «directiva del usuario (esta ronda)» de arriba choca con patrones pasados, la directiva de esta ronda tiene prioridad.
`,
    fr: `
## Résumé des décisions passées (bilan cumulé de ce dépôt — calibrage score/direction)
Ci-dessous des briefs passés qu'un humain a déjà tranchés ou qui ont été vérifiés après lancement. Chaque ligne: [décision/résultat] impact/effort · titre (· justification). Calibre le score et la direction des nouvelles propositions sur cette évaluation cumulée:
{{historyList}}

Guide de calibrage:
- Ne propose pas de types similaires à ce qui a été «rejeté». Si tu as malgré tout une raison de proposer, indique dans problem en une ligne «en quoi cela diffère du rejet passé».
- Propose plus activement les types qui ont réussi en «vérifié», et note impact généreusement en accord avec l'évaluation humaine passée.
- «Manqué» est un type approuvé mais dont l'hypothèse a échoué — ne répète pas la même erreur et note les propositions similaires avec prudence.
- Fixe impact/effort des nouvelles propositions au niveau que l'humain a donné aux «cas similaires» ci-dessus — ne note pas au feeling.
- Toutefois, si la «directive utilisateur (ce tour)» ci-dessus entre en conflit avec les schémas passés, la directive de ce tour prime.
`,
    hi: `
## पिछले निर्णयों का सारांश (इस रेपो का संचयी स्कोरकार्ड — स्कोर/दिशा अंशांकन)
नीचे पिछले ब्रीफ़ हैं जिन पर मानव पहले ही निर्णय कर चुका या जो लॉन्च के बाद सत्यापित हुए। प्रत्येक पंक्ति: [निर्णय/परिणाम] impact/effort · शीर्षक (· कारण)। नए प्रस्तावों के स्कोर व दिशा को इस संचयी मूल्यांकन के अनुरूप अंशांकित करें:
{{historyList}}

अंशांकन मार्गदर्शन:
- «अस्वीकृत» जैसे प्रकार न प्रस्तावित करें। फिर भी प्रस्ताव का कारण हो तो problem में एक पंक्ति में बताएँ «पिछले अस्वीकरण से यह कैसे भिन्न है»।
- «सत्यापित» के रूप में सफल प्रकारों को अधिक सक्रियता से प्रस्तावित करें, और पिछले मानव मूल्यांकन के अनुरूप impact उदारता से दें।
- «चूक गया» वह प्रकार है जो स्वीकृत हुआ पर जिसकी परिकल्पना चूक गई — वही गलती न दोहराएँ और समान प्रस्तावों को सावधानी से स्कोर करें।
- नए प्रस्तावों का impact/effort ऊपर दिए «समान मामलों» को मानव द्वारा दिए स्तर पर रखें — अनुमान से स्कोर न करें।
- परंतु यदि ऊपर का «उपयोगकर्ता निर्देश (इस दौर)» पिछले पैटर्न से टकराए, तो इस दौर का निर्देश प्राथमिकता रखता है।
`,
    ja: `
## 過去の決定サマリ(このリポジトリの累積成績表 — スコア·方向の補正)
以下は人がすでに決定したか、リリース後に検証された過去ブリーフだ。各行: [決定/結果] impact/effort · タイトル (· 根拠)。新提案のスコアと方向をこの累積評価に合わせて補正せよ:
{{historyList}}

補正の指針:
- 「却下」されたものに似た種類は提案するな。それでも提案する理由があれば、problem に「過去の却下と何が違うか」を一行で示せ。
- 「検証済み」で成功した種類はより積極的に提案し、過去の人の評価に合わせて impact を高めに見よ。
- 「外れ」は承認されたが仮説が外れた種類だ — 同じ過ちを繰り返さず、似た提案は慎重にスコアせよ。
- 新提案の impact/effort は上の「類似ケース」に人が付けたスコア水準に合わせよ — 勘で付けるな。
- ただし、上の「ユーザー指示(今回)」が過去パターンと衝突する場合は、今回の指示が優先する。
`,
    ko: `
## 과거 결정 요약 (이 레포의 누적 성적표 — 점수·방향 보정)
아래는 사람이 이미 결정했거나 출시 후 검증된 과거 브리프다. 각 줄: [결정/결과] impact/effort · 제목 (· 근거). 새 제안의 점수와 방향을 이 누적 평가에 맞춰 보정하라:
{{historyList}}

보정 지침:
- «기각» 된 것과 비슷한 종류는 제안하지 마라. 그래도 제안할 이유가 있으면 problem 에 «과거 기각과 무엇이 다른지» 를 한 줄로 밝혀라.
- «검증됨» 으로 성공한 종류는 더 적극적으로 제안하고, 점수(impact)를 과거 사람 평가에 맞춰 후하게 봐라.
- «빗나감» 은 승인됐지만 가설이 빗나간 종류다 — 같은 실수를 반복하지 말고 비슷한 제안은 신중히 점수 매겨라.
- 새 제안의 impact/effort 는 위 «유사 건» 에 사람이 매긴 점수 수준에 맞춘다 — 감으로 매기지 마라.
- 단, 위 «사용자 지시(이번 회차)» 가 과거 패턴과 충돌하면 이번 회차 지시가 우선이다.
`,
    "pt-BR": `
## Resumo de decisões passadas (placar acumulado deste repo — calibração de pontuação/direção)
Abaixo estão briefs anteriores que um humano já decidiu ou que foram verificados pós-lançamento. Cada linha: [decisão/resultado] impact/effort · título (· justificativa). Calibre a pontuação e a direção das novas propostas a esta avaliação acumulada:
{{historyList}}

Guia de calibração:
- Não proponha tipos semelhantes ao que foi «rejeitado». Se ainda assim tiver motivo para propor, indique em problem, em uma linha, «em que difere da rejeição anterior».
- Proponha mais ativamente os tipos que tiveram sucesso como «verificado», e pontue impact generosamente conforme a avaliação humana anterior.
- «Não atingido» é um tipo que foi aprovado mas cuja hipótese falhou — não repita o mesmo erro e pontue propostas semelhantes com cautela.
- Defina impact/effort das novas propostas no nível que o humano deu aos «casos semelhantes» acima — não pontue no chute.
- Contudo, se a «diretiva do usuário (esta rodada)» acima conflitar com padrões passados, a diretiva desta rodada tem prioridade.
`,
    ru: `
## Сводка прошлых решений (накопленная оценочная карта этого репозитория — калибровка оценки/направления)
Ниже — прошлые брифы, по которым человек уже принял решение или которые были проверены после выпуска. Каждая строка: [решение/результат] impact/effort · заголовок (· обоснование). Откалибруйте оценку и направление новых предложений по этой накопленной оценке:
{{historyList}}

Руководство по калибровке:
- Не предлагайте типы, похожие на «отклонённые». Если всё же есть причина предложить, укажите в problem одной строкой, «чем это отличается от прошлого отклонения».
- Активнее предлагайте типы, успешные как «проверено», и оценивайте impact щедро в соответствии с прошлой оценкой человека.
- «Не оправдалось» — это тип, который одобрили, но чья гипотеза не оправдалась — не повторяйте ту же ошибку и осторожно оценивайте похожие предложения.
- Задавайте impact/effort новых предложений на уровне, который человек дал «похожим случаям» выше — не оценивайте на глаз.
- Однако если «директива пользователя (этот раунд)» выше конфликтует с прошлыми паттернами, приоритет у директивы этого раунда.
`,
    "zh-Hans": `
## 过往决策摘要(本仓库累积成绩单——分数/方向校准)
以下是人已做出决定或发布后已验证的过往简报。每行: [决定/结果] impact/effort · 标题 (· 依据)。将新提案的分数与方向校准到此累积评估:
{{historyList}}

校准指引:
- 不要提出与「已拒绝」相似的类型。若仍有理由提出,请在 problem 中用一行说明「与过往拒绝有何不同」。
- 对以「已验证」成功的类型更积极地提出,并按过往人评从宽给出 impact。
- 「未命中」是已批准但假设未命中的类型——不要重复同样的错误,对相似提案谨慎评分。
- 将新提案的 impact/effort 设定在上方「相似案例」中人所给的水平——不要凭感觉评分。
- 但若上方「用户指示(本轮)」与过往模式冲突,则以本轮指示为优先。
`,
  },

  "collect.githubFeedback": {
    ar: "- إشارة GitHub (مستودع التغذية الراجعة: {{fbRepo}}): تتجمع تغذية المستخدمين الراجعة (أسئلة·أخطاء·أفكار·Show&Tell) ليس في origin مستودع التطوير هذا بل في مستودع التغذية الراجعة العام `{{fbRepo}}` — اقرأ «ذلك المستودع» عبر `gh` CLI (ليس origin المحلي): القضايا المفتوحة (`gh issue list -R {{fbRepo}} --limit 30 --json number,title,body,labels,comments`)، Discussions (`gh api repos/{{fbRepo}}/discussions` أو GraphQL)، المتابعات غير المحلولة لقضايا أُغلقت مؤخراً (`gh issue list -R {{fbRepo}} --state closed --limit 20 ...`). إشارات الكود·TODO·git·الوثائق تبقى على أساس «المستودع المحلي» كما في البنود أدناه.",
    en: "- GitHub signal (feedback repo: {{fbRepo}}): user feedback (questions·bugs·ideas·Show&Tell) is gathered not in this dev repo's origin but in the public feedback repo `{{fbRepo}}` — read «that repo» via the `gh` CLI (not the local origin): open issues (`gh issue list -R {{fbRepo}} --limit 30 --json number,title,body,labels,comments`), Discussions (`gh api repos/{{fbRepo}}/discussions` or GraphQL), unresolved follow-ups of recently closed issues (`gh issue list -R {{fbRepo}} --state closed --limit 20 ...`). Code·TODO·git·doc signals remain based on the «local repo» per the items below.",
    es: "- Señal de GitHub (repo de feedback: {{fbRepo}}): el feedback de usuarios (preguntas·bugs·ideas·Show&Tell) se reúne no en el origin de este repo de desarrollo sino en el repo público de feedback `{{fbRepo}}` — lee «ese repo» con el CLI `gh` (no el origin local): issues abiertos (`gh issue list -R {{fbRepo}} --limit 30 --json number,title,body,labels,comments`), Discussions (`gh api repos/{{fbRepo}}/discussions` o GraphQL), seguimientos no resueltos de issues cerrados recientemente (`gh issue list -R {{fbRepo}} --state closed --limit 20 ...`). Las señales de código·TODO·git·docs siguen basándose en el «repo local» según los puntos de abajo.",
    fr: "- Signal GitHub (dépôt de feedback: {{fbRepo}}): le feedback des utilisateurs (questions·bugs·idées·Show&Tell) est rassemblé non pas dans l'origin de ce dépôt de dev mais dans le dépôt public de feedback `{{fbRepo}}` — lis «ce dépôt» via le CLI `gh` (pas l'origin local): issues ouvertes (`gh issue list -R {{fbRepo}} --limit 30 --json number,title,body,labels,comments`), Discussions (`gh api repos/{{fbRepo}}/discussions` ou GraphQL), suivis non résolus d'issues récemment fermées (`gh issue list -R {{fbRepo}} --state closed --limit 20 ...`). Les signaux code·TODO·git·docs restent basés sur le «dépôt local» selon les points ci-dessous.",
    hi: "- GitHub संकेत (फ़ीडबैक रेपो: {{fbRepo}}): उपयोगकर्ता फ़ीडबैक (प्रश्न·बग·विचार·Show&Tell) इस डेव रेपो के origin में नहीं बल्कि सार्वजनिक फ़ीडबैक रेपो `{{fbRepo}}` में जुटता है — «उस रेपो» को `gh` CLI से पढ़ें (स्थानीय origin नहीं): खुले issues (`gh issue list -R {{fbRepo}} --limit 30 --json number,title,body,labels,comments`), Discussions (`gh api repos/{{fbRepo}}/discussions` या GraphQL), हाल में बंद हुए issues के अनसुलझे फ़ॉलो-अप (`gh issue list -R {{fbRepo}} --state closed --limit 20 ...`)। कोड·TODO·git·दस्तावेज़ संकेत नीचे दिए मदों के अनुसार «स्थानीय रेपो» पर आधारित रहते हैं।",
    ja: "- GitHub 信号(フィードバック repo: {{fbRepo}}): ユーザーフィードバック(質問·バグ·アイデア·Show&Tell)はこの開発 repo の origin ではなく、公開フィードバック repo `{{fbRepo}}` に集まる — `gh` CLI で「その repo」を読め(ローカル origin ではない): オープン issue(`gh issue list -R {{fbRepo}} --limit 30 --json number,title,body,labels,comments`)、Discussions(`gh api repos/{{fbRepo}}/discussions` または GraphQL)、最近クローズした issue の未解決フォローアップ(`gh issue list -R {{fbRepo}} --state closed --limit 20 ...`)。コード·TODO·git·文書信号は下記の項目どおり「ローカル repo」基準だ。",
    ko: "- GitHub 신호 (피드백 repo: {{fbRepo}}): 사용자 피드백(질문·버그·아이디어·Show&Tell)은 이 개발 레포의 origin 이 아니라 공개 피드백 repo `{{fbRepo}}` 에 모인다 — `gh` CLI 로 «그 repo» 를 읽어라(로컬 origin 이 아니다): 열린 이슈(`gh issue list -R {{fbRepo}} --limit 30 --json number,title,body,labels,comments`), Discussions(`gh api repos/{{fbRepo}}/discussions` 또는 GraphQL), 최근 닫힌 이슈의 미해결 후속(`gh issue list -R {{fbRepo}} --state closed --limit 20 ...`). 코드·TODO·git·문서 신호는 아래 항목대로 «로컬 레포» 기준이다.",
    "pt-BR": "- Sinal do GitHub (repo de feedback: {{fbRepo}}): o feedback dos usuários (perguntas·bugs·ideias·Show&Tell) é reunido não no origin deste repo de dev, mas no repo público de feedback `{{fbRepo}}` — leia «esse repo» via CLI `gh` (não o origin local): issues abertas (`gh issue list -R {{fbRepo}} --limit 30 --json number,title,body,labels,comments`), Discussions (`gh api repos/{{fbRepo}}/discussions` ou GraphQL), follow-ups não resolvidos de issues recém-fechadas (`gh issue list -R {{fbRepo}} --state closed --limit 20 ...`). Sinais de código·TODO·git·docs permanecem baseados no «repo local» conforme os itens abaixo.",
    ru: "- Сигнал GitHub (репозиторий обратной связи: {{fbRepo}}): отзывы пользователей (вопросы·баги·идеи·Show&Tell) собираются не в origin этого dev-репозитория, а в публичном репозитории обратной связи `{{fbRepo}}` — читайте «тот репозиторий» через CLI `gh` (не локальный origin): открытые issue (`gh issue list -R {{fbRepo}} --limit 30 --json number,title,body,labels,comments`), Discussions (`gh api repos/{{fbRepo}}/discussions` или GraphQL), нерешённые продолжения недавно закрытых issue (`gh issue list -R {{fbRepo}} --state closed --limit 20 ...`). Сигналы кода·TODO·git·документов остаются на основе «локального репозитория» согласно пунктам ниже.",
    "zh-Hans": "- GitHub 信号(反馈仓库: {{fbRepo}}):用户反馈(问题·bug·想法·Show&Tell)汇集的不是本开发仓库的 origin,而是公开反馈仓库 `{{fbRepo}}`——用 `gh` CLI 读取「那个仓库」(不是本地 origin):开放 issue(`gh issue list -R {{fbRepo}} --limit 30 --json number,title,body,labels,comments`)、Discussions(`gh api repos/{{fbRepo}}/discussions` 或 GraphQL)、近期已关闭 issue 的未解决后续(`gh issue list -R {{fbRepo}} --state closed --limit 20 ...`)。代码·TODO·git·文档信号仍按下方各项以「本地仓库」为准。",
  },
  "collect.githubLocal": {
    ar: "- إشارة GitHub: إن توفّر `gh` CLI وكان هذا المستودع بعيداً على GitHub — القضايا المفتوحة (`gh issue list --limit 30 --json number,title,body,labels,comments`)، أحدث discussions، المتابعات غير المحلولة لقضايا أُغلقت مؤخراً.",
    en: "- GitHub signal: if the `gh` CLI is available and this repo is a GitHub remote — open issues (`gh issue list --limit 30 --json number,title,body,labels,comments`), recent discussions, unresolved follow-ups of recently closed issues.",
    es: "- Señal de GitHub: si el CLI `gh` está disponible y este repo es un remoto de GitHub — issues abiertos (`gh issue list --limit 30 --json number,title,body,labels,comments`), discussions recientes, seguimientos no resueltos de issues cerrados recientemente.",
    fr: "- Signal GitHub: si le CLI `gh` est disponible et que ce dépôt est un distant GitHub — issues ouvertes (`gh issue list --limit 30 --json number,title,body,labels,comments`), discussions récentes, suivis non résolus d'issues récemment fermées.",
    hi: "- GitHub संकेत: यदि `gh` CLI उपलब्ध हो और यह रेपो GitHub रिमोट हो — खुले issues (`gh issue list --limit 30 --json number,title,body,labels,comments`), हाल की discussions, हाल में बंद हुए issues के अनसुलझे फ़ॉलो-अप।",
    ja: "- GitHub 信号: `gh` CLI があり、このリポジトリが GitHub リモートなら — オープン issue(`gh issue list --limit 30 --json number,title,body,labels,comments`)、最近の discussions、最近クローズした issue の未解決フォローアップ。",
    ko: "- GitHub 신호: `gh` CLI 가 있고 이 레포가 GitHub 원격이면 — 열린 이슈(`gh issue list --limit 30 --json number,title,body,labels,comments`), 최근 discussions, 최근 닫힌 이슈의 미해결 후속.",
    "pt-BR": "- Sinal do GitHub: se o CLI `gh` estiver disponível e este repo for um remoto do GitHub — issues abertas (`gh issue list --limit 30 --json number,title,body,labels,comments`), discussions recentes, follow-ups não resolvidos de issues recém-fechadas.",
    ru: "- Сигнал GitHub: если доступен CLI `gh` и этот репозиторий — удалённый на GitHub — открытые issue (`gh issue list --limit 30 --json number,title,body,labels,comments`), недавние discussions, нерешённые продолжения недавно закрытых issue.",
    "zh-Hans": "- GitHub 信号:若有 `gh` CLI 且本仓库为 GitHub 远端——开放 issue(`gh issue list --limit 30 --json number,title,body,labels,comments`)、近期 discussions、近期已关闭 issue 的未解决后续。",
  },
  "collect.storeTailDefault": {
    ar: "\n- مراجعات المتجر: ملف JSON في قسم «إشارة مراجعات المتجر» أعلاه.",
    en: "\n- Store reviews: the JSON file in the «Store review signal» section above.",
    es: "\n- Reseñas de la tienda: el archivo JSON de la sección «Señal de reseñas de la tienda» de arriba.",
    fr: "\n- Avis de la boutique: le fichier JSON de la section «Signal des avis de la boutique» ci-dessus.",
    hi: "\n- स्टोर समीक्षाएँ: ऊपर «स्टोर समीक्षा संकेत» खंड की JSON फ़ाइल।",
    ja: "\n- ストアレビュー: 上の「ストアレビュー信号」セクションの JSON ファイル。",
    ko: "\n- 스토어 리뷰: 위 «스토어 리뷰 신호» 섹션의 JSON 파일.",
    "pt-BR": "\n- Avaliações da loja: o arquivo JSON da seção «Sinal de avaliações da loja» acima.",
    ru: "\n- Отзывы магазина: JSON-файл из раздела «Сигнал отзывов магазина» выше.",
    "zh-Hans": "\n- 商店评价: 上方「商店评价信号」一节的 JSON 文件。",
  },
  "collect.storeTailDesign": {
    ar: "\n- مراجعات المتجر: ملف JSON في قسم «إشارة مراجعات المتجر» أعلاه (انتقِ شكاوى التصميم فقط للتعزيز).",
    en: "\n- Store reviews: the JSON file in the «Store review signal» section above (pick only design-related complaints to reinforce).",
    es: "\n- Reseñas de la tienda: el archivo JSON de la sección «Señal de reseñas de la tienda» de arriba (elige solo quejas de diseño para reforzar).",
    fr: "\n- Avis de la boutique: le fichier JSON de la section «Signal des avis de la boutique» ci-dessus (ne retiens que les plaintes liées au design pour renforcer).",
    hi: "\n- स्टोर समीक्षाएँ: ऊपर «स्टोर समीक्षा संकेत» खंड की JSON फ़ाइल (केवल डिज़ाइन-संबंधी शिकायतें चुनकर सुदृढ़ करें)।",
    ja: "\n- ストアレビュー: 上の「ストアレビュー信号」セクションの JSON ファイル(デザイン関連の不満だけ選んで補強)。",
    ko: "\n- 스토어 리뷰: 위 «스토어 리뷰 신호» 섹션의 JSON 파일 (디자인 관련 불만만 골라 보강).",
    "pt-BR": "\n- Avaliações da loja: o arquivo JSON da seção «Sinal de avaliações da loja» acima (escolha apenas reclamações de design para reforçar).",
    ru: "\n- Отзывы магазина: JSON-файл из раздела «Сигнал отзывов магазина» выше (выберите только жалобы по дизайну для усиления).",
    "zh-Hans": "\n- 商店评价: 上方「商店评价信号」一节的 JSON 文件(仅挑选与设计相关的抱怨以增强)。",
  },
  "collect.crashTail": {
    ar: "\n- الأعطال: ملف JSON في قسم «إشارة الأعطال» أعلاه.",
    en: "\n- Crashes: the JSON file in the «Crash signal» section above.",
    es: "\n- Fallos: el archivo JSON de la sección «Señal de fallos» de arriba.",
    fr: "\n- Plantages: le fichier JSON de la section «Signal de plantage» ci-dessus.",
    hi: "\n- क्रैश: ऊपर «क्रैश संकेत» खंड की JSON फ़ाइल।",
    ja: "\n- クラッシュ: 上の「クラッシュ信号」セクションの JSON ファイル。",
    ko: "\n- 크래시: 위 «크래시 신호» 섹션의 JSON 파일.",
    "pt-BR": "\n- Crashes: o arquivo JSON da seção «Sinal de crash» acima.",
    ru: "\n- Сбои: JSON-файл из раздела «Сигнал сбоев» выше.",
    "zh-Hans": "\n- 崩溃: 上方「崩溃信号」一节的 JSON 文件。",
  },

  // ── 기본(default/bug) 본문 ───────────────────────────────────────────────────
  "collect.defaultBody": {
    ar: `{{persona}} مهمتك أن تجد «العمل الجدير بالبناء التالي» في هذا المستودع وتنظّمه في بريفات فرص. لا تعدّل الكود — اقرأ/ابحث فقط.
{{profile}}{{directive}}{{history}}{{verification}}{{storeReviews}}{{crashSignals}}{{designContext}}{{lensBlock}}
## المرحلة 1 — تجميع الإشارات (ما أمكن، وتابع حتى لو فشل بعضها)
{{githubSignal}}
- إشارات داخل المستودع: وثائق المهام/خارطة الطريق التي يستخدمها هذا المستودع (ابحث وفق عرف وثائق المستودع — مثل وثائق todo/roadmap تحت \`docs/\`·\`TODO.md\`·\`ROADMAP.md\`·متتبع القضايا)، تعليقات TODO/FIXME/HACK في الكود (\`grep -rn\`)، قسم خارطة الطريق في README.
- التدفق الأخير: افهم اتجاه العمل الأخير عبر \`git log --oneline -30\` — ولا تعد اقتراح ما هو قيد التنفيذ بالفعل.{{storeTail}}{{crashTail}}

## المرحلة 2 — التركيب: كتابة بريفات الفرص (5 كحد أقصى)
اجمع الإشارات في وحدات «مشكلة/فرصة». متطلبات كل بريف:
- **السند إلزامي**: يجب أن يكون كل بريف قابلاً للتتبّع إلى إشارة رأيتها فعلاً في المرحلة 1. ممنوع الاقتراح التخيّلي بلا سند. اكتب في ref ضمن evidence مرجعاً قابلاً للتحقق (رقم القضية/URL، ملف:سطر، sha الكوميت).
{{dedup}}
- **impact / effort**: عدد صحيح 1~5. impact 5 = متصل مباشرة بقيمة/إيراد المستخدم الأساسي، 1 = طفيف. effort 5 = أسابيع، 1 = نصف يوم.
- **spec**: مستوى يتيح لوكيل آخر بدء التنفيذ فور الاعتماد — قصة المستخدم، معايير القبول (قائمة تحقق)، الحالات الحدّية، اللا-أهداف.
- **معايير قبول التصميم (للبريفات التي تمسّ واجهة المستخدم فقط)**: اعكس «قيود التصميم» أعلاه في معايير قبول spec — «معنى» اللون المستخدم (اتبع رموز/عهود هذا المستودع ولا تخلط المعاني)، i18n للنصوص المعروضة («كامل مجموعة» اللغات المدعومة في هذا المستودع)، الحالات (فارغ/خطأ/تحميل/معطّل/تركيز)، إمكانية الوصول (تسميات·تباين). لا تثبّت لوناً/عدد لغات معيّناً بل عبّر «كما حدّده هذا المستودع». لا تدرجها في البريفات بلا واجهة (daemon·الشبكة·CLI وغيرها).

{{backlog}}

## المرحلة 3 — المخرجات
اكتب ملف «مصفوفة» JSON في المسار التالي (لا تكتب في مكان آخر):
{{outFile}}

مخطط كل عنصر:
{
  "title": "سطر واحد للمشكلة/الفرصة (حتى 80 حرفاً)",
  "problem": "تعريف المشكلة بالتفصيل — مَن، متى، ما الذي يزعج",
  "evidence": [{ "kind": "{{kinds}}", "ref": "مرجع قابل للتحقق", "summary": "ما يقوله هذا السند في سطر" }],
  "impact": 1-5,
  "effort": 1-5,
  "scope": "ما يُنجز هذه المرة / اللا-أهداف",
  "spec": "قصة المستخدم + معايير القبول + الحالات الحدّية (markdown)",
{{dedupSchema}}
}

إن لم يوجد فعلاً ما تقترحه فاكتب مصفوفة فارغة []. بعد كتابة الملف، أنهِ بسطر واحد «اكتمل كتابة N بريف».{{outputDirective}}`,
    en: `{{persona}} Your mission is to find the «next valuable thing to build» in this repo and organize it into opportunity briefs. Do not modify code — only read/investigate.
{{profile}}{{directive}}{{history}}{{verification}}{{storeReviews}}{{crashSignals}}{{designContext}}{{lensBlock}}
## Step 1 — Signal collection (whatever is possible; continue even if some fail)
{{githubSignal}}
- In-repo signals: the to-do/roadmap docs this repo uses (find them per the repo's doc conventions — e.g., todo/roadmap docs under \`docs/\`·\`TODO.md\`·\`ROADMAP.md\`·issue trackers), TODO/FIXME/HACK comments in code (\`grep -rn\`), the roadmap section of README.
- Recent flow: grasp the recent direction of work via \`git log --oneline -30\` — and do not re-propose what is already in progress.{{storeTail}}{{crashTail}}

## Step 2 — Synthesis: write opportunity briefs (up to 5)
Group signals into «problem/opportunity» units. Requirements per brief:
- **Evidence required**: every brief must be traceable to a signal you actually saw in step 1. No imagined proposals without evidence. In evidence's ref, write a verifiable reference (issue number/URL, file:line, commit sha).
{{dedup}}
- **impact / effort**: integers 1~5. impact 5 = directly tied to core user value/revenue, 1 = trivial. effort 5 = weeks, 1 = half a day.
- **spec**: a level at which another agent can start implementation right after approval — user story, acceptance criteria (checklist), edge cases, non-goals.
- **Design acceptance criteria (only for briefs that touch the UI)**: reflect the «Design constraints» above in spec's acceptance criteria — the «meaning» of the colors used (follow this repo's tokens/commitments and do not confuse meanings), i18n of user-facing strings (the «entire set» of locales this repo supports), states (empty/error/loading/disabled/focus), accessibility (labels·contrast). Do not hardcode a specific color/locale count — express it «as this repo defines». Do not add this to briefs with no UI surface (daemon·network·CLI, etc.).

{{backlog}}

## Step 3 — Output
Write a JSON «array» file to the following path (do not write elsewhere):
{{outFile}}

Schema per element:
{
  "title": "one line for the problem/opportunity (within 80 chars)",
  "problem": "detailed problem definition — who, when, what is inconvenient",
  "evidence": [{ "kind": "{{kinds}}", "ref": "verifiable reference", "summary": "what this evidence says, one line" }],
  "impact": 1-5,
  "effort": 1-5,
  "scope": "what is done this time / non-goals",
  "spec": "user story + acceptance criteria + edge cases (markdown)",
{{dedupSchema}}
}

If there is truly nothing to propose, write an empty array []. After writing the file, end with one line: «N briefs written».{{outputDirective}}`,
    es: `{{persona}} Tu misión es encontrar «lo siguiente valioso por construir» en este repo y organizarlo en briefs de oportunidad. No modifiques código — solo lee/investiga.
{{profile}}{{directive}}{{history}}{{verification}}{{storeReviews}}{{crashSignals}}{{designContext}}{{lensBlock}}
## Paso 1 — Recopilación de señales (lo que sea posible; continúa aunque algunas fallen)
{{githubSignal}}
- Señales internas del repo: los documentos de tareas/roadmap que usa este repo (encuéntralos según las convenciones de docs del repo — p. ej., docs de todo/roadmap bajo \`docs/\`·\`TODO.md\`·\`ROADMAP.md\`·issue trackers), comentarios TODO/FIXME/HACK en el código (\`grep -rn\`), la sección de roadmap del README.
- Flujo reciente: capta la dirección reciente del trabajo con \`git log --oneline -30\` — y no vuelvas a proponer lo que ya está en curso.{{storeTail}}{{crashTail}}

## Paso 2 — Síntesis: escribe briefs de oportunidad (hasta 5)
Agrupa las señales en unidades de «problema/oportunidad». Requisitos por brief:
- **Evidencia obligatoria**: todo brief debe ser rastreable a una señal que viste realmente en el paso 1. Sin propuestas imaginadas sin evidencia. En el ref de evidence, escribe una referencia verificable (número de issue/URL, archivo:línea, sha de commit).
{{dedup}}
- **impact / effort**: enteros 1~5. impact 5 = directamente ligado al valor/ingreso central del usuario, 1 = trivial. effort 5 = semanas, 1 = medio día.
- **spec**: un nivel en el que otro agente pueda empezar la implementación justo tras la aprobación — historia de usuario, criterios de aceptación (checklist), casos límite, no-objetivos.
- **Criterios de aceptación de diseño (solo para briefs que tocan la UI)**: refleja las «Restricciones de diseño» de arriba en los criterios de aceptación de spec — el «significado» de los colores usados (sigue los tokens/compromisos de este repo y no confundas significados), i18n de las cadenas visibles (el «conjunto completo» de locales que soporta este repo), estados (vacío/error/carga/deshabilitado/foco), accesibilidad (etiquetas·contraste). No fijes un color/número de locales concreto — exprésalo «como lo define este repo». No lo añadas a briefs sin superficie de UI (daemon·red·CLI, etc.).

{{backlog}}

## Paso 3 — Salida
Escribe un archivo «array» JSON en la siguiente ruta (no escribas en otro lugar):
{{outFile}}

Esquema por elemento:
{
  "title": "una línea para el problema/oportunidad (dentro de 80 caracteres)",
  "problem": "definición detallada del problema — quién, cuándo, qué incomoda",
  "evidence": [{ "kind": "{{kinds}}", "ref": "referencia verificable", "summary": "lo que dice esta evidencia, una línea" }],
  "impact": 1-5,
  "effort": 1-5,
  "scope": "lo que se hace esta vez / no-objetivos",
  "spec": "historia de usuario + criterios de aceptación + casos límite (markdown)",
{{dedupSchema}}
}

Si de verdad no hay nada que proponer, escribe un array vacío []. Tras escribir el archivo, termina con una línea: «N briefs escritos».{{outputDirective}}`,
    fr: `{{persona}} Ta mission est de trouver «la prochaine chose utile à construire» dans ce dépôt et de l'organiser en briefs d'opportunité. Ne modifie pas le code — lis/investigue seulement.
{{profile}}{{directive}}{{history}}{{verification}}{{storeReviews}}{{crashSignals}}{{designContext}}{{lensBlock}}
## Étape 1 — Collecte de signaux (tout ce qui est possible; continue même si certains échouent)
{{githubSignal}}
- Signaux internes au dépôt: les docs de tâches/roadmap qu'utilise ce dépôt (trouve-les selon les conventions de docs du dépôt — p. ex. docs todo/roadmap sous \`docs/\`·\`TODO.md\`·\`ROADMAP.md\`·issue trackers), les commentaires TODO/FIXME/HACK dans le code (\`grep -rn\`), la section roadmap du README.
- Flux récent: saisis la direction récente du travail via \`git log --oneline -30\` — et ne re-propose pas ce qui est déjà en cours.{{storeTail}}{{crashTail}}

## Étape 2 — Synthèse: écris des briefs d'opportunité (jusqu'à 5)
Regroupe les signaux en unités «problème/opportunité». Exigences par brief:
- **Preuve obligatoire**: chaque brief doit être traçable à un signal que tu as réellement vu à l'étape 1. Pas de propositions imaginées sans preuve. Dans le ref de evidence, écris une référence vérifiable (numéro d'issue/URL, fichier:ligne, sha de commit).
{{dedup}}
- **impact / effort**: entiers 1~5. impact 5 = directement lié à la valeur/au revenu central de l'utilisateur, 1 = mineur. effort 5 = semaines, 1 = une demi-journée.
- **spec**: un niveau auquel un autre agent peut commencer l'implémentation juste après l'approbation — user story, critères d'acceptation (checklist), cas limites, non-objectifs.
- **Critères d'acceptation de design (seulement pour les briefs qui touchent l'UI)**: reflète les «Contraintes de design» ci-dessus dans les critères d'acceptation de spec — le «sens» des couleurs utilisées (suis les tokens/engagements de ce dépôt et ne confonds pas les sens), i18n des chaînes visibles (l'«ensemble complet» des locales prises en charge par ce dépôt), états (vide/erreur/chargement/désactivé/focus), accessibilité (libellés·contraste). Ne fige pas une couleur/un nombre de locales précis — exprime-le «tel que ce dépôt le définit». Ne l'ajoute pas aux briefs sans surface UI (daemon·réseau·CLI, etc.).

{{backlog}}

## Étape 3 — Sortie
Écris un fichier «tableau» JSON au chemin suivant (n'écris pas ailleurs):
{{outFile}}

Schéma par élément:
{
  "title": "une ligne pour le problème/l'opportunité (dans les 80 caractères)",
  "problem": "définition détaillée du problème — qui, quand, ce qui gêne",
  "evidence": [{ "kind": "{{kinds}}", "ref": "référence vérifiable", "summary": "ce que dit cette preuve, une ligne" }],
  "impact": 1-5,
  "effort": 1-5,
  "scope": "ce qui est fait cette fois / non-objectifs",
  "spec": "user story + critères d'acceptation + cas limites (markdown)",
{{dedupSchema}}
}

S'il n'y a vraiment rien à proposer, écris un tableau vide []. Après avoir écrit le fichier, termine par une ligne: «N briefs écrits».{{outputDirective}}`,
    hi: `{{persona}} आपका कार्य इस रेपो में «अगली बनाने योग्य मूल्यवान चीज़» खोजकर उसे अवसर-ब्रीफ़ में संगठित करना है। कोड न बदलें — केवल पढ़ें/जाँचें।
{{profile}}{{directive}}{{history}}{{verification}}{{storeReviews}}{{crashSignals}}{{designContext}}{{lensBlock}}
## चरण 1 — संकेत संग्रह (जो संभव हो; कुछ विफल हों तो भी जारी रखें)
{{githubSignal}}
- रेपो-आंतरिक संकेत: इस रेपो द्वारा उपयोग किए जाने वाले to-do/roadmap दस्तावेज़ (रेपो की दस्तावेज़ परंपरा के अनुसार खोजें — जैसे \`docs/\` के अंतर्गत todo/roadmap दस्तावेज़·\`TODO.md\`·\`ROADMAP.md\`·issue tracker), कोड में TODO/FIXME/HACK टिप्पणियाँ (\`grep -rn\`), README का roadmap खंड।
- हाल का प्रवाह: \`git log --oneline -30\` से हाल की कार्य-दिशा समझें — और जो पहले से प्रगति पर है उसे दोबारा प्रस्तावित न करें।{{storeTail}}{{crashTail}}

## चरण 2 — संश्लेषण: अवसर-ब्रीफ़ लिखें (अधिकतम 5)
संकेतों को «समस्या/अवसर» इकाइयों में समूहित करें। प्रत्येक ब्रीफ़ की अपेक्षाएँ:
- **साक्ष्य अनिवार्य**: हर ब्रीफ़ चरण 1 में वास्तव में देखे गए संकेत तक पता-योग्य होना चाहिए। बिना साक्ष्य काल्पनिक प्रस्ताव नहीं। evidence के ref में सत्यापन-योग्य संदर्भ लिखें (issue संख्या/URL, फ़ाइल:लाइन, commit sha)।
{{dedup}}
- **impact / effort**: पूर्णांक 1~5। impact 5 = मूल उपयोगकर्ता मूल्य/राजस्व से सीधे जुड़ा, 1 = मामूली। effort 5 = सप्ताह, 1 = आधा दिन।
- **spec**: ऐसा स्तर जहाँ स्वीकृति के तुरंत बाद कोई अन्य एजेंट कार्यान्वयन शुरू कर सके — यूज़र स्टोरी, स्वीकृति मानदंड (चेकलिस्ट), किनारे के मामले, गैर-लक्ष्य।
- **डिज़ाइन स्वीकृति मानदंड (केवल UI को छूने वाले ब्रीफ़)**: ऊपर की «डिज़ाइन प्रतिबंध» को spec के स्वीकृति मानदंड में दर्शाएँ — प्रयुक्त रंगों का «अर्थ» (इस रेपो के टोकन/प्रतिबद्धता का पालन करें और अर्थ न मिलाएँ), दिखने वाले स्ट्रिंग्स का i18n (इस रेपो द्वारा समर्थित लोकेल का «पूरा समुच्चय»), स्थितियाँ (खाली/त्रुटि/लोडिंग/निष्क्रिय/फोकस), एक्सेसिबिलिटी (लेबल·कंट्रास्ट)। किसी विशेष रंग/लोकेल-संख्या को न जड़ें — «जैसा यह रेपो तय करता है» वैसा व्यक्त करें। बिना UI सतह वाले ब्रीफ़ (daemon·नेटवर्क·CLI आदि) में न जोड़ें।

{{backlog}}

## चरण 3 — आउटपुट
निम्न पथ पर JSON «array» फ़ाइल लिखें (अन्यत्र न लिखें):
{{outFile}}

प्रत्येक तत्व का स्कीमा:
{
  "title": "समस्या/अवसर की एक पंक्ति (80 अक्षरों के भीतर)",
  "problem": "विस्तृत समस्या परिभाषा — कौन, कब, क्या असुविधाजनक",
  "evidence": [{ "kind": "{{kinds}}", "ref": "सत्यापन-योग्य संदर्भ", "summary": "यह साक्ष्य क्या कहता है, एक पंक्ति" }],
  "impact": 1-5,
  "effort": 1-5,
  "scope": "इस बार जो किया जाए / गैर-लक्ष्य",
  "spec": "यूज़र स्टोरी + स्वीकृति मानदंड + किनारे के मामले (markdown)",
{{dedupSchema}}
}

यदि वास्तव में प्रस्तावित करने को कुछ न हो तो खाली array [] लिखें। फ़ाइल लिखने के बाद एक पंक्ति «N ब्रीफ़ लिखे गए» से समाप्त करें।{{outputDirective}}`,
    ja: `{{persona}}このリポジトリの「次に作る価値ある仕事」を見つけ、機会ブリーフに整理するのが任務だ。コードを修正するな — 読む/調べるだけ。
{{profile}}{{directive}}{{history}}{{verification}}{{storeReviews}}{{crashSignals}}{{designContext}}{{lensBlock}}
## ステップ1 — 信号収集(できるものだけ、失敗しても続行)
{{githubSignal}}
- リポジトリ内信号: このリポジトリが使うToDo/ロードマップ文書(リポジトリの文書慣習に従って探せ — 例: \`docs/\` 配下の todo/roadmap 文書·\`TODO.md\`·\`ROADMAP.md\`·課題トラッカーなど)、コードの TODO/FIXME/HACK コメント(\`grep -rn\`)、README のロードマップ節。
- 最近の流れ: \`git log --oneline -30\` で最近の作業方向を把握し — すでに進行中のものを再提案するな。{{storeTail}}{{crashTail}}

## ステップ2 — 統合: 機会ブリーフを書く(最大5件)
信号を「問題/機会」単位でまとめよ。各ブリーフの要件:
- **根拠必須**: すべてのブリーフはステップ1で実際に見た信号へ遡れること。根拠なき空想提案は禁止。evidence の ref には確認可能な参照(課題番号/URL、ファイル:行、コミット sha)を書け。
{{dedup}}
- **impact / effort**: 1~5の整数。impact 5 = 中核のユーザー価値/収益に直結、1 = 些細。effort 5 = 数週間、1 = 半日。
- **spec**: 承認後すぐ別のエージェントが実装を始められる水準 — ユーザーストーリー、受け入れ基準(チェックリスト)、エッジケース、非目標。
- **デザイン受け入れ基準(UIに触れるブリーフのみ)**: spec の受け入れ基準に上の「デザイン制約」を反映せよ — 使う色の「意味」(このリポジトリのトークン/約束に従い意味を混同するな)、表示文字列の i18n(このリポジトリが対応するロケール「集合すべて」)、状態(空/エラー/読み込み/無効/フォーカス)、アクセシビリティ(ラベル·コントラスト)。特定の色·ロケール数を固定せず「このリポジトリが定めたとおり」に表現せよ。UI面のないブリーフ(daemon·ネットワーク·CLI など)には入れるな。

{{backlog}}

## ステップ3 — 産出
次のパスに JSON「配列」ファイルを書け(他の場所に書くな):
{{outFile}}

各要素のスキーマ:
{
  "title": "問題/機会を一行で(80文字以内)",
  "problem": "詳細な問題定義 — 誰が、いつ、何が不便か",
  "evidence": [{ "kind": "{{kinds}}", "ref": "確認可能な参照", "summary": "この根拠が言うことを一行" }],
  "impact": 1-5,
  "effort": 1-5,
  "scope": "今回やること / 非目標",
  "spec": "ユーザーストーリー + 受け入れ基準 + エッジケース (markdown)",
{{dedupSchema}}
}

提案すべきものが本当になければ空配列 [] を書け。ファイルを書いたら「N件のブリーフ作成完了」の一行で終えよ。{{outputDirective}}`,
    ko: `{{persona}} 이 레포의 «다음에 만들 가치 있는 일» 을 찾아 기회 브리프로 정리하는 것이 임무다. 코드를 수정하지 마라 — 읽기/조사만 한다.
{{profile}}{{directive}}{{history}}{{verification}}{{storeReviews}}{{crashSignals}}{{designContext}}{{lensBlock}}
## 1단계 — 신호 수집 (가능한 것만, 실패해도 계속)
{{githubSignal}}
- 레포 내부 신호: 이 레포가 쓰는 할 일/로드맵 문서(레포의 문서 컨벤션을 따라 찾아라 — 예: \`docs/\` 아래 todo/roadmap 문서·\`TODO.md\`·\`ROADMAP.md\`·이슈 트래커 등), 코드의 TODO/FIXME/HACK 주석(\`grep -rn\`), README 의 로드맵 섹션.
- 최근 흐름: \`git log --oneline -30\` 으로 최근 작업 방향을 파악해 — 이미 진행 중인 것을 다시 제안하지 마라.{{storeTail}}{{crashTail}}

## 2단계 — 종합: 기회 브리프 작성 (최대 5건)
신호들을 «문제/기회» 단위로 묶어라. 각 브리프 요건:
- **근거 필수**: 모든 브리프는 1단계에서 실제로 본 신호로 역추적 가능해야 한다. 근거 없는 상상 제안 금지. evidence 의 ref 에는 확인 가능한 참조(이슈 번호/URL, 파일:라인, 커밋 sha)를 적는다.
{{dedup}}
- **impact / effort**: 1~5 정수. impact 5 = 핵심 사용자 가치/수익에 직결, 1 = 사소. effort 5 = 수 주, 1 = 반나절.
- **spec**: 승인 즉시 다른 에이전트가 구현을 시작할 수 있는 수준 — 유저스토리, 수용 기준(체크리스트), 엣지케이스, 비-목표.
- **디자인 수용 기준 (UI 가 닿는 브리프만)**: spec 의 수용 기준에 위 「디자인 제약」 을 반영하라 — 쓰는 색의 «의미»(이 레포가 정한 토큰/약속을 따르고 의미를 혼동하지 마라), 노출 문자열의 i18n(이 레포가 지원하는 로케일 «집합» 전부), 상태(빈/오류/로딩/비활성/포커스), 접근성(라벨·대비). 특정 색·로케일 수를 박지 말고 «이 레포가 정한 대로» 표현하라. UI 표면이 없는 브리프(daemon·네트워크·CLI 등)엔 넣지 마라.

{{backlog}}

## 3단계 — 산출
다음 경로에 JSON «배열» 파일을 써라 (다른 곳에 쓰지 마라):
{{outFile}}

각 원소 스키마:
{
  "title": "문제/기회 한 줄 (80자 이내)",
  "problem": "상세 문제 정의 — 누가, 언제, 무엇이 불편한가",
  "evidence": [{ "kind": "{{kinds}}", "ref": "확인 가능한 참조", "summary": "이 근거가 말하는 것 한 줄" }],
  "impact": 1-5,
  "effort": 1-5,
  "scope": "이번에 하는 것 / 비-목표",
  "spec": "유저스토리 + 수용 기준 + 엣지케이스 (markdown)",
{{dedupSchema}}
}

제안할 것이 정말 없으면 빈 배열 [] 을 써라. 파일을 쓴 뒤 «브리프 N건 작성 완료» 한 줄로 끝내라.{{outputDirective}}`,
    "pt-BR": `{{persona}} Sua missão é encontrar «a próxima coisa valiosa a construir» neste repo e organizá-la em briefs de oportunidade. Não modifique código — apenas leia/investigue.
{{profile}}{{directive}}{{history}}{{verification}}{{storeReviews}}{{crashSignals}}{{designContext}}{{lensBlock}}
## Passo 1 — Coleta de sinais (o que for possível; continue mesmo se alguns falharem)
{{githubSignal}}
- Sinais internos do repo: os docs de tarefas/roadmap que este repo usa (encontre-os conforme as convenções de docs do repo — ex.: docs de todo/roadmap sob \`docs/\`·\`TODO.md\`·\`ROADMAP.md\`·issue trackers), comentários TODO/FIXME/HACK no código (\`grep -rn\`), a seção de roadmap do README.
- Fluxo recente: capte a direção recente do trabalho via \`git log --oneline -30\` — e não reproponha o que já está em andamento.{{storeTail}}{{crashTail}}

## Passo 2 — Síntese: escreva briefs de oportunidade (até 5)
Agrupe os sinais em unidades de «problema/oportunidade». Requisitos por brief:
- **Evidência obrigatória**: todo brief deve ser rastreável a um sinal que você realmente viu no passo 1. Sem propostas imaginadas sem evidência. No ref de evidence, escreva uma referência verificável (número de issue/URL, arquivo:linha, sha de commit).
{{dedup}}
- **impact / effort**: inteiros 1~5. impact 5 = diretamente ligado ao valor/receita central do usuário, 1 = trivial. effort 5 = semanas, 1 = meio dia.
- **spec**: um nível em que outro agente possa iniciar a implementação logo após a aprovação — user story, critérios de aceitação (checklist), casos de borda, não-objetivos.
- **Critérios de aceitação de design (apenas para briefs que tocam a UI)**: reflita as «Restrições de design» acima nos critérios de aceitação de spec — o «significado» das cores usadas (siga os tokens/compromissos deste repo e não confunda significados), i18n das strings visíveis (o «conjunto inteiro» de localidades que este repo suporta), estados (vazio/erro/carregando/desabilitado/foco), acessibilidade (rótulos·contraste). Não fixe uma cor/contagem de localidades específica — expresse «como este repo define». Não adicione isso a briefs sem superfície de UI (daemon·rede·CLI, etc.).

{{backlog}}

## Passo 3 — Saída
Escreva um arquivo «array» JSON no seguinte caminho (não escreva em outro lugar):
{{outFile}}

Esquema por elemento:
{
  "title": "uma linha para o problema/oportunidade (até 80 caracteres)",
  "problem": "definição detalhada do problema — quem, quando, o que incomoda",
  "evidence": [{ "kind": "{{kinds}}", "ref": "referência verificável", "summary": "o que esta evidência diz, uma linha" }],
  "impact": 1-5,
  "effort": 1-5,
  "scope": "o que é feito desta vez / não-objetivos",
  "spec": "user story + critérios de aceitação + casos de borda (markdown)",
{{dedupSchema}}
}

Se realmente não houver nada a propor, escreva um array vazio []. Após escrever o arquivo, termine com uma linha: «N briefs escritos».{{outputDirective}}`,
    ru: `{{persona}} Твоя задача — найти «следующую ценную вещь для создания» в этом репозитории и оформить её в брифы возможностей. Не изменяй код — только читай/исследуй.
{{profile}}{{directive}}{{history}}{{verification}}{{storeReviews}}{{crashSignals}}{{designContext}}{{lensBlock}}
## Шаг 1 — Сбор сигналов (всё возможное; продолжай, даже если что-то не удалось)
{{githubSignal}}
- Внутренние сигналы репозитория: документы задач/дорожной карты, которые использует этот репозиторий (находи их по соглашениям документации репозитория — напр., docs todo/roadmap в \`docs/\`·\`TODO.md\`·\`ROADMAP.md\`·трекеры задач), комментарии TODO/FIXME/HACK в коде (\`grep -rn\`), раздел roadmap в README.
- Недавний поток: пойми недавнее направление работы через \`git log --oneline -30\` — и не предлагай повторно то, что уже в работе.{{storeTail}}{{crashTail}}

## Шаг 2 — Синтез: напиши брифы возможностей (до 5)
Сгруппируй сигналы в единицы «проблема/возможность». Требования к каждому брифу:
- **Доказательство обязательно**: каждый бриф должен прослеживаться до сигнала, который ты действительно видел на шаге 1. Никаких выдуманных предложений без доказательств. В ref у evidence пиши проверяемую ссылку (номер issue/URL, файл:строка, sha коммита).
{{dedup}}
- **impact / effort**: целые 1~5. impact 5 = напрямую связано с ключевой ценностью/доходом пользователя, 1 = незначительно. effort 5 = недели, 1 = полдня.
- **spec**: уровень, на котором другой агент может начать реализацию сразу после одобрения — user story, критерии приёмки (чеклист), краевые случаи, не-цели.
- **Критерии приёмки дизайна (только для брифов, касающихся UI)**: отрази «Ограничения дизайна» выше в критериях приёмки spec — «смысл» используемых цветов (следуй токенам/обязательствам этого репозитория и не путай смыслы), i18n видимых строк («весь набор» локалей, поддерживаемых этим репозиторием), состояния (пусто/ошибка/загрузка/отключено/фокус), доступность (подписи·контраст). Не фиксируй конкретный цвет/число локалей — выражай «как определяет этот репозиторий». Не добавляй это в брифы без поверхности UI (daemon·сеть·CLI и т. п.).

{{backlog}}

## Шаг 3 — Вывод
Запиши JSON-файл «массив» по следующему пути (не пиши в другое место):
{{outFile}}

Схема каждого элемента:
{
  "title": "одна строка для проблемы/возможности (в пределах 80 символов)",
  "problem": "подробное определение проблемы — кто, когда, что неудобно",
  "evidence": [{ "kind": "{{kinds}}", "ref": "проверяемая ссылка", "summary": "что говорит это доказательство, одна строка" }],
  "impact": 1-5,
  "effort": 1-5,
  "scope": "что делается в этот раз / не-цели",
  "spec": "user story + критерии приёмки + краевые случаи (markdown)",
{{dedupSchema}}
}

Если действительно нечего предложить, запиши пустой массив []. После записи файла закончи одной строкой: «Написано N брифов».{{outputDirective}}`,
    "zh-Hans": `{{persona}}你的任务是在本仓库中找到「下一个值得构建的有价值之事」,并整理为机会简报。不要修改代码——只读取/调研。
{{profile}}{{directive}}{{history}}{{verification}}{{storeReviews}}{{crashSignals}}{{designContext}}{{lensBlock}}
## 第 1 步 — 信号收集(尽可能进行;即使部分失败也继续)
{{githubSignal}}
- 仓库内部信号: 本仓库使用的待办/路线图文档(按仓库的文档惯例查找——如 \`docs/\` 下的 todo/roadmap 文档·\`TODO.md\`·\`ROADMAP.md\`·问题跟踪器等)、代码中的 TODO/FIXME/HACK 注释(\`grep -rn\`)、README 的路线图章节。
- 近期动向: 通过 \`git log --oneline -30\` 掌握近期工作方向——并且不要重复提出已在进行中的事项。{{storeTail}}{{crashTail}}

## 第 2 步 — 综合: 撰写机会简报(最多 5 条)
将信号归并为「问题/机会」单元。每条简报的要求:
- **依据必需**: 每条简报都必须可追溯到你在第 1 步实际看到的信号。禁止无依据的臆想提案。在 evidence 的 ref 中写可核实的引用(issue 编号/URL、文件:行、提交 sha)。
{{dedup}}
- **impact / effort**: 1~5 整数。impact 5 = 与核心用户价值/收入直接相关,1 = 琐碎。effort 5 = 数周,1 = 半天。
- **spec**: 达到批准后另一智能体即可开始实现的水平——用户故事、验收标准(清单)、边界情形、非目标。
- **设计验收标准(仅限触及 UI 的简报)**: 将上方「设计约束」反映到 spec 的验收标准中——所用颜色的「含义」(遵循本仓库的令牌/约定,不要混淆含义)、可见字符串的 i18n(本仓库支持的语言环境「全部集合」)、状态(空/错误/加载/禁用/聚焦)、无障碍(标签·对比度)。不要写死某种颜色/语言环境数量——按「本仓库的规定」表达。不要将其加入没有 UI 表面的简报(daemon·网络·CLI 等)。

{{backlog}}

## 第 3 步 — 产出
将 JSON「数组」文件写入以下路径(不要写到别处):
{{outFile}}

每个元素的 schema:
{
  "title": "问题/机会一行(80 字以内)",
  "problem": "详细问题定义——谁、何时、什么不便",
  "evidence": [{ "kind": "{{kinds}}", "ref": "可核实的引用", "summary": "该依据所述,一行" }],
  "impact": 1-5,
  "effort": 1-5,
  "scope": "本次所做 / 非目标",
  "spec": "用户故事 + 验收标准 + 边界情形 (markdown)",
{{dedupSchema}}
}

若确实没有可提出的内容,则写空数组 []。写完文件后以一行「已写 N 条简报」结束。{{outputDirective}}`,
  },
} satisfies Record<string, Msg>;
