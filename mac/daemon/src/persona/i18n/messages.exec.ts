// PO 프롬프트 다국어 카탈로그 — 브리프 후속 빌더 (revise·cleanup·exec).
//
// ko 는 SSOT — prompt.ts 의 기존 리터럴과 byte-identical. «{{name}}» 은 format() 보간 자리.

import type { Msg } from "./locale.js";

export const execMessages = {
  // ── 브리프 수정 지시 (buildPoRevisePrompt) ──────────────────────────────────
  "revise.body": {
    ar: `أنت وكيل مالك المنتج (PO) لهذا المستودع. ترك المستخدم توجيه تعديل على بريف الفرصة أدناه. اعكس التوجيه و«أعد تركيب» البريف. لا تعدّل الكود — وإن لزم فابحث فقط بقراءة المستودع لتعزيز السند.

## البريف الحالي
- title: {{title}}
- problem: {{problem}}
- evidence: {{evidence}}
- impact: {{impact}} / effort: {{effort}}
- scope: {{scope}}
- spec:
{{spec}}

## توجيه تعديل المستخدم
{{comment}}

## المخرجات
اكتب النسخة المحدّثة التي تعكس التوجيه في المسار التالي كـ«كائن JSON واحد» (ليست مصفوفة، ولا تكتب في مكان آخر):
{{outFile}}

المخطط نفسه كالتجميع: { "title", "problem", "evidence": [{"kind","ref","summary"}], "impact": 1-5, "effort": 1-5, "scope", "spec" }.
- احفظ الحقول التي لا يمسّها التوجيه كما هي (لا تُعد كتابة بلا داعٍ).
- حافظ على مبدأ تتبّع السند — إن أضعف التوجيه السند فعزّزه من المستودع أو أضف سند user_directive.
بعد كتابة الملف، أنهِ بسطر واحد «اكتملت إعادة التركيب».{{outputDirective}}`,
    en: `You are this repository's Product Owner (PO) agent. The user left a revision directive on the opportunity brief below. Reflect the directive and «re-synthesize» the brief. Do not modify code — if needed, only investigate by reading the repo to strengthen evidence.

## Current brief
- title: {{title}}
- problem: {{problem}}
- evidence: {{evidence}}
- impact: {{impact}} / effort: {{effort}}
- scope: {{scope}}
- spec:
{{spec}}

## User revision directive
{{comment}}

## Output
Write the updated version reflecting the directive to the following path as a «single JSON object» (not an array, do not write elsewhere):
{{outFile}}

The schema is the same as collection: { "title", "problem", "evidence": [{"kind","ref","summary"}], "impact": 1-5, "effort": 1-5, "scope", "spec" }.
- Keep fields the directive does not touch as-is (no unnecessary rewriting).
- Maintain the evidence-traceability principle — if the directive weakens evidence, reinforce it from the repo or add a user_directive evidence.
After writing the file, end with one line: «Re-synthesis complete».{{outputDirective}}`,
    es: `Eres el agente Product Owner (PO) de este repositorio. El usuario dejó una directiva de revisión en el brief de oportunidad de abajo. Refleja la directiva y «re-sintetiza» el brief. No modifiques código — si es necesario, solo investiga leyendo el repo para reforzar la evidencia.

## Brief actual
- title: {{title}}
- problem: {{problem}}
- evidence: {{evidence}}
- impact: {{impact}} / effort: {{effort}}
- scope: {{scope}}
- spec:
{{spec}}

## Directiva de revisión del usuario
{{comment}}

## Salida
Escribe la versión actualizada que refleja la directiva en la siguiente ruta como un «único objeto JSON» (no un array, no escribas en otro lugar):
{{outFile}}

El esquema es el mismo que la recopilación: { "title", "problem", "evidence": [{"kind","ref","summary"}], "impact": 1-5, "effort": 1-5, "scope", "spec" }.
- Mantén tal cual los campos que la directiva no toca (sin reescritura innecesaria).
- Mantén el principio de trazabilidad de evidencia — si la directiva debilita la evidencia, refuérzala desde el repo o añade una evidencia user_directive.
Tras escribir el archivo, termina con una línea: «Re-síntesis completa».{{outputDirective}}`,
    fr: `Tu es l'agent Product Owner (PO) de ce dépôt. L'utilisateur a laissé une directive de révision sur le brief d'opportunité ci-dessous. Reflète la directive et «re-synthétise» le brief. Ne modifie pas le code — si besoin, investigue seulement en lisant le dépôt pour renforcer les preuves.

## Brief actuel
- title: {{title}}
- problem: {{problem}}
- evidence: {{evidence}}
- impact: {{impact}} / effort: {{effort}}
- scope: {{scope}}
- spec:
{{spec}}

## Directive de révision de l'utilisateur
{{comment}}

## Sortie
Écris la version mise à jour reflétant la directive au chemin suivant sous forme d'«objet JSON unique» (pas un tableau, n'écris pas ailleurs):
{{outFile}}

Le schéma est le même que la collecte: { "title", "problem", "evidence": [{"kind","ref","summary"}], "impact": 1-5, "effort": 1-5, "scope", "spec" }.
- Garde tels quels les champs que la directive ne touche pas (pas de réécriture inutile).
- Maintiens le principe de traçabilité des preuves — si la directive affaiblit les preuves, renforce-les depuis le dépôt ou ajoute une preuve user_directive.
Après avoir écrit le fichier, termine par une ligne: «Re-synthèse terminée».{{outputDirective}}`,
    hi: `आप इस रिपॉज़िटरी के Product Owner (PO) एजेंट हैं। उपयोगकर्ता ने नीचे दिए अवसर-ब्रीफ़ पर एक संशोधन निर्देश छोड़ा है। निर्देश को दर्शाएँ और ब्रीफ़ को «पुनः-संश्लेषित» करें। कोड न बदलें — यदि आवश्यक हो तो साक्ष्य सुदृढ़ करने हेतु केवल रेपो पढ़कर जाँचें।

## वर्तमान ब्रीफ़
- title: {{title}}
- problem: {{problem}}
- evidence: {{evidence}}
- impact: {{impact}} / effort: {{effort}}
- scope: {{scope}}
- spec:
{{spec}}

## उपयोगकर्ता संशोधन निर्देश
{{comment}}

## आउटपुट
निर्देश को दर्शाने वाली अद्यतन प्रति निम्न पथ पर «एकल JSON ऑब्जेक्ट» के रूप में लिखें (array नहीं, अन्यत्र न लिखें):
{{outFile}}

स्कीमा संग्रह जैसा ही: { "title", "problem", "evidence": [{"kind","ref","summary"}], "impact": 1-5, "effort": 1-5, "scope", "spec" }।
- जिन फ़ील्ड को निर्देश नहीं छूता उन्हें ज्यों का त्यों रखें (अनावश्यक पुनर्लेखन नहीं)।
- साक्ष्य-अनुरेखणीयता सिद्धांत बनाए रखें — यदि निर्देश से साक्ष्य कमज़ोर हो तो रेपो से सुदृढ़ करें या user_directive साक्ष्य जोड़ें।
फ़ाइल लिखने के बाद एक पंक्ति «पुनः-संश्लेषण पूर्ण» से समाप्त करें।{{outputDirective}}`,
    ja: `あなたはこのリポジトリのプロダクトオーナー(PO)エージェントだ。下の機会ブリーフにユーザーが修正指示を残した。指示を反映してブリーフを「再統合」せよ。コードを修正するな — 必要ならリポジトリを読んで根拠を補強する調査のみ。

## 現在のブリーフ
- title: {{title}}
- problem: {{problem}}
- evidence: {{evidence}}
- impact: {{impact}} / effort: {{effort}}
- scope: {{scope}}
- spec:
{{spec}}

## ユーザー修正指示
{{comment}}

## 産出
指示を反映した更新版を次のパスに「単一の JSON オブジェクト」で書け(配列ではない、他の場所に書くな):
{{outFile}}

スキーマは収集時と同じ: { "title", "problem", "evidence": [{"kind","ref","summary"}], "impact": 1-5, "effort": 1-5, "scope", "spec" }。
- 指示が触れないフィールドは原形を維持せよ(不要な書き直し禁止)。
- 根拠の追跡可能性の原則を維持 — 指示で根拠が弱まればリポジトリから補強するか user_directive 根拠を追加せよ。
ファイルを書いたら「再統合完了」の一行で終えよ。{{outputDirective}}`,
    ko: `너는 이 저장소의 프로덕트 오너(PO) 에이전트다. 아래 기회 브리프에 사용자가 수정 지시를 남겼다. 지시를 반영해 브리프를 «재종합» 하라. 코드를 수정하지 마라 — 필요하면 레포를 읽어 근거를 보강하는 조사만 한다.

## 현재 브리프
- title: {{title}}
- problem: {{problem}}
- evidence: {{evidence}}
- impact: {{impact}} / effort: {{effort}}
- scope: {{scope}}
- spec:
{{spec}}

## 사용자 수정 지시
{{comment}}

## 산출
지시를 반영한 갱신본을 다음 경로에 JSON «단일 객체» 로 써라 (배열 아님, 다른 곳에 쓰지 마라):
{{outFile}}

스키마는 수집 때와 동일: { "title", "problem", "evidence": [{"kind","ref","summary"}], "impact": 1-5, "effort": 1-5, "scope", "spec" }.
- 지시가 닿지 않는 필드는 원형을 유지하라 (불필요한 재작성 금지).
- 근거 역추적 원칙 유지 — 지시로 근거가 약해지면 레포에서 보강하거나 user_directive 근거를 추가.
파일을 쓴 뒤 «재종합 완료» 한 줄로 끝내라.{{outputDirective}}`,
    "pt-BR": `Você é o agente Product Owner (PO) deste repositório. O usuário deixou uma diretiva de revisão no brief de oportunidade abaixo. Reflita a diretiva e «re-sintetize» o brief. Não modifique código — se necessário, apenas investigue lendo o repo para reforçar a evidência.

## Brief atual
- title: {{title}}
- problem: {{problem}}
- evidence: {{evidence}}
- impact: {{impact}} / effort: {{effort}}
- scope: {{scope}}
- spec:
{{spec}}

## Diretiva de revisão do usuário
{{comment}}

## Saída
Escreva a versão atualizada que reflete a diretiva no seguinte caminho como um «único objeto JSON» (não um array, não escreva em outro lugar):
{{outFile}}

O esquema é o mesmo da coleta: { "title", "problem", "evidence": [{"kind","ref","summary"}], "impact": 1-5, "effort": 1-5, "scope", "spec" }.
- Mantenha como estão os campos que a diretiva não toca (sem reescrita desnecessária).
- Mantenha o princípio de rastreabilidade da evidência — se a diretiva enfraquecer a evidência, reforce-a a partir do repo ou adicione uma evidência user_directive.
Após escrever o arquivo, termine com uma linha: «Re-síntese concluída».{{outputDirective}}`,
    ru: `Ты — агент Product Owner (PO) этого репозитория. Пользователь оставил директиву на правку брифа возможности ниже. Отрази директиву и «пересоберите» бриф. Не изменяй код — при необходимости только исследуй, читая репозиторий, чтобы усилить доказательства.

## Текущий бриф
- title: {{title}}
- problem: {{problem}}
- evidence: {{evidence}}
- impact: {{impact}} / effort: {{effort}}
- scope: {{scope}}
- spec:
{{spec}}

## Директива правки пользователя
{{comment}}

## Вывод
Запиши обновлённую версию, отражающую директиву, по следующему пути как «единый объект JSON» (не массив, не пиши в другое место):
{{outFile}}

Схема та же, что при сборе: { "title", "problem", "evidence": [{"kind","ref","summary"}], "impact": 1-5, "effort": 1-5, "scope", "spec" }.
- Поля, которых директива не касается, оставляй как есть (без лишних переписываний).
- Сохраняй принцип прослеживаемости доказательств — если директива ослабляет доказательства, усиль их из репозитория или добавь доказательство user_directive.
После записи файла закончи одной строкой: «Пересборка завершена».{{outputDirective}}`,
    "zh-Hans": `你是本仓库的产品负责人(PO)智能体。用户在下方机会简报上留下了修订指示。反映该指示并「重新综合」简报。不要修改代码——必要时仅通过阅读仓库来调研以强化依据。

## 当前简报
- title: {{title}}
- problem: {{problem}}
- evidence: {{evidence}}
- impact: {{impact}} / effort: {{effort}}
- scope: {{scope}}
- spec:
{{spec}}

## 用户修订指示
{{comment}}

## 产出
将反映指示的更新版本写入以下路径,作为「单个 JSON 对象」(不是数组,不要写到别处):
{{outFile}}

schema 与收集时相同: { "title", "problem", "evidence": [{"kind","ref","summary"}], "impact": 1-5, "effort": 1-5, "scope", "spec" }。
- 指示未触及的字段保持原样(不做不必要的重写)。
- 保持依据可追溯原则——若指示削弱了依据,则从仓库强化或添加 user_directive 依据。
写完文件后以一行「重新综合完成」结束。{{outputDirective}}`,
  },

  // ── 기각 브리프 코드 흔적 정리 (buildPoCleanupPrompt) ────────────────────────
  "cleanup.refsNone": {
    ar: "(لا شيء — ابدأ بالبحث في كامل المستودع)",
    en: "(none — start by searching the whole repo)",
    es: "(ninguno — empieza buscando en todo el repo)",
    fr: "(aucun — commence par chercher dans tout le dépôt)",
    hi: "(कोई नहीं — पूरे रेपो में खोजकर शुरू करें)",
    ja: "(なし — リポジトリ全体の検索から始めよ)",
    ko: "(없음 — 레포 전체 검색으로 시작하라)",
    "pt-BR": "(nenhum — comece buscando em todo o repo)",
    ru: "(нет — начни с поиска по всему репозиторию)",
    "zh-Hans": "(无 — 从搜索整个仓库开始)",
  },
  "cleanup.body": {
    ar: `نظّف «آثار الكود» لبريف الفرصة المرفوض. تقرّر بعد المراجعة «عدم تنفيذ» الفكرة أدناه — لا تنفّذها أبداً. مهمتك أن تجد وتـ«تزيل» ما بقي في قاعدة الكود بسبب هذه الفكرة: تعليقات TODO/FIXME/HACK، والكود الميت (ستب غير مكتمل·كود غير مستخدم لهذه الفكرة فقط)، وبنود المهام في الوثائق.

## الفكرة المرفوضة
- title: {{title}}
- problem: {{problem}}
- scope: {{scope}}

## السند (نقطة البداية — هذه الإشارات صنعت البريف)
{{refs}}

## تعليمات العمل
1. تحقّق أولاً من ref السند أعلاه (ملف:سطر، وثيقة، قضية)، ثم ابحث في كامل المستودع عن تعليقات TODO/FIXME/HACK·بنود وثائق متعلقة بهذه الفكرة (grep).
2. أزل فقط ما تتيقّن أنه «لهذه الفكرة المرفوضة وحدها» — لا تمسّ أبداً كوداً تستخدمه ميزة أخرى أو TODO غير ذي صلة. إن لم تتيقّن فاتركه واكتفِ بالإبلاغ.
3. ممنوع تغيير السلوك — الأغلب إزالة تعليقات/وثائق، وإن حذفت كوداً ميتاً فتأكّد بالوسائل المتاحة (بناء/فحص الأنواع) أنه لم ينكسر.
4. ممنوع ميزة جديدة/إعادة هيكلة — هذه الجلسة للحذف·التنظيف فقط.
5. لا تعمل commit — اترك التغيير في شجرة العمل ليعالجه المستخدم بنفسه بعد المراجعة.

عند الانتهاء، أبلغ بقائمة «ملف:سطر — ماذا حذفت» والبنود التي تركتها لعدم اليقين (إن وجدت). إن لم يوجد أثر للإزالة إطلاقاً فأبلغ بذلك في سطر واحد.`,
    en: `Clean up the «code traces» of the rejected opportunity brief. The idea below was decided «not to do» after review — never implement it. Your mission is to find and «remove» what remains in the codebase because of this idea: TODO/FIXME/HACK comments, dead code (an unfinished stub·unused code for this idea only), and to-do items in docs.

## Rejected idea
- title: {{title}}
- problem: {{problem}}
- scope: {{scope}}

## Evidence (starting points — these signals created the brief)
{{refs}}

## Work instructions
1. First check the ref of the evidence above (file:line, doc, issue), then search the whole repo for TODO/FIXME/HACK comments·doc items related to this idea (grep).
2. Remove only what you are sure is «for this rejected idea alone» — never touch code used by another feature or unrelated TODOs. If unsure, leave it and just report.
3. No behavior change — most of this is removing comments/docs; if you delete dead code, confirm with available means (build/type-check) that nothing broke.
4. No new features/refactoring — this session is for deletion·cleanup only.
5. Do not commit — leave changes in the working tree for the user to review and handle themselves.

When done, report a list of «file:line — what you deleted» and items you left due to uncertainty (if any). If there are no traces to remove at all, report that in one line.`,
    es: `Limpia los «rastros de código» del brief de oportunidad rechazado. La idea de abajo se decidió «no hacer» tras la revisión — nunca la implementes. Tu misión es encontrar y «eliminar» lo que queda en el código por esta idea: comentarios TODO/FIXME/HACK, código muerto (un stub sin terminar·código sin usar solo para esta idea) y elementos de tareas en docs.

## Idea rechazada
- title: {{title}}
- problem: {{problem}}
- scope: {{scope}}

## Evidencia (puntos de partida — estas señales crearon el brief)
{{refs}}

## Instrucciones de trabajo
1. Primero revisa el ref de la evidencia de arriba (archivo:línea, doc, issue), luego busca en todo el repo comentarios TODO/FIXME/HACK·elementos de docs relacionados con esta idea (grep).
2. Elimina solo lo que estés seguro de que es «solo para esta idea rechazada» — nunca toques código que usa otra función ni TODOs no relacionados. Si dudas, déjalo y solo repórtalo.
3. Sin cambio de comportamiento — la mayor parte es eliminar comentarios/docs; si borras código muerto, confirma con los medios disponibles (build/type-check) que nada se rompió.
4. Sin nuevas funciones/refactorización — esta sesión es solo para eliminación·limpieza.
5. No hagas commit — deja los cambios en el árbol de trabajo para que el usuario los revise y maneje.

Al terminar, reporta una lista de «archivo:línea — qué borraste» y los elementos que dejaste por incertidumbre (si los hay). Si no hay rastros que eliminar en absoluto, repórtalo en una línea.`,
    fr: `Nettoie les «traces de code» du brief d'opportunité rejeté. L'idée ci-dessous a été décidée «à ne pas faire» après revue — ne l'implémente jamais. Ta mission est de trouver et «supprimer» ce qui reste dans le code à cause de cette idée: commentaires TODO/FIXME/HACK, code mort (un stub inachevé·code inutilisé pour cette idée seule) et éléments de tâches dans la doc.

## Idée rejetée
- title: {{title}}
- problem: {{problem}}
- scope: {{scope}}

## Preuves (points de départ — ces signaux ont créé le brief)
{{refs}}

## Instructions de travail
1. Vérifie d'abord le ref des preuves ci-dessus (fichier:ligne, doc, issue), puis cherche dans tout le dépôt les commentaires TODO/FIXME/HACK·éléments de doc liés à cette idée (grep).
2. Ne supprime que ce dont tu es sûr que c'est «pour cette idée rejetée seule» — ne touche jamais au code utilisé par une autre fonctionnalité ni aux TODO non liés. En cas de doute, laisse-le et rapporte seulement.
3. Pas de changement de comportement — l'essentiel est de retirer commentaires/docs; si tu supprimes du code mort, confirme avec les moyens disponibles (build/type-check) que rien n'est cassé.
4. Pas de nouvelles fonctionnalités/refactorisation — cette session est pour la suppression·le nettoyage uniquement.
5. Ne fais pas de commit — laisse les changements dans l'arbre de travail pour que l'utilisateur les revoie et les gère lui-même.

Une fois terminé, rapporte une liste de «fichier:ligne — ce que tu as supprimé» et les éléments laissés par incertitude (s'il y en a). S'il n'y a aucune trace à retirer, rapporte-le en une ligne.`,
    hi: `अस्वीकृत अवसर-ब्रीफ़ के «कोड निशान» साफ़ करें। नीचे दी गई आइडिया समीक्षा के बाद «न करने» का निर्णय हुआ — इसे कभी लागू न करें। आपका कार्य इस आइडिया के कारण कोडबेस में बचे को खोजकर «हटाना» है: TODO/FIXME/HACK टिप्पणियाँ, मृत कोड (केवल इस आइडिया हेतु अधूरा stub·अप्रयुक्त कोड), और docs में to-do आइटम।

## अस्वीकृत आइडिया
- title: {{title}}
- problem: {{problem}}
- scope: {{scope}}

## साक्ष्य (प्रारंभ बिंदु — इन संकेतों ने ब्रीफ़ बनाया)
{{refs}}

## कार्य निर्देश
1. पहले ऊपर साक्ष्य के ref (फ़ाइल:लाइन, doc, issue) जाँचें, फिर इस आइडिया से संबंधित TODO/FIXME/HACK टिप्पणियाँ·doc आइटम पूरे रेपो में खोजें (grep)।
2. केवल वही हटाएँ जिसके बारे में आप निश्चित हों कि यह «केवल इस अस्वीकृत आइडिया हेतु» है — किसी अन्य फ़ीचर द्वारा प्रयुक्त कोड या असंबंधित TODO को कभी न छुएँ। निश्चित न हों तो छोड़ दें और केवल रिपोर्ट करें।
3. व्यवहार परिवर्तन नहीं — अधिकांश टिप्पणियाँ/docs हटाना है; यदि मृत कोड हटाएँ तो उपलब्ध साधनों (build/type-check) से पुष्टि करें कि कुछ टूटा नहीं।
4. नई फ़ीचर/रीफैक्टरिंग नहीं — यह सत्र केवल हटाने·सफ़ाई हेतु है।
5. commit न करें — परिवर्तन वर्किंग ट्री में छोड़ें ताकि उपयोगकर्ता समीक्षा कर स्वयं संभाले।

समाप्त होने पर «फ़ाइल:लाइन — आपने क्या हटाया» की सूची, और अनिश्चितता के कारण छोड़े गए आइटम (यदि हों) रिपोर्ट करें। यदि हटाने को कोई निशान न हो तो उसे एक पंक्ति में रिपोर्ट करें।`,
    ja: `却下された機会ブリーフの「コードの痕跡」を整理せよ。下のアイデアはレビューの末「やらない」と決まった — 絶対に実装するな。任務は、このアイデアのためにコードベースに残るものを見つけて「除去」することだ: TODO/FIXME/HACK コメント、デッドコード(このアイデア専用の未完成スタブ·未使用コード)、文書の ToDo 項目。

## 却下されたアイデア
- title: {{title}}
- problem: {{problem}}
- scope: {{scope}}

## 根拠(出発点 — これらの信号がブリーフを作った)
{{refs}}

## 作業指針
1. まず上の根拠の ref(ファイル:行、文書、課題)を確認し、次にこのアイデアに関連する TODO/FIXME/HACK コメント·文書項目をリポジトリ全体で追加検索せよ(grep)。
2. 「この却下アイデア専用」と確信できるものだけ除去せよ — 他機能が使うコードや無関係な TODO には絶対に触れるな。確信がなければ残して報告のみせよ。
3. 動作変更禁止 — 大半はコメント/文書の除去で、デッドコードを消したら利用可能な手段(ビルド/型チェック)で壊れていないか確認せよ。
4. 新機能/リファクタ禁止 — このセッションは削除·整理専用だ。
5. commit するな — 変更は作業ツリーに残し、ユーザーがレビュー後に自分で処理する。

終わったら「ファイル:行 — 何を消したか」の一覧と、確信がなく残した項目(あれば)を報告せよ。除去すべき痕跡が全くなければ、その事実を一行で報告せよ。`,
    ko: `기각된 기회 브리프의 «코드 흔적» 을 정리하라. 아래 아이디어는 검토 끝에 «하지 않기로» 결정됐다 — 절대 구현하지 마라. 이 아이디어 때문에 코드베이스에 남아 있는 TODO/FIXME/HACK 주석, 죽은 코드(이 아이디어만을 위한 미완성 스텁·미사용 코드), 문서의 할 일 항목을 찾아 «제거» 하는 것이 임무다.

## 기각된 아이디어
- title: {{title}}
- problem: {{problem}}
- scope: {{scope}}

## 근거 (출발점 — 이 신호들이 브리프를 만들었다)
{{refs}}

## 작업 지침
1. 위 근거의 ref(파일:라인, 문서, 이슈)를 먼저 확인하고, 이 아이디어와 관련된 TODO/FIXME/HACK 주석·문서 항목을 레포 전체에서 추가로 검색하라 (grep).
2. 제거는 «이 기각된 아이디어만을 위한 것» 이라고 확신할 수 있는 것만 — 다른 기능이 쓰는 코드, 무관한 TODO 는 절대 건드리지 마라. 확신이 없으면 남기고 보고만 하라.
3. 동작 변경 금지 — 주석/문서 제거가 대부분이고, 죽은 코드를 지웠다면 가능한 수단(빌드/타입체크)으로 깨지지 않았는지 확인하라.
4. 새 기능/리팩터링 금지 — 이 세션은 삭제·정리 전용이다.
5. 커밋하지 마라 — 변경은 작업 트리에 남겨 사용자가 검토 후 직접 처리한다.

끝나면 «파일:라인 — 무엇을 지웠는지» 목록과, 확신이 없어 남긴 항목(있다면)을 보고하라. 제거할 흔적이 전혀 없으면 그 사실을 한 줄로 보고하라.`,
    "pt-BR": `Limpe os «rastros de código» do brief de oportunidade rejeitado. A ideia abaixo foi decidida «não fazer» após revisão — nunca a implemente. Sua missão é encontrar e «remover» o que resta no código por causa desta ideia: comentários TODO/FIXME/HACK, código morto (um stub inacabado·código não usado só para esta ideia) e itens de tarefas em docs.

## Ideia rejeitada
- title: {{title}}
- problem: {{problem}}
- scope: {{scope}}

## Evidência (pontos de partida — estes sinais criaram o brief)
{{refs}}

## Instruções de trabalho
1. Primeiro verifique o ref da evidência acima (arquivo:linha, doc, issue), depois busque em todo o repo comentários TODO/FIXME/HACK·itens de doc relacionados a esta ideia (grep).
2. Remova apenas o que você tiver certeza de que é «só para esta ideia rejeitada» — nunca toque em código usado por outro recurso nem TODOs não relacionados. Em dúvida, deixe e apenas reporte.
3. Sem mudança de comportamento — a maior parte é remover comentários/docs; se apagar código morto, confirme com os meios disponíveis (build/type-check) que nada quebrou.
4. Sem novos recursos/refatoração — esta sessão é só para exclusão·limpeza.
5. Não faça commit — deixe as mudanças na árvore de trabalho para o usuário revisar e tratar.

Ao terminar, reporte uma lista de «arquivo:linha — o que você apagou» e os itens deixados por incerteza (se houver). Se não houver rastros a remover, reporte isso em uma linha.`,
    ru: `Очисти «следы кода» отклонённого брифа возможности. По идее ниже после рассмотрения решено «не делать» — никогда её не реализуй. Твоя задача — найти и «удалить» то, что осталось в кодовой базе из-за этой идеи: комментарии TODO/FIXME/HACK, мёртвый код (незавершённая заглушка·неиспользуемый код только для этой идеи) и пункты задач в документации.

## Отклонённая идея
- title: {{title}}
- problem: {{problem}}
- scope: {{scope}}

## Доказательства (отправные точки — эти сигналы создали бриф)
{{refs}}

## Инструкции по работе
1. Сначала проверь ref доказательств выше (файл:строка, документ, issue), затем поищи по всему репозиторию комментарии TODO/FIXME/HACK·пункты документации, связанные с этой идеей (grep).
2. Удаляй только то, в чём уверен, что это «только для этой отклонённой идеи» — никогда не трогай код, используемый другой функцией, или несвязанные TODO. Если не уверен, оставь и только сообщи.
3. Без изменения поведения — в основном это удаление комментариев/документов; если удаляешь мёртвый код, доступными средствами (сборка/проверка типов) убедись, что ничего не сломалось.
4. Без новых функций/рефакторинга — эта сессия только для удаления·очистки.
5. Не делай commit — оставь изменения в рабочем дереве, чтобы пользователь сам просмотрел и обработал.

По завершении сообщи список «файл:строка — что удалил» и пункты, оставленные из-за неуверенности (если есть). Если следов для удаления нет вовсе, сообщи об этом одной строкой.`,
    "zh-Hans": `清理被拒绝的机会简报的「代码痕迹」。下方想法经评审决定「不做」——绝不要实现它。你的任务是找出并「移除」因该想法残留在代码库中的内容: TODO/FIXME/HACK 注释、死代码(仅为此想法的未完成桩·未使用代码),以及文档中的待办项。

## 被拒绝的想法
- title: {{title}}
- problem: {{problem}}
- scope: {{scope}}

## 依据(起点——这些信号促成了简报)
{{refs}}

## 工作指引
1. 先核对上方依据的 ref(文件:行、文档、issue),再在整个仓库中搜索与此想法相关的 TODO/FIXME/HACK 注释·文档项(grep)。
2. 仅移除你确信「仅为此被拒想法」的内容——绝不要触碰其他功能使用的代码或无关的 TODO。若不确定,保留并仅报告。
3. 不改变行为——大多是移除注释/文档;若删除死代码,用可用手段(构建/类型检查)确认未损坏。
4. 不新增功能/重构——本会话仅用于删除·清理。
5. 不要 commit——将变更留在工作树中,供用户审阅后自行处理。

完成后,报告「文件:行 — 删除了什么」的列表,以及因不确定而保留的项(若有)。若完全没有可移除的痕迹,用一行报告该事实。`,
  },

  // ── 승인 → 구현 세션 (buildPoExecPrompt) ────────────────────────────────────
  "exec.body": {
    ar: `نفّذ بريف الفرصة المعتمد.

## المشكلة
{{problem}}

## النطاق
{{scope}}

## المواصفات
{{spec}}

{{designContext}}
- قد لا يقرأ الوكيل الذي يشغّل هذه الجلسة (codex·LLM محلي وغيرها) ملفّي CLAUDE.md/AGENTS.md لهذا المستودع تلقائياً — إن كان العمل يمسّ واجهة المستخدم فاتبع قيود التصميم أعلاه «مباشرةً» (معايير قبول التصميم في المواصفات هي «ماذا»، وهذا القيد مؤشّر SSOT لـ«كيف»).

بعد التنفيذ، تحقّق ذاتياً بالوسائل المتاحة (اختبار/بناء/تشغيل) وأبلغ بالنتيجة وفق قائمة معايير القبول. لا تمسّ اللا-أهداف في النطاق.`,
    en: `Implement the approved opportunity brief.

## Problem
{{problem}}

## Scope
{{scope}}

## Spec
{{spec}}

{{designContext}}
- The agent running this session (codex·local LLM, etc.) may not automatically read this repo's CLAUDE.md/AGENTS.md — if the work touches the UI, follow the design constraints above «directly» (the spec's design acceptance criteria are the «what», this constraint is the SSOT pointer for «how»).

After implementing, self-verify with available means (test/build/run) and report the result per the acceptance-criteria checklist. Do not touch the scope's non-goals.`,
    es: `Implementa el brief de oportunidad aprobado.

## Problema
{{problem}}

## Alcance
{{scope}}

## Spec
{{spec}}

{{designContext}}
- El agente que ejecuta esta sesión (codex·LLM local, etc.) puede no leer automáticamente el CLAUDE.md/AGENTS.md de este repo — si el trabajo toca la UI, sigue las restricciones de diseño de arriba «directamente» (los criterios de aceptación de diseño del spec son el «qué», esta restricción es el puntero SSOT del «cómo»).

Tras implementar, autoverifica con los medios disponibles (test/build/run) y reporta el resultado según la checklist de criterios de aceptación. No toques los no-objetivos del alcance.`,
    fr: `Implémente le brief d'opportunité approuvé.

## Problème
{{problem}}

## Portée
{{scope}}

## Spec
{{spec}}

{{designContext}}
- L'agent qui exécute cette session (codex·LLM local, etc.) peut ne pas lire automatiquement le CLAUDE.md/AGENTS.md de ce dépôt — si le travail touche l'UI, suis les contraintes de design ci-dessus «directement» (les critères d'acceptation de design du spec sont le «quoi», cette contrainte est le pointeur SSOT du «comment»).

Après l'implémentation, auto-vérifie avec les moyens disponibles (test/build/run) et rapporte le résultat selon la checklist des critères d'acceptation. Ne touche pas aux non-objectifs de la portée.`,
    hi: `स्वीकृत अवसर-ब्रीफ़ को लागू करें।

## समस्या
{{problem}}

## दायरा
{{scope}}

## स्पेक
{{spec}}

{{designContext}}
- इस सत्र को चलाने वाला एजेंट (codex·लोकल LLM आदि) इस रेपो का CLAUDE.md/AGENTS.md स्वतः न पढ़ सके — यदि कार्य UI को छूता है तो ऊपर के डिज़ाइन प्रतिबंधों का «सीधे» पालन करें (spec के डिज़ाइन स्वीकृति मानदंड «क्या» हैं, यह प्रतिबंध «कैसे» का SSOT सूचक है)।

लागू करने के बाद, उपलब्ध साधनों (test/build/run) से स्वयं सत्यापित करें और स्वीकृति-मानदंड चेकलिस्ट के अनुसार परिणाम रिपोर्ट करें। दायरे के गैर-लक्ष्यों को न छुएँ।`,
    ja: `承認された機会ブリーフを実装せよ。

## 問題
{{problem}}

## スコープ
{{scope}}

## スペック
{{spec}}

{{designContext}}
- このセッションを動かすエージェント(codex·ローカル LLM など)はこのリポジトリの CLAUDE.md/AGENTS.md を自動で読まないことがある — UI に触れる作業なら上のデザイン制約に「直接」従え(スペックのデザイン受け入れ基準は「何を」、この制約は「どう」の SSOT ポインタだ)。

実装後、利用可能な手段(テスト/ビルド/実行)で自己検証し、受け入れ基準チェックリストに沿って結果を報告せよ。スコープの非目標には触れるな。`,
    ko: `승인된 기회 브리프를 구현하라.

## 문제
{{problem}}

## 스코프
{{scope}}

## 스펙
{{spec}}

{{designContext}}
- 이 세션을 돌리는 에이전트(codex·로컬 LLM 등)는 이 레포의 CLAUDE.md/AGENTS.md 를 자동으로 읽지 못할 수 있다 — UI 가 닿는 작업이면 위 디자인 제약을 «직접» 따르라(스펙의 디자인 수용 기준은 «무엇을», 이 제약은 «어떻게» 의 SSOT 포인터다).

구현 후 가능한 수단(테스트/빌드/실행)으로 스스로 검증하고, 수용 기준 체크리스트에 따라 결과를 보고하라. 스코프의 비-목표는 건드리지 마라.`,
    "pt-BR": `Implemente o brief de oportunidade aprovado.

## Problema
{{problem}}

## Escopo
{{scope}}

## Spec
{{spec}}

{{designContext}}
- O agente que executa esta sessão (codex·LLM local, etc.) pode não ler automaticamente o CLAUDE.md/AGENTS.md deste repo — se o trabalho tocar a UI, siga as restrições de design acima «diretamente» (os critérios de aceitação de design do spec são o «o quê», esta restrição é o ponteiro SSOT do «como»).

Após implementar, autoverifique com os meios disponíveis (test/build/run) e reporte o resultado conforme a checklist de critérios de aceitação. Não toque nos não-objetivos do escopo.`,
    ru: `Реализуй одобренный бриф возможности.

## Проблема
{{problem}}

## Охват
{{scope}}

## Спецификация
{{spec}}

{{designContext}}
- Агент, запускающий эту сессию (codex·локальная LLM и т. п.), может не читать автоматически CLAUDE.md/AGENTS.md этого репозитория — если работа касается UI, следуй ограничениям дизайна выше «напрямую» (критерии приёмки дизайна в спецификации — это «что», это ограничение — указатель SSOT для «как»).

После реализации самопроверься доступными средствами (тест/сборка/запуск) и сообщи результат по чеклисту критериев приёмки. Не трогай не-цели охвата.`,
    "zh-Hans": `实现已批准的机会简报。

## 问题
{{problem}}

## 范围
{{scope}}

## 规格
{{spec}}

{{designContext}}
- 运行本会话的智能体(codex·本地 LLM 等)可能不会自动读取本仓库的 CLAUDE.md/AGENTS.md——若工作触及 UI,请「直接」遵循上方设计约束(spec 的设计验收标准是「做什么」,本约束是「如何做」的 SSOT 指针)。

实现后,用可用手段(测试/构建/运行)自我验证,并按验收标准清单报告结果。不要触碰范围的非目标。`,
  },
} satisfies Record<string, Msg>;
