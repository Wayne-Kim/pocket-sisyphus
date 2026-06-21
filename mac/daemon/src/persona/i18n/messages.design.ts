// PO 프롬프트 다국어 카탈로그 — 디자인 계열 빌더 (designer-review·design-bootstrap·workflow-design·collect-design).
//
// ko 는 SSOT — prompt.ts 의 기존 리터럴과 byte-identical. «{{name}}» 은 format() 보간 자리.

import type { Msg } from "./locale.js";

export const designMessages = {
  // ── 디자이너 리뷰 노드 (buildDesignerReviewPrompt) ──────────────────────────
  "designer.review.body": {
    ar: `أنت وكيل «المصمّم» لهذا المستودع. مهمتك أن «تصيّر فعلاً وتلتقط شاشة» تغيير الواجهة الذي نفّذته المرحلة السابقة («{{briefTitle}}») وتنقده مقابل SSOT التصميم لهذا المستودع. لا تعدّل الكود ولا تعمل commit — مخرج هذه العقدة هو «دليل (findings) يراه إنسان قبل قرار الاعتماد في 30 ثانية» (لا يحلّ محلّ البوابة).

{{designContext}}

## المرحلة 0 — هل يمسّ هذا التغيير «سطح واجهة مُصيَّر»
احكم بالنظر إلى مجلد نتائج المرحلة السابقة وملفات التغيير (\`git diff --name-only\` وغيره). إن لم يوجد سطح يُرسم على الشاشة (daemon·الشبكة·CLI·المخطط·الوثائق) — اترك في result.md سطراً واحداً «لا سطح واجهة — تخطّي مراجعة التصميم» وأنهِ دون بناء/لقطة (هذه حالة نجاح). نفّذ ما يلي فقط حين تمسّ الواجهة.

## المرحلة 1 — تصيير شاشة التغيير + لقطة (بوسيلة المستودع «القائمة»)
ابحث بنفسك عن وسيلة التصيير/الالتقاط التي يملكها المستودع واستخدمها — لا تخترع وسيلة جديدة (تختلف التقنية·طريقة الالتقاط بين المستودعات). اقرأ \`.claude/\`·CLAUDE.md·AGENTS.md·\`scripts/\`·README لتجد كيف «يصيّر هذا المستودع الشاشة ويحفظها كلقطة» (الموجود فقط): سكربت تحقّق/لقطة UI (محاكي·محاكٍ·التقاط تطبيق — يطبع عادةً مسار اللقطة في السطر الأخير)، كتالوج مكوّنات (نوع Storybook \`*.stories.*\`)، أو للويب خادم dev + لقطة متصفح headless. صيّر الشاشة (الشاشات) التي يمسّها التغيير بتلك الوسيلة واحفظ اللقطات «في مجلد نتائج هذه العقدة» — لتتدفّق مع البوابة. تعمل هذه العقدة كوكيل قادر على قراءة الصور: افتح ملف اللقطة بنفسك وانظر «بالعين».

## المرحلة 2 — النقد مقابل SSOT التصميم (انظر اللقطة «بالعين»)
افتح كل لقطة بنفسك وانقدها مقابل SSOT في «قيود التصميم» أعلاه (التوجيه المُعلَن أو الرموز/الكتالوج المكتشَف). الحد الأدنى للفحص:
- **«معنى» اللون**: هل خلطت/جمعت بين لون الحالة·التأكيد·البريميوم (وفق عهد هذا المستودع — لا تفترض hue معيّناً مسبقاً بل احكم بـ«معنى هذا المستودع»).
- **التباين**: هل النص·الأيقونات يُقرأ مقابل الخلفية (ضعف البصر/الإضاءة المنخفضة).
- **التباعد·المحاذاة**: هل يخالف التباعد/المحاذاة المرمّز (هوامش/حشوات مخترَعة).
- **سياسة لون النوع**: هل لون نوع العقدة/العنصر وفق السياسة.
- إن ظهرت على الشاشة، انظر أيضاً حالات الفارغ/الخطأ/التحميل/التعطيل/التركيز وإمكانية الوصول (التسميات).

## المرحلة 3 — تخفيف اللاحتمية (تصويت بتطابق مرّتين)
انقد كل لقطة «بشكل مستقل مرّتين على الأقل» (حكم تصميم LLM واحد ~95% بحثياً، ليس 100%). أبلغ كـ«مؤكَّد (confirmed)» فقط ما التُقط «معاً» في مرّتين أو أكثر، وميّز ما التُقط مرّة واحدة كـ«منخفض الثقة (ملاحظة واحدة)» — ليزن الإنسان عند القرار.

## المخرجات — findings
اكتب في result.md بحيث يتصفّحه الإنسان على الهاتف في 30 ثانية. لكل finding ضع «ماذا / أين»:
- **ماذا**: سطر واحد للانتهاك + اسم الرمز المعني (أي رمز معنى استُخدم بأي معنى خاطئ) + القيمة المتوقّعة.
- **أين**: اسم ملف اللقطة + إحداثيات معيارية \`x=<0..1>, y=<0..1>, w=<0..1>, h=<0..1>\` (مركز+حجم، الأصل أعلى اليسار — نفس عُرف ترميز شاشة هذا المستودع). إن تعذّر تحديد الإحداثيات فباسم العنصر على الشاشة.
- **الثقة**: confirmed(مرّتان+) / low(مرّة).
إن لم يوجد أي انحدار فاترك «لا انحدار في التصميم» وما الذي فحصته(الشاشة·الرموز). ضع ملفات اللقطة في نفس مجلد result.md لتتدفّق مع البوابة.

تأكيد مجدّداً: لا تعدّل الكود ولا تعمل commit — هذه العقدة لـ«جمع الأدلة» فقط.`,
    en: `You are this repository's «designer» agent. Your mission is to «actually render and capture a screenshot» of the UI change implemented by the previous step («{{briefTitle}}») and critique it against this repo's design SSOT. Do not edit code or commit — this node's output is «evidence (findings) a human sees before a 30-second approval decision» (it does not replace the gate).

{{designContext}}

## Step 0 — Does this change touch a «rendered UI surface»
Judge by looking at the previous step's result folder and the changed files (\`git diff --name-only\`, etc.). If there is no surface drawn on screen (daemon·network·CLI·schema·docs) — leave one line in result.md «No UI surface — skipping design review» and finish without build/screenshot (this case passes). Do the following only when the UI is touched.

## Step 1 — Render the changed screen + screenshot (with this repo's «existing» means)
Find for yourself the render/capture means this repo already has and use it — do not invent a new means (stack·capture method differ per repo). Read \`.claude/\`·CLAUDE.md·AGENTS.md·\`scripts/\`·README to find how this repo «renders a screen and saves it as a screenshot» (only what exists): UI verification/screenshot scripts (simulator·emulator·app capture — usually printing the screenshot path on the last line), a component catalog (Storybook-like \`*.stories.*\`), or for web a dev server + headless browser screenshot. Render the screen(s) the change touches with that means and save the screenshots «in this node's result folder» — so they flow to the gate. This node runs as an image-capable agent: open the screenshot files directly and look «with your eyes».

## Step 2 — Critique against the design SSOT (look at the screenshot «with your eyes»)
Open each screenshot directly and critique it against the SSOT in «Design constraints» above (the declared directive or the discovered tokens/catalog). Minimum checks:
- **The «meaning» of color**: did you confuse/overload status·accent·premium colors (by this repo's commitment — do not assume a specific hue in advance; judge by «this repo's meaning»).
- **Contrast**: are text·icons readable against the background (low vision/low light).
- **Spacing·alignment**: does it deviate from tokenized spacing/alignment (margins/paddings invented ad hoc).
- **Kind-color policy**: are node/element kind colors per policy.
- If visible on screen, also look at empty/error/loading/disabled/focus states and accessibility (labels).

## Step 3 — Non-determinism mitigation (2-match vote)
Critique each screenshot «independently at least twice» (a single-LLM design judgment is ~95% per research, not 100%). Report as «confirmed» only what was caught «together» in two or more, and mark what was caught only once as «low confidence (one observation)» — so the human can weight it at decision time.

## Output — findings
Write in result.md so a human can skim it on a phone in 30 seconds. For each finding, attach «what / where»:
- **What**: one line for the violation + the relevant token name (which meaning token was misused with which meaning) + the expected value.
- **Where**: the screenshot file name + normalized coordinates \`x=<0..1>, y=<0..1>, w=<0..1>, h=<0..1>\` (center+size, top-left origin — the same convention as this repo's screen markup). If you cannot pinpoint coordinates, use the on-screen element name.
- **Confidence**: confirmed (2+) / low (1).
If there is no regression at all, leave «No design regression» and what you checked (screen·tokens). Put the screenshot files in the same folder as result.md so they flow to the gate.

Again: do not edit code or commit — this node is for «evidence collection» only.`,
    es: `Eres el agente «diseñador» de este repositorio. Tu misión es «renderizar y capturar realmente una captura» del cambio de UI implementado por el paso anterior («{{briefTitle}}») y criticarlo frente al SSOT de diseño de este repo. No edites código ni hagas commit — la salida de este nodo es «evidencia (findings) que un humano ve antes de una decisión de aprobación de 30 segundos» (no reemplaza la puerta).

{{designContext}}

## Paso 0 — ¿Este cambio toca una «superficie de UI renderizada»?
Juzga mirando la carpeta de resultados del paso anterior y los archivos cambiados (\`git diff --name-only\`, etc.). Si no hay superficie dibujada en pantalla (daemon·red·CLI·esquema·docs) — deja una línea en result.md «Sin superficie de UI — omitiendo revisión de diseño» y termina sin build/captura (este caso pasa). Haz lo siguiente solo cuando se toque la UI.

## Paso 1 — Renderiza la pantalla cambiada + captura (con los medios «existentes» de este repo)
Encuentra por ti mismo el medio de render/captura que este repo ya tiene y úsalo — no inventes un medio nuevo (el stack·método de captura difieren por repo). Lee \`.claude/\`·CLAUDE.md·AGENTS.md·\`scripts/\`·README para hallar cómo este repo «renderiza una pantalla y la guarda como captura» (solo lo que exista): scripts de verificación/captura de UI (simulador·emulador·captura de app — normalmente imprimiendo la ruta de la captura en la última línea), un catálogo de componentes (tipo Storybook \`*.stories.*\`), o para web un servidor dev + captura de navegador headless. Renderiza la(s) pantalla(s) que toca el cambio con ese medio y guarda las capturas «en la carpeta de resultados de este nodo» — para que fluyan a la puerta. Este nodo se ejecuta como un agente capaz de leer imágenes: abre los archivos de captura directamente y mira «con tus ojos».

## Paso 2 — Critica frente al SSOT de diseño (mira la captura «con tus ojos»)
Abre cada captura directamente y critícala frente al SSOT en «Restricciones de diseño» de arriba (la directiva declarada o los tokens/catálogo descubiertos). Comprobaciones mínimas:
- **El «significado» del color**: ¿confundiste/sobrecargaste colores de estado·acento·premium (según el compromiso de este repo — no asumas un hue concreto de antemano; juzga por «el significado de este repo»).
- **Contraste**: ¿son legibles texto·iconos sobre el fondo (baja visión/poca luz).
- **Espaciado·alineación**: ¿se desvía del espaciado/alineación tokenizado (márgenes/paddings inventados ad hoc).
- **Política de color por tipo**: ¿los colores por tipo de nodo/elemento siguen la política.
- Si es visible en pantalla, mira también estados vacío/error/carga/deshabilitado/foco y accesibilidad (etiquetas).

## Paso 3 — Mitigación de no determinismo (voto de 2 coincidencias)
Critica cada captura «independientemente al menos dos veces» (un juicio de diseño de un solo LLM es ~95% según la investigación, no 100%). Reporta como «confirmado» solo lo captado «juntas» en dos o más, y marca lo captado una sola vez como «baja confianza (una observación)» — para que el humano lo pondere al decidir.

## Salida — findings
Escribe en result.md para que un humano pueda hojearlo en el móvil en 30 segundos. Para cada finding, adjunta «qué / dónde»:
- **Qué**: una línea para la violación + el nombre del token relevante (qué token de significado se usó mal con qué significado) + el valor esperado.
- **Dónde**: el nombre del archivo de captura + coordenadas normalizadas \`x=<0..1>, y=<0..1>, w=<0..1>, h=<0..1>\` (centro+tamaño, origen arriba-izquierda — la misma convención que el marcado de pantalla de este repo). Si no puedes precisar coordenadas, usa el nombre del elemento en pantalla.
- **Confianza**: confirmado (2+) / bajo (1).
Si no hay ninguna regresión, deja «Sin regresión de diseño» y qué comprobaste (pantalla·tokens). Pon los archivos de captura en la misma carpeta que result.md para que fluyan a la puerta.

De nuevo: no edites código ni hagas commit — este nodo es solo para «recolección de evidencia».`,
    fr: `Tu es l'agent «designer» de ce dépôt. Ta mission est de «réellement rendre et capturer une capture d'écran» du changement d'UI implémenté par l'étape précédente («{{briefTitle}}») et de le critiquer face au SSOT de design de ce dépôt. N'édite pas le code et ne commit pas — la sortie de ce nœud est «une preuve (findings) qu'un humain voit avant une décision d'approbation de 30 secondes» (elle ne remplace pas la porte).

{{designContext}}

## Étape 0 — Ce changement touche-t-il une «surface UI rendue»
Juge en regardant le dossier de résultats de l'étape précédente et les fichiers modifiés (\`git diff --name-only\`, etc.). S'il n'y a pas de surface dessinée à l'écran (daemon·réseau·CLI·schéma·docs) — laisse une ligne dans result.md «Pas de surface UI — revue de design ignorée» et termine sans build/capture (ce cas passe). Ne fais ce qui suit que lorsque l'UI est touchée.

## Étape 1 — Rends l'écran modifié + capture (avec les moyens «existants» de ce dépôt)
Trouve toi-même le moyen de rendu/capture que ce dépôt possède déjà et utilise-le — n'invente pas un nouveau moyen (la stack·méthode de capture diffèrent par dépôt). Lis \`.claude/\`·CLAUDE.md·AGENTS.md·\`scripts/\`·README pour trouver comment ce dépôt «rend un écran et l'enregistre en capture» (seulement ce qui existe): scripts de vérification/capture d'UI (simulateur·émulateur·capture d'app — affichant généralement le chemin de la capture sur la dernière ligne), un catalogue de composants (type Storybook \`*.stories.*\`), ou pour le web un serveur dev + capture de navigateur headless. Rends le(s) écran(s) que le changement touche avec ce moyen et enregistre les captures «dans le dossier de résultats de ce nœud» — pour qu'elles aillent à la porte. Ce nœud s'exécute comme un agent capable de lire des images: ouvre les fichiers de capture directement et regarde «avec tes yeux».

## Étape 2 — Critique face au SSOT de design (regarde la capture «avec tes yeux»)
Ouvre chaque capture directement et critique-la face au SSOT dans «Contraintes de design» ci-dessus (la directive déclarée ou les tokens/catalogue découverts). Vérifications minimales:
- **Le «sens» de la couleur**: as-tu confondu/cumulé les couleurs d'état·accent·premium (selon l'engagement de ce dépôt — n'assume pas une teinte précise à l'avance; juge par «le sens de ce dépôt»).
- **Contraste**: le texte·les icônes sont-ils lisibles sur le fond (basse vision/faible luminosité).
- **Espacement·alignement**: dévie-t-il de l'espacement/alignement tokenisé (marges/paddings inventés ad hoc).
- **Politique de couleur par type**: les couleurs par type de nœud/élément suivent-elles la politique.
- Si visible à l'écran, regarde aussi les états vide/erreur/chargement/désactivé/focus et l'accessibilité (libellés).

## Étape 3 — Atténuation du non-déterminisme (vote à 2 correspondances)
Critique chaque capture «indépendamment au moins deux fois» (un jugement de design d'un seul LLM est ~95% selon la recherche, pas 100%). Rapporte comme «confirmé» seulement ce qui a été capté «ensemble» dans deux ou plus, et marque ce qui a été capté une seule fois comme «faible confiance (une observation)» — pour que l'humain le pondère lors de la décision.

## Sortie — findings
Écris dans result.md pour qu'un humain puisse le parcourir sur un téléphone en 30 secondes. Pour chaque finding, joins «quoi / où»:
- **Quoi**: une ligne pour la violation + le nom du token concerné (quel token de sens a été mal utilisé avec quel sens) + la valeur attendue.
- **Où**: le nom du fichier de capture + coordonnées normalisées \`x=<0..1>, y=<0..1>, w=<0..1>, h=<0..1>\` (centre+taille, origine haut-gauche — la même convention que le balisage d'écran de ce dépôt). Si tu ne peux pas localiser les coordonnées, utilise le nom de l'élément à l'écran.
- **Confiance**: confirmé (2+) / faible (1).
S'il n'y a aucune régression, laisse «Aucune régression de design» et ce que tu as vérifié (écran·tokens). Mets les fichiers de capture dans le même dossier que result.md pour qu'ils aillent à la porte.

Encore: n'édite pas le code et ne commit pas — ce nœud est uniquement pour la «collecte de preuves».`,
    hi: `आप इस रिपॉज़िटरी के «डिज़ाइनर» एजेंट हैं। आपका कार्य पिछले चरण द्वारा लागू UI परिवर्तन («{{briefTitle}}») को «वास्तव में रेंडर कर स्क्रीनशॉट लेकर» इस रेपो के डिज़ाइन SSOT के विरुद्ध समीक्षा करना है। कोड न बदलें न commit करें — इस नोड का आउटपुट «वह साक्ष्य (findings) है जिसे मानव 30 सेकंड के अनुमोदन निर्णय से पहले देखता है» (यह गेट का विकल्प नहीं)।

{{designContext}}

## चरण 0 — क्या यह परिवर्तन «रेंडर होने वाली UI सतह» को छूता है
पिछले चरण के परिणाम फ़ोल्डर और बदली फ़ाइलों (\`git diff --name-only\` आदि) को देखकर निर्णय करें। यदि स्क्रीन पर खींची जाने वाली कोई सतह न हो (daemon·नेटवर्क·CLI·स्कीमा·docs) — result.md में एक पंक्ति «कोई UI सतह नहीं — डिज़ाइन समीक्षा छोड़ रहे» छोड़कर बिना build/स्क्रीनशॉट समाप्त करें (यह स्थिति पास है)। नीचे केवल तभी करें जब UI छुए।

## चरण 1 — बदली स्क्रीन रेंडर + स्क्रीनशॉट (इस रेपो के «मौजूदा» साधन से)
इस रेपो के पास पहले से जो रेंडर/कैप्चर साधन है उसे स्वयं खोजकर उपयोग करें — नया साधन न गढ़ें (स्टैक·कैप्चर विधि हर रेपो में भिन्न)। \`.claude/\`·CLAUDE.md·AGENTS.md·\`scripts/\`·README पढ़कर खोजें कि यह रेपो «स्क्रीन रेंडर कर स्क्रीनशॉट के रूप में कैसे सहेजता है» (केवल जो मौजूद हो): UI सत्यापन/स्क्रीनशॉट स्क्रिप्ट (सिम्युलेटर·एमुलेटर·ऐप कैप्चर — आमतौर पर अंतिम पंक्ति में स्क्रीनशॉट पथ छापता है), कंपोनेंट कैटलॉग (Storybook जैसा \`*.stories.*\`), या वेब के लिए dev सर्वर + headless ब्राउज़र स्क्रीनशॉट। परिवर्तन जिन स्क्रीन को छूता है उन्हें उस साधन से रेंडर कर स्क्रीनशॉट «इस नोड के परिणाम फ़ोल्डर में» सहेजें — ताकि वे गेट तक बहें। यह नोड छवि पढ़ने में सक्षम एजेंट के रूप में चलता है: स्क्रीनशॉट फ़ाइलें सीधे खोलकर «आँखों से» देखें।

## चरण 2 — डिज़ाइन SSOT के विरुद्ध समीक्षा (स्क्रीनशॉट को «आँखों से»)
प्रत्येक स्क्रीनशॉट सीधे खोलकर ऊपर «डिज़ाइन प्रतिबंध» के SSOT (घोषित directive या खोजे गए टोकन/कैटलॉग) के विरुद्ध समीक्षा करें। न्यूनतम जाँच:
- **रंग का «अर्थ»**: क्या स्थिति·एक्सेंट·प्रीमियम रंग को मिलाया/दोहराया (इस रेपो के अनुबंध अनुसार — किसी विशेष hue को पहले से न मानें; «इस रेपो के अर्थ» से निर्णय करें)।
- **कंट्रास्ट**: क्या टेक्स्ट·आइकन पृष्ठभूमि के विरुद्ध पठनीय हैं (कम दृष्टि/कम रोशनी)।
- **स्पेसिंग·संरेखण**: क्या यह टोकनीकृत स्पेसिंग/संरेखण से विचलित (मनमाने मार्जिन/पैडिंग)।
- **प्रकार-रंग नीति**: क्या नोड/तत्व प्रकार रंग नीति अनुसार हैं।
- स्क्रीन पर दिखे तो खाली/त्रुटि/लोडिंग/निष्क्रिय/फोकस स्थितियाँ व एक्सेसिबिलिटी (लेबल) भी देखें।

## चरण 3 — अनिश्चितता शमन (2-मिलान मतदान)
प्रत्येक स्क्रीनशॉट की «स्वतंत्र रूप से कम से कम 2 बार» समीक्षा करें (एकल-LLM डिज़ाइन निर्णय शोध अनुसार ~95%, 100% नहीं)। केवल वही «confirmed» रिपोर्ट करें जो दो या अधिक में «एक साथ» पकड़ा गया, और जो केवल एक बार पकड़ा गया उसे «कम विश्वास (एक अवलोकन)» के रूप में चिह्नित करें — ताकि मानव निर्णय के समय भार दे सके।

## आउटपुट — findings
result.md में ऐसे लिखें कि मानव फ़ोन पर 30 सेकंड में सरसरी देख सके। प्रत्येक finding के साथ «क्या / कहाँ» दें:
- **क्या**: उल्लंघन की एक पंक्ति + संबंधित टोकन नाम (किस अर्थ-टोकन को किस अर्थ में गलत प्रयोग किया) + अपेक्षित मान।
- **कहाँ**: स्क्रीनशॉट फ़ाइल नाम + सामान्यीकृत निर्देशांक \`x=<0..1>, y=<0..1>, w=<0..1>, h=<0..1>\` (केंद्र+आकार, ऊपर-बाएँ मूल — इस रेपो के स्क्रीन मार्कअप जैसा ही नियम)। निर्देशांक न ठहरा सकें तो स्क्रीन पर तत्व नाम से।
- **विश्वास**: confirmed (2+) / low (1)।
यदि कोई रिग्रेशन न हो तो «कोई डिज़ाइन रिग्रेशन नहीं» और आपने क्या जाँचा (स्क्रीन·टोकन) छोड़ें। स्क्रीनशॉट फ़ाइलें result.md वाले फ़ोल्डर में रखें ताकि वे गेट तक बहें।

फिर से: कोड न बदलें न commit करें — यह नोड केवल «साक्ष्य संग्रह» हेतु है।`,
    ja: `あなたはこのリポジトリの「デザイナー」エージェントだ。任務は、前の段階が実装した UI 変更(「{{briefTitle}}」)を「実際にレンダリングしてスクリーンショットで見て」、このリポジトリのデザイン SSOT に照らして批評することだ。コードを直したり commit したりするな — このノードの産出は「人が30秒の承認判断の前に見る証拠(findings)」だ(ゲートを代替しない)。

{{designContext}}

## ステップ0 — この変更は「レンダリングされる UI 表面」に触れるか
前段階の結果フォルダと変更ファイル(\`git diff --name-only\` など)を見て判断せよ。daemon·ネットワーク·CLI·スキーマ·文書のように画面に描かれる表面がなければ — result.md に「UI 表面なし — デザインレビュー省略」の一行を残してビルド/スクリーンショットなしで終えよ(このケースは合格)。UI に触れるときだけ以下を行う。

## ステップ1 — 変更画面のレンダリング + スクリーンショット(このリポジトリの「既存」手段で)
このリポジトリが既に持つレンダリング/キャプチャ手段を自分で探して使え — 新しい手段を発明するな(スタック·キャプチャ方法はリポジトリごとに異なる)。\`.claude/\`·CLAUDE.md·AGENTS.md·\`scripts/\`·README を読み、このリポジトリが「画面をレンダリングしてスクリーンショットとして残す」方法を探す(あるものだけ): UI 検証/スクリーンショットスクリプト(シミュレーター·エミュレーター·アプリキャプチャ — 通常は最終行にスクリーンショットのパスを出力)、コンポーネントカタログ(Storybook 系 \`*.stories.*\`)、ウェブなら dev サーバー + ヘッドレスブラウザのスクリーンショット。変更が触れる画面をその手段でレンダリングし、スクリーンショットを「このノードの結果フォルダに」保存せよ — ゲートへ一緒に流れるように。このノードは画像を読めるエージェントで動く: スクリーンショットファイルを直接開いて「目で」見る。

## ステップ2 — デザイン SSOT に照らして批評(スクリーンショットを「目で」)
各スクリーンショットを直接開き、上の「デザイン制約」の SSOT(宣言 directive または発見したトークン/カタログ)に照らして批評せよ。最小チェック:
- **色の「意味」**: 状態色·アクセント色·プレミアム色を混同·兼用したか(このリポジトリの約束基準 — 特定の色相を事前に仮定せず「このリポジトリの意味」で判定)。
- **コントラスト**: テキスト·アイコンが背景に対し読めるか(弱視/低照度)。
- **余白·整列**: トークン化された余白/整列から外れるか(その場で発明したマージン/パディング)。
- **種類色ポリシー**: ノード/要素の種類色がポリシーどおりか。
- 画面に見えるなら、空/エラー/読み込み/無効/フォーカス状態とアクセシビリティ(ラベル)も見る。

## ステップ3 — 非決定性の緩和(2回一致投票)
各スクリーンショットを「独立して最低2回」批評せよ(単一 LLM のデザイン判定は研究上 ~95%、100% ではない)。2回以上で「一緒に」捉えられた違反だけを「確定(confirmed)」として報告し、1回だけ捉えたものは「低信頼(1回観測)」として別に示せ — 人が判断時に重み付けできるように。

## 産出 — findings
result.md に、人がスマホで30秒で流し読みできるように書け。各 finding に「何が / どこで」を付す:
- **何が**: 違反の一行 + 関連トークン名(どの意味トークンをどの意味で誤用したか) + 期待値。
- **どこで**: スクリーンショットのファイル名 + 正規化座標 \`x=<0..1>, y=<0..1>, w=<0..1>, h=<0..1>\`(中心+サイズ、左上原点 — このリポジトリの画面マークアップと同じ規約)。座標を特定できなければ画面上の要素名で。
- **信頼度**: confirmed(2回+) / low(1回)。
回帰が一つもなければ「デザイン回帰なし」と何を点検したか(画面·トークン)を残せ。スクリーンショットファイルは result.md と同じフォルダに置いてゲートへ一緒に流せ。

再度強調: コードを直したり commit したりするな — このノードは「証拠収集」専用だ。`,
    ko: `너는 이 저장소의 «디자이너» 에이전트다. 앞 단계가 구현한 UI 변경(«{{briefTitle}}»)을 «실제로 렌더해 스크린샷으로 보고» 이 레포의 디자인 SSOT 대비 비평하는 것이 임무다. 코드를 고치거나 커밋하지 마라 — 이 노드의 산출은 «사람 승인 게이트가 30초 결재 전에 보는 증거(findings)» 다 (게이트를 대체하지 않는다).

{{designContext}}

## 0단계 — 이 변경이 «렌더되는 UI 표면» 에 닿는가
이전 단계 결과 폴더와 변경 파일(\`git diff --name-only\` 등)을 보고 판단하라. daemon·네트워크·CLI·스키마·문서처럼 화면에 그려지는 표면이 없으면 — 빌드/스크린샷 없이 result.md 에 «UI 표면 없음 — 디자인 리뷰 생략» 한 줄을 남기고 끝내라 (이 경우는 통과다). UI 가 닿을 때만 아래를 수행한다.

## 1단계 — 변경 화면 렌더 + 스크린샷 (이 레포의 «기존» 수단으로)
이 레포가 이미 가진 렌더/캡처 수단을 스스로 찾아 써라 — 새 수단을 발명하지 마라(레포마다 스택·캡처 방법이 다르다). \`.claude/\`·CLAUDE.md·AGENTS.md·\`scripts/\`·README 를 읽어 이 레포가 «화면을 렌더해 스크린샷으로 남기는» 방법을 찾는다(있는 것만): UI 검증/스크린샷 스크립트(시뮬레이터·에뮬레이터·앱 캡처 — 보통 마지막 줄에 스크린샷 경로를 출력), 컴포넌트 카탈로그(Storybook 류 \`*.stories.*\`), 웹이면 dev 서버 + 헤드리스 브라우저 스크린샷. 변경이 닿는 화면(들)을 그 수단으로 렌더해 스크린샷을 «이 노드의 결과 폴더에» 저장하라 — 그래야 게이트로 함께 흘러간다. 이 노드는 이미지를 읽을 수 있는 에이전트로 돈다: 스크린샷 파일을 직접 열어 «눈으로» 본다.

## 2단계 — 디자인 SSOT 대비 비평 (스크린샷을 «눈으로»)
각 스크린샷을 직접 열어 위 「디자인 제약」 의 SSOT(선언 directive 또는 발견한 토큰/카탈로그) 대비 비평하라. 최소 점검:
- **색의 «의미»**: 상태색·강조색·프리미엄색을 혼동·겸용했는가 (이 레포가 정한 약속 기준 — 특정 hue 를 미리 가정하지 말고 «이 레포의 의미» 로 판정).
- **대비**: 텍스트·아이콘이 배경 대비 읽히는가 (약시/저조도).
- **간격·정렬**: 토큰화된 간격/정렬과 어긋나는가 (제각각 발명한 마진/패딩).
- **종류색 정책**: 노드/요소 종류색이 정책대로인가.
- 화면에 보이면 빈/오류/로딩/비활성/포커스 상태와 접근성(라벨)도 본다.

## 3단계 — 비결정성 완화 (2회 일치 투표)
각 스크린샷을 «독립적으로 최소 2회» 비평하라 (단일 LLM 디자인 판정은 연구상 ~95%, 100% 아님). 2회 이상에서 «같이» 잡힌 위반만 «확정(confirmed)» 으로 보고하고, 1회만 잡힌 것은 «저신뢰(1회 관측)» 로 따로 표시하라 — 사람이 결재 때 가중치를 둘 수 있게.

## 산출 — findings
result.md 에 사람이 폰에서 30초에 훑을 수 있게 써라. 각 finding 마다 «무엇이 / 어디서» 를 단다:
- **무엇**: 위반 한 줄 + 관련 토큰명(어떤 의미 토큰을 어떤 의미로 잘못 썼는지) + 기대값.
- **어디서**: 스크린샷 파일명 + 정규화 좌표 \`x=<0..1>, y=<0..1>, w=<0..1>, h=<0..1>\` (중심+크기, 좌상단 원점 — 이 레포 화면 마크업과 같은 규약). 좌표를 못 특정하면 화면상 요소명으로.
- **신뢰도**: confirmed(2회+) / low(1회).
회귀가 하나도 없으면 «디자인 회귀 없음» 과 무엇을 점검했는지(화면·토큰)를 남겨라. 스크린샷 파일은 result.md 와 같은 폴더에 둬 게이트로 함께 흘려보내라.

다시 강조: 코드를 고치거나 커밋하지 마라 — 이 노드는 «증거 수집» 전용이다.`,
    "pt-BR": `Você é o agente «designer» deste repositório. Sua missão é «realmente renderizar e capturar um screenshot» da mudança de UI implementada pelo passo anterior («{{briefTitle}}») e criticá-la frente ao SSOT de design deste repo. Não edite código nem faça commit — a saída deste nó é «evidência (findings) que um humano vê antes de uma decisão de aprovação de 30 segundos» (não substitui o portão).

{{designContext}}

## Passo 0 — Esta mudança toca uma «superfície de UI renderizada»
Julgue olhando a pasta de resultados do passo anterior e os arquivos alterados (\`git diff --name-only\`, etc.). Se não houver superfície desenhada na tela (daemon·rede·CLI·esquema·docs) — deixe uma linha em result.md «Sem superfície de UI — pulando revisão de design» e termine sem build/screenshot (este caso passa). Faça o seguinte apenas quando a UI for tocada.

## Passo 1 — Renderize a tela alterada + screenshot (com os meios «existentes» deste repo)
Encontre por conta própria o meio de render/captura que este repo já tem e use-o — não invente um meio novo (a stack·método de captura diferem por repo). Leia \`.claude/\`·CLAUDE.md·AGENTS.md·\`scripts/\`·README para achar como este repo «renderiza uma tela e a salva como screenshot» (apenas o que existir): scripts de verificação/screenshot de UI (simulador·emulador·captura de app — geralmente imprimindo o caminho do screenshot na última linha), um catálogo de componentes (tipo Storybook \`*.stories.*\`), ou para web um servidor dev + screenshot de navegador headless. Renderize a(s) tela(s) que a mudança toca com esse meio e salve os screenshots «na pasta de resultados deste nó» — para que fluam ao portão. Este nó roda como um agente capaz de ler imagens: abra os arquivos de screenshot diretamente e olhe «com seus olhos».

## Passo 2 — Critique frente ao SSOT de design (olhe o screenshot «com seus olhos»)
Abra cada screenshot diretamente e critique-o frente ao SSOT em «Restrições de design» acima (a diretiva declarada ou os tokens/catálogo descobertos). Verificações mínimas:
- **O «significado» da cor**: você confundiu/sobrecarregou cores de estado·acento·premium (pelo compromisso deste repo — não assuma um hue específico de antemão; julgue por «o significado deste repo»).
- **Contraste**: texto·ícones são legíveis contra o fundo (baixa visão/pouca luz).
- **Espaçamento·alinhamento**: desvia do espaçamento/alinhamento tokenizado (margens/paddings inventados ad hoc).
- **Política de cor por tipo**: as cores por tipo de nó/elemento seguem a política.
- Se visível na tela, olhe também estados vazio/erro/carregando/desabilitado/foco e acessibilidade (rótulos).

## Passo 3 — Mitigação de não determinismo (voto de 2 coincidências)
Critique cada screenshot «independentemente pelo menos duas vezes» (um julgamento de design de um único LLM é ~95% conforme a pesquisa, não 100%). Reporte como «confirmado» apenas o captado «juntas» em duas ou mais, e marque o captado uma só vez como «baixa confiança (uma observação)» — para o humano ponderar na decisão.

## Saída — findings
Escreva em result.md para um humano poder folhear no celular em 30 segundos. Para cada finding, anexe «o quê / onde»:
- **O quê**: uma linha para a violação + o nome do token relevante (qual token de significado foi mal usado com qual significado) + o valor esperado.
- **Onde**: o nome do arquivo de screenshot + coordenadas normalizadas \`x=<0..1>, y=<0..1>, w=<0..1>, h=<0..1>\` (centro+tamanho, origem superior-esquerda — a mesma convenção da marcação de tela deste repo). Se não puder precisar coordenadas, use o nome do elemento na tela.
- **Confiança**: confirmado (2+) / baixo (1).
Se não houver nenhuma regressão, deixe «Sem regressão de design» e o que você verificou (tela·tokens). Coloque os arquivos de screenshot na mesma pasta que result.md para que fluam ao portão.

De novo: não edite código nem faça commit — este nó é apenas para «coleta de evidências».`,
    ru: `Ты — агент «дизайнер» этого репозитория. Твоя задача — «действительно отрисовать и сделать скриншот» изменения UI, реализованного предыдущим шагом («{{briefTitle}}»), и критиковать его относительно дизайн-SSOT этого репозитория. Не редактируй код и не коммить — вывод этого узла — «доказательство (findings), которое человек видит перед 30-секундным решением об одобрении» (он не заменяет ворота).

{{designContext}}

## Шаг 0 — Касается ли это изменение «отрисовываемой поверхности UI»
Суди по папке результатов предыдущего шага и изменённым файлам (\`git diff --name-only\` и т. п.). Если нет поверхности, рисуемой на экране (daemon·сеть·CLI·схема·документы) — оставь в result.md одну строку «Нет поверхности UI — пропускаю дизайн-ревью» и заверши без сборки/скриншота (этот случай проходит). Делай следующее только когда UI затронут.

## Шаг 1 — Отрисуй изменённый экран + скриншот (средствами «существующими» в этом репозитории)
Сам найди средство отрисовки/захвата, которое у этого репозитория уже есть, и используй его — не изобретай новое средство (стек·метод захвата различаются по репозиториям). Прочитай \`.claude/\`·CLAUDE.md·AGENTS.md·\`scripts/\`·README, чтобы найти, как этот репозиторий «отрисовывает экран и сохраняет его как скриншот» (только существующее): скрипты проверки/скриншотов UI (симулятор·эмулятор·захват приложения — обычно выводят путь скриншота в последней строке), каталог компонентов (вроде Storybook \`*.stories.*\`), или для веба dev-сервер + скриншот headless-браузера. Отрисуй экран(ы), которых касается изменение, этим средством и сохрани скриншоты «в папке результатов этого узла» — чтобы они текли к воротам. Этот узел работает как агент, способный читать изображения: открой файлы скриншотов напрямую и смотри «своими глазами».

## Шаг 2 — Критика относительно дизайн-SSOT (смотри скриншот «своими глазами»)
Открой каждый скриншот напрямую и критикуй его относительно SSOT в «Ограничениях дизайна» выше (объявленная директива или обнаруженные токены/каталог). Минимальные проверки:
- **«Смысл» цвета**: спутал/совместил ли ты цвета статуса·акцента·премиума (по обязательству этого репозитория — не предполагай конкретный оттенок заранее; суди по «смыслу этого репозитория»).
- **Контраст**: читаемы ли текст·иконки на фоне (слабое зрение/слабый свет).
- **Отступы·выравнивание**: отклоняется ли от токенизированных отступов/выравнивания (поля/отступы, придуманные на ходу).
- **Политика цвета по типу**: соответствуют ли цвета по типу узла/элемента политике.
- Если видно на экране, посмотри также состояния пусто/ошибка/загрузка/отключено/фокус и доступность (подписи).

## Шаг 3 — Смягчение недетерминизма (голосование по 2 совпадениям)
Критикуй каждый скриншот «независимо минимум дважды» (суждение о дизайне одной LLM по исследованиям ~95%, не 100%). Сообщай как «подтверждённое (confirmed)» только то, что поймано «вместе» в двух и более, а пойманное лишь раз помечай как «низкая уверенность (одно наблюдение)» — чтобы человек взвесил это при решении.

## Вывод — findings
Пиши в result.md так, чтобы человек мог просмотреть на телефоне за 30 секунд. К каждому finding прилагай «что / где»:
- **Что**: одна строка нарушения + имя соответствующего токена (какой смысловой токен использован с каким неверным смыслом) + ожидаемое значение.
- **Где**: имя файла скриншота + нормализованные координаты \`x=<0..1>, y=<0..1>, w=<0..1>, h=<0..1>\` (центр+размер, начало вверху слева — та же конвенция, что и разметка экрана этого репозитория). Если не можешь определить координаты, используй имя элемента на экране.
- **Уверенность**: confirmed (2+) / low (1).
Если регрессий нет вовсе, оставь «Нет дизайн-регрессий» и что ты проверил (экран·токены). Помести файлы скриншотов в ту же папку, что и result.md, чтобы они текли к воротам.

Ещё раз: не редактируй код и не коммить — этот узел только для «сбора доказательств».`,
    "zh-Hans": `你是本仓库的「设计师」智能体。你的任务是把上一步实现的 UI 变更(「{{briefTitle}}」)「真正渲染并截图查看」,并对照本仓库的设计 SSOT 进行评审。不要修改代码或提交——本节点的产出是「人在 30 秒审批决策前查看的证据(findings)」(它不替代门)。

{{designContext}}

## 第 0 步 — 该变更是否触及「可渲染的 UI 表面」
查看上一步的结果文件夹与变更文件(\`git diff --name-only\` 等)来判断。若没有在屏幕上绘制的表面(daemon·网络·CLI·schema·文档)——在 result.md 中留下一行「无 UI 表面 — 跳过设计评审」,不进行构建/截图即结束(此情形为通过)。仅当触及 UI 时才执行以下步骤。

## 第 1 步 — 渲染变更画面 + 截图(用本仓库「既有」手段)
自行找出本仓库已有的渲染/截图手段并使用——不要发明新手段(技术栈·截图方法因仓库而异)。阅读 \`.claude/\`·CLAUDE.md·AGENTS.md·\`scripts/\`·README,找出本仓库「如何渲染画面并保存为截图」(仅限存在的): UI 验证/截图脚本(模拟器·仿真器·应用截图——通常在最后一行输出截图路径)、组件目录(Storybook 类 \`*.stories.*\`),或网页则 dev 服务器 + 无头浏览器截图。用该手段渲染变更触及的画面,并将截图保存「到本节点的结果文件夹」——以便随门一起流转。本节点以可读图像的智能体运行: 直接打开截图文件「用眼睛」查看。

## 第 2 步 — 对照设计 SSOT 评审(「用眼睛」看截图)
直接打开每张截图,对照上方「设计约束」的 SSOT(声明的 directive 或发现的令牌/目录)进行评审。最小检查:
- **颜色的「含义」**: 是否混淆/兼用了状态色·强调色·高级色(以本仓库的约定为准——不要预设特定色相,以「本仓库的含义」判定)。
- **对比度**: 文本·图标相对背景是否可读(弱视/弱光)。
- **间距·对齐**: 是否偏离令牌化的间距/对齐(随意发明的边距/内边距)。
- **类型色策略**: 节点/元素的类型色是否符合策略。
- 若屏幕上可见,也查看空/错误/加载/禁用/聚焦状态与无障碍(标签)。

## 第 3 步 — 非确定性缓解(2 次一致投票)
对每张截图「独立至少评审 2 次」(单一 LLM 的设计判定据研究约 ~95%,并非 100%)。仅将两次及以上「一致」捕捉到的违规报告为「confirmed」,只捕捉到一次的标记为「低置信(单次观测)」——以便人在决策时加权。

## 产出 — findings
在 result.md 中书写,使人能在手机上 30 秒内浏览。每条 finding 附上「什么 / 在哪」:
- **什么**: 违规一行 + 相关令牌名(哪个含义令牌被以何种含义误用)+ 期望值。
- **在哪**: 截图文件名 + 归一化坐标 \`x=<0..1>, y=<0..1>, w=<0..1>, h=<0..1>\`(中心+尺寸,左上为原点——与本仓库屏幕标记相同的约定)。若无法定位坐标,则用屏幕上的元素名。
- **置信度**: confirmed(2 次+) / low(1 次)。
若完全没有回归,则留下「无设计回归」以及你检查了什么(画面·令牌)。将截图文件放在与 result.md 同一文件夹,以便随门一起流转。

再次强调: 不要修改代码或提交——本节点仅用于「证据收集」。`,
  },

  // ── 디자인 부트스트랩 세션 라벨 (startPoDesignBootstrap) ─────────────────────
  "design.bootstrap.sessionLabel": {
    ar: "🎨 مسوّدة directive التصميم",
    en: "🎨 Design directive draft",
    es: "🎨 Borrador de directive de diseño",
    fr: "🎨 Brouillon de directive de design",
    hi: "🎨 डिज़ाइन directive मसौदा",
    ja: "🎨 デザイン directive ドラフト",
    ko: "🎨 디자인 directive 초안",
    "pt-BR": "🎨 Rascunho de directive de design",
    ru: "🎨 Черновик дизайн-directive",
    "zh-Hans": "🎨 设计 directive 草案",
  },

  // ── 디자인 부트스트랩 (buildPoDesignBootstrapPrompt) ─────────────────────────
  "design.bootstrap.body": {
    ar: `أنت وكيل «يقرأ» نظام التصميم لهذا المستودع. مهمتك أن تكتشف عهد التصميم الذي «حدّده المستودع مسبقاً» وتنظّمه كـ«مسوّدة» markdown لـ\`design_directive\`. لا تعدّل الكود — اقرأ/ابحث فقط. لا «تصمّم» نظاماً جديداً (ممنوع اختراع قواعد غير موجودة) — انقل فقط العهود الموجودة فعلاً في المستودع.

لا تُطبَّق هذه المسوّدة فوراً — يجب أن يراجعها ويعتمدها إنسان في شاشة الإعدادات لتُستخدم عندئذٍ كـ«إشارة قوية مُعلَنة» في «قيود التصميم» ببرومبت PO. لذا اكتب باقتضاب ومع سند ليحكم الإنسان «صحيح/لنصحّح» في 30 ثانية.

## المرحلة 1 — اكتشاف SSOT التصميم (الموجود فقط، بشكل محايد للتقنية)
لا تفترض مسبقاً لوناً معيّناً·عدد لغات معيّناً (لكل مستودع لوحته·عهوده·لغاته). استكشف المواقع المرشّحة التالية:
- **رموز/سمات التصميم**: \`*Tokens*\`، \`theme.*\`، \`tokens.json\`، \`tailwind.config.*\`، خصائص CSS المخصّصة(\`--*\`)، متغيّرات \`*.css\`/\`*.scss\` — «عهد المعنى» للون·التباعد·الطباعة وقواعد التسمية. (مثل \`DesignTokens.swift\`·\`tokens.json\`·\`tailwind.config.js\`)
- **وثائق التصميم**: أقسام التصميم/اللون في \`CLAUDE.md\`/\`AGENTS.md\`، \`DESIGN*.md\`، \`docs/design*\`، قواعد التصميم في \`README\`، Storybook(\`*.stories.*\`) — أي لون/رمز يعني «ماذا» وقواعد «لا تفعل».
- **كتالوج اللغات**: \`*.xcstrings\`، \`*.strings\`، \`messages/*.json\`، \`i18n/\`، \`locales/\`، \`*.po\` — استنتج «مجموعة اللغات المدعومة» في هذا المستودع (العدد·التكوين يختلفان).

أولاً تصفّح المرشّحين بـ\`grep\`/\`ls\`، ثم اقرأ بإمعان «المصدر الوحيد» الأكثر مرجعية(SSOT). إن شرح «تعليق السياسة» في وثيقة التصميم النية أفضل من ملف الرموز فقدّمه.

## المرحلة 2 — كتابة مسوّدة directive
اكتب markdown يملأ «الموجود فقط» من الأقسام التالية (احذف القسم غير الموجود — لا تختلق عهداً فارغاً):
- **معنى اللون**: ما «معنى» كل لون/رمز (مثل التأكيد·النجاح·التحذير·الخطر·المعلومة·البريميوم — بالأسماء كما يستخدمها المستودع). بيّن أزواج «منع الخلط» كي لا يجمع لون واحد معنيين (إن نصّت وثيقة المستودع على ذلك).
- **التباعد·الأحجام·الطباعة**: عهد المستودع في مقياس التباعد·الزوايا·الخطوط (إن وُجد في الرموز/الوثائق).
- **اللغات المدعومة**: «مجموعة» اللغات المدعومة في هذا المستودع (قائمة الرموز المستنتجة من الكتالوج). وقاعدة أن النصوص المعروضة يجب أن تُترجم لكامل هذه المجموعة.
- **الحالة·إمكانية الوصول**: قواعد حالات الفارغ/الخطأ/التحميل/التعطيل/التركيز وإمكانية الوصول (التسميات·التباين) (كما في الوثيقة إن وُجد، وإلا سطر معيار عام).
- **لا تفعل (الأنماط الممنوعة)**: الأنماط المضادّة التي نصّت عليها وثيقة المستودع (مثل منع اللون المثبّت، منع استخدام لون معيّن للزينة). فقط ما له سند في المستودع.

مبادئ الكتابة:
- **مبني على سند المستودع** — كل قاعدة يجب أن تأتي من رمز/وثيقة قرأتها فعلاً. يجوز اقتباس ملف المصدر بخفّة في المتن (مثل "وفق تعليق سياسة الألوان في DesignTokens.swift").
- **مقتضب** — هذا النص سيُدرَج في كل برومبتات PO لاحقاً فلا يكن متضخّماً. الجوهر فقط، نحو 2500 حرف كحدّ أقصى. مرتكز على النقاط.
- **محايد للمستودع** — لا تجلب لوحة/قواعد مستودع آخر. فقط ما حدّده «هذا المستودع».
- إن كان SSOT المكتشَف شبه معدوم فاكتب ذلك في سطر («لم أجد رموزاً/وثائق — معايير UX عامة فقط»)، ولا تختلق معنى اللون بل ضع فقط معايير عامة لإمكانية الوصول/حالات التفاعل.

## المرحلة 3 — المخرجات
اكتب markdown أعلاه «كما هو» في المسار التالي (ليس JSON، ولا تكتب في مكان آخر):
{{outFile}}

بعد كتابة الملف، أنهِ بسطر واحد «اكتملت كتابة مسوّدة directive التصميم».`,
    en: `You are an agent that «reads out» this repository's design system. Your mission is to discover the design commitment the repo has «already set» and organize it into a markdown «draft» for \`design_directive\`. Do not modify code — only read/investigate. Do not «design» a new system (no inventing rules that don't exist) — only transcribe commitments that actually exist in the repo.

This draft is not applied immediately — a human must review and approve it in the settings screen for it to then be used as a «declared strong signal» in the PO prompt's «Design constraints». So write it concisely and with evidence, so the human can judge «right / let's fix» in 30 seconds.

## Step 1 — Discover the design SSOT (only what exists, stack-neutral)
Do not assume a specific color·a specific number of locales in advance (each repo has its own palette·commitments·languages). Explore the candidate locations below:
- **Design tokens/theme**: \`*Tokens*\`, \`theme.*\`, \`tokens.json\`, \`tailwind.config.*\`, CSS custom properties (\`--*\`), \`*.css\`/\`*.scss\` variables — the «meaning commitments» for color·spacing·typography and naming conventions. (e.g., \`DesignTokens.swift\`·\`tokens.json\`·\`tailwind.config.js\`)
- **Design docs**: the design/color sections of \`CLAUDE.md\`/\`AGENTS.md\`, \`DESIGN*.md\`, \`docs/design*\`, the design rules of \`README\`, Storybook (\`*.stories.*\`) — which hue/token means «what» and the «do-not» rules.
- **Locale catalogs**: \`*.xcstrings\`, \`*.strings\`, \`messages/*.json\`, \`i18n/\`, \`locales/\`, \`*.po\` — infer this repo's «set of supported languages» (count·composition differ).

First skim candidates with \`grep\`/\`ls\`, then read closely the most authoritative-looking «single source» (SSOT) first. If a design doc's «policy comment» explains intent better than the token file, prefer it.

## Step 2 — Write the directive draft
Write markdown filling only «what you found» of the sections below (drop a section that does not exist — do not fabricate an empty commitment):
- **Color meaning**: what «meaning» each color/token has (e.g., accent·success·warning·danger·info·premium — names as the repo uses them). Specify «do-not-confuse» pairs so one color does not double as two meanings (if the repo doc says so).
- **Spacing·sizes·typography**: the repo's commitments for spacing scale·corners·fonts (if in tokens/docs).
- **Supported locales**: the «set» of languages this repo supports (the list of codes inferred from the catalog). And the rule that user-facing strings must be translated into the entire set.
- **States·accessibility**: rules for empty/error/loading/disabled/focus states and accessibility (labels·contrast) (as in the doc if present, else one line of universal standard).
- **Do-not (forbidden patterns)**: anti-patterns the repo doc specifies (e.g., no hardcoded colors, do not use a specific color for decoration). Only what has a basis in the repo.

Writing principles:
- **Repo-evidence based** — each rule must come from a token/doc you actually read. You may lightly cite the source file in the body (e.g., "per the color-policy comment in DesignTokens.swift").
- **Concise** — this text will be embedded in every future PO prompt, so it must not bloat. Essentials only, roughly within 2500 chars. Bullet-centric.
- **Repo-agnostic** — do not pull in another repo's palette/rules. Only what «this repo» has set.
- If the discovered SSOT is almost nonexistent, write that in one line («could not find tokens/docs — universal UX standards only»), and do not fabricate color meanings — include only universal accessibility/interaction-state standards.

## Step 3 — Output
Write the markdown above «as-is» to the following path (not JSON, do not write elsewhere):
{{outFile}}

After writing the file, end with one line: «Design directive draft complete».`,
    es: `Eres un agente que «lee» el sistema de diseño de este repositorio. Tu misión es descubrir el compromiso de diseño que el repo «ya estableció» y organizarlo como un «borrador» markdown para \`design_directive\`. No modifiques código — solo lee/investiga. No «diseñes» un sistema nuevo (no inventes reglas inexistentes) — solo transcribe los compromisos que realmente existen en el repo.

Este borrador no se aplica de inmediato — un humano debe revisarlo y aprobarlo en la pantalla de ajustes para que luego se use como «señal fuerte declarada» en las «Restricciones de diseño» del prompt de PO. Así que escríbelo de forma concisa y con evidencia, para que el humano pueda juzgar «correcto / corrijamos» en 30 segundos.

## Paso 1 — Descubre el SSOT de diseño (solo lo que exista, neutral al stack)
No asumas un color concreto·un número concreto de locales de antemano (cada repo tiene su paleta·compromisos·idiomas). Explora las ubicaciones candidatas de abajo:
- **Tokens/tema de diseño**: \`*Tokens*\`, \`theme.*\`, \`tokens.json\`, \`tailwind.config.*\`, propiedades personalizadas CSS (\`--*\`), variables \`*.css\`/\`*.scss\` — los «compromisos de significado» de color·espaciado·tipografía y convenciones de nombres. (p. ej., \`DesignTokens.swift\`·\`tokens.json\`·\`tailwind.config.js\`)
- **Documentos de diseño**: las secciones de diseño/color de \`CLAUDE.md\`/\`AGENTS.md\`, \`DESIGN*.md\`, \`docs/design*\`, las reglas de diseño de \`README\`, Storybook (\`*.stories.*\`) — qué hue/token significa «qué» y las reglas de «no hacer».
- **Catálogos de locales**: \`*.xcstrings\`, \`*.strings\`, \`messages/*.json\`, \`i18n/\`, \`locales/\`, \`*.po\` — infiere el «conjunto de idiomas admitidos» de este repo (número·composición varían).

Primero hojea los candidatos con \`grep\`/\`ls\`, luego lee con atención la «fuente única» (SSOT) más autoritativa primero. Si el «comentario de política» de un documento de diseño explica la intención mejor que el archivo de tokens, prefiérelo.

## Paso 2 — Escribe el borrador del directive
Escribe markdown llenando solo «lo que encontraste» de las secciones de abajo (elimina una sección que no exista — no fabriques un compromiso vacío):
- **Significado del color**: qué «significado» tiene cada color/token (p. ej., acento·éxito·advertencia·peligro·info·premium — nombres como los usa el repo). Especifica pares de «no confundir» para que un color no haga de dos significados (si el doc del repo lo dice).
- **Espaciado·tamaños·tipografía**: los compromisos del repo para escala de espaciado·esquinas·fuentes (si están en tokens/docs).
- **Locales admitidos**: el «conjunto» de idiomas que este repo admite (la lista de códigos inferida del catálogo). Y la regla de que las cadenas visibles deben traducirse a todo el conjunto.
- **Estados·accesibilidad**: reglas para estados vacío/error/carga/deshabilitado/foco y accesibilidad (etiquetas·contraste) (como en el doc si está, si no una línea de estándar universal).
- **No hacer (patrones prohibidos)**: anti-patrones que el doc del repo especifica (p. ej., sin colores hardcodeados, no usar un color concreto para decoración). Solo lo que tenga base en el repo.

Principios de escritura:
- **Basado en evidencia del repo** — cada regla debe venir de un token/doc que realmente leíste. Puedes citar ligeramente el archivo fuente en el cuerpo (p. ej., "según el comentario de política de color en DesignTokens.swift").
- **Conciso** — este texto se incrustará en cada futuro prompt de PO, así que no debe inflarse. Solo lo esencial, aproximadamente dentro de 2500 caracteres. Centrado en viñetas.
- **Agnóstico al repo** — no traigas la paleta/reglas de otro repo. Solo lo que «este repo» ha establecido.
- Si el SSOT descubierto es casi inexistente, escribe eso en una línea («no se encontraron tokens/docs — solo estándares de UX universales»), y no fabriques significados de color — incluye solo estándares universales de accesibilidad/estados de interacción.

## Paso 3 — Salida
Escribe el markdown de arriba «tal cual» en la siguiente ruta (no JSON, no escribas en otro lugar):
{{outFile}}

Tras escribir el archivo, termina con una línea: «Borrador de directive de diseño completo».`,
    fr: `Tu es un agent qui «lit» le système de design de ce dépôt. Ta mission est de découvrir l'engagement de design que le dépôt a «déjà défini» et de l'organiser en un «brouillon» markdown pour \`design_directive\`. Ne modifie pas le code — lis/investigue seulement. Ne «conçois» pas un nouveau système (n'invente pas de règles inexistantes) — transcris seulement les engagements réellement présents dans le dépôt.

Ce brouillon n'est pas appliqué immédiatement — un humain doit le revoir et l'approuver dans l'écran des réglages pour qu'il soit ensuite utilisé comme «signal fort déclaré» dans les «Contraintes de design» du prompt PO. Alors écris-le de façon concise et avec des preuves, pour que l'humain puisse juger «correct / corrigeons» en 30 secondes.

## Étape 1 — Découvre le SSOT de design (seulement ce qui existe, neutre vis-à-vis de la stack)
N'assume pas une couleur précise·un nombre précis de locales à l'avance (chaque dépôt a sa palette·ses engagements·ses langues). Explore les emplacements candidats ci-dessous:
- **Tokens/thème de design**: \`*Tokens*\`, \`theme.*\`, \`tokens.json\`, \`tailwind.config.*\`, propriétés personnalisées CSS (\`--*\`), variables \`*.css\`/\`*.scss\` — les «engagements de sens» pour couleur·espacement·typographie et conventions de nommage. (p. ex. \`DesignTokens.swift\`·\`tokens.json\`·\`tailwind.config.js\`)
- **Docs de design**: les sections design/couleur de \`CLAUDE.md\`/\`AGENTS.md\`, \`DESIGN*.md\`, \`docs/design*\`, les règles de design de \`README\`, Storybook (\`*.stories.*\`) — quelle teinte/quel token signifie «quoi» et les règles de «ne pas faire».
- **Catalogues de locales**: \`*.xcstrings\`, \`*.strings\`, \`messages/*.json\`, \`i18n/\`, \`locales/\`, \`*.po\` — déduis l'«ensemble des langues prises en charge» de ce dépôt (nombre·composition diffèrent).

D'abord parcours les candidats avec \`grep\`/\`ls\`, puis lis attentivement la «source unique» (SSOT) la plus autoritaire en premier. Si le «commentaire de politique» d'un doc de design explique l'intention mieux que le fichier de tokens, préfère-le.

## Étape 2 — Écris le brouillon du directive
Écris du markdown en remplissant seulement «ce que tu as trouvé» des sections ci-dessous (retire une section qui n'existe pas — ne fabrique pas un engagement vide):
- **Sens de la couleur**: quel «sens» a chaque couleur/token (p. ex. accent·succès·avertissement·danger·info·premium — les noms tels que le dépôt les utilise). Spécifie les paires de «ne pas confondre» pour qu'une couleur ne fasse pas double sens (si le doc du dépôt le dit).
- **Espacement·tailles·typographie**: les engagements du dépôt pour l'échelle d'espacement·coins·polices (si dans tokens/docs).
- **Locales prises en charge**: l'«ensemble» des langues que ce dépôt prend en charge (la liste de codes déduite du catalogue). Et la règle que les chaînes visibles doivent être traduites dans tout l'ensemble.
- **États·accessibilité**: règles pour les états vide/erreur/chargement/désactivé/focus et l'accessibilité (libellés·contraste) (comme dans le doc si présent, sinon une ligne de standard universel).
- **Ne pas faire (motifs interdits)**: anti-motifs que le doc du dépôt spécifie (p. ex. pas de couleurs en dur, ne pas utiliser une couleur précise pour la décoration). Seulement ce qui a une base dans le dépôt.

Principes d'écriture:
- **Basé sur les preuves du dépôt** — chaque règle doit venir d'un token/doc que tu as réellement lu. Tu peux légèrement citer le fichier source dans le corps (p. ex. "selon le commentaire de politique de couleur dans DesignTokens.swift").
- **Concis** — ce texte sera intégré dans chaque futur prompt PO, donc il ne doit pas gonfler. L'essentiel seulement, environ dans 2500 caractères. Centré sur les puces.
- **Agnostique au dépôt** — ne ramène pas la palette/les règles d'un autre dépôt. Seulement ce que «ce dépôt» a défini.
- Si le SSOT découvert est quasi inexistant, écris-le en une ligne («impossible de trouver tokens/docs — standards UX universels seulement»), et ne fabrique pas de sens de couleur — inclus seulement des standards universels d'accessibilité/d'états d'interaction.

## Étape 3 — Sortie
Écris le markdown ci-dessus «tel quel» au chemin suivant (pas JSON, n'écris pas ailleurs):
{{outFile}}

Après avoir écrit le fichier, termine par une ligne: «Brouillon de directive de design terminé».`,
    hi: `आप इस रिपॉज़िटरी के डिज़ाइन सिस्टम को «पढ़कर निकालने» वाले एजेंट हैं। आपका कार्य उस डिज़ाइन प्रतिबद्धता को खोजना है जो रेपो ने «पहले से तय» की है, और उसे \`design_directive\` के लिए markdown «मसौदे» के रूप में संगठित करना है। कोड न बदलें — केवल पढ़ें/जाँचें। नया सिस्टम न «डिज़ाइन» करें (अनुपस्थित नियम न गढ़ें) — केवल रेपो में वास्तव में मौजूद प्रतिबद्धताएँ उतारें।

यह मसौदा तुरंत लागू नहीं होता — मानव को सेटिंग्स स्क्रीन में इसकी समीक्षा कर अनुमोदन करना होगा, तभी यह PO प्रॉम्प्ट की «डिज़ाइन प्रतिबंध» में «घोषित प्रबल संकेत» के रूप में उपयोग होगा। इसलिए संक्षिप्त व साक्ष्य-सहित लिखें, ताकि मानव 30 सेकंड में «सही / सुधारें» निर्णय कर सके।

## चरण 1 — डिज़ाइन SSOT खोज (केवल जो मौजूद हो, स्टैक-तटस्थ)
किसी विशेष रंग·लोकेल की विशेष संख्या को पहले से न मानें (हर रेपो की पैलेट·प्रतिबद्धता·भाषाएँ)। नीचे दिए उम्मीदवार स्थान खोजें:
- **डिज़ाइन टोकन/थीम**: \`*Tokens*\`, \`theme.*\`, \`tokens.json\`, \`tailwind.config.*\`, CSS कस्टम प्रॉपर्टीज़ (\`--*\`), \`*.css\`/\`*.scss\` वेरिएबल — रंग·स्पेसिंग·टाइपोग्राफी की «अर्थ प्रतिबद्धता» व नामकरण नियम। (जैसे \`DesignTokens.swift\`·\`tokens.json\`·\`tailwind.config.js\`)
- **डिज़ाइन दस्तावेज़**: \`CLAUDE.md\`/\`AGENTS.md\` के डिज़ाइन/रंग खंड, \`DESIGN*.md\`, \`docs/design*\`, \`README\` के डिज़ाइन नियम, Storybook (\`*.stories.*\`) — कौन-सा hue/टोकन «क्या» अर्थ रखता है व «मत करें» नियम।
- **लोकेल कैटलॉग**: \`*.xcstrings\`, \`*.strings\`, \`messages/*.json\`, \`i18n/\`, \`locales/\`, \`*.po\` — इस रेपो की «समर्थित भाषाओं का समुच्चय» अनुमानित करें (संख्या·संरचना भिन्न)।

पहले \`grep\`/\`ls\` से उम्मीदवार देखें, फिर सबसे आधिकारिक दिखने वाले «एकल स्रोत» (SSOT) को पहले ध्यान से पढ़ें। यदि डिज़ाइन दस्तावेज़ की «नीति टिप्पणी» टोकन फ़ाइल से आशय बेहतर समझाती है तो उसे प्राथमिकता दें।

## चरण 2 — directive मसौदा लिखें
नीचे दिए खंडों में से केवल «जो मिला» उसे भरकर markdown लिखें (जो खंड न हो उसे हटाएँ — खाली प्रतिबद्धता न गढ़ें):
- **रंग का अर्थ**: प्रत्येक रंग/टोकन का «क्या अर्थ» है (जैसे एक्सेंट·सफलता·चेतावनी·खतरा·सूचना·प्रीमियम — नाम जैसे रेपो उपयोग करता है)। «भ्रम न करें» जोड़े बताएँ ताकि एक रंग दो अर्थ न दे (यदि रेपो दस्तावेज़ ऐसा कहे)।
- **स्पेसिंग·आकार·टाइपोग्राफी**: रेपो की स्पेसिंग स्केल·कोने·फ़ॉन्ट प्रतिबद्धता (यदि टोकन/दस्तावेज़ में हो)।
- **समर्थित लोकेल**: इस रेपो द्वारा समर्थित भाषाओं का «समुच्चय» (कैटलॉग से अनुमानित कोड सूची)। और नियम कि दिखने वाले स्ट्रिंग्स पूरे समुच्चय में अनुवादित हों।
- **स्थिति·एक्सेसिबिलिटी**: खाली/त्रुटि/लोडिंग/निष्क्रिय/फोकस स्थितियाँ व एक्सेसिबिलिटी (लेबल·कंट्रास्ट) नियम (दस्तावेज़ में हो तो वैसा, न हो तो सार्वभौमिक मानक की एक पंक्ति)।
- **मत करें (निषिद्ध पैटर्न)**: रेपो दस्तावेज़ द्वारा निर्दिष्ट एंटी-पैटर्न (जैसे हार्डकोडेड रंग नहीं, सजावट हेतु विशेष रंग नहीं)। केवल जिसका रेपो में आधार हो।

लेखन सिद्धांत:
- **रेपो-साक्ष्य आधारित** — हर नियम वास्तव में पढ़े गए टोकन/दस्तावेज़ से आए। स्रोत फ़ाइल को मुख्य पाठ में हल्के उद्धृत कर सकते हैं (जैसे "DesignTokens.swift के रंग-नीति टिप्पणी अनुसार")।
- **संक्षिप्त** — यह पाठ आगे हर PO प्रॉम्प्ट में जड़ा जाएगा, इसलिए फूला न हो। केवल सार, लगभग 2500 अक्षरों के भीतर। बुलेट-केंद्रित।
- **रेपो-अज्ञेय** — अन्य रेपो की पैलेट/नियम न लाएँ। केवल जो «यह रेपो» तय करता है।
- यदि खोजा गया SSOT लगभग न हो तो उसे एक पंक्ति में लिखें («टोकन/दस्तावेज़ नहीं मिले — केवल सार्वभौमिक UX मानक»), और रंग अर्थ न गढ़ें — केवल सार्वभौमिक एक्सेसिबिलिटी/इंटरैक्शन-स्थिति मानक डालें।

## चरण 3 — आउटपुट
ऊपर का markdown निम्न पथ पर «ज्यों का त्यों» लिखें (JSON नहीं, अन्यत्र न लिखें):
{{outFile}}

फ़ाइल लिखने के बाद एक पंक्ति «डिज़ाइन directive मसौदा पूर्ण» से समाप्त करें।`,
    ja: `あなたはこのリポジトリのデザインシステムを「読み取る」エージェントだ。任務は、リポジトリが「すでに定めた」デザイン約束を発見し、\`design_directive\` の markdown「ドラフト」として整理することだ。コードを修正するな — 読む/調べるだけ。新しいシステムを「設計」するな(存在しない規則の発明禁止) — リポジトリに実際にある約束だけを書き写せ。

このドラフトはすぐには適用されない — 人が設定画面でレビュー·承認して初めて PO プロンプトの「デザイン制約」に「宣言された強信号」として使われる。だから人が30秒で「正しい/直そう」と判断できるよう、根拠を添えて簡潔に書け。

## ステップ1 — デザイン SSOT の発見(あるものだけ、スタック中立に)
特定の色·特定のロケール数を事前に仮定するな(リポジトリごとにパレット·約束·言語が異なる)。下の候補場所を探索せよ:
- **デザイントークン/テーマ**: \`*Tokens*\`、\`theme.*\`、\`tokens.json\`、\`tailwind.config.*\`、CSS カスタムプロパティ(\`--*\`)、\`*.css\`/\`*.scss\` 変数 — 色·余白·タイポグラフィの「意味の約束」と命名規則。(例: \`DesignTokens.swift\`·\`tokens.json\`·\`tailwind.config.js\`)
- **デザイン文書**: \`CLAUDE.md\`/\`AGENTS.md\` のデザイン·色セクション、\`DESIGN*.md\`、\`docs/design*\`、\`README\` のデザイン規則、Storybook(\`*.stories.*\`) — どの色相/トークンがどんな「意味」か、そして「やるな」のルール。
- **ロケールカタログ**: \`*.xcstrings\`、\`*.strings\`、\`messages/*.json\`、\`i18n/\`、\`locales/\`、\`*.po\` — このリポジトリの「対応言語の集合」を推論せよ(数·構成は異なる)。

まず \`grep\`/\`ls\` で候補を流し見し、最も権威ありそうな「単一出所」(SSOT)から精読せよ。デザイン文書の「ポリシーコメント」がトークンファイルより意図をよく説明するならそちらを優先する。

## ステップ2 — directive ドラフトの作成
下の節のうち「見つけたものだけ」を埋めた markdown を書け(存在しない節は外せ — 空の約束を捏造するな):
- **色の意味**: 各色/トークンが「どんな意味」か(例: アクセント·成功·警告·危険·情報·プレミアム — 名前はリポジトリが使うそのまま)。一色が二つの意味を兼ねないよう「混同禁止」ペアを明示せよ(リポジトリ文書がそう書いていれば)。
- **余白·サイズ·タイポグラフィ**: リポジトリが定めた余白スケール·角·フォントの約束(トークン/文書にあれば)。
- **対応ロケール**: このリポジトリが対応する言語の「集合」(カタログから推論したコード一覧)。そして表示文字列はこの集合すべてに翻訳されるべきという規則。
- **状態·アクセシビリティ**: 空/エラー/読み込み/無効/フォーカス状態とアクセシビリティ(ラベル·コントラスト)の規則(文書にあればそのまま、なければ普遍基準を一行)。
- **やるな(禁止パターン)**: リポジトリ文書が明示するアンチパターン(例: ハードコード色禁止、特定色を装飾に使うな)。リポジトリに根拠があるものだけ。

執筆原則:
- **リポジトリ根拠ベース** — 各規則は実際に読んだトークン/文書から来ること。出所ファイルを本文で軽く引用してよい(例: "DesignTokens.swift の色ポリシーコメントに基づく")。
- **簡潔** — このテキストは今後すべての PO プロンプトに埋め込まれるので肥大化させるな。要点のみ、おおよそ 2500 文字以内。箇条書き中心。
- **リポジトリ非依存** — 他リポジトリのパレット/規則を持ち込むな。「このリポジトリ」が定めたものだけ。
- 発見した SSOT がほぼなければそれを一行で書き(「トークン/文書が見つからない — 普遍的 UX 基準のみ」)、色の意味を捏造せず、普遍的なアクセシビリティ/相互作用状態の基準だけを入れよ。

## ステップ3 — 産出
上の markdown を次のパスに「そのまま」書け(JSON ではない、他の場所に書くな):
{{outFile}}

ファイルを書いたら「デザイン directive ドラフト作成完了」の一行で終えよ。`,
    ko: `너는 이 저장소의 디자인 시스템을 «읽어내는» 에이전트다. 임무는 이 레포가 «이미 정해 둔» 디자인 약속을 발견해 \`design_directive\` 마크다운 «초안» 으로 정리하는 것이다. 코드를 수정하지 마라 — 읽기/조사만 한다. 디자인 시스템을 새로 «설계» 하지 마라(없는 규칙을 발명 금지) — 레포에 실제로 있는 약속만 옮겨 적는다.

이 초안은 곧장 적용되지 않는다 — 사람이 설정 화면에서 검토·승인해야 비로소 PO 프롬프트의 「디자인 제약」 에 «선언된 강신호» 로 쓰인다. 그러니 사람이 30초 안에 «맞다/고치자» 판단할 수 있게, 근거 있고 간결하게 써라.

## 1단계 — 디자인 SSOT 발견 (있는 것만, 스택-중립적으로)
특정 색·특정 로케일 수를 미리 가정하지 마라(레포마다 팔레트·약속·지원 언어가 다르다). 아래 후보 위치를 탐색하라:
- **디자인 토큰/테마**: \`*Tokens*\`, \`theme.*\`, \`tokens.json\`, \`tailwind.config.*\`, CSS custom properties(\`--*\`), \`*.css\`/\`*.scss\` 변수 — 색·간격·타이포의 «의미 약속» 과 명명 규칙. (예: \`DesignTokens.swift\`·\`tokens.json\`·\`tailwind.config.js\`)
- **디자인 문서**: \`CLAUDE.md\`/\`AGENTS.md\` 의 디자인·색 섹션, \`DESIGN*.md\`, \`docs/design*\`, \`README\` 의 디자인 규칙, Storybook(\`*.stories.*\`) — 어떤 hue/토큰이 어떤 «의미» 인지와 «하지 마라» 규칙.
- **로케일 카탈로그**: \`*.xcstrings\`, \`*.strings\`, \`messages/*.json\`, \`i18n/\`, \`locales/\`, \`*.po\` — 이 레포가 «지원하는 언어 집합» 을 추론한다(개수·구성은 레포마다 다르다).

먼저 \`grep\`/\`ls\` 로 후보를 훑고, 가장 권위 있어 보이는 «단일 출처»(SSOT)부터 정독하라. 디자인 문서의 «정책 주석» 이 토큰 파일보다 의도를 더 잘 설명하면 그쪽을 우선한다.

## 2단계 — directive 초안 작성
다음 절들을 «발견한 것만» 채운 markdown 을 써라 (없는 절은 빼라 — 빈 약속을 지어내지 마라):
- **색의 의미**: 각 색/토큰이 «무슨 의미» 인지 (예: 강조·성공·경고·위험·정보·프리미엄 등 — 이름은 레포가 쓰는 그대로). 한 색이 두 의미를 겸하지 않게 «혼동 금지» 쌍을 명시하라(레포 문서가 그렇게 적었다면).
- **간격·크기·타이포**: 레포가 정한 간격 스케일·모서리·폰트 약속 (토큰/문서에 있으면).
- **지원 로케일**: 이 레포가 지원하는 언어 «집합» (카탈로그에서 추론한 코드 목록). 노출 문자열은 이 집합 전부에 번역돼야 한다는 규칙.
- **상태·접근성**: 빈/오류/로딩/비활성/포커스 상태와 접근성(라벨·대비) 규칙 (문서에 있으면 그대로, 없으면 보편 기준 한 줄).
- **하지 마라(금지 패턴)**: 레포 문서가 명시한 안티패턴 (예: 하드코딩 색 금지, 특정 색을 장식에 쓰지 말 것 등). 레포에 근거가 있는 것만.

작성 원칙:
- **레포 근거 기반** — 각 규칙은 실제로 읽은 토큰/문서에서 나와야 한다. 출처 파일을 본문에 가볍게 인용해도 좋다(예: "DesignTokens.swift 의 색상 정책 주석 기준").
- **간결** — 이 텍스트는 앞으로 모든 PO 프롬프트에 박히므로 비대하면 안 된다. 핵심만, 대략 2500자 이내. 불릿 중심.
- **레포-무관** — 다른 레포의 팔레트/규칙을 끌어오지 마라. «이 레포» 가 정한 것만.
- 발견된 SSOT 가 거의 없으면 그 사실을 한 줄로 적고(«토큰/문서를 못 찾음 — 보편 UX 기준만»), 색 의미를 지어내지 말고 보편 접근성/상호작용 상태 기준만 담아라.

## 3단계 — 산출
위 markdown 을 다음 경로에 «그대로» 써라 (JSON 아님, 다른 곳에 쓰지 마라):
{{outFile}}

파일을 쓴 뒤 «디자인 directive 초안 작성 완료» 한 줄로 끝내라.`,
    "pt-BR": `Você é um agente que «lê» o sistema de design deste repositório. Sua missão é descobrir o compromisso de design que o repo «já definiu» e organizá-lo como um «rascunho» markdown para \`design_directive\`. Não modifique código — apenas leia/investigue. Não «projete» um sistema novo (não invente regras inexistentes) — apenas transcreva os compromissos que realmente existem no repo.

Este rascunho não é aplicado de imediato — um humano deve revisá-lo e aprová-lo na tela de configurações para que então seja usado como «sinal forte declarado» nas «Restrições de design» do prompt de PO. Então escreva-o de forma concisa e com evidência, para o humano poder julgar «certo / vamos corrigir» em 30 segundos.

## Passo 1 — Descubra o SSOT de design (apenas o que existe, neutro à stack)
Não assuma uma cor específica·um número específico de localidades de antemão (cada repo tem sua paleta·compromissos·idiomas). Explore os locais candidatos abaixo:
- **Tokens/tema de design**: \`*Tokens*\`, \`theme.*\`, \`tokens.json\`, \`tailwind.config.*\`, propriedades personalizadas CSS (\`--*\`), variáveis \`*.css\`/\`*.scss\` — os «compromissos de significado» de cor·espaçamento·tipografia e convenções de nomenclatura. (ex.: \`DesignTokens.swift\`·\`tokens.json\`·\`tailwind.config.js\`)
- **Documentos de design**: as seções de design/cor de \`CLAUDE.md\`/\`AGENTS.md\`, \`DESIGN*.md\`, \`docs/design*\`, as regras de design do \`README\`, Storybook (\`*.stories.*\`) — qual hue/token significa «o quê» e as regras de «não faça».
- **Catálogos de localidade**: \`*.xcstrings\`, \`*.strings\`, \`messages/*.json\`, \`i18n/\`, \`locales/\`, \`*.po\` — infira o «conjunto de idiomas suportados» deste repo (número·composição variam).

Primeiro folheie os candidatos com \`grep\`/\`ls\`, depois leia atentamente a «fonte única» (SSOT) de aparência mais autoritativa primeiro. Se o «comentário de política» de um documento de design explica a intenção melhor que o arquivo de tokens, prefira-o.

## Passo 2 — Escreva o rascunho do directive
Escreva markdown preenchendo apenas «o que você encontrou» das seções abaixo (remova uma seção que não exista — não fabrique um compromisso vazio):
- **Significado da cor**: que «significado» cada cor/token tem (ex.: acento·sucesso·aviso·perigo·info·premium — nomes como o repo os usa). Especifique pares de «não confundir» para que uma cor não sirva de dois significados (se o doc do repo disser).
- **Espaçamento·tamanhos·tipografia**: os compromissos do repo para escala de espaçamento·cantos·fontes (se em tokens/docs).
- **Localidades suportadas**: o «conjunto» de idiomas que este repo suporta (a lista de códigos inferida do catálogo). E a regra de que strings visíveis devem ser traduzidas para todo o conjunto.
- **Estados·acessibilidade**: regras para estados vazio/erro/carregando/desabilitado/foco e acessibilidade (rótulos·contraste) (como no doc se presente, senão uma linha de padrão universal).
- **Não faça (padrões proibidos)**: anti-padrões que o doc do repo especifica (ex.: sem cores hardcoded, não usar uma cor específica para decoração). Apenas o que tem base no repo.

Princípios de escrita:
- **Baseado em evidência do repo** — cada regra deve vir de um token/doc que você realmente leu. Você pode citar levemente o arquivo fonte no corpo (ex.: "conforme o comentário de política de cor em DesignTokens.swift").
- **Conciso** — este texto será embutido em cada futuro prompt de PO, então não deve inchar. Apenas o essencial, aproximadamente em 2500 caracteres. Centrado em bullets.
- **Agnóstico ao repo** — não traga a paleta/regras de outro repo. Apenas o que «este repo» definiu.
- Se o SSOT descoberto for quase inexistente, escreva isso em uma linha («não foi possível encontrar tokens/docs — apenas padrões de UX universais»), e não fabrique significados de cor — inclua apenas padrões universais de acessibilidade/estados de interação.

## Passo 3 — Saída
Escreva o markdown acima «como está» no seguinte caminho (não JSON, não escreva em outro lugar):
{{outFile}}

Após escrever o arquivo, termine com uma linha: «Rascunho de directive de design concluído».`,
    ru: `Ты — агент, который «считывает» дизайн-систему этого репозитория. Твоя задача — обнаружить дизайн-обязательство, которое репозиторий «уже задал», и оформить его как markdown-«черновик» для \`design_directive\`. Не изменяй код — только читай/исследуй. Не «проектируй» новую систему (не изобретай несуществующие правила) — только переписывай обязательства, реально существующие в репозитории.

Этот черновик не применяется сразу — человек должен просмотреть и одобрить его на экране настроек, чтобы он затем использовался как «объявленный сильный сигнал» в «Ограничениях дизайна» промпта PO. Поэтому пиши кратко и с доказательствами, чтобы человек мог за 30 секунд решить «верно / поправим».

## Шаг 1 — Обнаружь дизайн-SSOT (только существующее, нейтрально к стеку)
Не предполагай конкретный цвет·конкретное число локалей заранее (у каждого репозитория своя палитра·обязательства·языки). Исследуй кандидатные места ниже:
- **Дизайн-токены/тема**: \`*Tokens*\`, \`theme.*\`, \`tokens.json\`, \`tailwind.config.*\`, кастомные свойства CSS (\`--*\`), переменные \`*.css\`/\`*.scss\` — «обязательства смысла» для цвета·отступов·типографики и правила именования. (напр., \`DesignTokens.swift\`·\`tokens.json\`·\`tailwind.config.js\`)
- **Дизайн-документы**: разделы дизайна/цвета в \`CLAUDE.md\`/\`AGENTS.md\`, \`DESIGN*.md\`, \`docs/design*\`, правила дизайна в \`README\`, Storybook (\`*.stories.*\`) — какой оттенок/токен что «значит» и правила «не делай».
- **Каталоги локалей**: \`*.xcstrings\`, \`*.strings\`, \`messages/*.json\`, \`i18n/\`, \`locales/\`, \`*.po\` — выведи «набор поддерживаемых языков» этого репозитория (число·состав различаются).

Сначала пробегись по кандидатам \`grep\`/\`ls\`, затем внимательно прочитай наиболее авторитетный «единственный источник» (SSOT). Если «комментарий политики» в дизайн-документе объясняет замысел лучше, чем файл токенов, предпочти его.

## Шаг 2 — Напиши черновик directive
Напиши markdown, заполнив только «то, что нашёл», из разделов ниже (убери раздел, которого нет — не фабрикуй пустое обязательство):
- **Смысл цвета**: какой «смысл» у каждого цвета/токена (напр., акцент·успех·предупреждение·опасность·инфо·премиум — имена как их использует репозиторий). Укажи пары «не путать», чтобы один цвет не нёс два смысла (если так сказано в документе репозитория).
- **Отступы·размеры·типографика**: обязательства репозитория по шкале отступов·углам·шрифтам (если в токенах/документах).
- **Поддерживаемые локали**: «набор» языков, поддерживаемых этим репозиторием (список кодов, выведенный из каталога). И правило, что видимые строки должны переводиться на весь набор.
- **Состояния·доступность**: правила для состояний пусто/ошибка/загрузка/отключено/фокус и доступности (подписи·контраст) (как в документе, если есть, иначе одна строка универсального стандарта).
- **Не делай (запрещённые паттерны)**: антипаттерны, указанные в документе репозитория (напр., без хардкод-цветов, не использовать конкретный цвет для украшения). Только то, что имеет основание в репозитории.

Принципы написания:
- **На основе доказательств репозитория** — каждое правило должно исходить из токена/документа, который ты реально прочитал. Можешь слегка процитировать исходный файл в тексте (напр., "согласно комментарию политики цвета в DesignTokens.swift").
- **Кратко** — этот текст будет встраиваться в каждый будущий промпт PO, поэтому не должен раздуваться. Только суть, примерно в пределах 2500 символов. С опорой на маркеры.
- **Независимо от репозитория** — не притягивай палитру/правила другого репозитория. Только то, что задал «этот репозиторий».
- Если обнаруженный SSOT почти отсутствует, напиши это одной строкой («не удалось найти токены/документы — только универсальные стандарты UX»), и не фабрикуй смыслы цвета — включи только универсальные стандарты доступности/состояний взаимодействия.

## Шаг 3 — Вывод
Запиши markdown выше «как есть» по следующему пути (не JSON, не пиши в другое место):
{{outFile}}

После записи файла закончи одной строкой: «Черновик дизайн-directive готов».`,
    "zh-Hans": `你是「读取」本仓库设计系统的智能体。你的任务是发现仓库「已经设定」的设计约定,并将其整理为 \`design_directive\` 的 markdown「草案」。不要修改代码——只读取/调研。不要「设计」新系统(禁止发明不存在的规则)——只誊写仓库中确实存在的约定。

此草案不会立即生效——必须由人在设置界面审阅并批准,之后才作为 PO 提示「设计约束」中「已声明的强信号」使用。因此请简洁并附依据地书写,使人能在 30 秒内判断「正确 / 修正」。

## 第 1 步 — 发现设计 SSOT(仅限存在的,技术栈中立)
不要预设特定颜色·特定语言环境数量(每个仓库的调色板·约定·语言各异)。探查下列候选位置:
- **设计令牌/主题**: \`*Tokens*\`、\`theme.*\`、\`tokens.json\`、\`tailwind.config.*\`、CSS 自定义属性(\`--*\`)、\`*.css\`/\`*.scss\` 变量——颜色·间距·排版的「含义约定」与命名规则。(如 \`DesignTokens.swift\`·\`tokens.json\`·\`tailwind.config.js\`)
- **设计文档**: \`CLAUDE.md\`/\`AGENTS.md\` 的设计/颜色章节、\`DESIGN*.md\`、\`docs/design*\`、\`README\` 的设计规则、Storybook(\`*.stories.*\`)——哪种色相/令牌代表「何种含义」以及「不要这样做」的规则。
- **语言环境目录**: \`*.xcstrings\`、\`*.strings\`、\`messages/*.json\`、\`i18n/\`、\`locales/\`、\`*.po\`——推断本仓库「支持的语言集合」(数量·构成各异)。

先用 \`grep\`/\`ls\` 浏览候选,再优先精读看起来最权威的「单一来源」(SSOT)。若设计文档的「策略注释」比令牌文件更能说明意图,则以其为优先。

## 第 2 步 — 撰写 directive 草案
仅填入下列各节中「你找到的」内容来书写 markdown(不存在的节删除——不要捏造空约定):
- **颜色含义**: 每种颜色/令牌的「含义」(如 强调·成功·警告·危险·信息·高级 等——名称按仓库使用的原样)。注明「禁止混淆」配对,使一种颜色不兼任两种含义(若仓库文档如此说明)。
- **间距·尺寸·排版**: 仓库设定的间距刻度·圆角·字体约定(若在令牌/文档中)。
- **支持的语言环境**: 本仓库支持的语言「集合」(从目录推断的代码列表)。以及可见字符串须翻译到整个集合的规则。
- **状态·无障碍**: 空/错误/加载/禁用/聚焦状态与无障碍(标签·对比度)规则(文档中有则照其,否则给出一行通用标准)。
- **不要做(禁止模式)**: 仓库文档明示的反模式(如 禁止硬编码颜色、不要将特定颜色用于装饰)。仅限在仓库中有依据者。

撰写原则:
- **基于仓库依据**——每条规则须来自你实际读过的令牌/文档。可在正文中轻引来源文件(如 "依据 DesignTokens.swift 的颜色策略注释")。
- **简洁**——此文本今后会嵌入每个 PO 提示,故不可臃肿。仅留要点,大约 2500 字以内。以要点为主。
- **与仓库无关**——不要引入其他仓库的调色板/规则。仅限「本仓库」所设定者。
- 若发现的 SSOT 几乎没有,则用一行写明(「未找到令牌/文档——仅通用 UX 标准」),且不要捏造颜色含义——只纳入通用的无障碍/交互状态标准。

## 第 3 步 — 产出
将上述 markdown「原样」写入以下路径(不是 JSON,不要写到别处):
{{outFile}}

写完文件后以一行「设计 directive 草案完成」结束。`,
  },

  // ── 수집 «디자인» 렌즈 본문 (buildPoCollectPrompt 의 design 분기) ────────────
  "collect.design.body": {
    ar: `{{persona}} اجعل التصميم — الذي كان يتبع كـ«قيد» لمهام أخرى — «موضوعاً من الدرجة الأولى» هذه المرة، وامسح سطح واجهة هذا المستودع مقابل SSOT التصميم لاكتشاف «دين التصميم» كبريفات فرص. لا تعدّل الكود — اقرأ/ابحث فقط.

هذا «اكتشاف قبل التنفيذ (discovery)» وليس «مراجعة بعد التنفيذ» — من الشاشات المبنية فعلاً، جد اتساق التصميم·إمكانية الوصول·التباين·انجراف الرموز·عدم اتساق الأنماط، وارفعها كبريفات أولوية «جنباً إلى جنب» مع باكلوج الميزات. (لا يتداخل دوره مع «عقدة بوابة مراجعة التصميم» في سير عمل التنفيذ ولا «كتلة معايير قبول التصميم» في بطاقة البريف — تلك أماكن لمراجعة/قبول تغيير مُنجَز، وهنا مكان «إيجاد» ما يجب إصلاحه.)
{{profile}}{{directive}}{{history}}{{verification}}{{storeReviews}}{{crashSignals}}{{designContext}}
## المرحلة 1 — مسح سطح الواجهة (مقابل SSOT التصميم، ما أمكن)
SSOT التصميم لهذا المستودع الذي «أُعلِن/اكتُشِف» في «قيود التصميم» أعلاه هو «المسطرة». التركيز على {{focus}} (نفس منظور عدسة «التصميم» في البحث). امسح سطح الواجهة مقابل ذلك المعيار (التقنية·اللوحة·تسمية الرموز يحدّدها المستودع — لا تفترض إطاراً/لوناً معيّناً):
- **جمع سطح الواجهة**: جد ملفات العرض/المكوّنات (مثل \`*View*\`/SwiftUI \`View\`، مكوّنات React/Vue/Svelte، \`*.css\`/\`*.scss\`/styled-components — الموجود فعلاً في هذا المستودع). امسح الأنماط المشبوهة بـ\`grep -rn\` على نطاق واسع.
- **انجراف الرموز**: قيم حرفية·مثبّتة تتجاوز رموز المعنى (عهد اللون·التباعد·الطباعة الذي حدّده SSOT). مثل: لون حرفي بدل رمز المعنى (\`.orange\`/\`.yellow\`/\`.blue\`)، أبيض/أسود مثبّت (\`.white\`/\`.black\`)، إفراط في tint عام (\`.tint\`)، تباعد بأرقام سحرية — اسم الرمز/النمط المُنتهَك يتبع «تسمية SSOT لهذا المستودع».
- **خلط/تداخل معنى اللون**: استخدام لون واحد بمعنيين (استعارة لون الحالة للزينة)، أو تركيب نهى عنه SSOT.
- **إمكانية الوصول**: غياب تسميات الوصول، ضعف تباين النص/الخلفية، عدم دعم النوع الديناميكي·هدف اللمس، نقل المعلومة باللون وحده.
- **عدم اتساق الأنماط**: تباعد/زوايا مختلفة لمكوّن بنفس الدور بين الشاشات، حالات مفقودة (فارغ/خطأ/تحميل/معطّل/تركيز)، أنماط مُعرّفة مكرّرة.
- **سطح i18n**: نصوص معروضة لا تمرّ بمجموعة اللغات/طريقة الاستخراج التي حدّدها هذا المستودع.
- **إشارات تعزيز (إن وُجدت)**: عزّز impact بربط شكاوى التصميم من النوع «صعب القراءة·الزر صغير·اللون مربك» من المصادر أدناه.
{{githubSignal}}
- التدفق الأخير: بـ\`git log --oneline -30\` لا تعد اقتراح عمل تصميم قيد التنفيذ بالفعل.{{storeTail}}{{crashTail}}

## المرحلة 2 — التركيب: كتابة بريفات دين التصميم (5 كحد أقصى)
اجمع الانتهاكات التي رأيتها في وحدات «مشكلة/فرصة» — ليس انتهاكاً مفرداً، بل حزمة «دين» لنفس الانجراف المنتشر عبر عدّة شاشات. متطلبات كل بريف:
- **السند إلزامي — ملف:سطر + اسم الرمز/النمط المُنتهَك**: اكتب في ref كل evidence «ملف:سطر» وفي summary «اسم الرمز/النمط المُنتهَك وما الذي تجاوزه» (مثل ref \`Views/FooView.swift:42\`، summary \`لون حرفي .orange — تجاوز رمز المعنى (pro)\`). ممنوع اقتراح متخيَّل بلا موضع رأيته فعلاً.
{{dedup}}
- **عقد كتابة العنوان·الملخّص (القارئ = من يعتمد/يرفض خلال ~30 ثانية في الباكلوج)**: يقدّم العنوان «النتيجة من منظور المستخدم/المنتج» في سطر واحد مبسّط — لا تضع اسم ملف·رمز كود (.ts·.swift إلخ)·معرّفاً أو اختصاراً بأحرف كبيرة (مثل ESRCH·PR_SET_PDEATHSIG·رقم CVE) في العنوان وحده، وأبقِ الجمل الموصولة بـ«—» واحدة كحد أقصى، ضمن 80 حرفاً (إلزامي). تبدأ الجملة الأولى من problem بـ«ملخّص في سطر يفهمه غير المختص» (من·متى·ما الذي يزعج، بلا مصطلحات تقنية). أنزِل التفاصيل التقنية — الرموز·CVE·مراجع الكود·مسارات الملفات — إلى الجمل التالية وإلى spec·evidence: العنوان·الملخّص مبسّطان والتفاصيل في spec. حتى لو كان الموضوع تقنياً بطبعه (تحصين daemon إلخ) فهذا العقد ينطبق دائماً، والأسماء العَلَمية التي لا مفر منها (Tor·SSH إلخ) مسموحة لكن اشرحها.
- **impact / effort**: عدد صحيح 1~5. impact هو أثر ذلك الدين على الاتساق·إمكانية الوصول·تجربة المستخدم (انتهاك الوصول·ضعف التباين عالٍ)، وeffort جهد الإصلاح (نصف يوم=1، أسابيع=5).
- **scope / spec**: مستوى قابل للتنفيذ فور الاعتماد — أي ملفات تُغيَّر بأي رمز معنى/نمط، معايير القبول (طريقة التأكد أن الانتهاك 0)، اللا-أهداف (لا تغيير في السلوك وغيره). هذا البريف موضوعه التصميم، فالـ problem/spec يقول معيار التصميم نفسه.

{{backlog}}

## المرحلة 3 — المخرجات
اكتب ملف «مصفوفة» JSON في المسار التالي (لا تكتب في مكان آخر):
{{outFile}}

مخطط كل عنصر (نفس صيغة بريف ميزة الكود — يدخلان جنباً إلى جنب في الباكلوج نفسه):
{
  "title": "دين تصميم في سطر مبسّط من منظور نتيجة المستخدم/المنتج (حتى 80 حرفاً؛ بلا اسم ملف·رمز كود·اختصار منفرد؛ جملة «—» واحدة كحد أقصى)",
  "problem": "الجملة الأولى ملخّص في سطر يفهمه غير المختص (لمن وكيف يُزعج، بلا مصطلحات) — ثم أنزِل التفاصيل (ما الذي في أي شاشات خالف أي رمز/نمط) إلى spec/evidence",
  "evidence": [{ "kind": "{{designKinds}}", "ref": "ملف:سطر", "summary": "اسم الرمز/النمط المُنتهَك + ما الذي تجاوزه" }],
  "impact": 1-5,
  "effort": 1-5,
  "scope": "السطح المُصلَح هذه المرة / اللا-أهداف",
  "spec": "قصة المستخدم + معايير القبول (تأكيد الانتهاك 0) + الحالات الحدّية (markdown)",
{{dedupSchema}}
}

إن لم يوجد دين تصميم تقترحه فعلاً فاكتب مصفوفة فارغة []. بعد كتابة الملف، أنهِ بسطر واحد «اكتمل كتابة N دين تصميم».{{outputDirective}}`,
    en: `{{persona}} Make design — which used to tag along only as a «constraint» on other work — a «first-class subject» this time, and scan this repo's UI surface against the design SSOT to discover «design debt» as opportunity briefs. Do not modify code — only read/investigate.

This is «pre-implementation discovery», not «post-implementation review» — from already-built screens, find design consistency·accessibility·contrast·token drift·pattern inconsistency, and raise them as priority briefs «side by side» with the feature backlog. (Its role does not overlap with the implementation workflow's «design review gate node» or the brief card's «design acceptance criteria block» — those are places to review/accept a made change; here is the place to «find» what to fix.)
{{profile}}{{directive}}{{history}}{{verification}}{{storeReviews}}{{crashSignals}}{{designContext}}
## Step 1 — UI surface scan (against the design SSOT, only what is possible)
The repo's design SSOT «declared/discovered» in «Design constraints» above is the «measuring stick». The focus is {{focus}} (the same perspective as research's «design» lens). Scan the UI surface against that standard (stack·palette·token naming are set by the repo — do not assume a specific framework/color):
- **Gather the UI surface**: find view/component files (e.g., \`*View*\`/SwiftUI \`View\`, React/Vue/Svelte components, \`*.css\`/\`*.scss\`/styled-components — whatever actually exists in this repo). Sweep suspicious patterns broadly with \`grep -rn\`.
- **Token drift**: literals·hardcoded values bypassing meaning tokens (the color·spacing·typography commitment the SSOT set). E.g., a literal color instead of a meaning token (\`.orange\`/\`.yellow\`/\`.blue\`), hardcoded black/white (\`.white\`/\`.black\`), overuse of a global tint (\`.tint\`), magic-number spacing — the violated token/pattern name follows «this repo's SSOT naming».
- **Color-meaning confusion·overloading**: using one color for two meanings (borrowing a status color for decoration), or a combination the SSOT said «do not».
- **Accessibility**: missing accessibility labels, insufficient text/background contrast, no dynamic-type·touch-target support, conveying info by color alone.
- **Pattern inconsistency**: same-role components with different spacing/corners per screen, missing states (empty/error/loading/disabled/focus), redundantly defined styles.
- **i18n surface**: user-facing strings that do not go through the locale set/extraction method this repo set.
- **Reinforcing signals (if any)**: reinforce impact by cross-attaching design complaints of the «hard to read·button is small·color is confusing» kind from the sources below.
{{githubSignal}}
- Recent flow: with \`git log --oneline -30\`, do not re-propose design work already in progress.{{storeTail}}{{crashTail}}

## Step 2 — Synthesis: write design-debt briefs (up to 5)
Group the violations you saw into «problem/opportunity» units — not a single isolated violation, but a «debt» bundle of the same drift spread across multiple screens. Requirements per brief:
- **Evidence required — file:line + violated token/pattern name**: in every evidence's ref write «file:line», and in summary write «the violated token/pattern name and what it bypassed» (e.g., ref \`Views/FooView.swift:42\`, summary \`literal .orange — bypassed the meaning token (pro)\`). No imagined proposals without a location you actually saw.
{{dedup}}
- **Title·summary writing contract (the reader = whoever approves/rejects within ~30 s on the backlog)**: the title leads with the «user/product-facing outcome» in one plain line — do not drop a filename·code symbol (.ts·.swift, etc.)·an all-caps identifier or abbreviation (e.g., ESRCH·PR_SET_PDEATHSIG·a CVE number) into the title on its own, keep «—»-joined clauses to at most one, within 80 chars (strict). The problem's first sentence starts with a «one-line summary a non-expert can understand» (who·when·what is inconvenient, no jargon). Push technical details — symbols·CVEs·code references·file paths — to later sentences and to spec·evidence: plain title·summary, details in spec. Even when the subject is inherently technical (daemon hardening, etc.) this contract always applies; unavoidable proper nouns (Tor·SSH, etc.) are allowed but spell them out.
- **impact / effort**: integers 1~5. impact is that debt's hit to consistency·accessibility·user experience (accessibility violations·insufficient contrast are high), effort is the cost to fix (half a day=1, weeks=5).
- **scope / spec**: a level implementable right after approval — which files to change to which meaning token/pattern, acceptance criteria (how to confirm violations are 0), non-goals (no behavior change, etc.). Since this brief's subject is design itself, problem/spec is the design standard.

{{backlog}}

## Step 3 — Output
Write a JSON «array» file to the following path (do not write elsewhere):
{{outFile}}

Schema per element (the «same» format as a code-feature brief — they go side by side in the same backlog):
{
  "title": "design debt in one plain line from the user/product outcome (within 80 chars; no standalone filename·code symbol·abbreviation; at most one «—» clause)",
  "problem": "first sentence is a one-line summary a non-expert can understand (how it inconveniences whom, no jargon) — then push details (what on which screens violated which token/pattern) to spec/evidence",
  "evidence": [{ "kind": "{{designKinds}}", "ref": "file:line", "summary": "violated token/pattern name + what it bypassed" }],
  "impact": 1-5,
  "effort": 1-5,
  "scope": "the surface fixed this time / non-goals",
  "spec": "user story + acceptance criteria (confirm 0 violations) + edge cases (markdown)",
{{dedupSchema}}
}

If there is truly no design debt to propose, write an empty array []. After writing the file, end with one line: «N design-debt items written».{{outputDirective}}`,
    es: `{{persona}} Haz del diseño — que solía acompañar solo como «restricción» de otro trabajo — un «sujeto de primera clase» esta vez, y escanea la superficie de UI de este repo frente al SSOT de diseño para descubrir «deuda de diseño» como briefs de oportunidad. No modifiques código — solo lee/investiga.

Esto es «descubrimiento previo a la implementación», no «revisión posterior» — desde pantallas ya construidas, encuentra consistencia de diseño·accesibilidad·contraste·deriva de tokens·inconsistencia de patrones, y elévalas como briefs de prioridad «lado a lado» con el backlog de funciones. (Su rol no se solapa con el «nodo puerta de revisión de diseño» del workflow de implementación ni con el «bloque de criterios de aceptación de diseño» de la tarjeta del brief — esos son lugares para revisar/aceptar un cambio hecho; aquí es el lugar para «encontrar» qué arreglar.)
{{profile}}{{directive}}{{history}}{{verification}}{{storeReviews}}{{crashSignals}}{{designContext}}
## Paso 1 — Escaneo de la superficie de UI (frente al SSOT de diseño, solo lo posible)
El SSOT de diseño del repo «declarado/descubierto» en «Restricciones de diseño» de arriba es la «vara de medir». El foco es {{focus}} (la misma perspectiva que la lente «design» de la investigación). Escanea la superficie de UI frente a ese estándar (stack·paleta·nombres de tokens los fija el repo — no asumas un framework/color específico):
- **Reúne la superficie de UI**: encuentra archivos de vista/componente (p. ej., \`*View*\`/SwiftUI \`View\`, componentes React/Vue/Svelte, \`*.css\`/\`*.scss\`/styled-components — lo que realmente exista en este repo). Barre patrones sospechosos ampliamente con \`grep -rn\`.
- **Deriva de tokens**: literales·valores hardcodeados que evitan tokens de significado (el compromiso de color·espaciado·tipografía que fijó el SSOT). P. ej., un color literal en vez de un token de significado (\`.orange\`/\`.yellow\`/\`.blue\`), blanco/negro hardcodeado (\`.white\`/\`.black\`), abuso de un tint global (\`.tint\`), espaciado con números mágicos — el nombre del token/patrón violado sigue «los nombres del SSOT de este repo».
- **Confusión·sobrecarga del significado del color**: usar un color para dos significados (tomar prestado un color de estado para decoración), o una combinación que el SSOT dijo «no hacer».
- **Accesibilidad**: etiquetas de accesibilidad faltantes, contraste texto/fondo insuficiente, sin soporte de tipo dinámico·objetivo táctil, transmitir info solo por color.
- **Inconsistencia de patrones**: componentes del mismo rol con diferente espaciado/esquinas por pantalla, estados faltantes (vacío/error/carga/deshabilitado/foco), estilos definidos redundantemente.
- **Superficie i18n**: cadenas visibles que no pasan por el conjunto de locales/método de extracción que fijó este repo.
- **Señales de refuerzo (si las hay)**: refuerza impact adjuntando de forma cruzada quejas de diseño del tipo «difícil de leer·el botón es pequeño·el color confunde» de las fuentes de abajo.
{{githubSignal}}
- Flujo reciente: con \`git log --oneline -30\`, no vuelvas a proponer trabajo de diseño ya en curso.{{storeTail}}{{crashTail}}

## Paso 2 — Síntesis: escribe briefs de deuda de diseño (hasta 5)
Agrupa las violaciones que viste en unidades de «problema/oportunidad» — no una violación aislada, sino un paquete de «deuda» de la misma deriva esparcida por varias pantallas. Requisitos por brief:
- **Evidencia obligatoria — archivo:línea + nombre del token/patrón violado**: en el ref de cada evidence escribe «archivo:línea», y en summary escribe «el nombre del token/patrón violado y qué evitó» (p. ej., ref \`Views/FooView.swift:42\`, summary \`literal .orange — evitó el token de significado (pro)\`). Sin propuestas imaginadas sin una ubicación que realmente viste.
{{dedup}}
- **Contrato de redacción de título·resumen (el lector = quien aprueba/rechaza en ~30 s en el backlog)**: el título encabeza con el «resultado de cara al usuario/producto» en una línea sencilla — no metas un nombre de archivo·símbolo de código (.ts·.swift, etc.)·un identificador o abreviatura en mayúsculas (p. ej., ESRCH·PR_SET_PDEATHSIG·un número CVE) solo en el título, mantén las cláusulas unidas por «—» en una como máximo, dentro de 80 caracteres (estricto). La primera frase de problem empieza con un «resumen de una línea que un no experto entienda» (quién·cuándo·qué incomoda, sin jerga). Baja los detalles técnicos — símbolos·CVE·referencias de código·rutas de archivo — a las frases posteriores y a spec·evidence: título·resumen sencillos, detalles en spec. Aunque el tema sea intrínsecamente técnico (endurecimiento de daemon, etc.) este contrato siempre aplica; los nombres propios inevitables (Tor·SSH, etc.) se permiten pero explícalos.
- **impact / effort**: enteros 1~5. impact es el golpe de esa deuda a la consistencia·accesibilidad·experiencia de usuario (las violaciones de accesibilidad·contraste insuficiente son altas), effort es el costo de arreglar (medio día=1, semanas=5).
- **scope / spec**: un nivel implementable justo tras la aprobación — qué archivos cambiar a qué token/patrón de significado, criterios de aceptación (cómo confirmar 0 violaciones), no-objetivos (sin cambio de comportamiento, etc.). Como el sujeto de este brief es el diseño mismo, problem/spec es el estándar de diseño.

{{backlog}}

## Paso 3 — Salida
Escribe un archivo «array» JSON en la siguiente ruta (no escribas en otro lugar):
{{outFile}}

Esquema por elemento (el «mismo» formato que un brief de función de código — van lado a lado en el mismo backlog):
{
  "title": "deuda de diseño en una línea sencilla desde el resultado de usuario/producto (dentro de 80 caracteres; sin nombre de archivo·símbolo de código·abreviatura solos; máx. una cláusula «—»)",
  "problem": "la primera frase es un resumen de una línea que un no experto entienda (cómo incomoda a quién, sin jerga) — luego baja los detalles (qué en qué pantallas violó qué token/patrón) a spec/evidence",
  "evidence": [{ "kind": "{{designKinds}}", "ref": "archivo:línea", "summary": "nombre del token/patrón violado + qué evitó" }],
  "impact": 1-5,
  "effort": 1-5,
  "scope": "la superficie arreglada esta vez / no-objetivos",
  "spec": "historia de usuario + criterios de aceptación (confirmar 0 violaciones) + casos límite (markdown)",
{{dedupSchema}}
}

Si de verdad no hay deuda de diseño que proponer, escribe un array vacío []. Tras escribir el archivo, termina con una línea: «N elementos de deuda de diseño escritos».{{outputDirective}}`,
    fr: `{{persona}} Fais du design — qui ne suivait qu'en tant que «contrainte» d'un autre travail — un «sujet de première classe» cette fois, et scanne la surface UI de ce dépôt face au SSOT de design pour découvrir la «dette de design» en tant que briefs d'opportunité. Ne modifie pas le code — lis/investigue seulement.

C'est de la «découverte avant implémentation», pas une «revue après implémentation» — à partir d'écrans déjà construits, trouve la cohérence de design·l'accessibilité·le contraste·la dérive des tokens·l'incohérence des motifs, et élève-les en briefs de priorité «côte à côte» avec le backlog de fonctionnalités. (Son rôle ne recoupe pas le «nœud de porte de revue de design» du workflow d'implémentation ni le «bloc de critères d'acceptation de design» de la carte du brief — ce sont des endroits pour revoir/accepter un changement fait; ici c'est l'endroit pour «trouver» quoi corriger.)
{{profile}}{{directive}}{{history}}{{verification}}{{storeReviews}}{{crashSignals}}{{designContext}}
## Étape 1 — Scan de la surface UI (face au SSOT de design, seulement ce qui est possible)
Le SSOT de design du dépôt «déclaré/découvert» dans «Contraintes de design» ci-dessus est le «mètre étalon». Le focus est {{focus}} (la même perspective que la lentille «design» de la recherche). Scanne la surface UI face à ce standard (stack·palette·nommage des tokens sont fixés par le dépôt — n'assume pas un framework/couleur précis):
- **Rassemble la surface UI**: trouve les fichiers de vue/composant (p. ex. \`*View*\`/SwiftUI \`View\`, composants React/Vue/Svelte, \`*.css\`/\`*.scss\`/styled-components — ce qui existe réellement dans ce dépôt). Balaie largement les motifs suspects avec \`grep -rn\`.
- **Dérive des tokens**: littéraux·valeurs codées en dur contournant les tokens de sens (l'engagement de couleur·espacement·typographie que le SSOT a fixé). P. ex., une couleur littérale au lieu d'un token de sens (\`.orange\`/\`.yellow\`/\`.blue\`), noir/blanc codé en dur (\`.white\`/\`.black\`), abus d'un tint global (\`.tint\`), espacement à nombres magiques — le nom du token/motif violé suit «le nommage du SSOT de ce dépôt».
- **Confusion·cumul du sens de la couleur**: utiliser une couleur pour deux sens (emprunter une couleur d'état pour la décoration), ou une combinaison que le SSOT a interdite.
- **Accessibilité**: libellés d'accessibilité manquants, contraste texte/fond insuffisant, pas de support type dynamique·cible tactile, transmettre l'info par la couleur seule.
- **Incohérence des motifs**: composants de même rôle avec espacement/coins différents par écran, états manquants (vide/erreur/chargement/désactivé/focus), styles définis de façon redondante.
- **Surface i18n**: chaînes visibles qui ne passent pas par l'ensemble de locales/la méthode d'extraction que ce dépôt a fixés.
- **Signaux de renfort (s'il y en a)**: renforce impact en attachant de façon croisée des plaintes de design du type «difficile à lire·le bouton est petit·la couleur prête à confusion» depuis les sources ci-dessous.
{{githubSignal}}
- Flux récent: avec \`git log --oneline -30\`, ne re-propose pas un travail de design déjà en cours.{{storeTail}}{{crashTail}}

## Étape 2 — Synthèse: écris des briefs de dette de design (jusqu'à 5)
Regroupe les violations que tu as vues en unités «problème/opportunité» — pas une violation isolée, mais un paquet de «dette» de la même dérive répandue sur plusieurs écrans. Exigences par brief:
- **Preuve obligatoire — fichier:ligne + nom du token/motif violé**: dans le ref de chaque evidence écris «fichier:ligne», et dans summary écris «le nom du token/motif violé et ce qu'il a contourné» (p. ex. ref \`Views/FooView.swift:42\`, summary \`littéral .orange — a contourné le token de sens (pro)\`). Pas de propositions imaginées sans un emplacement que tu as réellement vu.
{{dedup}}
- **Contrat de rédaction titre·résumé (le lecteur = celui qui approuve/rejette en ~30 s sur le backlog)**: le titre met en avant le «résultat côté utilisateur/produit» en une ligne simple — ne mets pas un nom de fichier·symbole de code (.ts·.swift, etc.)·un identifiant ou une abréviation en majuscules (p. ex. ESRCH·PR_SET_PDEATHSIG·un numéro CVE) seul dans le titre, garde au plus une clause reliée par «—», dans les 80 caractères (strict). La première phrase de problem commence par un «résumé d'une ligne compréhensible par un non-expert» (qui·quand·ce qui gêne, sans jargon). Renvoie les détails techniques — symboles·CVE·références de code·chemins de fichiers — aux phrases suivantes et à spec·evidence: titre·résumé simples, détails dans spec. Même si le sujet est intrinsèquement technique (durcissement du daemon, etc.) ce contrat s'applique toujours; les noms propres inévitables (Tor·SSH, etc.) sont permis mais explicite-les.
- **impact / effort**: entiers 1~5. impact est l'impact de cette dette sur la cohérence·l'accessibilité·l'expérience utilisateur (les violations d'accessibilité·le contraste insuffisant sont élevés), effort est le coût de correction (une demi-journée=1, des semaines=5).
- **scope / spec**: un niveau implémentable juste après l'approbation — quels fichiers changer vers quel token/motif de sens, critères d'acceptation (comment confirmer 0 violation), non-objectifs (pas de changement de comportement, etc.). Comme le sujet de ce brief est le design lui-même, problem/spec est le standard de design.

{{backlog}}

## Étape 3 — Sortie
Écris un fichier «tableau» JSON au chemin suivant (n'écris pas ailleurs):
{{outFile}}

Schéma par élément (le «même» format qu'un brief de fonctionnalité de code — ils vont côte à côte dans le même backlog):
{
  "title": "dette de design en une ligne simple selon le résultat utilisateur/produit (dans les 80 caractères; sans nom de fichier·symbole de code·abréviation seuls; au plus une clause «—»)",
  "problem": "la première phrase est un résumé d'une ligne compréhensible par un non-expert (comment cela gêne qui, sans jargon) — puis renvoie les détails (quoi sur quels écrans a violé quel token/motif) vers spec/evidence",
  "evidence": [{ "kind": "{{designKinds}}", "ref": "fichier:ligne", "summary": "nom du token/motif violé + ce qu'il a contourné" }],
  "impact": 1-5,
  "effort": 1-5,
  "scope": "la surface corrigée cette fois / non-objectifs",
  "spec": "user story + critères d'acceptation (confirmer 0 violation) + cas limites (markdown)",
{{dedupSchema}}
}

S'il n'y a vraiment pas de dette de design à proposer, écris un tableau vide []. Après avoir écrit le fichier, termine par une ligne: «N éléments de dette de design écrits».{{outputDirective}}`,
    hi: `{{persona}} डिज़ाइन को — जो अब तक अन्य कार्य की «बाधा» के रूप में ही साथ चलता था — इस बार «प्रथम-श्रेणी विषय» बनाएँ, और इस रेपो के UI सतह को डिज़ाइन SSOT के विरुद्ध स्कैन कर «डिज़ाइन ऋण» को अवसर-ब्रीफ़ के रूप में खोजें। कोड न बदलें — केवल पढ़ें/जाँचें।

यह «कार्यान्वयन-पूर्व खोज (discovery)» है, «कार्यान्वयन-पश्चात समीक्षा» नहीं — पहले से बनी स्क्रीनों से डिज़ाइन संगति·एक्सेसिबिलिटी·कंट्रास्ट·टोकन ड्रिफ़्ट·पैटर्न असंगति खोजें, और उन्हें फ़ीचर बैकलॉग के «साथ-साथ» प्राथमिकता ब्रीफ़ के रूप में उठाएँ। (इसकी भूमिका कार्यान्वयन वर्कफ़्लो के «डिज़ाइन समीक्षा गेट नोड» या ब्रीफ़ कार्ड के «डिज़ाइन स्वीकृति मानदंड ब्लॉक» से नहीं टकराती — वे बने परिवर्तन की समीक्षा/स्वीकृति के स्थान हैं, यहाँ «क्या ठीक करें» खोजने का स्थान है।)
{{profile}}{{directive}}{{history}}{{verification}}{{storeReviews}}{{crashSignals}}{{designContext}}
## चरण 1 — UI सतह स्कैन (डिज़ाइन SSOT के विरुद्ध, जो संभव हो)
ऊपर «डिज़ाइन प्रतिबंध» में «घोषित/खोजा गया» इस रेपो का डिज़ाइन SSOT «मापदंड» है। फोकस {{focus}} है (शोध की «design» लेंस जैसा ही दृष्टिकोण)। उस मानक के विरुद्ध UI सतह स्कैन करें (स्टैक·पैलेट·टोकन नामकरण रेपो तय करता है — विशेष फ्रेमवर्क/रंग न मानें):
- **UI सतह जुटाएँ**: व्यू/कंपोनेंट फ़ाइलें खोजें (जैसे \`*View*\`/SwiftUI \`View\`, React/Vue/Svelte कंपोनेंट, \`*.css\`/\`*.scss\`/styled-components — जो इस रेपो में वास्तव में हो)। \`grep -rn\` से संदिग्ध पैटर्न व्यापक रूप से खंगालें।
- **टोकन ड्रिफ़्ट**: अर्थ-टोकन को बायपास करते लिटरल·हार्डकोडेड मान (SSOT द्वारा तय रंग·स्पेसिंग·टाइपोग्राफी प्रतिबद्धता)। जैसे: अर्थ-टोकन के बजाय लिटरल रंग (\`.orange\`/\`.yellow\`/\`.blue\`), हार्डकोडेड श्वेत/श्याम (\`.white\`/\`.black\`), वैश्विक tint (\`.tint\`) का दुरुपयोग, मैजिक-नंबर स्पेसिंग — उल्लंघित टोकन/पैटर्न नाम «इस रेपो के SSOT नामकरण» का अनुसरण करे।
- **रंग-अर्थ भ्रम·दोहरा उपयोग**: एक रंग को दो अर्थ में प्रयोग (स्थिति रंग को सजावट हेतु उधार), या SSOT द्वारा «मना» किया संयोजन।
- **एक्सेसिबिलिटी**: एक्सेसिबिलिटी लेबल अनुपस्थित, टेक्स्ट/पृष्ठभूमि कंट्रास्ट अपर्याप्त, डायनामिक टाइप·टच टार्गेट असमर्थित, केवल रंग से सूचना देना।
- **पैटर्न असंगति**: समान भूमिका कंपोनेंट का स्क्रीन-दर-स्क्रीन भिन्न स्पेसिंग/कोने, लुप्त स्थितियाँ (खाली/त्रुटि/लोडिंग/निष्क्रिय/फोकस), अनावश्यक रूप से परिभाषित शैलियाँ।
- **i18n सतह**: दिखने वाले स्ट्रिंग्स जो इस रेपो द्वारा तय लोकेल समुच्चय/निष्कर्षण विधि से न गुज़रें।
- **सुदृढ़ संकेत (यदि हों)**: नीचे दिए स्रोतों से «पढ़ना कठिन·बटन छोटा·रंग भ्रमित» प्रकार की डिज़ाइन शिकायतें क्रॉस-संलग्न कर impact सुदृढ़ करें।
{{githubSignal}}
- हाल का प्रवाह: \`git log --oneline -30\` से पहले से प्रगति पर डिज़ाइन कार्य को दोबारा प्रस्तावित न करें।{{storeTail}}{{crashTail}}

## चरण 2 — संश्लेषण: डिज़ाइन-ऋण ब्रीफ़ लिखें (अधिकतम 5)
देखे गए उल्लंघनों को «समस्या/अवसर» इकाइयों में समूहित करें — एकल उल्लंघन नहीं, बल्कि कई स्क्रीनों में फैले समान ड्रिफ़्ट का «ऋण» बंडल। प्रत्येक ब्रीफ़ की अपेक्षाएँ:
- **साक्ष्य अनिवार्य — फ़ाइल:लाइन + उल्लंघित टोकन/पैटर्न नाम**: हर evidence के ref में «फ़ाइल:लाइन», और summary में «उल्लंघित टोकन/पैटर्न नाम व क्या बायपास किया» लिखें (जैसे ref \`Views/FooView.swift:42\`, summary \`लिटरल .orange — अर्थ-टोकन (pro) बायपास\`)। वास्तव में देखे स्थान बिना काल्पनिक प्रस्ताव नहीं।
{{dedup}}
- **शीर्षक·सारांश लेखन अनुबंध (पाठक = जो बैकलॉग पर ~30 सेकंड में स्वीकृत/अस्वीकृत करता है)**: title «उपयोगकर्ता/उत्पाद की दृष्टि से परिणाम» को एक सरल पंक्ति में आगे रखे — फ़ाइल नाम·कोड चिह्न (.ts·.swift आदि)·पूरे बड़े अक्षरों वाला पहचानकर्ता या संक्षेपण (जैसे ESRCH·PR_SET_PDEATHSIG·CVE संख्या) को शीर्षक में अकेले न डालें, «—» से जुड़े उपवाक्य अधिकतम एक, 80 अक्षरों के भीतर (कठोर)। problem का पहला वाक्य «गैर-विशेषज्ञ भी समझ सके ऐसा एक-पंक्ति सार» से शुरू हो (कौन·कब·क्या असुविधाजनक, बिना तकनीकी शब्दजाल)। तकनीकी विवरण — चिह्न·CVE·कोड संदर्भ·फ़ाइल पथ — को बाद के वाक्यों और spec·evidence में डालें: शीर्षक·सारांश सरल, विवरण spec में। भले ही विषय स्वभावतः तकनीकी हो (daemon हार्डनिंग आदि) यह अनुबंध सदा लागू है; अपरिहार्य विशेष नाम (Tor·SSH आदि) अनुमत हैं पर उन्हें खोलकर लिखें।
- **impact / effort**: पूर्णांक 1~5। impact वह ऋण संगति·एक्सेसिबिलिटी·उपयोगकर्ता अनुभव पर जो आघात देता है (एक्सेसिबिलिटी उल्लंघन·अपर्याप्त कंट्रास्ट उच्च), effort ठीक करने की लागत (आधा दिन=1, सप्ताह=5)।
- **scope / spec**: स्वीकृति के तुरंत बाद लागू-योग्य स्तर — किन फ़ाइलों को किस अर्थ-टोकन/पैटर्न में बदलें, स्वीकृति मानदंड (उल्लंघन 0 कैसे पुष्टि करें), गैर-लक्ष्य (व्यवहार परिवर्तन नहीं आदि)। चूँकि इस ब्रीफ़ का विषय स्वयं डिज़ाइन है, problem/spec ही डिज़ाइन मानक कहता है।

{{backlog}}

## चरण 3 — आउटपुट
निम्न पथ पर JSON «array» फ़ाइल लिखें (अन्यत्र न लिखें):
{{outFile}}

प्रत्येक तत्व का स्कीमा (कोड-फ़ीचर ब्रीफ़ जैसा «समान» प्रारूप — दोनों एक ही बैकलॉग में साथ-साथ जाते हैं):
{
  "title": "उपयोगकर्ता/उत्पाद परिणाम से डिज़ाइन ऋण की एक सरल पंक्ति (80 अक्षरों के भीतर; फ़ाइल नाम·कोड चिह्न·संक्षेपण अकेले नहीं; «—» उपवाक्य अधिकतम एक)",
  "problem": "पहला वाक्य गैर-विशेषज्ञ भी समझ सके ऐसा एक-पंक्ति सार (किसे कैसे असुविधाजनक, बिना शब्दजाल) — फिर विवरण (किन स्क्रीनों का क्या, किस टोकन/पैटर्न को तोड़ा) spec/evidence में",
  "evidence": [{ "kind": "{{designKinds}}", "ref": "फ़ाइल:लाइन", "summary": "उल्लंघित टोकन/पैटर्न नाम + क्या बायपास किया" }],
  "impact": 1-5,
  "effort": 1-5,
  "scope": "इस बार ठीक की सतह / गैर-लक्ष्य",
  "spec": "यूज़र स्टोरी + स्वीकृति मानदंड (उल्लंघन 0 पुष्टि) + किनारे के मामले (markdown)",
{{dedupSchema}}
}

यदि प्रस्तावित करने को वास्तव में कोई डिज़ाइन ऋण न हो तो खाली array [] लिखें। फ़ाइल लिखने के बाद एक पंक्ति «N डिज़ाइन-ऋण आइटम लिखे गए» से समाप्त करें।{{outputDirective}}`,
    ja: `{{persona}}これまで他の仕事の「制約」としてだけ付いてきたデザインを、今回は「一級の主題」とし、このリポジトリの UI 表面をデザイン SSOT に照らしてスキャンし「デザイン負債」を機会ブリーフとして発掘せよ。コードを修正するな — 読む/調べるだけ。

これは「実装後の検収」ではなく「実装前の発掘(discovery)」だ — すでに作られた画面から、デザイン一貫性·アクセシビリティ·コントラスト·トークンドリフト·パターン不一致を見つけ、機能バックログと「並んで」優先ブリーフに上げる。(その役割は実装ワークフローの「デザインレビューゲートノード」やブリーフカードの「デザイン受け入れ基準ブロック」と重ならない — それらは作られた変更を検収/受け入れる場で、ここは何を直すかを「見つける」場だ。)
{{profile}}{{directive}}{{history}}{{verification}}{{storeReviews}}{{crashSignals}}{{designContext}}
## ステップ1 — UI 表面スキャン(デザイン SSOT に照らして、可能なものだけ)
上の「デザイン制約」が「宣言/発見」したこのリポジトリのデザイン SSOT が「ものさし」だ。焦点は {{focus}} (リサーチの「デザイン」レンズと同じ観点)。その基準に照らして UI 表面をスキャンせよ(スタック·パレット·トークン命名はリポジトリが定める — 特定のフレームワーク/色を仮定するな):
- **UI 表面を集める**: ビュー/コンポーネントファイルを探す(例: \`*View*\`/SwiftUI \`View\`、React/Vue/Svelte コンポーネント、\`*.css\`/\`*.scss\`/styled-components — このリポジトリに実際にあるもの)。\`grep -rn\` で疑わしいパターンを広く洗え。
- **トークンドリフト**: 意味トークンを迂回するリテラル·ハードコード値(SSOT が定めた色·余白·タイポグラフィの約束)。例) 意味トークンの代わりにリテラル色(\`.orange\`/\`.yellow\`/\`.blue\`)、ハードコードの白黒(\`.white\`/\`.black\`)、グローバル tint(\`.tint\`)の乱用、マジックナンバー余白 — 違反したトークン/パターン名は「このリポジトリの SSOT 命名」に従う。
- **色の意味の混同·兼用**: 一色を二つの意味で使う(状態色を装飾に借用)、または SSOT が「やるな」とした組み合わせ。
- **アクセシビリティ**: アクセシビリティラベル欠落、テキスト/背景コントラスト不足、ダイナミックタイプ·タッチターゲット未対応、色だけでの情報伝達。
- **パターン不一致**: 同じ役割のコンポーネントが画面ごとに異なる余白/角、欠落した状態(空/エラー/読み込み/無効/フォーカス)、重複定義されたスタイル。
- **i18n 表面**: このリポジトリが定めたロケール集合/抽出方式を通らない表示文字列。
- **補強信号(あれば)**: 下の出所から「読みにくい·ボタンが小さい·色が紛らわしい」類のデザイン不満を交差で付けて impact を補強せよ。
{{githubSignal}}
- 最近の流れ: \`git log --oneline -30\` で、すでに進行中のデザイン作業を再提案するな。{{storeTail}}{{crashTail}}

## ステップ2 — 統合: デザイン負債ブリーフを書く(最大5件)
見た違反を「問題/機会」単位でまとめよ — 単一の孤立違反ではなく、同じドリフトが複数画面に広がった「負債」の束として。各ブリーフの要件:
- **根拠必須 — ファイル:行 + 違反したトークン/パターン名**: すべての evidence の ref に「ファイル:行」を、summary に「違反したトークン/パターン名と何を迂回したか」を書け(例: ref \`Views/FooView.swift:42\`、summary \`リテラル .orange — 意味トークン(pro)を迂回\`)。実際に見た位置のない空想提案は禁止。
{{dedup}}
- **タイトル·要約の作成契約(読み手 = バックログで約30秒で承認/却下する人)**: title は「ユーザー/製品から見た結果」を平易な一行で先に出す — ファイル名·コード記号(.ts·.swift など)·全部大文字の識別子や略語(例: ESRCH·PR_SET_PDEATHSIG·CVE 番号)をタイトルに単独で入れず、「—」で繋ぐ節は1個以下、80文字以内(厳守)。problem の最初の文は「非専門家にも分かる一行要約」で始める(誰が·いつ·何が不便か、専門用語なしで)。記号·CVE·コード参照·ファイルパスなどの技術ディテールは2文目以降と spec·evidence に下ろせ — タイトル·要約は平易に、ディテールは spec。主題が本質的に技術的でも(daemon ハードニング等)この契約は常に適用し、避けられない固有名(Tor·SSH 等)は許すが噛み砕いて書く。
- **impact / effort**: 1~5の整数。impact はその負債が一貫性·アクセシビリティ·ユーザー体験に与える打撃(アクセシビリティ違反·コントラスト不足は高く)、effort は直す手間(半日=1、数週間=5)。
- **scope / spec**: 承認後すぐ実装できる水準 — どのファイルをどの意味トークン/パターンに変えるか、受け入れ基準(違反が0か確認する方法)、非目標(動作変更なし等)。このブリーフ自体がデザインを主題とするので、problem/spec がそのままデザイン基準を言う。

{{backlog}}

## ステップ3 — 産出
次のパスに JSON「配列」ファイルを書け(他の場所に書くな):
{{outFile}}

各要素のスキーマ(コード機能ブリーフと「同じ」形式 — 同じバックログに並んで入る):
{
  "title": "デザイン負債をユーザー/製品の結果として平易に書いた一行(80文字以内; ファイル名·コード記号·略語の単独不可; 「—」節は1個以下)",
  "problem": "最初の文は非専門家にも分かる一行要約(誰にどう不便か、専門用語なし) — 続けてどの画面の何がどのトークン/パターンを破ったか等のディテールは spec/evidence に",
  "evidence": [{ "kind": "{{designKinds}}", "ref": "ファイル:行", "summary": "違反したトークン/パターン名 + 何を迂回したか" }],
  "impact": 1-5,
  "effort": 1-5,
  "scope": "今回直す表面 / 非目標",
  "spec": "ユーザーストーリー + 受け入れ基準(違反0確認) + エッジケース (markdown)",
{{dedupSchema}}
}

提案すべきデザイン負債が本当になければ空配列 [] を書け。ファイルを書いたら「デザイン負債 N件作成完了」の一行で終えよ。{{outputDirective}}`,
    ko: `{{persona}} 다른 기능의 «제약» 으로만 따라붙던 디자인을 이번엔 «1급 주제» 로 삼아, 이 레포의 UI 표면을 디자인 SSOT 대비로 스캔해 «디자인 부채» 를 기회 브리프로 발굴하는 것이 임무다. 코드를 수정하지 마라 — 읽기/조사만 한다.

이건 «구현 후 검수» 가 아니라 «구현 전 발굴(discovery)» 다 — 이미 만들어진 화면에서 디자인 일관성·접근성·대비·토큰 드리프트·패턴 불일치를 찾아, 코드 기능 백로그와 «나란히» 우선순위 브리프로 올린다. (구현 워크플로우의 «디자인 리뷰 게이트 노드» 나 브리프 카드의 «디자인 수용 기준 블록» 과 역할이 겹치지 않는다 — 그건 만들어진 변경을 검수/수용하는 자리고, 여긴 무엇을 고칠지 «찾는» 자리다.)
{{profile}}{{directive}}{{history}}{{verification}}{{storeReviews}}{{crashSignals}}{{designContext}}
## 1단계 — UI 표면 스캔 (design SSOT 대비, 가능한 것만)
위 「디자인 제약」 이 «선언/발견» 한 이 레포의 디자인 SSOT 가 «측정 기준자» 다. 초점은 {{focus}} 다 (리서치의 «디자인» 렌즈와 같은 관점). 그 기준 대비 UI 표면을 스캔하라 (스택·팔레트·토큰 명명은 레포가 정한다 — 특정 프레임워크/색을 가정하지 마라):
- **UI 표면 모으기**: 뷰/컴포넌트 파일을 찾는다 (예: \`*View*\`/SwiftUI \`View\`, React/Vue/Svelte 컴포넌트, \`*.css\`/\`*.scss\`/styled-components 등 — 이 레포에 실제로 있는 것). \`grep -rn\` 으로 의심 패턴을 폭넓게 훑어라.
- **토큰 드리프트**: 의미 토큰(SSOT 가 정한 색·간격·타이포 약속)을 우회한 리터럴·하드코딩 값. 예) 의미 토큰 대신 리터럴 색(\`.orange\`/\`.yellow\`/\`.blue\`), 하드코딩 흑백(\`.white\`/\`.black\`), 전역 틴트(\`.tint\`) 남용, 매직 넘버 간격 — 위반 토큰/패턴명은 «이 레포 SSOT 의 명명» 을 따른다.
- **색 의미 혼동·겸용**: 한 색을 두 의미로 쓰거나(상태색을 장식에 빌려쓰기), SSOT 가 «하지 마라» 한 조합.
- **접근성**: 접근성 라벨 누락, 텍스트/배경 대비 부족, 동적 타입·터치 타깃 미대응, 색에만 의존한 정보 전달.
- **패턴 불일치**: 같은 역할 컴포넌트가 화면마다 다른 간격/모서리, 누락된 상태(빈/오류/로딩/비활성/포커스), 중복 정의된 스타일.
- **i18n 표면**: 노출 문자열이 이 레포가 정한 로케일 집합/추출 방식을 안 타는 패턴.
- **보강 신호 (있으면)**: 아래 출처에서 «읽기 어렵다·버튼이 작다·색이 헷갈린다» 류 디자인 불만을 교차로 붙여 impact 를 보강하라.
{{githubSignal}}
- 최근 흐름: \`git log --oneline -30\` 으로 이미 진행 중인 디자인 작업은 다시 제안하지 마라.{{storeTail}}{{crashTail}}

## 2단계 — 종합: 디자인 부채 브리프 작성 (최대 5건)
스캔에서 본 위반을 «문제/기회» 단위로 묶어라 — 낱개 위반 하나가 아니라, 같은 드리프트가 여러 화면에 퍼진 «부채» 묶음으로. 각 브리프 요건:
- **근거 필수 — 파일:라인 + 위반 토큰/패턴명**: 모든 evidence 의 ref 에 «파일:라인» 을, summary 에 «위반한 토큰/패턴명과 무엇을 우회했는지» 를 적어라 (예: ref \`Views/FooView.swift:42\`, summary \`리터럴 .orange — 의미 토큰(pro) 우회\`). 실제로 본 위치가 없는 상상 제안 금지.
{{dedup}}
- **제목·요약 작성 계약 (읽는 사람 = 백로그에서 30초 안에 승인/기각하는 사람)**: title 은 «사용자·제품 관점 결과» 를 평이한 한 줄로 앞세운다 — 파일명·코드 심볼(.ts·.swift 등)·전부-대문자 식별자나 약어(예: ESRCH·PR_SET_PDEATHSIG·CVE 번호)를 제목에 단독으로 넣지 말고, «—» 로 잇는 절은 1개 이하, 80자 이내(엄수). problem 의 첫 문장은 «비전문가도 이해할 한 줄 요약» 으로 시작한다(누가·언제·무엇이 불편한가를 전문용어 없이). 심볼·CVE·코드 참조·파일경로 등 기술 디테일은 둘째 문장 이후와 spec·evidence 로 내려라 — 제목·요약은 평이하게, 디테일은 spec. 주제가 본질적으로 기술적이어도(daemon 하드닝 등) 이 계약은 항상 적용하고, 불가피한 고유명(Tor·SSH 등)은 허용하되 풀어 쓴다.
- **impact / effort**: 1~5 정수. impact 는 그 부채가 일관성·접근성·사용자 경험에 주는 타격(접근성 위반·대비 부족은 높게), effort 는 고치는 품(반나절=1, 수 주=5).
- **scope / spec**: 승인 즉시 구현 가능한 수준 — 어느 파일들을 어떤 의미 토큰/패턴으로 바꿀지, 수용 기준(위반이 0 인지 확인하는 방법), 비-목표(동작 변경 없음 등). 이 브리프 자체가 디자인이 주제이므로 problem/spec 이 곧 디자인 기준을 말한다.

{{backlog}}

## 3단계 — 산출
다음 경로에 JSON «배열» 파일을 써라 (다른 곳에 쓰지 마라):
{{outFile}}

각 원소 스키마 (코드 기능 브리프와 «동일» 형식 — 같은 백로그에 나란히 들어간다):
{
  "title": "디자인 부채를 사용자·제품 결과로 평이하게 쓴 한 줄 (80자 이내; 파일명·코드 심볼·약어 단독 금지; «—» 절 1개 이하)",
  "problem": "첫 문장은 비전문가도 이해할 한 줄 요약(누구에게 어떻게 불편한가, 전문용어 없이) — 그다음 어느 화면의 무엇이 어떤 토큰/패턴을 어겼는지 등 디테일은 spec/evidence 로",
  "evidence": [{ "kind": "{{designKinds}}", "ref": "파일:라인", "summary": "위반 토큰/패턴명 + 무엇을 우회했는지" }],
  "impact": 1-5,
  "effort": 1-5,
  "scope": "이번에 고치는 표면 / 비-목표",
  "spec": "유저스토리 + 수용 기준(위반 0 확인) + 엣지케이스 (markdown)",
{{dedupSchema}}
}

제안할 디자인 부채가 정말 없으면 빈 배열 [] 을 써라. 파일을 쓴 뒤 «디자인 부채 N건 작성 완료» 한 줄로 끝내라.{{outputDirective}}`,
    "pt-BR": `{{persona}} Faça do design — que antes acompanhava apenas como «restrição» de outro trabalho — um «sujeito de primeira classe» desta vez, e escaneie a superfície de UI deste repo frente ao SSOT de design para descobrir «dívida de design» como briefs de oportunidade. Não modifique código — apenas leia/investigue.

Isto é «descoberta pré-implementação», não «revisão pós-implementação» — a partir de telas já construídas, encontre consistência de design·acessibilidade·contraste·deriva de tokens·inconsistência de padrões, e eleve-as como briefs prioritários «lado a lado» com o backlog de recursos. (Seu papel não se sobrepõe ao «nó de portão de revisão de design» do workflow de implementação nem ao «bloco de critérios de aceitação de design» do cartão do brief — esses são lugares para revisar/aceitar uma mudança feita; aqui é o lugar para «encontrar» o que corrigir.)
{{profile}}{{directive}}{{history}}{{verification}}{{storeReviews}}{{crashSignals}}{{designContext}}
## Passo 1 — Varredura da superfície de UI (frente ao SSOT de design, apenas o possível)
O SSOT de design do repo «declarado/descoberto» em «Restrições de design» acima é a «régua». O foco é {{focus}} (a mesma perspectiva da lente «design» da pesquisa). Varra a superfície de UI frente a esse padrão (stack·paleta·nomenclatura de tokens são definidos pelo repo — não assuma um framework/cor específico):
- **Reúna a superfície de UI**: encontre arquivos de view/componente (ex.: \`*View*\`/SwiftUI \`View\`, componentes React/Vue/Svelte, \`*.css\`/\`*.scss\`/styled-components — o que realmente existir neste repo). Varra padrões suspeitos amplamente com \`grep -rn\`.
- **Deriva de tokens**: literais·valores hardcoded que ignoram tokens de significado (o compromisso de cor·espaçamento·tipografia que o SSOT definiu). Ex.: uma cor literal em vez de um token de significado (\`.orange\`/\`.yellow\`/\`.blue\`), preto/branco hardcoded (\`.white\`/\`.black\`), uso excessivo de um tint global (\`.tint\`), espaçamento com números mágicos — o nome do token/padrão violado segue «a nomenclatura do SSOT deste repo».
- **Confusão·sobrecarga do significado da cor**: usar uma cor para dois significados (tomar emprestada uma cor de estado para decoração), ou uma combinação que o SSOT disse «não fazer».
- **Acessibilidade**: rótulos de acessibilidade ausentes, contraste texto/fundo insuficiente, sem suporte a tipo dinâmico·alvo de toque, transmitir info só por cor.
- **Inconsistência de padrões**: componentes de mesmo papel com espaçamento/cantos diferentes por tela, estados ausentes (vazio/erro/carregando/desabilitado/foco), estilos definidos redundantemente.
- **Superfície i18n**: strings visíveis que não passam pelo conjunto de localidades/método de extração que este repo definiu.
- **Sinais de reforço (se houver)**: reforce impact anexando de forma cruzada reclamações de design do tipo «difícil de ler·o botão é pequeno·a cor confunde» das fontes abaixo.
{{githubSignal}}
- Fluxo recente: com \`git log --oneline -30\`, não reproponha trabalho de design já em andamento.{{storeTail}}{{crashTail}}

## Passo 2 — Síntese: escreva briefs de dívida de design (até 5)
Agrupe as violações que você viu em unidades de «problema/oportunidade» — não uma violação isolada, mas um pacote de «dívida» da mesma deriva espalhada por várias telas. Requisitos por brief:
- **Evidência obrigatória — arquivo:linha + nome do token/padrão violado**: no ref de cada evidence escreva «arquivo:linha», e no summary escreva «o nome do token/padrão violado e o que ignorou» (ex.: ref \`Views/FooView.swift:42\`, summary \`literal .orange — ignorou o token de significado (pro)\`). Sem propostas imaginadas sem uma localização que você realmente viu.
{{dedup}}
- **Contrato de escrita de título·resumo (o leitor = quem aprova/rejeita em ~30 s no backlog)**: o título encabeça com o «resultado do ponto de vista do usuário/produto» em uma linha simples — não coloque um nome de arquivo·símbolo de código (.ts·.swift, etc.)·um identificador ou abreviação em maiúsculas (ex.: ESRCH·PR_SET_PDEATHSIG·um número CVE) sozinho no título, mantenha as cláusulas unidas por «—» em no máximo uma, dentro de 80 caracteres (rigoroso). A primeira frase do problem começa com um «resumo de uma linha que um leigo entenda» (quem·quando·o que incomoda, sem jargão). Empurre os detalhes técnicos — símbolos·CVE·referências de código·caminhos de arquivo — para frases posteriores e para spec·evidence: título·resumo simples, detalhes no spec. Mesmo que o tema seja intrinsecamente técnico (endurecimento do daemon, etc.) este contrato sempre se aplica; nomes próprios inevitáveis (Tor·SSH, etc.) são permitidos, mas explique-os.
- **impact / effort**: inteiros 1~5. impact é o impacto dessa dívida na consistência·acessibilidade·experiência do usuário (violações de acessibilidade·contraste insuficiente são altos), effort é o custo de corrigir (meio dia=1, semanas=5).
- **scope / spec**: um nível implementável logo após a aprovação — quais arquivos mudar para qual token/padrão de significado, critérios de aceitação (como confirmar 0 violações), não-objetivos (sem mudança de comportamento, etc.). Como o sujeito deste brief é o próprio design, problem/spec é o padrão de design.

{{backlog}}

## Passo 3 — Saída
Escreva um arquivo «array» JSON no seguinte caminho (não escreva em outro lugar):
{{outFile}}

Esquema por elemento (o «mesmo» formato de um brief de recurso de código — eles vão lado a lado no mesmo backlog):
{
  "title": "dívida de design em uma linha simples pelo resultado do usuário/produto (até 80 caracteres; sem nome de arquivo·símbolo de código·abreviação sozinhos; no máx. uma cláusula «—»)",
  "problem": "a primeira frase é um resumo de uma linha que um leigo entenda (como incomoda quem, sem jargão) — depois empurre os detalhes (o que em quais telas violou qual token/padrão) para spec/evidence",
  "evidence": [{ "kind": "{{designKinds}}", "ref": "arquivo:linha", "summary": "nome do token/padrão violado + o que ignorou" }],
  "impact": 1-5,
  "effort": 1-5,
  "scope": "a superfície corrigida desta vez / não-objetivos",
  "spec": "user story + critérios de aceitação (confirmar 0 violações) + casos de borda (markdown)",
{{dedupSchema}}
}

Se realmente não houver dívida de design a propor, escreva um array vazio []. Após escrever o arquivo, termine com uma linha: «N itens de dívida de design escritos».{{outputDirective}}`,
    ru: `{{persona}} Сделай дизайн — который раньше шёл лишь как «ограничение» другой работы — «первоклассным предметом» на этот раз и просканируй поверхность UI этого репозитория относительно дизайн-SSOT, чтобы обнаружить «дизайн-долг» как брифы возможностей. Не изменяй код — только читай/исследуй.

Это «обнаружение до реализации (discovery)», а не «приёмка после реализации» — из уже построенных экранов найди согласованность дизайна·доступность·контраст·дрейф токенов·несогласованность паттернов и подними их как приоритетные брифы «бок о бок» с бэклогом функций. (Его роль не пересекается с «узлом ворот дизайн-ревью» в workflow реализации или «блоком критериев приёмки дизайна» в карточке брифа — это места для ревью/приёмки сделанного изменения, а здесь место, чтобы «найти», что чинить.)
{{profile}}{{directive}}{{history}}{{verification}}{{storeReviews}}{{crashSignals}}{{designContext}}
## Шаг 1 — Сканирование поверхности UI (относительно дизайн-SSOT, только возможное)
Дизайн-SSOT репозитория, «объявленный/обнаруженный» в «Ограничениях дизайна» выше, — это «мерило». Фокус — {{focus}} (та же перспектива, что у линзы «design» в исследовании). Сканируй поверхность UI относительно этого стандарта (стек·палитру·именование токенов задаёт репозиторий — не предполагай конкретный фреймворк/цвет):
- **Собери поверхность UI**: найди файлы вью/компонентов (напр., \`*View*\`/SwiftUI \`View\`, компоненты React/Vue/Svelte, \`*.css\`/\`*.scss\`/styled-components — то, что реально есть в этом репозитории). Широко прочеши подозрительные паттерны через \`grep -rn\`.
- **Дрейф токенов**: литералы·хардкод-значения в обход смысловых токенов (обязательство цвета·отступов·типографики, заданное SSOT). Напр., литеральный цвет вместо смыслового токена (\`.orange\`/\`.yellow\`/\`.blue\`), хардкод чёрного/белого (\`.white\`/\`.black\`), злоупотребление глобальным tint (\`.tint\`), отступы магическими числами — имя нарушенного токена/паттерна следует «именованию SSOT этого репозитория».
- **Путаница·совмещение смысла цвета**: использование одного цвета в двух смыслах (заимствование цвета статуса для украшения), или комбинация, которую SSOT «запретил».
- **Доступность**: отсутствие подписей доступности, недостаточный контраст текста/фона, отсутствие поддержки динамического типа·области касания, передача информации только цветом.
- **Несогласованность паттернов**: компоненты одной роли с разными отступами/углами по экранам, отсутствующие состояния (пусто/ошибка/загрузка/отключено/фокус), избыточно определённые стили.
- **Поверхность i18n**: видимые строки, не проходящие через набор локалей/метод извлечения, заданные этим репозиторием.
- **Усиливающие сигналы (если есть)**: усиль impact, перекрёстно прикрепляя дизайн-жалобы типа «трудно читать·кнопка маленькая·цвет сбивает с толку» из источников ниже.
{{githubSignal}}
- Недавний поток: по \`git log --oneline -30\` не предлагай повторно дизайн-работу, уже идущую в процессе.{{storeTail}}{{crashTail}}

## Шаг 2 — Синтез: напиши брифы дизайн-долга (до 5)
Сгруппируй увиденные нарушения в единицы «проблема/возможность» — не одно изолированное нарушение, а пакет «долга» одного и того же дрейфа, распространённого по нескольким экранам. Требования к каждому брифу:
- **Доказательство обязательно — файл:строка + имя нарушенного токена/паттерна**: в ref каждого evidence пиши «файл:строка», а в summary — «имя нарушенного токена/паттерна и что он обошёл» (напр., ref \`Views/FooView.swift:42\`, summary \`литеральный .orange — обошёл смысловой токен (pro)\`). Никаких выдуманных предложений без реально увиденного места.
{{dedup}}
- **Контракт написания заголовка·резюме (читатель — тот, кто одобряет/отклоняет за ~30 с в бэклоге)**: заголовок выводит вперёд «результат с точки зрения пользователя/продукта» одной простой строкой — не вставляйте имя файла·кодовый символ (.ts·.swift и т. п.)·идентификатор или аббревиатуру капсом (напр. ESRCH·PR_SET_PDEATHSIG·номер CVE) в заголовок по отдельности, держите не более одного предложения, соединённого «—», в пределах 80 символов (строго). Первое предложение problem начинается с «однострочного резюме, понятного неспециалисту» (кто·когда·что неудобно, без жаргона). Технические детали — символы·CVE·ссылки на код·пути файлов — спускайте в последующие предложения и в spec·evidence: заголовок·резюме простые, детали в spec. Даже если тема по сути техническая (харднинг daemon и т. п.), этот контракт применяется всегда; неизбежные имена собственные (Tor·SSH и т. п.) допускаются, но раскрывайте их.
- **impact / effort**: целые 1~5. impact — удар этого долга по согласованности·доступности·пользовательскому опыту (нарушения доступности·недостаточный контраст высоки), effort — стоимость исправления (полдня=1, недели=5).
- **scope / spec**: уровень, реализуемый сразу после одобрения — какие файлы менять на какой смысловой токен/паттерн, критерии приёмки (как подтвердить 0 нарушений), не-цели (без изменения поведения и т. п.). Поскольку предмет этого брифа — сам дизайн, problem/spec и есть стандарт дизайна.

{{backlog}}

## Шаг 3 — Вывод
Запиши JSON-файл «массив» по следующему пути (не пиши в другое место):
{{outFile}}

Схема каждого элемента («тот же» формат, что у брифа функции кода — они идут бок о бок в одном бэклоге):
{
  "title": "дизайн-долг одной простой строкой с точки зрения результата пользователя/продукта (в пределах 80 символов; без имени файла·кодового символа·аббревиатуры по отдельности; не более одного предложения «—»)",
  "problem": "первое предложение — однострочное резюме, понятное неспециалисту (как и кому неудобно, без жаргона) — затем детали (что на каких экранах нарушило какой токен/паттерн) спускайте в spec/evidence",
  "evidence": [{ "kind": "{{designKinds}}", "ref": "файл:строка", "summary": "имя нарушенного токена/паттерна + что он обошёл" }],
  "impact": 1-5,
  "effort": 1-5,
  "scope": "поверхность, исправленная в этот раз / не-цели",
  "spec": "user story + критерии приёмки (подтвердить 0 нарушений) + краевые случаи (markdown)",
{{dedupSchema}}
}

Если действительно нет дизайн-долга для предложения, запиши пустой массив []. После записи файла закончи одной строкой: «Написано N пунктов дизайн-долга».{{outputDirective}}`,
    "zh-Hans": `{{persona}}这次把设计——以往只作为其他工作的「约束」附带——作为「一级主题」,对照设计 SSOT 扫描本仓库的 UI 表面,将「设计债」发掘为机会简报。不要修改代码——只读取/调研。

这是「实现前发掘(discovery)」,而非「实现后检收」——从已构建的画面中找出设计一致性·无障碍·对比度·令牌漂移·模式不一致,并将其作为优先简报与功能待办「并列」提出。(其角色不与实现工作流的「设计评审门节点」或简报卡的「设计验收标准块」重叠——那些是评审/接受已完成变更之处,这里是「寻找」该修什么之处。)
{{profile}}{{directive}}{{history}}{{verification}}{{storeReviews}}{{crashSignals}}{{designContext}}
## 第 1 步 — UI 表面扫描(对照设计 SSOT,仅限可行)
上方「设计约束」「声明/发现」的本仓库设计 SSOT 即「标尺」。焦点为 {{focus}}(与调研的「design」视角相同)。对照该标准扫描 UI 表面(技术栈·调色板·令牌命名由仓库设定——不要假定特定框架/颜色):
- **收集 UI 表面**: 找出视图/组件文件(如 \`*View*\`/SwiftUI \`View\`、React/Vue/Svelte 组件、\`*.css\`/\`*.scss\`/styled-components——本仓库实际存在者)。用 \`grep -rn\` 广泛排查可疑模式。
- **令牌漂移**: 绕过含义令牌的字面量·硬编码值(SSOT 设定的颜色·间距·排版约定)。如:用字面量颜色而非含义令牌(\`.orange\`/\`.yellow\`/\`.blue\`)、硬编码黑白(\`.white\`/\`.black\`)、滥用全局 tint(\`.tint\`)、魔数间距——被违反的令牌/模式名遵循「本仓库 SSOT 的命名」。
- **颜色含义混淆·兼用**: 用一种颜色表达两种含义(借状态色作装饰),或 SSOT「禁止」的组合。
- **无障碍**: 缺少无障碍标签、文本/背景对比不足、不支持动态字号·触控目标、仅以颜色传达信息。
- **模式不一致**: 同角色组件在各画面间间距/圆角不同、缺失状态(空/错误/加载/禁用/聚焦)、冗余定义的样式。
- **i18n 表面**: 不经过本仓库设定的语言环境集合/提取方式的可见字符串。
- **增强信号(若有)**: 从下方来源交叉附上「难以阅读·按钮太小·颜色易混」一类的设计抱怨以增强 impact。
{{githubSignal}}
- 近期动向: 用 \`git log --oneline -30\`,不要重复提出已在进行的设计工作。{{storeTail}}{{crashTail}}

## 第 2 步 — 综合: 撰写设计债简报(最多 5 条)
将所见违规归并为「问题/机会」单元——不是单个孤立违规,而是同一漂移散布于多个画面的「债务」捆绑。每条简报的要求:
- **依据必需 — 文件:行 + 被违反的令牌/模式名**: 每条 evidence 的 ref 写「文件:行」,summary 写「被违反的令牌/模式名及其绕过了什么」(如 ref \`Views/FooView.swift:42\`、summary \`字面量 .orange — 绕过含义令牌(pro)\`)。禁止没有实际看到位置的臆想提案。
{{dedup}}
- **标题·摘要撰写契约(读者 = 在待办上约 30 秒内批准/拒绝的人)**: title 以「从用户/产品角度看的结果」用平实的一行打头——不要把文件名·代码符号(.ts·.swift 等)·全大写标识符或缩写(如 ESRCH·PR_SET_PDEATHSIG·CVE 编号)单独放进标题,用「—」连接的从句至多一个,80 字以内(严格)。problem 的首句以「非专业者也能看懂的一行摘要」开头(谁·何时·什么不便,不用术语)。把技术细节——符号·CVE·代码引用·文件路径——下放到后续句子和 spec·evidence:标题·摘要平实,细节在 spec。即便主题本质上是技术性的(daemon 加固等)本契约也始终适用;不可避免的专有名词(Tor·SSH 等)允许但要展开说明。
- **impact / effort**: 1~5 整数。impact 是该债务对一致性·无障碍·用户体验的冲击(无障碍违规·对比不足为高),effort 是修复成本(半天=1,数周=5)。
- **scope / spec**: 达到批准后即可实现的水平——将哪些文件改为何种含义令牌/模式、验收标准(如何确认违规为 0)、非目标(不改变行为等)。由于本简报的主题就是设计,problem/spec 即设计标准。

{{backlog}}

## 第 3 步 — 产出
将 JSON「数组」文件写入以下路径(不要写到别处):
{{outFile}}

每个元素的 schema(与代码功能简报「相同」格式——两者在同一待办中并列):
{
  "title": "从用户/产品结果出发、平实地写设计债的一行(80 字以内;文件名·代码符号·缩写不可单独出现;「—」从句至多一个)",
  "problem": "首句为非专业者也能看懂的一行摘要(对谁如何不便,不用术语)——然后把细节(哪些画面的什么违反了哪个令牌/模式)下放到 spec/evidence",
  "evidence": [{ "kind": "{{designKinds}}", "ref": "文件:行", "summary": "被违反的令牌/模式名 + 绕过了什么" }],
  "impact": 1-5,
  "effort": 1-5,
  "scope": "本次修复的表面 / 非目标",
  "spec": "用户故事 + 验收标准(确认违规为 0) + 边界情形 (markdown)",
{{dedupSchema}}
}

若确实没有可提出的设计债,则写空数组 []。写完文件后以一行「已写 N 条设计债」结束。{{outputDirective}}`,
  },

  // ── 워크플로우 설계 프롬프트 (buildPoWorkflowDesignPrompt) ───────────────────
  "workflow.design.body": {
    ar: `أنت وكيل PO لهذا المستودع. صمّم سير عمل (DAG) متعدّد الوكلاء لتنفيذ «بريف الفرصة المعتمد» أدناه. لا تعدّل الكود — اقرأ المستودع للتعرّف على طريقة التحقق فقط، والمخرج تعريف سير عمل JSON واحد.

## البريف
- title: {{title}}
- problem: {{problem}}
- scope: {{scope}}
- spec:
{{spec}}

{{designContext}}

## الهيكل الذي يجب أن يتبعه سير العمل
«تثبيت المواصفات → التنفيذ → التحقق الذاتي → بوابة موافقة بشرية (commit) → الإنهاء». جسّد هذا الهيكل وفق البريف:
- **تثبيت المواصفات**: ثبّت spec البريف كوثيقة مواصفات تتبع عرف المواصفات/الوثائق لهذا المستودع واحفظها (جد أولاً موقع·صيغة المستودع واتبعها، وإلا وثيقة جديدة تحت \`docs/\`).
- **التنفيذ**: نفّذ وفق تلك المواصفات. إن لزم قسّم التنفيذ إلى عقدتين (مثل خلفية / واجهة حسب الطبقة·الوحدة). إن مسّ البريف الواجهة فضمّن جوهر «قيود التصميم» أعلاه (معنى اللون·مجموعة اللغات المدعومة·الحالة·إمكانية الوصول التي أعلنها/اكتشفها هذا المستودع) في prompt عقدة التنفيذ «مباشرةً» — جلسة العقدة لا تقرأ CLAUDE.md/AGENTS.md تلقائياً.
- **التحقق الذاتي**: استخدم وسائل التحقق القائمة في هذا المستودع كما هي — اقرأ \`.claude/\`/CLAUDE.md/AGENTS.md/scripts واختر ما يناسب نوع تغيير البريف (مثل: تغيير الواجهة → تحقّق UI/لقطة لتلك التقنية، تغيير الخلفية/CLI → اختبار+بناء/فحص الأنواع). إن مسّ التغيير النصوص المعروضة·الترجمة (i18n)، وإن وُجدت في المستودع وسيلة فحص lint/كتالوج i18n فشغّلها لإظهار مرشّحي «تجاوز المورد/الكتالوج» بـ«ملف:سطر»، وتحقّق أولاً من المرشّحين «الجدد» الذين أدخلهم هذا التغيير (diff) — هذا يلتقط انحدار اللغة المفقودة الذي لا تراه اللقطة/التشغيل. لا تخترع طريقة تحقّق جديدة. اربط حافة «فشل» عقدة التحقق بعقدة التنفيذ لصنع حلقة إعادة محاولة.
- **مراجعة المصمّم (للبريفات التي تمسّ الواجهة فقط)**: إن مسّ التنفيذ «سطح واجهة مُصيَّر»، ضع عقدة عمل «مراجعة المصمّم» واحدة بين التحقق الذاتي والبوابة (عقدة «قبل» البوابة مباشرةً — كي تتدفّق findings كدليل إدخال للبوابة). تلك العقدة تصيّر/تلتقط شاشة التغيير بوسيلة الالتقاط «القائمة» في هذا المستودع (لقطة محاكي/تطبيق·Storybook·متصفح headless للويب)، وتنقد اللقطة «بالنظر مباشرةً» مقابل SSOT التصميم في «قيود التصميم» أعلاه، وتترك في result.md findings تضع لكل انتهاك (خلط معنى اللون·التباين·التباعد·لون النوع) «ماذا/أين (إحداثيات معيارية أو اسم رمز)». لتخفيف اللاحتمية اجعلها تنقد الشاشة نفسها مرّتين أو أكثر وتبلّغ «المؤكَّد» فقط. هذه العقدة لـ«جمع الأدلة» فقط فلا تعدّل الكود وتمرّ للبوابة فقط (لا حافة «فشل» — ليس حجباً تلقائياً بل يراه الإنسان عند القرار). إن كان البريف بلا سطح مُصيَّر (تغيير نص فقط مثلاً) فلا تضع هذه العقدة.
- **بوابة الموافقة البشرية**: قبل الإنهاء مباشرةً عقدة عمل واحدة بـ\`requires_approval: true\` — إن وافق المستخدم فإن جلسة تلك العقدة «تعمل commit فقط» للتغيير. لا تدمج فرع العمل في الفرع الأساسي مباشرةً (لا git merge·push) — إعادة الدمج تتولّاها طابور الدمج في daemon بالتسلسل بعد موافقة البوابة+commit (مع اكتشاف التعارض مسبقاً·تنظيف بعد الدمج). يجب ألا يوجد مسار يمضي دون بوابة. إن كان بريف واجهة فاجعل prompt البوابة يقرأ findings «مراجعة المصمّم» معاً ويذكر الانحدار غير المحلول في ملخّص الـ commit.

## مخطط التعريف (بهذه الصيغة بالضبط)
العقدة (NodeDef): { "id": "سلسلة فريدة", "type": "start" | "task" | "end", "title": "سطر واحد", "prompt": "إلزامي للـ task — التعليمات الكاملة المرسلة لجلسة هذه العقدة", "agent"?: أحد {{agentIds}} (عند الحذف {{defaultAgent}}), "requires_approval"?: true (للبوابة فقط), "x": رقم, "y": رقم }
الحافة (EdgeDef): { "id": "سلسلة فريدة", "from": "id العقدة", "to": "id العقدة", "condition"?: "fail" }

القواعد:
- عقدة start واحدة وعقدة end واحدة إلزاميتان. عقدة task تتطلّب prompt.
- الحلقة (حافة للخلف) عبر حافة "fail" للعمل فقط — أي دورة عبر حافة أخرى تُرفض.
- prompt كل task يدخل «جلسة جديدة ترى تلك العقدة فقط» — ضمّن السياق اللازم (محتوى البريف وغيره) داخل prompt مباشرةً (نتائج العقدة السابقة تُمرَّر تلقائياً عبر مجلد Task، فاكتفِ بأن تقول "اقرأ مجلد نتائج المرحلة السابقة").
- العقد نحو 6±2 — لا تفرط في التقسيم. الإحداثيات بتدفّق أعلى→أسفل بشكل مرتّب (x 60~400، y بفاصل 170).

## المخرجات
اكتب «كائن JSON واحد» { "nodes": [...], "edges": [...] } في المسار التالي (لا تكتب في مكان آخر):
{{outFile}}

بعد كتابة الملف، أنهِ بسطر واحد «اكتمل تصميم سير العمل».`,
    en: `You are this repository's PO agent. Design a multi-agent workflow (DAG) to implement the «approved opportunity brief» below. Do not modify code — only read the repo to understand verification methods, and the output is a single workflow-definition JSON.

## Brief
- title: {{title}}
- problem: {{problem}}
- scope: {{scope}}
- spec:
{{spec}}

{{designContext}}

## The skeleton the workflow must follow
«Confirm spec → implement → self-verify → human approval gate (commit) → end». Concretize this skeleton to fit the brief:
- **Confirm spec**: confirm the brief's spec as a spec document following this repo's spec/doc conventions and save it (first find and follow the repo's location·format, else a new doc under \`docs/\`).
- **Implement**: implement per that spec. If needed, split implementation into 2 nodes (e.g., backend / frontend by layer·module). If the brief touches the UI, embed the core of «Design constraints» above (the color meaning·supported locale set·states·accessibility this repo declared/discovered) «directly» in the implementation node's prompt — the node session cannot automatically read that repo's CLAUDE.md/AGENTS.md.
- **Self-verify**: use this repo's existing verification means as-is — read the repo's \`.claude/\`/CLAUDE.md/AGENTS.md/scripts and pick what fits the brief's change kind (e.g., a UI change → that stack's UI/snapshot verification, a backend/CLI change → tests+build/type-check). If the change touches user-facing strings·translation (i18n), and the repo has an i18n lint/catalog-check means, run it to surface «resource/catalog-bypassing» anti-pattern candidates as «file:line», and check the «newly introduced» candidates of this change (diff) first — this catches missing-locale regressions that snapshots/runs cannot see. Do not invent a new verification method. Wire the verification node's «fail» edge back to the implementation node to make a retry loop.
- **Designer review (only for briefs that touch the UI)**: if the implementation touches a «rendered UI surface», put one «designer review» task node between self-verify and the gate (the node «just before» the gate — so findings flow as the gate's input evidence). That node renders/captures the changed screen with this repo's «existing» capture means (simulator/app screenshot·Storybook·web headless, etc.), critiques the screenshot against the design SSOT in «Design constraints» above «by looking directly», and leaves in result.md findings that attach «what/where (normalized coordinates or token name)» to each violation (color-meaning confusion·contrast·spacing·kind color). For non-determinism mitigation, have it critique the same screen 2+ times and report only the «confirmed». This node is for «evidence collection» only, so it does not edit code and only passes through to the gate («no fail edge» — not auto-blocking, the human sees it at decision time). If the brief has no rendered surface (e.g., text-only changes), do not place this node.
- **Human approval gate**: just before end, one \`requires_approval: true\` task node — if the user approves, that node's session «commits only». Do not merge the work branch directly into the base branch (no git merge·push) — re-integration is handled by the daemon's merge queue serially after gate approval+commit (with pre-conflict detection·post-merge cleanup). There must be no path that proceeds without a gate. For a UI brief, have the gate prompt also read the «designer review» findings and note unresolved regressions in the commit summary.

## Definition schema (exactly this format)
Node (NodeDef): { "id": "unique string", "type": "start" | "task" | "end", "title": "one line", "prompt": "required for task — the full instruction sent to this node's session", "agent"?: one of {{agentIds}} (defaults to {{defaultAgent}} if omitted), "requires_approval"?: true (gate only), "x": number, "y": number }
Edge (EdgeDef): { "id": "unique string", "from": "node id", "to": "node id", "condition"?: "fail" }

Rules:
- One start node, one end node required. A task node requires a prompt.
- A loop (a backward edge) only via a task's "fail" edge — a cycle via any other edge is rejected.
- Each task's prompt goes into «a new session that sees only that node» — embed the needed context (brief content, etc.) directly in the prompt (the previous node's results are auto-passed via the Task folder, so just say "read the previous step's result folder").
- About 6±2 nodes — do not over-split. Coordinates flowing top→bottom nicely (x 60~400, y spacing 170).

## Output
Write a «single JSON object» { "nodes": [...], "edges": [...] } to the following path (do not write elsewhere):
{{outFile}}

After writing the file, end with one line: «Workflow design complete».`,
    es: `Eres el agente PO de este repositorio. Diseña un workflow multiagente (DAG) para implementar el «brief de oportunidad aprobado» de abajo. No modifiques código — solo lee el repo para entender los métodos de verificación, y la salida es un único JSON de definición de workflow.

## Brief
- title: {{title}}
- problem: {{problem}}
- scope: {{scope}}
- spec:
{{spec}}

{{designContext}}

## El esqueleto que el workflow debe seguir
«Confirmar spec → implementar → autoverificar → puerta de aprobación humana (commit) → fin». Concreta este esqueleto según el brief:
- **Confirmar spec**: confirma el spec del brief como un documento de spec siguiendo las convenciones de spec/docs de este repo y guárdalo (primero encuentra y sigue la ubicación·formato del repo, si no un nuevo doc bajo \`docs/\`).
- **Implementar**: implementa según ese spec. Si es necesario, divide la implementación en 2 nodos (p. ej., backend / frontend por capa·módulo). Si el brief toca la UI, incrusta el núcleo de «Restricciones de diseño» de arriba (el significado del color·conjunto de locales admitidos·estados·accesibilidad que este repo declaró/descubrió) «directamente» en el prompt del nodo de implementación — la sesión del nodo no puede leer automáticamente el CLAUDE.md/AGENTS.md de ese repo.
- **Autoverificar**: usa los medios de verificación existentes de este repo tal cual — lee el \`.claude/\`/CLAUDE.md/AGENTS.md/scripts del repo y elige lo que se ajuste al tipo de cambio del brief (p. ej., un cambio de UI → verificación UI/snapshot de ese stack, un cambio de backend/CLI → tests+build/type-check). Si el cambio toca cadenas visibles·traducción (i18n), y el repo tiene un medio de lint/chequeo de catálogo i18n, ejecútalo para sacar a la superficie candidatos de anti-patrón «que evitan el recurso/catálogo» como «archivo:línea», y revisa primero los candidatos «recién introducidos» por este cambio (diff) — esto detecta regresiones de locale faltante que los snapshots/ejecuciones no pueden ver. No inventes un nuevo método de verificación. Conecta la arista «fail» del nodo de verificación de vuelta al nodo de implementación para hacer un bucle de reintento.
- **Revisión de diseñador (solo para briefs que tocan la UI)**: si la implementación toca una «superficie de UI renderizada», pon un nodo de tarea «revisión de diseñador» entre la autoverificación y la puerta (el nodo «justo antes» de la puerta — para que los findings fluyan como evidencia de entrada de la puerta). Ese nodo renderiza/captura la pantalla cambiada con los medios de captura «existentes» de este repo (captura de simulador/app·Storybook·navegador headless web, etc.), critica la captura frente al SSOT de diseño en «Restricciones de diseño» de arriba «mirando directamente», y deja en result.md findings que adjuntan «qué/dónde (coordenadas normalizadas o nombre de token)» a cada violación (confusión de significado de color·contraste·espaciado·color por tipo). Para mitigar el no determinismo, haz que critique la misma pantalla 2+ veces y reporte solo lo «confirmado». Este nodo es solo para «recolección de evidencia», así que no edita código y solo pasa a la puerta («sin arista fail» — no bloquea automáticamente, el humano lo ve al decidir). Si el brief no tiene superficie renderizada (p. ej., cambios solo de texto), no coloques este nodo.
- **Puerta de aprobación humana**: justo antes del fin, un nodo de tarea \`requires_approval: true\` — si el usuario aprueba, la sesión de ese nodo «solo hace commit». No fusiones la rama de trabajo directamente en la rama base (sin git merge·push) — la re-integración la maneja la cola de merge del daemon en serie tras la aprobación de la puerta+commit (con detección previa de conflictos·limpieza posterior al merge). No debe haber ningún camino que proceda sin una puerta. Para un brief de UI, haz que el prompt de la puerta también lea los findings de «revisión de diseñador» y anote regresiones no resueltas en el resumen del commit.

## Esquema de definición (exactamente este formato)
Nodo (NodeDef): { "id": "cadena única", "type": "start" | "task" | "end", "title": "una línea", "prompt": "requerido para task — la instrucción completa enviada a la sesión de este nodo", "agent"?: uno de {{agentIds}} (por defecto {{defaultAgent}} si se omite), "requires_approval"?: true (solo puerta), "x": número, "y": número }
Arista (EdgeDef): { "id": "cadena única", "from": "id de nodo", "to": "id de nodo", "condition"?: "fail" }

Reglas:
- Un nodo start, un nodo end requeridos. Un nodo task requiere un prompt.
- Un bucle (una arista hacia atrás) solo vía una arista "fail" de una tarea — un ciclo vía cualquier otra arista se rechaza.
- El prompt de cada task entra en «una nueva sesión que solo ve ese nodo» — incrusta el contexto necesario (contenido del brief, etc.) directamente en el prompt (los resultados del nodo anterior se pasan automáticamente vía la carpeta Task, así que solo di "lee la carpeta de resultados del paso anterior").
- Unos 6±2 nodos — no sobre-dividas. Coordenadas fluyendo de arriba→abajo de forma ordenada (x 60~400, y espaciado 170).

## Salida
Escribe un «único objeto JSON» { "nodes": [...], "edges": [...] } en la siguiente ruta (no escribas en otro lugar):
{{outFile}}

Tras escribir el archivo, termina con una línea: «Diseño de workflow completo».`,
    fr: `Tu es l'agent PO de ce dépôt. Conçois un workflow multi-agents (DAG) pour implémenter le «brief d'opportunité approuvé» ci-dessous. Ne modifie pas le code — lis seulement le dépôt pour comprendre les méthodes de vérification, et la sortie est un unique JSON de définition de workflow.

## Brief
- title: {{title}}
- problem: {{problem}}
- scope: {{scope}}
- spec:
{{spec}}

{{designContext}}

## Le squelette que le workflow doit suivre
«Confirmer le spec → implémenter → auto-vérifier → porte d'approbation humaine (commit) → fin». Concrétise ce squelette selon le brief:
- **Confirmer le spec**: confirme le spec du brief en un document de spec suivant les conventions de spec/docs de ce dépôt et sauvegarde-le (trouve et suis d'abord l'emplacement·format du dépôt, sinon un nouveau doc sous \`docs/\`).
- **Implémenter**: implémente selon ce spec. Si besoin, divise l'implémentation en 2 nœuds (p. ex. backend / frontend par couche·module). Si le brief touche l'UI, intègre le cœur des «Contraintes de design» ci-dessus (le sens des couleurs·l'ensemble de locales pris en charge·les états·l'accessibilité que ce dépôt a déclarés/découverts) «directement» dans le prompt du nœud d'implémentation — la session du nœud ne peut pas lire automatiquement le CLAUDE.md/AGENTS.md de ce dépôt.
- **Auto-vérifier**: utilise les moyens de vérification existants de ce dépôt tels quels — lis le \`.claude/\`/CLAUDE.md/AGENTS.md/scripts du dépôt et choisis ce qui correspond au type de changement du brief (p. ex. un changement d'UI → vérification UI/snapshot de cette stack, un changement backend/CLI → tests+build/type-check). Si le changement touche des chaînes visibles·la traduction (i18n), et que le dépôt a un moyen de lint/vérification de catalogue i18n, exécute-le pour faire émerger des candidats d'anti-motif «contournant la ressource/le catalogue» en «fichier:ligne», et vérifie d'abord les candidats «nouvellement introduits» par ce changement (diff) — cela capte les régressions de locale manquante que les snapshots/exécutions ne voient pas. N'invente pas une nouvelle méthode de vérification. Relie l'arête «fail» du nœud de vérification au nœud d'implémentation pour faire une boucle de nouvelle tentative.
- **Revue de designer (seulement pour les briefs qui touchent l'UI)**: si l'implémentation touche une «surface UI rendue», place un nœud de tâche «revue de designer» entre l'auto-vérification et la porte (le nœud «juste avant» la porte — pour que les findings circulent comme preuve d'entrée de la porte). Ce nœud rend/capture l'écran modifié avec les moyens de capture «existants» de ce dépôt (capture de simulateur/app·Storybook·navigateur headless web, etc.), critique la capture face au SSOT de design dans «Contraintes de design» ci-dessus «en regardant directement», et laisse dans result.md des findings qui attachent «quoi/où (coordonnées normalisées ou nom de token)» à chaque violation (confusion de sens de couleur·contraste·espacement·couleur par type). Pour atténuer le non-déterminisme, fais-le critiquer le même écran 2+ fois et ne rapporter que le «confirmé». Ce nœud est uniquement pour la «collecte de preuves», donc il n'édite pas le code et ne fait que passer à la porte («pas d'arête fail» — pas de blocage auto, l'humain le voit à la décision). Si le brief n'a pas de surface rendue (p. ex. changements de texte seulement), ne place pas ce nœud.
- **Porte d'approbation humaine**: juste avant la fin, un nœud de tâche \`requires_approval: true\` — si l'utilisateur approuve, la session de ce nœud «fait seulement le commit». Ne fusionne pas la branche de travail directement dans la branche de base (pas de git merge·push) — la ré-intégration est gérée par la file de merge du daemon en série après l'approbation de la porte+commit (avec détection préalable de conflits·nettoyage post-merge). Il ne doit y avoir aucun chemin qui procède sans porte. Pour un brief d'UI, fais aussi lire au prompt de la porte les findings de la «revue de designer» et noter les régressions non résolues dans le résumé du commit.

## Schéma de définition (exactement ce format)
Nœud (NodeDef): { "id": "chaîne unique", "type": "start" | "task" | "end", "title": "une ligne", "prompt": "requis pour task — l'instruction complète envoyée à la session de ce nœud", "agent"?: l'un de {{agentIds}} (par défaut {{defaultAgent}} si omis), "requires_approval"?: true (porte seulement), "x": nombre, "y": nombre }
Arête (EdgeDef): { "id": "chaîne unique", "from": "id de nœud", "to": "id de nœud", "condition"?: "fail" }

Règles:
- Un nœud start, un nœud end requis. Un nœud task requiert un prompt.
- Une boucle (une arête en arrière) seulement via une arête "fail" d'une tâche — un cycle via toute autre arête est rejeté.
- Le prompt de chaque task entre dans «une nouvelle session qui ne voit que ce nœud» — intègre le contexte nécessaire (contenu du brief, etc.) directement dans le prompt (les résultats du nœud précédent sont auto-transmis via le dossier Task, donc dis juste "lis le dossier de résultats de l'étape précédente").
- Environ 6±2 nœuds — ne sur-découpe pas. Coordonnées circulant de haut→bas joliment (x 60~400, y espacement 170).

## Sortie
Écris un «objet JSON unique» { "nodes": [...], "edges": [...] } au chemin suivant (n'écris pas ailleurs):
{{outFile}}

Après avoir écrit le fichier, termine par une ligne: «Conception du workflow terminée».`,
    hi: `आप इस रिपॉज़िटरी के PO एजेंट हैं। नीचे दिए «स्वीकृत अवसर-ब्रीफ़» को लागू करने हेतु एक मल्टी-एजेंट वर्कफ़्लो (DAG) डिज़ाइन करें। कोड न बदलें — केवल सत्यापन विधियाँ समझने हेतु रेपो पढ़ें, और आउटपुट एक एकल वर्कफ़्लो-परिभाषा JSON है।

## ब्रीफ़
- title: {{title}}
- problem: {{problem}}
- scope: {{scope}}
- spec:
{{spec}}

{{designContext}}

## वर्कफ़्लो जिस ढाँचे का पालन करे
«स्पेक तय करें → लागू करें → स्व-सत्यापन → मानव अनुमोदन गेट (commit) → समाप्ति»। इस ढाँचे को ब्रीफ़ के अनुसार मूर्त करें:
- **स्पेक तय करें**: ब्रीफ़ के spec को इस रेपो की स्पेक/दस्तावेज़ परंपरा अनुसार एक स्पेक दस्तावेज़ के रूप में तय कर सहेजें (पहले रेपो का स्थान·प्रारूप खोजकर अपनाएँ, अन्यथा \`docs/\` के अंतर्गत नया दस्तावेज़)।
- **लागू करें**: उस spec अनुसार लागू करें। आवश्यक हो तो कार्यान्वयन को 2 नोड में बाँटें (जैसे परत·मॉड्यूल अनुसार बैकएंड / फ्रंटएंड)। यदि ब्रीफ़ UI को छूता है तो ऊपर «डिज़ाइन प्रतिबंध» का सार (इस रेपो द्वारा घोषित/खोजा रंग अर्थ·समर्थित लोकेल समुच्चय·स्थिति·एक्सेसिबिलिटी) को कार्यान्वयन नोड के prompt में «सीधे» शामिल करें — नोड सत्र उस रेपो का CLAUDE.md/AGENTS.md स्वतः नहीं पढ़ सकता।
- **स्व-सत्यापन**: इस रेपो के मौजूदा सत्यापन साधन ज्यों के त्यों उपयोग करें — रेपो का \`.claude/\`/CLAUDE.md/AGENTS.md/scripts पढ़ें और ब्रीफ़ परिवर्तन प्रकार के अनुकूल चुनें (जैसे: UI परिवर्तन → उस स्टैक का UI/snapshot सत्यापन, बैकएंड/CLI परिवर्तन → टेस्ट+build/type-check)। यदि परिवर्तन दिखने वाले स्ट्रिंग्स·अनुवाद (i18n) को छूता है, और रेपो में i18n lint/कैटलॉग-जाँच साधन हो तो उसे चलाकर «संसाधन/कैटलॉग बायपास करने वाले» एंटी-पैटर्न उम्मीदवारों को «फ़ाइल:लाइन» के रूप में सामने लाएँ, और इस परिवर्तन (diff) द्वारा «नए लाए गए» उम्मीदवारों को पहले जाँचें — यह snapshot/run से न दिखने वाले लुप्त-लोकेल रिग्रेशन को पकड़ता है। नया सत्यापन तरीका न गढ़ें। सत्यापन नोड की «fail» एज को कार्यान्वयन नोड से जोड़कर पुनः-प्रयास लूप बनाएँ।
- **डिज़ाइनर समीक्षा (केवल UI को छूने वाले ब्रीफ़)**: यदि कार्यान्वयन «रेंडर होने वाली UI सतह» को छूता है, तो स्व-सत्यापन और गेट के बीच एक «डिज़ाइनर समीक्षा» टास्क नोड रखें (गेट से «ठीक पहले» का नोड — ताकि findings गेट के इनपुट साक्ष्य के रूप में बहें)। वह नोड इस रेपो के «मौजूदा» कैप्चर साधन (सिम्युलेटर/ऐप स्क्रीनशॉट·Storybook·वेब headless आदि) से बदली स्क्रीन रेंडर/कैप्चर करता है, स्क्रीनशॉट को ऊपर «डिज़ाइन प्रतिबंध» के डिज़ाइन SSOT के विरुद्ध «सीधे देखकर» समीक्षा करता है, और result.md में प्रत्येक उल्लंघन (रंग-अर्थ भ्रम·कंट्रास्ट·स्पेसिंग·प्रकार रंग) पर «क्या/कहाँ (सामान्यीकृत निर्देशांक या टोकन नाम)» संलग्न findings छोड़ता है। अनिश्चितता शमन हेतु उसी स्क्रीन की 2+ बार समीक्षा कराएँ और केवल «confirmed» रिपोर्ट कराएँ। यह नोड केवल «साक्ष्य संग्रह» हेतु है, अतः कोड नहीं बदलता और केवल गेट तक पास करता है («कोई fail एज नहीं» — स्वतः अवरोध नहीं, मानव निर्णय के समय देखता है)। यदि ब्रीफ़ में रेंडर सतह न हो (जैसे केवल टेक्स्ट परिवर्तन), तो यह नोड न रखें।
- **मानव अनुमोदन गेट**: समाप्ति से ठीक पहले एक \`requires_approval: true\` टास्क नोड — यदि उपयोगकर्ता अनुमोदित करे, तो उस नोड का सत्र परिवर्तन को «केवल commit तक» करता है। कार्य ब्रांच को बेस ब्रांच में सीधे मर्ज न करें (git merge·push नहीं) — पुनः-एकीकरण daemon की मर्ज क्यू गेट अनुमोदन+commit के बाद क्रमिक रूप से (पूर्व-टकराव पहचान·मर्ज-पश्चात सफ़ाई सहित) संभालती है। ऐसा कोई पथ न हो जो बिना गेट आगे बढ़े। UI ब्रीफ़ हेतु, गेट prompt से «डिज़ाइनर समीक्षा» findings भी पढ़वाएँ और commit सारांश में अनसुलझे रिग्रेशन नोट कराएँ।

## परिभाषा स्कीमा (बिल्कुल इसी प्रारूप में)
नोड (NodeDef): { "id": "अद्वितीय स्ट्रिंग", "type": "start" | "task" | "end", "title": "एक पंक्ति", "prompt": "task हेतु आवश्यक — इस नोड के सत्र को भेजा पूर्ण निर्देश", "agent"?: {{agentIds}} में से एक (छोड़ने पर {{defaultAgent}}), "requires_approval"?: true (केवल गेट), "x": संख्या, "y": संख्या }
एज (EdgeDef): { "id": "अद्वितीय स्ट्रिंग", "from": "नोड id", "to": "नोड id", "condition"?: "fail" }

नियम:
- एक start नोड, एक end नोड आवश्यक। task नोड को prompt आवश्यक।
- लूप (पीछे जाने वाली एज) केवल किसी task की "fail" एज से — अन्य किसी एज से चक्र अस्वीकृत।
- प्रत्येक task का prompt «एक नए सत्र में जाता है जो केवल उस नोड को देखता है» — आवश्यक संदर्भ (ब्रीफ़ सामग्री आदि) prompt में सीधे शामिल करें (पिछले नोड के परिणाम Task फ़ोल्डर से स्वतः पास होते हैं, अतः बस कहें "पिछले चरण का परिणाम फ़ोल्डर पढ़ें")।
- नोड लगभग 6±2 — अत्यधिक न बाँटें। निर्देशांक ऊपर→नीचे प्रवाह में सुंदर ढंग से (x 60~400, y अंतराल 170)।

## आउटपुट
निम्न पथ पर «एकल JSON ऑब्जेक्ट» { "nodes": [...], "edges": [...] } लिखें (अन्यत्र न लिखें):
{{outFile}}

फ़ाइल लिखने के बाद एक पंक्ति «वर्कफ़्लो डिज़ाइन पूर्ण» से समाप्त करें।`,
    ja: `あなたはこのリポジトリの PO エージェントだ。下の「承認された機会ブリーフ」を実装するマルチエージェントのワークフロー(DAG)を設計せよ。コードを修正するな — 検証方法を把握するためにリポジトリを読むだけ、産出はワークフロー定義 JSON 一つだ。

## ブリーフ
- title: {{title}}
- problem: {{problem}}
- scope: {{scope}}
- spec:
{{spec}}

{{designContext}}

## ワークフローが従うべき骨格
「スペック確定 → 実装 → 自己検証 → 人の承認ゲート(commit) → 終了」。この骨格をブリーフに合わせて具体化せよ:
- **スペック確定**: ブリーフの spec を、このリポジトリのスペック/文書慣習に従うスペック文書として確定し保存する(まずリポジトリの場所·形式を見つけて従い、なければ \`docs/\` 下に新規文書)。
- **実装**: その spec どおり実装。必要なら実装を2ノードに分けてよい(例: 層·モジュール別にバックエンド / フロントエンド)。ブリーフが UI に触れるなら、上の「デザイン制約」の核(このリポジトリが宣言/発見した色の意味·対応ロケール集合·状態·アクセシビリティ)を実装ノードの prompt に「直接」入れよ — ノードセッションはそのリポジトリの CLAUDE.md/AGENTS.md を自動で読めない。
- **自己検証**: このリポジトリの既存の検証手段をそのまま使え — リポジトリの \`.claude/\`/CLAUDE.md/AGENTS.md/scripts を読み、ブリーフの変更種別に合うものを選べ(例: UI 変更 → そのスタックの UI/スナップショット検証、バックエンド/CLI 変更 → テスト+ビルド/型チェック)。変更が表示文字列·翻訳(i18n)に触れ、リポジトリに i18n lint/カタログ点検手段があれば実行し、「リソース/カタログを迂回する」アンチパターン候補を「ファイル:行」で表面化し、この変更(diff)が「新たに持ち込んだ」候補を優先確認せよ — スナップショット/実行では見えない欠落ロケール回帰を捉える。新しい検証方式を発明するな。検証ノードの「fail」エッジを実装ノードへ戻して再試行ループを作れ。
- **デザイナーレビュー(UI に触れるブリーフのみ)**: 実装が「レンダリングされる UI 表面」に触れるなら、自己検証とゲートの間に「デザイナーレビュー」タスクノードを1つ置け(ゲートの「直前」ノード — そうすれば findings がゲートの入力証拠として流れる)。そのノードはこのリポジトリの「既存」キャプチャ手段(シミュレーター/アプリスクリーンショット·Storybook·ウェブヘッドレス等)で変更画面をレンダリング/キャプチャし、スクリーンショットを上の「デザイン制約」のデザイン SSOT に照らして「直接見て」批評し、各違反(色の意味の混同·コントラスト·余白·種類色)に「何が/どこで(正規化座標またはトークン名)」を付した findings を result.md に残す。非決定性緩和のため同じ画面を2回以上批評し「確定」のみ報告させよ。このノードは「証拠収集」専用なのでコードを直さずゲートへ通すだけ(「fail エッジなし」 — 自動ブロックではなく、人が判断時に見る)。ブリーフにレンダリング表面がない(例: テキストのみの変更)なら、このノードを置くな。
- **人の承認ゲート**: 終了直前に \`requires_approval: true\` のタスクノード1つ — ユーザーが承認したら、そのノードのセッションが変更を「commit までだけ」行う。作業ブランチをベースブランチに直接マージするな(git merge·push しない) — 再統合はゲート承認+commit 後に daemon のマージキューが直列で(事前衝突検出·マージ後クリーンアップ込みで)担う。ゲートなしで進む経路があってはならない。UI ブリーフなら、ゲートの prompt にも「デザイナーレビュー」の findings を読ませ、未解決の回帰を commit 要約に記させよ。

## 定義スキーマ(この形式どおり)
ノード(NodeDef): { "id": "一意の文字列", "type": "start" | "task" | "end", "title": "一行", "prompt": "task は必須 — このノードのセッションに送る全指示", "agent"?: {{agentIds}} のいずれか(省略時 {{defaultAgent}}), "requires_approval"?: true(ゲートのみ), "x": 数値, "y": 数値 }
エッジ(EdgeDef): { "id": "一意の文字列", "from": "ノード id", "to": "ノード id", "condition"?: "fail" }

規則:
- start ノード1つ、end ノード1つ必須。task ノードは prompt 必須。
- ループ(後ろ向きエッジ)は task の "fail" エッジでのみ — それ以外のエッジで循環を作ると拒否される。
- 各 task の prompt は「そのノードだけを見る新しいセッション」に入る — 必要な文脈(ブリーフ内容など)を prompt に直接入れよ(前ノードの結果は Task フォルダで自動的に渡されるので「前段階の結果フォルダを読め」と言えばよい)。
- ノードは 6±2 程度 — 過度に分割するな。座標は上→下の流れで見やすく(x 60~400、y 間隔 170)。

## 産出
次のパスに「単一の JSON オブジェクト」{ "nodes": [...], "edges": [...] } を書け(他の場所に書くな):
{{outFile}}

ファイルを書いたら「ワークフロー設計完了」の一行で終えよ。`,
    ko: `너는 이 저장소의 PO 에이전트다. 아래 «승인된 기회 브리프» 를 구현할 멀티 에이전트 워크플로우(DAG)를 설계하라. 코드를 수정하지 마라 — 레포를 읽어 검증 방법을 파악하는 조사만 하고, 산출은 워크플로우 정의 JSON 하나다.

## 브리프
- title: {{title}}
- problem: {{problem}}
- scope: {{scope}}
- spec:
{{spec}}

{{designContext}}

## 워크플로우가 따라야 할 골격
«스펙 확정 → 구현 → 자가 검증 → 사람 승인 게이트(커밋) → 종료». 이 골격을 브리프에 맞게 구체화하라:
- **스펙 확정**: 브리프 spec 을 이 레포의 스펙/문서 컨벤션을 따르는 스펙 문서로 확정해 저장 (레포가 쓰는 위치·형식을 먼저 찾아 따르고, 없으면 \`docs/\` 아래 새 문서로).
- **구현**: 그 스펙대로 구현. 필요하면 구현을 2개 노드로 나눠도 된다 (예: 백엔드 / 프런트엔드처럼 계층·모듈별로). UI 가 닿는 브리프면 위 「디자인 제약」 의 핵심(이 레포가 선언/발견한 색 의미·지원 로케일 집합·상태·접근성)을 구현 노드 prompt 에 «직접» 담아라 — 노드 세션은 그 레포의 CLAUDE.md/AGENTS.md 를 자동으로 읽지 못한다.
- **자가 검증**: 이 레포의 기존 검증 수단을 그대로 쓰라 — 레포의 \`.claude/\`/CLAUDE.md/AGENTS.md/scripts 를 읽고 브리프 변경 종류에 맞는 것을 고른다 (예: UI 변경이면 그 스택의 UI/스냅샷 검증, 백엔드/CLI 변경이면 테스트+빌드/타입체크). 노출 문자열·번역(i18n)이 닿는 변경이면, 레포에 i18n 린트/카탈로그 점검 수단이 있으면 돌려 «리소스/카탈로그를 우회하는» 안티패턴 후보를 «파일:라인» 으로 표면화하고, 이 변경(diff)이 «새로 들인» 후보를 우선 확인하라 — 스냅샷/실행으론 못 보는 누락 로케일 회귀를 잡는다. 새 검증 방식을 발명하지 마라. 검증 노드의 «실패» 간선을 구현 노드로 이어 재시도 루프를 만들어라.
- **디자이너 리뷰 (UI 가 닿는 브리프만)**: 구현이 «렌더되는 UI 표면» 에 닿으면, 자가 검증과 게이트 사이에 «디자이너 리뷰» 작업 노드 1개를 둬라 (게이트의 «직전» 노드 — 그래야 findings 가 게이트의 입력 evidence 로 흘러간다). 그 노드는 이 레포의 «기존» 캡처 수단(시뮬레이터/앱 스크린샷·Storybook·웹 헤드리스 등)으로 변경 화면을 렌더·캡처하고, 스크린샷을 위 「디자인 제약」 의 디자인 SSOT 대비 «직접 보고» 비평해 위반(색 의미 혼동·대비·간격·종류색)마다 «무엇이/어디서(정규화 좌표 또는 토큰명)» 를 단 findings 를 result.md 로 남긴다. 비결정성 완화로 같은 화면을 2회 이상 비평해 일치한 것만 «확정» 보고하게 하라. 이 노드는 «증거 수집» 전용이라 코드를 고치지 않고 게이트로 통과만 한다(«실패» 간선 없음 — 자동 차단이 아니라 사람이 결재 때 본다). 텍스트만 바뀌는 등 렌더 표면이 없는 브리프면 이 노드를 두지 마라.
- **사람 승인 게이트**: 종료 직전에 \`requires_approval: true\` 작업 노드 1개 — 사용자가 승인하면 그 노드의 세션이 변경을 «커밋까지만» 한다. 작업 브랜치를 기본 브랜치로 직접 합치지(git merge·push) 마라 — 재결합은 daemon 의 머지 큐가 게이트 승인+커밋 후 직렬로(충돌 사전탐지·머지 후 정리 포함) 담당한다. 게이트 없이 진행되는 경로가 있으면 안 된다. UI 브리프면 게이트 prompt 가 «디자이너 리뷰» findings 를 함께 읽어 커밋 요약에 미해결 회귀를 적게 하라.

## 정의 스키마 (이 형식 그대로)
노드(NodeDef): { "id": "고유 문자열", "type": "start" | "task" | "end", "title": "한 줄", "prompt": "task 필수 — 이 노드 세션에 보낼 전체 지시", "agent"?: {{agentIds}} 중 하나 (생략 시 {{defaultAgent}}), "requires_approval"?: true (게이트만), "x": 숫자, "y": 숫자 }
간선(EdgeDef): { "id": "고유 문자열", "from": "노드 id", "to": "노드 id", "condition"?: "fail" }

규칙:
- start 노드 1개, end 노드 1개 필수. task 노드는 prompt 필수.
- 루프(뒤로 가는 간선)는 작업의 "fail" 간선으로만 — 그 외 간선으로 순환을 만들면 거부된다.
- 각 task 의 prompt 는 «그 노드만 보는 새 세션» 에 들어간다 — 브리프 내용 등 필요한 컨텍스트를 prompt 안에 직접 담아라 (이전 노드 결과는 Task 폴더로 자동 전달되니 "이전 단계 결과 폴더를 읽어라" 라고 지시하면 된다).
- 노드는 6±2개 정도로 — 과도하게 쪼개지 마라. 좌표는 위→아래 흐름으로 보기 좋게 (x 60~400, y 60 간격 170).

## 산출
다음 경로에 JSON «단일 객체» { "nodes": [...], "edges": [...] } 를 써라 (다른 곳에 쓰지 마라):
{{outFile}}

파일을 쓴 뒤 «워크플로우 설계 완료» 한 줄로 끝내라.`,
    "pt-BR": `Você é o agente PO deste repositório. Projete um workflow multiagente (DAG) para implementar o «brief de oportunidade aprovado» abaixo. Não modifique código — apenas leia o repo para entender os métodos de verificação, e a saída é um único JSON de definição de workflow.

## Brief
- title: {{title}}
- problem: {{problem}}
- scope: {{scope}}
- spec:
{{spec}}

{{designContext}}

## O esqueleto que o workflow deve seguir
«Confirmar spec → implementar → autoverificar → portão de aprovação humana (commit) → fim». Concretize este esqueleto conforme o brief:
- **Confirmar spec**: confirme o spec do brief como um documento de spec seguindo as convenções de spec/docs deste repo e salve-o (primeiro encontre e siga a localização·formato do repo, senão um novo doc sob \`docs/\`).
- **Implementar**: implemente conforme esse spec. Se necessário, divida a implementação em 2 nós (ex.: backend / frontend por camada·módulo). Se o brief tocar a UI, incorpore o núcleo das «Restrições de design» acima (o significado da cor·conjunto de localidades suportadas·estados·acessibilidade que este repo declarou/descobriu) «diretamente» no prompt do nó de implementação — a sessão do nó não pode ler automaticamente o CLAUDE.md/AGENTS.md desse repo.
- **Autoverificar**: use os meios de verificação existentes deste repo como estão — leia o \`.claude/\`/CLAUDE.md/AGENTS.md/scripts do repo e escolha o que se ajusta ao tipo de mudança do brief (ex.: uma mudança de UI → verificação UI/snapshot dessa stack, uma mudança de backend/CLI → testes+build/type-check). Se a mudança tocar strings visíveis·tradução (i18n), e o repo tiver um meio de lint/checagem de catálogo i18n, execute-o para trazer à tona candidatos de anti-padrão «que ignoram o recurso/catálogo» como «arquivo:linha», e verifique primeiro os candidatos «recém-introduzidos» por esta mudança (diff) — isso captura regressões de localidade ausente que snapshots/execuções não veem. Não invente um novo método de verificação. Conecte a aresta «fail» do nó de verificação de volta ao nó de implementação para fazer um loop de nova tentativa.
- **Revisão de designer (apenas para briefs que tocam a UI)**: se a implementação tocar uma «superfície de UI renderizada», coloque um nó de tarefa «revisão de designer» entre a autoverificação e o portão (o nó «logo antes» do portão — para que os findings fluam como evidência de entrada do portão). Esse nó renderiza/captura a tela alterada com os meios de captura «existentes» deste repo (captura de simulador/app·Storybook·navegador headless web, etc.), critica a captura frente ao SSOT de design em «Restrições de design» acima «olhando diretamente», e deixa em result.md findings que anexam «o quê/onde (coordenadas normalizadas ou nome de token)» a cada violação (confusão de significado de cor·contraste·espaçamento·cor por tipo). Para mitigar o não determinismo, faça-o criticar a mesma tela 2+ vezes e reportar apenas o «confirmado». Este nó é apenas para «coleta de evidências», então não edita código e apenas passa ao portão («sem aresta fail» — não bloqueia automaticamente, o humano vê na decisão). Se o brief não tiver superfície renderizada (ex.: mudanças só de texto), não coloque este nó.
- **Portão de aprovação humana**: logo antes do fim, um nó de tarefa \`requires_approval: true\` — se o usuário aprovar, a sessão desse nó «apenas faz commit». Não mescle a branch de trabalho diretamente na branch base (sem git merge·push) — a reintegração é feita pela fila de merge do daemon em série após a aprovação do portão+commit (com detecção prévia de conflitos·limpeza pós-merge). Não deve haver nenhum caminho que prossiga sem um portão. Para um brief de UI, faça o prompt do portão também ler os findings da «revisão de designer» e anotar regressões não resolvidas no resumo do commit.

## Esquema de definição (exatamente este formato)
Nó (NodeDef): { "id": "string única", "type": "start" | "task" | "end", "title": "uma linha", "prompt": "obrigatório para task — a instrução completa enviada à sessão deste nó", "agent"?: um de {{agentIds}} (padrão {{defaultAgent}} se omitido), "requires_approval"?: true (apenas portão), "x": número, "y": número }
Aresta (EdgeDef): { "id": "string única", "from": "id do nó", "to": "id do nó", "condition"?: "fail" }

Regras:
- Um nó start, um nó end obrigatórios. Um nó task requer um prompt.
- Um loop (uma aresta para trás) apenas via aresta "fail" de uma tarefa — um ciclo via qualquer outra aresta é rejeitado.
- O prompt de cada task entra em «uma nova sessão que vê apenas aquele nó» — incorpore o contexto necessário (conteúdo do brief, etc.) diretamente no prompt (os resultados do nó anterior são passados automaticamente via pasta Task, então apenas diga "leia a pasta de resultados do passo anterior").
- Cerca de 6±2 nós — não divida demais. Coordenadas fluindo de cima→baixo de forma agradável (x 60~400, y espaçamento 170).

## Saída
Escreva um «único objeto JSON» { "nodes": [...], "edges": [...] } no seguinte caminho (não escreva em outro lugar):
{{outFile}}

Após escrever o arquivo, termine com uma linha: «Design do workflow concluído».`,
    ru: `Ты — агент PO этого репозитория. Спроектируй мультиагентный workflow (DAG) для реализации «одобренного брифа возможности» ниже. Не изменяй код — только читай репозиторий, чтобы понять методы проверки, и вывод — единый JSON определения workflow.

## Бриф
- title: {{title}}
- problem: {{problem}}
- scope: {{scope}}
- spec:
{{spec}}

{{designContext}}

## Скелет, которому должен следовать workflow
«Подтвердить spec → реализовать → самопроверка → ворота одобрения человеком (commit) → завершение». Конкретизируй этот скелет под бриф:
- **Подтвердить spec**: подтверди spec брифа как документ спецификации, следуя соглашениям spec/docs этого репозитория, и сохрани его (сначала найди и следуй расположению·формату репозитория, иначе новый документ в \`docs/\`).
- **Реализовать**: реализуй согласно этому spec. При необходимости раздели реализацию на 2 узла (напр., бэкенд / фронтенд по слою·модулю). Если бриф касается UI, встрой ядро «Ограничений дизайна» выше (смысл цвета·набор поддерживаемых локалей·состояния·доступность, которые этот репозиторий объявил/обнаружил) «напрямую» в prompt узла реализации — сессия узла не может автоматически читать CLAUDE.md/AGENTS.md этого репозитория.
- **Самопроверка**: используй существующие средства проверки этого репозитория как есть — прочитай \`.claude/\`/CLAUDE.md/AGENTS.md/scripts репозитория и выбери подходящее под вид изменения брифа (напр., изменение UI → проверка UI/снапшотов этого стека, изменение бэкенда/CLI → тесты+сборка/проверка типов). Если изменение касается видимых строк·перевода (i18n) и в репозитории есть средство i18n-линта/проверки каталога, запусти его, чтобы выявить кандидатов антипаттерна «в обход ресурса/каталога» как «файл:строка», и сначала проверь «вновь внесённых» этим изменением (diff) кандидатов — это ловит регрессии пропущенной локали, которые не видят снапшоты/запуски. Не изобретай новый метод проверки. Подключи ребро «fail» узла проверки обратно к узлу реализации, чтобы сделать цикл повтора.
- **Ревью дизайнера (только для брифов, касающихся UI)**: если реализация касается «отрисовываемой поверхности UI», помести один узел задачи «ревью дизайнера» между самопроверкой и воротами (узел «прямо перед» воротами — чтобы findings текли как входное доказательство ворот). Этот узел отрисовывает/захватывает изменённый экран средствами захвата «существующими» в этом репозитории (скриншот симулятора/приложения·Storybook·веб headless и т. п.), критикует скриншот относительно дизайн-SSOT в «Ограничениях дизайна» выше «глядя напрямую» и оставляет в result.md findings, прикрепляющие «что/где (нормализованные координаты или имя токена)» к каждому нарушению (путаница смысла цвета·контраст·отступы·цвет по типу). Для смягчения недетерминизма заставь критиковать тот же экран 2+ раза и сообщать только «подтверждённое». Этот узел только для «сбора доказательств», поэтому не редактирует код и лишь проходит к воротам («без ребра fail» — не авто-блокировка, человек видит при решении). Если у брифа нет отрисовываемой поверхности (напр., только текстовые изменения), не помещай этот узел.
- **Ворота одобрения человеком**: прямо перед завершением один узел задачи \`requires_approval: true\` — если пользователь одобряет, сессия этого узла «только делает commit». Не сливай рабочую ветку напрямую в базовую (без git merge·push) — повторную интеграцию выполняет очередь слияния daemon последовательно после одобрения ворот+commit (с предварительным обнаружением конфликтов·очисткой после слияния). Не должно быть пути, идущего без ворот. Для UI-брифа пусть prompt ворот также читает findings «ревью дизайнера» и отмечает нерешённые регрессии в сводке коммита.

## Схема определения (точно этот формат)
Узел (NodeDef): { "id": "уникальная строка", "type": "start" | "task" | "end", "title": "одна строка", "prompt": "обязательно для task — полная инструкция, отправляемая сессии этого узла", "agent"?: один из {{agentIds}} (по умолчанию {{defaultAgent}} при пропуске), "requires_approval"?: true (только ворота), "x": число, "y": число }
Ребро (EdgeDef): { "id": "уникальная строка", "from": "id узла", "to": "id узла", "condition"?: "fail" }

Правила:
- Один узел start, один узел end обязательны. Узел task требует prompt.
- Цикл (ребро назад) только через ребро "fail" задачи — цикл через любое другое ребро отклоняется.
- prompt каждой task попадает в «новую сессию, видящую только этот узел» — встрой нужный контекст (содержимое брифа и т. п.) прямо в prompt (результаты предыдущего узла передаются автоматически через папку Task, поэтому просто скажи "прочитай папку результатов предыдущего шага").
- Около 6±2 узлов — не дроби чрезмерно. Координаты, текущие сверху→вниз аккуратно (x 60~400, y интервал 170).

## Вывод
Запиши «единый объект JSON» { "nodes": [...], "edges": [...] } по следующему пути (не пиши в другое место):
{{outFile}}

После записи файла закончи одной строкой: «Проектирование workflow завершено».`,
    "zh-Hans": `你是本仓库的 PO 智能体。为实现下方「已批准的机会简报」设计一个多智能体工作流(DAG)。不要修改代码——只读取仓库以了解验证方法,产出是单个工作流定义 JSON。

## 简报
- title: {{title}}
- problem: {{problem}}
- scope: {{scope}}
- spec:
{{spec}}

{{designContext}}

## 工作流须遵循的骨架
「确定 spec → 实现 → 自我验证 → 人工审批门(commit) → 结束」。将此骨架按简报具体化:
- **确定 spec**: 将简报的 spec 确定为遵循本仓库 spec/文档惯例的规格文档并保存(先找出并遵循仓库的位置·格式,否则在 \`docs/\` 下新建文档)。
- **实现**: 按该 spec 实现。必要时可将实现拆为 2 个节点(如按层·模块分后端 / 前端)。若简报触及 UI,将上方「设计约束」的核心(本仓库声明/发现的颜色含义·支持的语言环境集合·状态·无障碍)「直接」放入实现节点的 prompt——节点会话无法自动读取该仓库的 CLAUDE.md/AGENTS.md。
- **自我验证**: 原样使用本仓库既有的验证手段——阅读仓库的 \`.claude/\`/CLAUDE.md/AGENTS.md/scripts,选择适合简报变更类型者(如:UI 变更 → 该技术栈的 UI/快照验证,后端/CLI 变更 → 测试+构建/类型检查)。若变更触及可见字符串·翻译(i18n),且仓库有 i18n lint/目录检查手段,则运行它以「文件:行」暴露「绕过资源/目录」的反模式候选,并优先检查本次变更(diff)「新引入」的候选——这能捕捉快照/运行看不到的缺失语言环境回归。不要发明新的验证方式。将验证节点的「fail」边连回实现节点以形成重试循环。
- **设计师评审(仅限触及 UI 的简报)**: 若实现触及「可渲染的 UI 表面」,在自我验证与门之间放置一个「设计师评审」任务节点(门的「紧前」节点——以便 findings 作为门的输入证据流转)。该节点用本仓库「既有」的截图手段(模拟器/应用截图·Storybook·网页无头等)渲染/截取变更画面,对照上方「设计约束」的设计 SSOT「直接查看」评审截图,并在 result.md 中为每个违规(颜色含义混淆·对比度·间距·类型色)附上「什么/在哪(归一化坐标或令牌名)」的 findings。为缓解非确定性,让其对同一画面评审 2 次以上并仅报告「confirmed」。该节点仅用于「证据收集」,故不修改代码,只通过至门(「无 fail 边」——并非自动阻断,人在决策时查看)。若简报没有可渲染表面(如仅文本变更),则不放置此节点。
- **人工审批门**: 在结束前放置一个 \`requires_approval: true\` 的任务节点——若用户批准,该节点的会话「仅 commit」变更。不要将工作分支直接合并入基分支(不要 git merge·push)——重新合并由 daemon 的合并队列在门批准+commit 后串行处理(含预冲突检测·合并后清理)。不得存在绕过门的路径。对于 UI 简报,让门的 prompt 也读取「设计师评审」的 findings,并在 commit 摘要中注明未解决的回归。

## 定义 schema(严格按此格式)
节点(NodeDef): { "id": "唯一字符串", "type": "start" | "task" | "end", "title": "一行", "prompt": "task 必填——发送给该节点会话的完整指令", "agent"?: {{agentIds}} 之一(省略时为 {{defaultAgent}}), "requires_approval"?: true(仅门), "x": 数字, "y": 数字 }
边(EdgeDef): { "id": "唯一字符串", "from": "节点 id", "to": "节点 id", "condition"?: "fail" }

规则:
- 必须有 1 个 start 节点、1 个 end 节点。task 节点必须有 prompt。
- 循环(向后的边)仅可经由某 task 的 "fail" 边——经由其他任何边形成的环将被拒绝。
- 每个 task 的 prompt 进入「只看到该节点的新会话」——将所需上下文(简报内容等)直接放入 prompt(上一节点的结果会经 Task 文件夹自动传递,故只需说"读取上一步的结果文件夹")。
- 节点约 6±2 个——不要过度拆分。坐标按上→下流向排布美观(x 60~400,y 间距 170)。

## 产出
将「单个 JSON 对象」{ "nodes": [...], "edges": [...] } 写入以下路径(不要写到别处):
{{outFile}}

写完文件后以一行「工作流设计完成」结束。`,
  },
} satisfies Record<string, Msg>;
