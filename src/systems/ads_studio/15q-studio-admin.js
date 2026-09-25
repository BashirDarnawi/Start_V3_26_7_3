// ==========================================
// ALBAYAN STUDIO v2 — ADMIN TOOLS (plan tasks P3-16, P3-19, P3-21, P0-10 report, M12 "More"; studio-staff.js lazy bundle)
// ==========================================
// The More section of the Team desk (15p renderStudioDeskMore -> renderStudioAdminMore), admin only:
// - payments waiting for confirmation (the classic rows and decisions of 15c, with the waiting time
//   against the payment target);
// - the alerts list (GET /api/studio/admin/alerts, the server's bilingual labels, paged) with the
//   jobs heartbeat;
// - the diagnostics summary (GET /api/studio/admin/diagnostics): queues met %, capacity, USD owed to
//   customers against the studio funds, the go/no-go rows, the heartbeat, the token and storage;
// - the collision report (GET /api/meta-ads/collisions): counts and rows with why each row is kept
//   or removable. No apply button: the owner runs scripts/studio_collision_repair.py;
// - one form per admin setting (GET/PUT /api/studio/admin/settings/{key}) with expectedVersion, an
//   explanation line per setting and field, the server's validation message when it refuses a
//   value, and a reload flow on 409 (someone saved first, or the desk cannot go off while in use).
// Sub-pages live on &id= (payments, alerts, diagnostics, collisions, settings-<key>), so Back
// returns to the More menu. Every server string is escaped; every input keeps a stable id.

const STUDIO_ADMIN_TTL_MS = 60 * 1000;
const STUDIO_ADMIN_RETRY_MS = 30 * 1000;
const STUDIO_ADMIN_MODES = Object.freeze(['off', 'pilot', 'on']);
const STUDIO_ADMIN_CAPABILITY_STATES = Object.freeze(['on', 'gated', 'off', 'unavailable']);
const STUDIO_ADMIN_WEEK = Object.freeze([['sun', 'Sunday', 'الأحد'], ['mon', 'Monday', 'الاثنين'], ['tue', 'Tuesday', 'الثلاثاء'], ['wed', 'Wednesday', 'الأربعاء'], ['thu', 'Thursday', 'الخميس'], ['fri', 'Friday', 'الجمعة'], ['sat', 'Saturday', 'السبت']]);
const STUDIO_ADMIN_SETTING_KEYS = Object.freeze(['rollout', 'intake', 'capabilities', 'limits', 'settlement', 'hours', 'contact', 'targets', 'thresholds']);
// [id, icon, English, Arabic, what it is for (EN), (AR)]
const STUDIO_ADMIN_PAGES = Object.freeze([
  ['payments', 'landmark', 'Payments waiting', 'مدفوعات بانتظار التأكيد', "Confirm or cancel the customers' top-up requests.", 'أكّد طلبات شحن العملاء أو ألغِها.'],
  ['alerts', 'bell-ring', 'Alerts', 'التنبيهات', 'What the studio jobs and the Meta checks raised.', 'ما أثارته مهام الاستوديو وفحوص ميتا.'],
  ['diagnostics', 'activity', 'Diagnostics', 'التشخيص', 'Queues, capacity, money and the go/no-go rows.', 'الطوابير والسعة والأموال وصفوف القرار.'],
  ['collisions', 'git-merge', 'Collision report', 'تقرير التعارض', "Studio campaigns that appear in Albayan Manager's books.", 'حملات الاستوديو التي تظهر في دفاتر مدير البيان.'],
  ['settings-rollout', 'toggle-right', 'Rollout', 'الإطلاق التدريجي', 'The new layout, the services and this desk.', 'الواجهة الجديدة والخدمات وهذا المكتب.'],
  ['settings-intake', 'inbox', 'Intake', 'استقبال الطلبات', 'Pause new requests; the daily cap.', 'إيقاف الطلبات الجديدة مؤقتاً؛ الحد اليومي.'],
  ['settings-capabilities', 'message-circle-reply', 'Reply channels', 'قنوات الردود', 'The honest label of every reply channel.', 'التسمية الصادقة لكل قناة ردود.'],
  ['settings-limits', 'wallet-cards', 'Budget limits', 'حدود الميزانية', 'Smallest and largest request, per-day floor, most days.', 'أصغر طلب وأكبره، وحد اليوم الأدنى، وأقصى مدة.'],
  ['settings-settlement', 'scale', 'Settlement', 'التسوية', 'The wait after delivery ends and the drift watch.', 'مدة الانتظار بعد انتهاء العرض ومراقبة تغيّر الصرف.'],
  ['settings-hours', 'clock', 'Service hours', 'ساعات العمل', 'The week, holidays, Ramadan and the on-duty hour.', 'أيام الأسبوع والعطل ورمضان وساعة المناوبة.'],
  ['settings-contact', 'phone', 'Contact numbers', 'أرقام التواصل', 'What customers see on the login page and in Help.', 'ما يراه العملاء في صفحة الدخول وفي المساعدة.'],
  ['settings-targets', 'target', 'Service targets', 'أهداف الخدمة', 'How fast the team promises to act.', 'السرعة التي يَعِد بها الفريق.'],
  ['settings-thresholds', 'sliders-horizontal', 'Thresholds', 'العتبات', 'The go/no-go and stop-rule numbers.', 'أرقام قرار المتابعة وقواعد الإيقاف.']
]);
// The forms: field = [path, kind, [label EN, AR], [hint EN, AR], options or [min, max]].
const STUDIO_ADMIN_MODE_HINT = ['off = nobody; pilot = only the allowlist; on = everyone.', 'off = لا أحد؛ pilot = القائمة المسموحة فقط؛ on = الجميع.'];
const STUDIO_ADMIN_SETTINGS = Object.freeze({
  rollout: {
    about: ['Which customers see the new layout, which services are open and who uses this desk. A change applies at the next page load; services and the desk are independent of the layout.', 'من يرى واجهة العملاء الجديدة، وأي الخدمات مفتوحة، ومن يستخدم هذا المكتب. يسري التغيير عند تحميل الصفحة التالي؛ الخدمات والمكتب مستقلان عن الواجهة.'],
    fields: [
      ['ui', 'mode', ['Customer layout', 'واجهة العملاء'], STUDIO_ADMIN_MODE_HINT, STUDIO_ADMIN_MODES],
      ['uiAllowlist', 'ids', ['Customer allowlist (user ids, one per line)', 'القائمة المسموحة للعملاء (معرّفات المستخدمين، واحد في كل سطر)'], ['Read only while the layout is "pilot". At most 200 ids.', 'تُقرأ فقط عندما تكون الواجهة "pilot". 200 معرّف كحد أقصى.']],
      ['services.help', 'mode', ['Help tickets', 'تذاكر المساعدة'], ['Opens tickets in both layouts.', 'يفتح التذاكر في الواجهتين.'], STUDIO_ADMIN_MODES],
      ['services.stopRequest', 'mode', ['Ask to stop', 'طلب الإيقاف'], ['The urgent stop request on a running ad, in both layouts.', 'طلب الإيقاف العاجل لإعلان يعمل، في الواجهتين.'], STUDIO_ADMIN_MODES],
      ['services.tiktok', 'mode', ['TikTok service', 'خدمة تيك توك'], ['The managed TikTok help request.', 'طلب مساعدة تيك توك اليدوي.'], STUDIO_ADMIN_MODES],
      ['staffDesk', 'mode', ['Team desk', 'مكتب الفريق'], ['This desk for the team. It cannot go off while open tickets or stop requests exist.', 'هذا المكتب للفريق. لا يمكن إيقافه ما دامت هناك تذاكر أو طلبات إيقاف مفتوحة.'], STUDIO_ADMIN_MODES],
      ['staffAllowlist', 'ids', ['Staff allowlist (user ids, one per line)', 'القائمة المسموحة للفريق (معرّفات المستخدمين، واحد في كل سطر)'], ['Read only while the desk is "pilot".', 'تُقرأ فقط عندما يكون المكتب "pilot".']]
    ]
  },
  intake: {
    about: ['Whether customers may send new requests, and how many a day. Drafts always save; a paused intake refuses only the send.', 'هل يستطيع العملاء إرسال طلبات جديدة، وكم طلباً في اليوم. المسودات تُحفظ دائماً؛ الإيقاف يرفض الإرسال فقط.'],
    fields: [
      ['open', 'flag', ['New requests are accepted', 'الطلبات الجديدة مقبولة'], ['Off = "New ad requests are paused" at the send button.', 'متوقف = «استقبال طلبات الإعلانات الجديدة متوقف مؤقتاً» عند زر الإرسال.']],
      ['maxSubmissionsPerDay', 'whole', ['Most sends per day (Tripoli day)', 'أقصى عدد إرسالات في اليوم (بتوقيت طرابلس)'], ['The capacity cap of D29: from 1 to 500 (500 = no cap in practice).', 'حد السعة (D29): من 1 إلى 500 (500 = لا حد عملياً).'], [1, 500]]
    ]
  },
  capabilities: {
    about: ['The label each reply channel shows customers: on = working; poll = Instagram comments checked every 5 minutes; gated = waiting for Meta approval; off = hidden; unavailable = "not available now".', 'التسمية التي تعرضها كل قناة ردود للعملاء: on = تعمل؛ poll = تُفحص تعليقات إنستغرام كل 5 دقائق؛ gated = بانتظار موافقة ميتا؛ off = مخفية؛ unavailable = «غير متاح حالياً».'],
    fields: [
      ['fbPublicReply', 'select', ['Facebook public replies', 'ردود فيسبوك العامة'], ['On only after the delivery check passed and the page is subscribed.', 'تعمل فقط بعد نجاح فحص التسليم واشتراك الصفحة.'], STUDIO_ADMIN_CAPABILITY_STATES],
      ['fbPrivateReply', 'select', ['Facebook private messages', 'رسائل فيسبوك الخاصة'], ['Needs Meta approval first.', 'تحتاج موافقة ميتا أولاً.'], STUDIO_ADMIN_CAPABILITY_STATES],
      ['igPublicReply', 'select', ['Instagram public replies', 'ردود إنستغرام العامة'], ['poll after the read test passed; on after Meta approval.', 'poll بعد نجاح اختبار القراءة؛ on بعد موافقة ميتا.'], ['on', 'poll', 'gated', 'off', 'unavailable']],
      ['igPrivateReply', 'select', ['Instagram private messages', 'رسائل إنستغرام الخاصة'], ['Needs Meta approval first.', 'تحتاج موافقة ميتا أولاً.'], STUDIO_ADMIN_CAPABILITY_STATES],
      ['tiktokService', 'select', ['TikTok service label', 'تسمية خدمة تيك توك'], ['A manual service: on when the team offers it.', 'خدمة يدوية: on عندما يقدمها الفريق.'], STUDIO_ADMIN_CAPABILITY_STATES]
    ]
  },
  limits: {
    about: ['The budget rules for NEW requests (older rows keep theirs): the total a customer pays per request, the per-day floor and the most days an ad may run.', 'قواعد الميزانية للطلبات الجديدة (الطلبات الأقدم تبقى على قواعدها): إجمالي ما يدفعه العميل للطلب، وحد اليوم الأدنى، وأقصى عدد أيام.'],
    fields: [
      ['minTotalMinorUSD', 'money', ['Smallest total per request (USD)', 'أصغر إجمالي للطلب (بالدولار)'], ['At least $1.', '1 دولار على الأقل.']],
      ['maxTotalMinorUSD', 'money', ['Largest total per request (USD)', 'أكبر إجمالي للطلب (بالدولار)'], ['Not below the smallest total.', 'لا يقل عن أصغر إجمالي.']],
      ['minPerDayMinorUSD', 'money', ['Per-day floor (USD)', 'حد اليوم الأدنى (بالدولار)'], ["Meta's own minimum daily budget: read it in Health.", 'الحد الأدنى اليومي لدى ميتا: اقرأه في التنبيهات.']],
      ['maxDays', 'whole', ['Most days an ad may run', 'أقصى عدد أيام يعمل فيها الإعلان'], ['1 to 90.', 'من 1 إلى 90.'], [1, 90]],
      ['p1CutoverAt', 'readonly', ['Release stamp of the P1 budget rules', 'ختم إصدار قواعد الميزانية P1'], ['Set at deploy; rows sent before it keep the old rules.', 'يُضبط عند النشر؛ الطلبات المرسلة قبله تبقى على القواعد القديمة.']]
    ]
  },
  settlement: {
    about: ["When an ended ad may be settled: the final Meta read comes this many hours after delivery ended, an ad Meta never showed may settle at once, and Meta's spend is watched for changes this many days.", 'متى يمكن تسوية إعلان منتهٍ: تُقرأ أرقام ميتا النهائية بعد هذا العدد من الساعات من انتهاء العرض، والإعلان الذي لم تعرضه ميتا يُسوّى فوراً، ويُراقب صرف ميتا لهذا العدد من الأيام.'],
    fields: [
      ['spendDelayHours', 'whole', ['Hours to wait after delivery ends', 'ساعات الانتظار بعد انتهاء العرض'], ['0 to 168 (D28 recommends 48).', 'من 0 إلى 168 (توصية D28: 48).'], [0, 168]],
      ['neverDeliveredImmediate', 'flag', ['Never-delivered ads settle at once', 'الإعلانات التي لم تُعرض تُسوّى فوراً'], ['A full return without the wait.', 'إعادة كاملة دون انتظار.']],
      ['driftWatchDays', 'whole', ['Days to watch for spend changes', 'أيام مراقبة تغيّر الصرف'], ['1 to 90; must outlive the wait (Meta is final after 28 days).', 'من 1 إلى 90؛ يجب أن تتجاوز مدة الانتظار (أرقام ميتا نهائية بعد 28 يوماً).'], [1, 90]]
    ]
  },
  hours: {
    about: ['The team\'s working hours in Tripoli time: due times of reviews, tickets, stop requests and payments count only inside them. Holidays and the Ramadan hours override the week; the on-duty hour is when the urgent WhatsApp line closes.', 'ساعات عمل الفريق بتوقيت طرابلس: مواعيد المراجعة والتذاكر وطلبات الإيقاف والمدفوعات تُحسب داخلها فقط. العطل وساعات رمضان تتقدم على الأسبوع؛ وساعة المناوبة هي موعد إغلاق خط واتساب العاجل.'],
    fields: []
  },
  contact: {
    about: ['The numbers customers see on the studio login page and in Help (D16, D23), and the on-duty WhatsApp for urgent stop requests outside working hours. International form, for example +218912345678.', 'الأرقام التي يراها العملاء في صفحة دخول الاستوديو وفي المساعدة (D16، D23)، وواتساب المناوبة لطلبات الإيقاف العاجلة خارج ساعات العمل. بالصيغة الدولية، مثل +218912345678.'],
    fields: [
      ['whatsapp', 'phone', ['WhatsApp', 'واتساب'], ['Shown to customers.', 'يظهر للعملاء.']],
      ['phone', 'phone', ['Phone', 'الهاتف'], ['Shown to customers.', 'يظهر للعملاء.']],
      ['email', 'email', ['Email', 'البريد'], ['Shown to customers.', 'يظهر للعملاء.']],
      ['urgentWhatsapp', 'phone', ['On-duty WhatsApp (urgent stops)', 'واتساب المناوبة (إيقاف عاجل)'], ['Shown only in the stop-request sheet outside working hours.', 'يظهر فقط في ورقة طلب الإيقاف خارج ساعات العمل.']]
    ]
  },
  targets: {
    about: ['How fast the team promises to act (D11). Minutes count only inside the service hours; business days skip holidays.', 'السرعة التي يَعِد بها الفريق (D11). الدقائق تُحسب داخل ساعات العمل فقط؛ وأيام العمل تتخطى العطل.'],
    fields: [
      ['reviewBusinessDays', 'whole', ['Review a request (business days)', 'مراجعة الطلب (أيام عمل)'], ['1 to 10.', 'من 1 إلى 10.'], [1, 10]],
      ['ticketFirstResponseMinutes', 'whole', ['First ticket answer (working minutes)', 'أول رد على التذكرة (دقائق عمل)'], ['15 to 2400.', 'من 15 إلى 2400.'], [15, 2400]],
      ['stopRequestMinutes', 'whole', ['Stop request (working minutes)', 'طلب الإيقاف (دقائق عمل)'], ['15 to 480; never above the ticket answer.', 'من 15 إلى 480؛ لا يزيد عن الرد على التذكرة.'], [15, 480]],
      ['paymentConfirmMinutes', 'whole', ['Payment confirmation (working minutes)', 'تأكيد الدفع (دقائق عمل)'], ['15 to 2400 (admins confirm).', 'من 15 إلى 2400 (المديرون يؤكدون).'], [15, 2400]],
      ['settlementBusinessDays', 'whole', ['Settlement after the final read (business days)', 'التسوية بعد القراءة النهائية (أيام عمل)'], ['1 to 10.', 'من 1 إلى 10.'], [1, 10]],
      ['tiktokBusinessDays', 'whole', ['TikTok request (business days)', 'طلب تيك توك (أيام عمل)'], ['1 to 10.', 'من 1 إلى 10.'], [1, 10]]
    ]
  },
  thresholds: {
    about: ['The numbers behind the go/no-go rows and the stop rules (D32). The zero-tolerance rules (money identity, duplicate charges, studio ads in the core books) are fixed and not here.', 'الأرقام خلف صفوف قرار المتابعة وقواعد الإيقاف (D32). قواعد الصفر (هوية الأموال، الخصم المكرر، إعلانات الاستوديو في دفاتر المدير) ثابتة وليست هنا.'],
    fields: [
      ['goConsecutiveWeeks', 'whole', ['Green weeks in a row needed', 'الأسابيع الخضراء المتتالية المطلوبة'], ['1 to 8.', 'من 1 إلى 8.'], [1, 8]],
      ['reconcileToleranceMinorUSD', 'money', ['Reconciliation tolerance (USD)', 'سماحية المطابقة (بالدولار)'], ['The difference allowed each month, at least this.', 'الفرق المسموح به شهرياً، على الأقل.']],
      ['reconcileToleranceBasisPoints', 'whole', ['Reconciliation tolerance (basis points)', 'سماحية المطابقة (نقاط أساس)'], ['100 = 1% of the month\'s studio spend.', '100 = 1% من صرف الاستوديو في الشهر.'], [0, 1000]],
      ['queueOnTargetPercent', 'whole', ['Queues on target (%)', 'الطوابير في الهدف (%)'], ['50 to 100.', 'من 50 إلى 100.'], [50, 100]],
      ['resultsFreshPercent', 'whole', ['Linked ads checked recently (%)', 'الإعلانات المربوطة المفحوصة حديثاً (%)'], ['50 to 100.', 'من 50 إلى 100.'], [50, 100]],
      ['resultsFreshHours', 'whole', ['"Recently" means within (hours)', '«حديثاً» تعني خلال (ساعات)'], ['1 to 48.', 'من 1 إلى 48.'], [1, 48]],
      ['webhookReplyP95Seconds', 'whole', ['Webhook reply p95 (seconds)', 'الرد عبر الويب هوك p95 (ثوانٍ)'], ['10 to 3600.', 'من 10 إلى 3600.'], [10, 3600]],
      ['pollReplyP95Seconds', 'whole', ['Poll reply p95 (seconds)', 'الرد عبر الفحص الدوري p95 (ثوانٍ)'], ['60 to 7200.', 'من 60 إلى 7200.'], [60, 7200]],
      ['replyFailureMaxPercent', 'whole', ['Most reply failures (%)', 'أقصى نسبة فشل الردود (%)'], ['0 to 50.', 'من 0 إلى 50.'], [0, 50]],
      ['restoreProofMaxDays', 'whole', ['Restore proven within (days)', 'إثبات الاستعادة خلال (أيام)'], ['1 to 30.', 'من 1 إلى 30.'], [1, 30]],
      ['tokenMinDaysLeft', 'whole', ['Meta token: least days left', 'رمز ميتا: أقل أيام متبقية'], ['1 to 60.', 'من 1 إلى 60.'], [1, 60]],
      ['strandedCaptureMaxMinutes', 'whole', ['Stop rule: "being returned" older than (minutes)', 'قاعدة إيقاف: «في طريقه إليك» أقدم من (دقائق)'], ['5 to 1440.', 'من 5 إلى 1440.'], [5, 1440]],
      ['replyOutageMaxHours', 'whole', ['Stop rule: replies down longer than (hours)', 'قاعدة إيقاف: توقف الردود أطول من (ساعات)'], ['1 to 72.', 'من 1 إلى 72.'], [1, 72]],
      ['heartbeatLateMaxMinutes', 'whole', ['Stop rule: jobs heartbeat late by (minutes)', 'قاعدة إيقاف: تأخر نبض المهام (دقائق)'], ['5 to 240.', 'من 5 إلى 240.'], [5, 240]],
      ['tokenExpiryWarnDays', 'days', ['Token expiry warnings (days before, comma separated)', 'تنبيهات انتهاء الرمز (أيام قبل الانتهاء، مفصولة بفواصل)'], ['1 to 5 numbers, each 1 to 60.', 'من رقم إلى 5 أرقام، كل منها من 1 إلى 60.']]
    ]
  }
});
const STUDIO_ADMIN_GO_LABELS = Object.freeze({
  integrityViolations: ['Daily money check: violations', 'فحص الأموال اليومي: مخالفات'],
  refundsAboveCap: ['Refunds above the cap without an override', 'إعادات فوق الحد دون تجاوز'],
  reconciliation: ['Reconciliation within tolerance (difference, cents)', 'المطابقة ضمن السماحية (الفرق بالسنت)'],
  reviewsOnTarget: ['Reviews on target (%)', 'المراجعات في الهدف (%)'],
  stopRequestsOnTarget: ['Stop requests on target (%)', 'طلبات الإيقاف في الهدف (%)'],
  paymentsOnTarget: ['Payment confirmations on target (%)', 'تأكيدات الدفع في الهدف (%)'],
  ticketsOnTarget: ['Ticket answers on target (%)', 'الردود على التذاكر في الهدف (%)'],
  resultsFresh: ['Linked ads checked recently (%)', 'الإعلانات المربوطة المفحوصة حديثاً (%)'],
  webhookReplyP95: ['Webhook reply p95 (seconds)', 'الرد عبر الويب هوك p95 (ثوانٍ)'],
  pollReplyP95: ['Poll reply p95 (seconds)', 'الرد عبر الفحص الدوري p95 (ثوانٍ)'],
  replyFailureRate: ['Reply failures (%)', 'فشل الردود (%)'],
  commentsLostToOutage: ['Comments lost to an outage', 'تعليقات ضاعت أثناء انقطاع'],
  noOpenMoneyIncident: ['Open money incidents', 'حوادث أموال مفتوحة'],
  runbookRehearsed: ['Runbook rehearsed (ticked by hand)', 'التدرب على دليل الطوارئ (يُحدَّد يدوياً)'],
  restoreProven: ['Restore proven (ticked by hand)', 'إثبات الاستعادة (يُحدَّد يدوياً)'],
  tokenValid: ['Meta token valid with enough days left', 'رمز ميتا صالح وبأيام كافية']
});
const STUDIO_ADMIN_STOP_LABELS = Object.freeze({
  walletIdentityBreak: ['Wallet identity break', 'كسر في هوية المحفظة'],
  duplicateCharge: ['Duplicate charge or return', 'خصم أو إعادة مكررة'],
  strandedCapture: ['Stranded capture ("being returned" too long)', 'مبلغ عالق («في طريقه إليك» طويلاً)'],
  studioInCoreBooks: ['A studio ad in the core books', 'إعلان استوديو في دفاتر المدير'],
  replyOutage: ['Comment replies down too long', 'توقف الردود على التعليقات طويلاً'],
  heartbeatLate: ['Studio jobs heartbeat late', 'تأخر نبض مهام الاستوديو']
});
const STUDIO_ADMIN_COLLISION_REASONS = Object.freeze({
  studio_name: ['the campaign name carries the studio code', 'اسم الحملة يحمل رمز الاستوديو'],
  studio_campaign_id: ['a studio request linked this campaign', 'ربط طلبٌ في الاستوديو هذه الحملة']
});

const _studioAdmin = { forUser: '', generation: 0, reads: Object.create(null), settings: Object.create(null), alertsPages: [], acks: new Map(), scan: null };
// acks: alert id -> the acknowledge in flight (single flight); scan: the last on-demand money scan
// ({promise, value, error, at}; renderStudioAdminScanRow).

// ------------------------------------------------------------------ small helpers

function studioAdminUserId() {
  return typeof studioMeUserId === 'function' ? studioMeUserId() : String((state.currentUser && state.currentUser.id) || '');
}

function studioAdminScope() {
  const uid = studioAdminUserId();
  if (_studioAdmin.forUser !== uid) {
    _studioAdmin.generation++;
    _studioAdmin.forUser = uid;
    _studioAdmin.reads = Object.create(null);
    _studioAdmin.settings = Object.create(null);
    _studioAdmin.alertsPages = [];
    _studioAdmin.acks = new Map();
    _studioAdmin.scan = null;
  }
  return uid;
}

function studioAdminIsAdmin() {
  return typeof isCurrentUserAdmin === 'function' && isCurrentUserAdmin();
}

function studioAdminServer() {
  return typeof isServerModeEnabled === 'function' && isServerModeEnabled();
}

function studioAdminIcon(name, className = 'studio-v2-icon') {
  return studioV2Icon(name, className);
}

function studioAdminRedraw() {
  if (typeof studioDeskRedraw === 'function') studioDeskRedraw();
  else studioV2Rerender();
}

function studioAdminOpen(id) {
  return studioV2Go({ tab: 'review', section: 'more', id: String(id || '') });
}

function studioAdminPage(id) {
  return STUDIO_ADMIN_PAGES.find(page => page[0] === String(id || '')) || null;
}

function studioAdminWhen(iso) {
  if (typeof studioDeskWhen === 'function') return studioDeskWhen(iso);
  const at = Date.parse(String(iso || ''));
  return Number.isFinite(at) ? new Date(at).toLocaleString(adsStudioIsAr() ? 'ar-LY' : 'en-GB') : '';
}

function studioAdminAgo(iso) {
  const at = Date.parse(String(iso || ''));
  if (!Number.isFinite(at)) return '';
  const minutes = Math.max(Math.floor((Date.now() - at) / 60000), 0);
  if (minutes < 60) return adsStudioText(`${minutes} min ago`, `قبل ${minutes} دقيقة`);
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return adsStudioText(`${hours} h ago`, `قبل ${hours} ساعة`);
  return adsStudioText(`${Math.floor(hours / 24)} days ago`, `قبل ${Math.floor(hours / 24)} يوماً`);
}

function studioAdminNumber(value, digits = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  try { return number.toLocaleString('en-US', { maximumFractionDigits: digits }); } catch (_) { return String(number); }
}

function studioAdminBytes(bytes) {
  const number = Number(bytes);
  if (!Number.isFinite(number) || number < 0) return '—';
  if (number < 1024 * 1024) return `${studioAdminNumber(number / 1024)} KB`;
  if (number < 1024 * 1024 * 1024) return `${studioAdminNumber(number / (1024 * 1024), 1)} MB`;
  return `${studioAdminNumber(number / (1024 * 1024 * 1024), 2)} GB`;
}

function studioAdminYesNo(value) {
  if (value === true) return adsStudioText('yes', 'نعم');
  if (value === false) return adsStudioText('no', 'لا');
  return adsStudioText('unknown', 'غير معروف');
}

// One admin read, kept a minute; a failed read waits 30 s (Retry asks at once).
function studioAdminRead(key, path, force = false) {
  studioAdminScope();
  let slot = _studioAdmin.reads[key];
  if (!slot) {
    slot = { value: null, loadedAt: 0, failedAt: 0, error: null, promise: null };
    _studioAdmin.reads[key] = slot;
  }
  if (!studioAdminServer() || slot.promise) return slot;
  const age = Date.now() - slot.loadedAt;
  if (!force) {
    if (slot.failedAt && Date.now() - slot.failedAt < STUDIO_ADMIN_RETRY_MS) return slot;
    if (slot.value !== null && age >= 0 && age < STUDIO_ADMIN_TTL_MS) return slot;
  }
  const generation = _studioAdmin.generation;
  const signal = studioReadSignal();
  slot.promise = studioApi(path, { method: 'GET' }).then(raw => {
    if (generation !== _studioAdmin.generation) return;
    slot.value = raw && typeof raw === 'object' ? raw : {};
    slot.loadedAt = Date.now();
    slot.failedAt = 0;
    slot.error = null;
  }, error => {
    if (generation !== _studioAdmin.generation || studioReadCancelled(error, signal)) return;
    slot.failedAt = Date.now();
    slot.error = (error && error.studio) || studioErrorInfo(error, 'read');
  }).finally(() => {
    if (generation !== _studioAdmin.generation) return;
    slot.promise = null;
    studioAdminRedraw();
  });
  return slot;
}

function studioAdminRetry(key, path) {
  studioAdminRead(String(key || ''), String(path || ''), true);
  studioAdminRedraw();
}

function renderStudioAdminProblem(slot, retryCode, testId) {
  if (slot.promise && slot.value === null) return `<p class="studio-desk-note" data-testid="${studioEsc(testId)}-loading">${studioEsc(adsStudioText('Reading…', 'جارٍ القراءة…'))}</p>`;
  if (slot.value === null && slot.error) {
    return `<div class="studio-desk-problem" role="alert" data-testid="${studioEsc(testId)}-problem"><p>${studioEsc(slot.error.text || '')}</p><button type="button" class="studio-v2-action studio-desk-small" onclick="${retryCode}">${studioEsc(adsStudioText('Try again', 'أعد المحاولة'))}</button></div>`;
  }
  return '';
}

function renderStudioAdminPageHead(id, extra = '') {
  const page = studioAdminPage(id);
  if (!page) return '';
  return `
          <div class="studio-desk-head" data-testid="studio-admin-head-${studioEsc(id)}">
            <div class="studio-desk-heading"><h2 class="studio-desk-h2">${studioAdminIcon(page[1], 'studio-desk-meta-icon')}<span>${studioEsc(adsStudioText(page[2], page[3]))}</span></h2><p class="studio-desk-note">${studioEsc(adsStudioText(page[4], page[5]))}</p></div>
            ${extra}
          </div>`;
}

function renderStudioAdminLine(label, value, tone = '', testId = '') {
  return `<div class="studio-desk-line"${tone ? ` data-tone="${studioEsc(tone)}"` : ''}${testId ? ` data-testid="${studioEsc(testId)}"` : ''}><span class="studio-desk-line-label">${studioEsc(label)}</span><span class="studio-desk-line-value" dir="auto">${studioEsc(value)}</span></div>`;
}

function studioAdminOkTone(ok) {
  return ok === true ? 'green' : ok === false ? 'red' : 'slate';
}

// ------------------------------------------------------------------ the menu

function renderStudioAdminMenu() {
  const pulse = typeof _studioDesk !== 'undefined' && _studioDesk.pulse ? _studioDesk.pulse.value : null;
  const counts = { payments: pulse && pulse.paymentsWaiting ? pulse.paymentsWaiting : 0, alerts: pulse ? pulse.alerts : 0 };
  const row = ([id, icon, en, ar, hintEn, hintAr]) => `
            <button type="button" class="studio-v2-row studio-admin-row" data-testid="studio-admin-open-${studioEsc(id)}" onclick="studioAdminOpen('${studioEsc(id)}')">
              ${studioAdminIcon(icon)}
              <span class="studio-admin-row-text"><span class="studio-v2-row-label">${studioEsc(adsStudioText(en, ar))}</span><span class="studio-desk-note">${studioEsc(adsStudioText(hintEn, hintAr))}</span></span>
              ${counts[id] ? `<span class="studio-desk-count" data-testid="studio-admin-count-${studioEsc(id)}">${studioEsc(String(counts[id]))}</span>` : ''}
            </button>`;
  const tools = STUDIO_ADMIN_PAGES.filter(page => !page[0].startsWith('settings-'));
  const settings = STUDIO_ADMIN_PAGES.filter(page => page[0].startsWith('settings-'));
  return `
          <h2 class="studio-desk-h2">${studioEsc(adsStudioText('Admin tools', 'أدوات المدير'))}</h2>
          <div class="studio-v2-list" data-testid="studio-admin-menu">${tools.map(row).join('')}</div>
          <h2 class="studio-desk-h2 studio-desk-h2-later">${studioEsc(adsStudioText('Settings', 'الإعدادات'))}</h2>
          <div class="studio-v2-list" data-testid="studio-admin-settings-menu">${settings.map(row).join('')}</div>`;
}

// ------------------------------------------------------------------ payments waiting

function studioAdminPaymentsWant(force = false) {
  const uid = studioAdminUserId();
  if (typeof refreshAdsStudioWallet !== 'function') return;
  if (force || _adsStudioWalletForUser !== uid) {
    if (typeof resetAdsStudioWalletCache === 'function') resetAdsStudioWalletCache();
    refreshAdsStudioWallet();
  } else if (_adsStudioWalletMine === null) {
    refreshAdsStudioWallet();
  }
}

function studioAdminPaymentsRefresh() {
  studioAdminPaymentsWant(true);
  studioAdminRedraw();
}

function renderStudioAdminPayments() {
  studioAdminPaymentsWant();
  const targets = studioAdminRead('targets', '/api/studio/admin/settings/targets');
  const minutes = targets.value && targets.value.value ? Number(targets.value.value.paymentConfirmMinutes) : 240;
  const pending = Array.isArray(_adsStudioWalletPendingAll) ? _adsStudioWalletPendingAll : null;
  const loading = pending === null;
  const rows = (pending || []).map(entity => {
    const data = entity && entity.data ? entity.data : {};
    const createdAt = String(data.createdAt || '');
    const waitedMinutes = createdAt && Number.isFinite(Date.parse(createdAt)) ? (Date.now() - Date.parse(createdAt)) / 60000 : null;
    const overdue = waitedMinutes !== null && waitedMinutes > (Number.isFinite(minutes) ? minutes : 240);
    const wait = createdAt ? `<p class="studio-desk-note studio-admin-payment-wait" data-testid="studio-admin-payment-wait" data-overdue="${overdue ? '1' : '0'}">${studioEsc(adsStudioText(`Waiting since ${studioAdminWhen(createdAt)} (${studioAdminAgo(createdAt)})`, `بانتظار التأكيد منذ ${studioAdminWhen(createdAt)} (${studioAdminAgo(createdAt)})`))}${overdue ? ` <span class="studio-flag">${studioEsc(adsStudioText('Past the target', 'تجاوز الهدف'))}</span>` : ''}</p>` : '';
    return `<li class="studio-admin-payment">${typeof _adsStudioWalletRequestRow === 'function' ? _adsStudioWalletRequestRow(entity, true) : ''}${wait}</li>`;
  });
  const refresh = `<button type="button" class="studio-v2-action studio-desk-small" data-testid="studio-admin-payments-refresh" onclick="studioAdminPaymentsRefresh()">${studioAdminIcon('refresh-cw')}<span>${studioEsc(adsStudioText('Refresh', 'تحديث'))}</span></button>`;
  let body;
  if (loading) body = `<p class="studio-desk-note" data-testid="studio-admin-payments-loading">${studioEsc(adsStudioText('Reading the payment requests…', 'نقرأ طلبات الدفع…'))}</p>`;
  else if (!rows.length) body = renderStudioDeskEmpty('landmark', adsStudioText('No payment waits for confirmation', 'لا دفعة تنتظر التأكيد'), '', 'studio-admin-payments-empty');
  else body = `<ul class="studio-desk-list studio-desk-classic" data-testid="studio-admin-payments">${rows.join('')}</ul>`;
  return renderStudioAdminPageHead('payments', refresh) + `<p class="studio-desk-note">${studioEsc(adsStudioText(`Target: confirm within ${Number.isFinite(minutes) ? minutes : 240} working minutes. A confirmed USD payment adds to the customer's available money; a LYD one to the plan balance.`, `الهدف: التأكيد خلال ${Number.isFinite(minutes) ? minutes : 240} دقيقة عمل. الدفعة المؤكدة بالدولار تُضاف إلى رصيد العميل المتاح، وبالدينار إلى رصيد الاشتراك.`))}</p>` + body;
}

// ------------------------------------------------------------------ alerts

function studioAdminAlertsPath() {
  const last = _studioAdmin.alertsPages[_studioAdmin.alertsPages.length - 1];
  return last && last.nextBefore ? `/api/studio/admin/alerts?limit=20&before=${encodeURIComponent(last.nextBefore)}` : '/api/studio/admin/alerts?limit=20';
}

function studioAdminAlertsMore() {
  const slot = _studioAdmin.reads.alerts;
  if (!slot || !slot.value || !slot.value.nextBefore || slot.promise) return;
  _studioAdmin.alertsPages.push({ alerts: Array.isArray(slot.value.alerts) ? slot.value.alerts : [], nextBefore: String(slot.value.nextBefore) });
  studioAdminRead('alerts', studioAdminAlertsPath(), true);
  studioAdminRedraw();
}

function studioAdminAlertsRefresh() {
  _studioAdmin.alertsPages = [];
  studioAdminRetry('alerts', '/api/studio/admin/alerts?limit=20');
}

function renderStudioAdminAlert(alert) {
  const kind = String((alert && alert.kind) || '').replace(/[^a-z_]/g, '').slice(0, 60);
  const label = studioPickText(alert && alert.labels, 300) || kind;
  const count = Number(alert && alert.count) || 0;
  const ack = !!(alert && alert.acknowledgedAt);
  const details = alert && alert.details && typeof alert.details === 'object' ? alert.details : {};
  const bits = [];
  if (alert && alert.lastAt) bits.push(adsStudioText(`last ${studioAdminAgo(alert.lastAt)}`, `آخر مرة ${studioAdminAgo(alert.lastAt)}`));
  if (count > 1) bits.push(adsStudioText(`${count} times`, `${count} مرات`));
  if (alert && alert.relatedId) bits.push(`${String(alert.relatedType || '').slice(0, 30)}: ${String(alert.relatedId).slice(0, 80)}`);
  if (Number.isSafeInteger(details.absorbedMinorUSD) && details.absorbedMinorUSD > 0) bits.push(adsStudioText(`Albayan absorbs ${studioUsd(details.absorbedMinorUSD)}`, `يتحمل البيان ${studioUsd(details.absorbedMinorUSD)}`));
  if (Number.isSafeInteger(details.daysLeft)) bits.push(adsStudioText(`${details.daysLeft} days left`, `بقي ${details.daysLeft} يوماً`));
  const id = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(String((alert && alert.id) || '')) ? String(alert.id) : '';
  const busy = !!id && _studioAdmin.acks.has(id);
  const ackButton = !ack && id
    ? `<div class="studio-desk-actions"><button type="button" class="studio-v2-action studio-desk-small" data-testid="studio-admin-alert-ack-${studioEsc(id)}" onclick="studioAdminAlertAck('${studioEsc(id)}', this)"${busy ? ' disabled aria-busy="true"' : ''}>${studioAdminIcon('check')}<span>${studioEsc(busy ? adsStudioText('Acknowledging…', 'جارٍ التأكيد…') : adsStudioText('Acknowledge', 'تأكيد الاطلاع'))}</span></button></div>` : '';
  return `
              <li class="studio-desk-box studio-admin-alert" data-testid="studio-admin-alert" data-kind="${studioEsc(kind)}" data-acknowledged="${ack ? '1' : '0'}"${id ? ` data-id="${studioEsc(id)}"` : ''}>
                <p class="studio-admin-alert-title">${studioAdminIcon(ack ? 'check' : 'bell-ring', 'studio-desk-meta-icon')}<span dir="auto">${studioEsc(label)}</span></p>
                <p class="studio-desk-note"><code class="studio-desk-code" dir="ltr">${studioEsc(kind)}</code>${bits.length ? ` · <span dir="auto">${studioEsc(bits.join(' · '))}</span>` : ''}${ack ? ` · ${studioEsc(adsStudioText('acknowledged', 'تم الاطلاع'))}` : ''}</p>
                ${ackButton}
              </li>`;
}

// "Acknowledge" (P3-23): POST /api/studio/admin/alerts/{id}/ack, single flight per alert. The
// server stamps acknowledgedAt (a replay answers the stamped alert as it is), so the row leaves
// the open list at once and the pulse count follows on its next read. UNKNOWN_ALERT (archived or a
// stale entry) is shown through the ONE error map and the list is read again.
function studioAdminAlertAck(id, button = null) {
  const alertId = String(id || '');
  if (!alertId || !studioAdminIsAdmin() || !studioAdminServer() || _studioAdmin.acks.has(alertId)) return null;
  if (button) setAdsStudioActionButtonBusy(button, true);
  const generation = _studioAdmin.generation;
  const promise = studioApi(`/api/studio/admin/alerts/${encodeURIComponent(alertId)}/ack`, { method: 'POST', body: {} }).then(reply => {
    if (generation !== _studioAdmin.generation) return null;
    const alert = reply && reply.alert && typeof reply.alert === 'object' ? reply.alert : null;
    if (!alert || !alert.acknowledgedAt) return null;
    studioAdminAlertLeft(alertId);
    if (typeof studioDeskPulseRefresh === 'function') studioDeskPulseRefresh();
    studioAdminNotify(true, adsStudioText('Alert acknowledged', 'تم تأكيد الاطلاع على التنبيه'), reply.replay === true ? adsStudioText('It was already acknowledged.', 'كان قد تم تأكيد الاطلاع عليه من قبل.') : '');
    return alert;
  }, error => {
    if (generation !== _studioAdmin.generation) return null;
    const info = (error && error.studio) || studioErrorInfo(error, 'action');
    studioAdminNotify(false, adsStudioText('Could not acknowledge the alert', 'تعذّر تأكيد الاطلاع على التنبيه'), info.text || '');
    if (info.code === 'UNKNOWN_ALERT') studioAdminAlertsRefresh();
    return null;
  }).finally(() => {
    if (generation !== _studioAdmin.generation) return;
    _studioAdmin.acks.delete(alertId);
    if (button) setAdsStudioActionButtonBusy(button, false);
    studioAdminRedraw();
  });
  _studioAdmin.acks.set(alertId, promise);
  studioAdminRedraw();
  return promise;
}

// An acknowledged alert leaves the open list this screen holds (the current page and the earlier ones).
function studioAdminAlertLeft(alertId) {
  const slot = _studioAdmin.reads.alerts;
  const drop = list => (Array.isArray(list) ? list.filter(item => !(item && String(item.id || '') === alertId)) : list);
  if (slot && slot.value && Array.isArray(slot.value.alerts)) slot.value.alerts = drop(slot.value.alerts);
  _studioAdmin.alertsPages = _studioAdmin.alertsPages.map(page => ({ ...page, alerts: drop(page.alerts) }));
}

function studioAdminNotify(ok, title, text) {
  try { showNotification(title, text, ok ? 'success' : 'error'); } catch (_) {}
}

function renderStudioAdminJobs(jobs) {
  if (!jobs || typeof jobs !== 'object') return '';
  const late = jobs.late === true;
  const tick = jobs.lastTickAt ? adsStudioText(`last tick ${studioAdminAgo(jobs.lastTickAt)}`, `آخر نبضة ${studioAdminAgo(jobs.lastTickAt)}`) : adsStudioText('never ticked', 'لم تنبض بعد');
  const text = jobs.enabled === false
    ? adsStudioText('The studio jobs loop is switched off here.', 'حلقة مهام الاستوديو متوقفة هنا.')
    : late ? adsStudioText(`Studio jobs heartbeat LATE (${tick}).`, `نبض مهام الاستوديو متأخر (${tick}).`) : adsStudioText(`Studio jobs heartbeat fine (${tick}).`, `نبض مهام الاستوديو سليم (${tick}).`);
  return `<p class="studio-desk-line" data-tone="${late ? 'red' : 'green'}" data-testid="studio-admin-heartbeat" data-late="${late ? '1' : '0'}"><span class="studio-desk-line-label">${studioAdminIcon('heart-pulse', 'studio-desk-meta-icon')}${studioEsc(text)}</span></p>`;
}

function renderStudioAdminAlerts() {
  const slot = studioAdminRead('alerts', studioAdminAlertsPath());
  const refresh = `<button type="button" class="studio-v2-action studio-desk-small" data-testid="studio-admin-alerts-refresh" onclick="studioAdminAlertsRefresh()"${slot.promise ? ' disabled' : ''}>${studioAdminIcon('refresh-cw')}<span>${studioEsc(adsStudioText('Refresh', 'تحديث'))}</span></button>`;
  const head = renderStudioAdminPageHead('alerts', refresh);
  const problem = renderStudioAdminProblem(slot, "studioAdminRetry('alerts', '/api/studio/admin/alerts?limit=20')", 'studio-admin-alerts');
  if (problem) return head + problem;
  const earlier = _studioAdmin.alertsPages.flatMap(page => page.alerts);
  const current = slot.value && Array.isArray(slot.value.alerts) ? slot.value.alerts : [];
  const alerts = earlier.concat(current).filter(item => item && typeof item === 'object');
  const list = alerts.length
    ? `<ul class="studio-desk-list" data-testid="studio-admin-alerts">${alerts.map(renderStudioAdminAlert).join('')}</ul>`
    : renderStudioDeskEmpty('bell-off', adsStudioText('No alerts', 'لا تنبيهات'), adsStudioText('The jobs loop and the Meta checks raised nothing.', 'لم تُثر حلقة المهام وفحوص ميتا شيئاً.'), 'studio-admin-alerts-empty');
  const more = slot.value && slot.value.nextBefore ? `<button type="button" class="studio-v2-action studio-desk-more" data-testid="studio-admin-alerts-more" onclick="studioAdminAlertsMore()"${slot.promise ? ' disabled' : ''}>${studioEsc(adsStudioText('Show older alerts', 'اعرض التنبيهات الأقدم'))}</button>` : '';
  return head + renderStudioAdminJobs(slot.value && slot.value.jobs) + list + more;
}

// ------------------------------------------------------------------ diagnostics

function studioAdminPercentText(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? adsStudioText('no data', 'لا بيانات') : `${studioAdminNumber(value, 1)}%`;
}

function renderStudioAdminQueues(operations) {
  const queues = operations && operations.queues && typeof operations.queues === 'object' ? operations.queues : {};
  const names = { reviews: ['Reviews', 'المراجعات'], tickets: ['Ticket answers', 'الردود على التذاكر'], stopRequests: ['Stop requests', 'طلبات الإيقاف'], payments: ['Payment confirmations', 'تأكيدات الدفع'] };
  const lines = Object.entries(names).map(([key, [en, ar]]) => {
    const queue = queues[key] && typeof queues[key] === 'object' ? queues[key] : {};
    const value = `${studioAdminPercentText(queue.percent)} ${adsStudioText(`met (${Number(queue.met) || 0} of ${Number(queue.sample) || 0}), ${Number(queue.waitingOverdue) || 0} waiting past the target`, `في الهدف (${Number(queue.met) || 0} من ${Number(queue.sample) || 0})، ${Number(queue.waitingOverdue) || 0} ينتظر بعد الموعد`)}`;
    return renderStudioAdminLine(adsStudioText(en, ar), value, studioAdminOkTone(queue.onTarget), `studio-admin-queue-${key}`);
  });
  const window = operations && operations.window ? Number(operations.window.queueDays) || 7 : 7;
  return `<section class="studio-desk-box" data-testid="studio-admin-queues"><h3 class="studio-desk-h3">${studioEsc(adsStudioText(`Queues on target (last ${window} days)`, `الطوابير في الهدف (آخر ${window} أيام)`))}</h3>${lines.join('')}</section>`;
}

function renderStudioAdminCapacity(operations) {
  const capacity = operations && operations.capacity && typeof operations.capacity === 'object' ? operations.capacity : {};
  const intake = capacity.intake && typeof capacity.intake === 'object' ? capacity.intake : {};
  const sends = capacity.sendsPerDay && typeof capacity.sendsPerDay === 'object' ? capacity.sendsPerDay : {};
  return `<section class="studio-desk-box" data-testid="studio-admin-capacity"><h3 class="studio-desk-h3">${studioEsc(adsStudioText('Capacity', 'السعة'))}</h3>
    ${renderStudioAdminLine(adsStudioText('Intake', 'الاستقبال'), intake.open === false ? adsStudioText('paused', 'متوقف مؤقتاً') : adsStudioText(`open, cap ${studioAdminNumber(intake.maxSubmissionsPerDay)} a day`, `مفتوح، الحد ${studioAdminNumber(intake.maxSubmissionsPerDay)} يومياً`), intake.open === false ? 'amber' : 'green')}
    ${renderStudioAdminLine(adsStudioText('Sends today', 'الإرسالات اليوم'), `${studioAdminNumber(capacity.submissionsToday)}${capacity.usedPercent !== null && capacity.usedPercent !== undefined ? ` (${studioAdminNumber(capacity.usedPercent, 1)}% ${adsStudioText('of the cap', 'من الحد')})` : ''}`)}
    ${renderStudioAdminLine(adsStudioText('Sends a day (average / max)', 'الإرسالات يومياً (المتوسط / الأعلى)'), `${studioAdminNumber(sends.average, 2)} / ${studioAdminNumber(sends.max)}`)}
    ${renderStudioAdminLine(adsStudioText('Waiting for review now', 'بانتظار المراجعة الآن'), studioAdminNumber(capacity.waitingReview))}
  </section>`;
}

function renderStudioAdminMoney(operations) {
  const money = operations && operations.money && typeof operations.money === 'object' ? operations.money : {};
  const owed = money.owed && typeof money.owed === 'object' ? money.owed : {};
  const absorbed = money.absorbedOverspend && typeof money.absorbedOverspend === 'object' ? money.absorbedOverspend : {};
  const reconciliation = money.reconciliation && typeof money.reconciliation === 'object' ? money.reconciliation : {};
  const funds = money.studioFunds && typeof money.studioFunds === 'object' ? money.studioFunds : {};
  const margin = owed.fundsMinusOwedMinorUSD;
  return `<section class="studio-desk-box" data-testid="studio-admin-money"><h3 class="studio-desk-h3">${studioEsc(adsStudioText('Money', 'الأموال'))}</h3>
    ${renderStudioAdminLine(adsStudioText('USD owed to customers (wallets + in ads)', 'الدولارات المستحقة للعملاء (المحافظ + في الإعلانات)'), studioUsd(owed.owedMinorUSD), '', 'studio-admin-owed')}
    ${renderStudioAdminLine(adsStudioText('Studio ad-account funds', 'أموال الحسابات الإعلانية للاستوديو'), funds.fundsMinorUSD === null || funds.fundsMinorUSD === undefined ? (funds.allowlistConfigured === false ? adsStudioText('no allowlisted account', 'لا حساب في القائمة المسموحة') : adsStudioText('unreadable', 'غير مقروءة')) : studioUsd(funds.fundsMinorUSD))}
    ${renderStudioAdminLine(adsStudioText('Funds minus owed', 'الأموال ناقص المستحق'), margin === null || margin === undefined ? '—' : studioUsd(margin), margin === null || margin === undefined ? 'slate' : margin < 0 ? 'red' : 'green')}
    ${renderStudioAdminLine(adsStudioText('Absorbed overspend (this month / total)', 'الصرف الزائد المتحمَّل (هذا الشهر / الإجمالي)'), `${studioUsd(absorbed.thisMonthMinorUSD)} / ${studioUsd(absorbed.totalMinorUSD)}`)}
    ${renderStudioAdminLine(adsStudioText(`Reconciliation ${reconciliation.month || ''}: difference vs tolerance`, `المطابقة ${reconciliation.month || ''}: الفرق مقابل السماحية`), `${studioUsd(reconciliation.differenceMinorUSD)} / ${studioUsd(reconciliation.toleranceMinorUSD)}`, studioAdminOkTone(reconciliation.withinTolerance))}
    ${renderStudioAdminLine(adsStudioText('Open money incidents', 'حوادث أموال مفتوحة'), studioAdminNumber(money.openIncidents), Number(money.openIncidents) > 0 ? 'red' : 'green')}
  </section>`;
}

function renderStudioAdminGoNoGo(operations) {
  const go = operations && operations.goNoGo && typeof operations.goNoGo === 'object' ? operations.goNoGo : null;
  if (!go) return '';
  const rows = Object.entries(go.go && typeof go.go === 'object' ? go.go : {}).map(([key, row]) => {
    const label = STUDIO_ADMIN_GO_LABELS[key] ? adsStudioText(STUDIO_ADMIN_GO_LABELS[key][0], STUDIO_ADMIN_GO_LABELS[key][1]) : key;
    const ok = row && typeof row === 'object' ? row.ok : null;
    const value = row && typeof row === 'object' && row.value !== null && row.value !== undefined ? studioAdminNumber(row.value, 1) : '—';
    return renderStudioAdminLine(label, `${ok === true ? adsStudioText('go', 'متابعة') : ok === false ? adsStudioText('no-go', 'توقف') : adsStudioText('unknown', 'غير معروف')} · ${value}`, studioAdminOkTone(ok), `studio-admin-go-${key}`);
  });
  const stops = Object.entries(go.stop && typeof go.stop === 'object' ? go.stop : {}).map(([key, row]) => {
    const label = STUDIO_ADMIN_STOP_LABELS[key] ? adsStudioText(STUDIO_ADMIN_STOP_LABELS[key][0], STUDIO_ADMIN_STOP_LABELS[key][1]) : key;
    const fired = row && typeof row === 'object' ? row.fired : null;
    return renderStudioAdminLine(label, fired === true ? adsStudioText('FIRED', 'انطلقت') : fired === false ? adsStudioText('quiet', 'هادئة') : adsStudioText('unknown', 'غير معروف'), fired === true ? 'red' : fired === false ? 'green' : 'slate', `studio-admin-stop-${key}`);
  });
  const verdict = go.stopVerdict === true
    ? adsStudioText('A stop rule fired: pause intake and the customer layout, take a backup, investigate.', 'انطلقت قاعدة إيقاف: أوقف الاستقبال وواجهة العملاء، خذ نسخة احتياطية، وحقّق.')
    : go.goVerdict === true ? adsStudioText(`Every go row is green (needed ${go.consecutiveWeeksNeeded || 2} weeks in a row).`, `كل صفوف المتابعة خضراء (المطلوب ${go.consecutiveWeeksNeeded || 2} أسابيع متتالية).`)
      : go.goVerdict === false ? adsStudioText('At least one go row is red.', 'صف واحد على الأقل أحمر.')
        : adsStudioText(`Some rows are unknown (${Array.isArray(go.unknown) ? go.unknown.length : 0}); the owner ticks the manual ones.`, `بعض الصفوف غير معروفة (${Array.isArray(go.unknown) ? go.unknown.length : 0})؛ يحدّد المالك اليدوية منها.`);
  return `<section class="studio-desk-box" data-testid="studio-admin-gonogo" data-stop="${go.stopVerdict === true ? '1' : '0'}"><h3 class="studio-desk-h3">${studioEsc(adsStudioText('Pilot go/no-go', 'قرار المتابعة في التجربة'))}</h3><p class="studio-desk-note">${studioEsc(verdict)}</p>${rows.join('')}<h4 class="studio-desk-label">${studioEsc(adsStudioText('Stop rules', 'قواعد الإيقاف'))}</h4>${stops.join('')}</section>`;
}

function renderStudioAdminDiagnostics() {
  const slot = studioAdminRead('diagnostics', '/api/studio/admin/diagnostics');
  const refresh = `<button type="button" class="studio-v2-action studio-desk-small" data-testid="studio-admin-diagnostics-refresh" onclick="studioAdminRetry('diagnostics', '/api/studio/admin/diagnostics')"${slot.promise ? ' disabled' : ''}>${studioAdminIcon('refresh-cw')}<span>${studioEsc(adsStudioText('Refresh', 'تحديث'))}</span></button>`;
  const head = renderStudioAdminPageHead('diagnostics', refresh);
  const problem = renderStudioAdminProblem(slot, "studioAdminRetry('diagnostics', '/api/studio/admin/diagnostics')", 'studio-admin-diagnostics');
  if (problem) return head + problem;
  const report = slot.value || {};
  const operations = report.operations && typeof report.operations === 'object' ? report.operations : {};
  const meta = operations.meta && typeof operations.meta === 'object' ? operations.meta : {};
  const token = meta.token && typeof meta.token === 'object' ? meta.token : {};
  const storage = operations.storage && typeof operations.storage === 'object' ? operations.storage : {};
  const baselines = report.baselines && typeof report.baselines === 'object' ? report.baselines : {};
  const baselineNames = { B1: ['Submit → decision (median hours)', 'الإرسال ← القرار (الوسيط بالساعات)'], B2: ['Sent back for changes (%)', 'أُعيدت للتعديل (%)'], B3: ['Holds older than 14 days', 'حجوزات أقدم من 14 يوماً'], B4: ['Ended, unsettled 7+ days', 'انتهت ولم تُسوَّ منذ 7 أيام أو أكثر'], B5: ['Draft → submit (median hours)', 'المسودة ← الإرسال (الوسيط بالساعات)'], B6: ['Account → first approval (median hours)', 'الحساب ← أول موافقة (الوسيط بالساعات)'] };
  const baselineLines = Object.entries(baselineNames).map(([key, [en, ar]]) => {
    const row = baselines[key] && typeof baselines[key] === 'object' ? baselines[key] : null;
    return renderStudioAdminLine(`${key} · ${adsStudioText(en, ar)}`, row ? `${studioAdminNumber(row.value, 1)} (${adsStudioText(`sample ${studioAdminNumber(row.sample)}`, `العينة ${studioAdminNumber(row.sample)}`)})` : adsStudioText('no data yet', 'لا بيانات بعد'));
  });
  const tokenLine = token.configured === false
    ? adsStudioText('token check not set up', 'فحص الرمز غير مُعدّ')
    : token.checked ? `${token.isValid === true ? adsStudioText('valid', 'صالح') : adsStudioText('NOT valid', 'غير صالح')} · ${token.expiresNever ? adsStudioText('never expires', 'لا ينتهي') : adsStudioText(`${studioAdminNumber(token.daysLeft)} days left`, `بقي ${studioAdminNumber(token.daysLeft)} يوماً`)}` : adsStudioText('not checked yet', 'لم يُفحص بعد');
  const generated = report.generatedAt ? `<p class="studio-desk-note">${studioEsc(adsStudioText(`Generated ${studioAdminWhen(report.generatedAt)}. Counts only, no personal data.`, `أُنشئ ${studioAdminWhen(report.generatedAt)}. أرقام فقط، دون بيانات شخصية.`))}</p>` : '';
  return head + generated
    + renderStudioAdminScanRow()
    + renderStudioAdminJobs(report.jobs)
    + renderStudioAdminQueues(operations)
    + renderStudioAdminCapacity(operations)
    + renderStudioAdminMoney(operations)
    + renderStudioAdminGoNoGo(operations)
    + `<section class="studio-desk-box" data-testid="studio-admin-system"><h3 class="studio-desk-h3">${studioEsc(adsStudioText('Meta and storage', 'ميتا والتخزين'))}</h3>
        ${renderStudioAdminLine(adsStudioText('Meta token', 'رمز ميتا'), tokenLine, token.checked ? studioAdminOkTone(token.isValid === true) : 'slate', 'studio-admin-token')}
        ${renderStudioAdminLine(adsStudioText('Meta connection', 'اتصال ميتا'), meta.connection && meta.connection.state ? String(meta.connection.state).slice(0, 20) : adsStudioText('unknown', 'غير معروف'), meta.connection && meta.connection.state === 'down' ? 'red' : 'slate')}
        ${renderStudioAdminLine(adsStudioText('Database size', 'حجم قاعدة البيانات'), storage.databaseBytes === null || storage.databaseBytes === undefined ? '—' : studioAdminBytes(storage.databaseBytes))}
        ${renderStudioAdminLine(adsStudioText('Rows (all types)', 'الصفوف (كل الأنواع)'), studioAdminNumber(storage.totalRows))}
        ${renderStudioAdminLine(adsStudioText('Last backup', 'آخر نسخة احتياطية'), storage.backup && storage.backup.at ? `${studioAdminAgo(storage.backup.at)} (${studioAdminBytes(storage.backup.bytes)})` : adsStudioText('none recorded', 'لا شيء مسجل'))}
      </section>`
    + `<section class="studio-desk-box" data-testid="studio-admin-baselines"><h3 class="studio-desk-h3">${studioEsc(adsStudioText('Baselines B1–B6 (before the pilot)', 'خطوط الأساس B1–B6 (قبل التجربة)'))}</h3>${baselineLines.join('')}</section>`;
}

// ------------------------------------------------------------------ the on-demand money scan (P3-24)

// "Scan money now": POST /api/studio/admin/integrity/scan (admin, one per 10 minutes on the server),
// single flight; the answer's counts are shown and the diagnostics and alerts reads are asked again.
// A 429 shows the wait through the ONE error map (Retry-After); nothing else changes.
function studioAdminScanNow(button = null) {
  if (!studioAdminIsAdmin() || !studioAdminServer() || (_studioAdmin.scan && _studioAdmin.scan.promise)) return null;
  const slot = _studioAdmin.scan || (_studioAdmin.scan = { promise: null, value: null, error: null, at: 0 });
  if (button) setAdsStudioActionButtonBusy(button, true);
  const generation = _studioAdmin.generation;
  slot.promise = studioApi('/api/studio/admin/integrity/scan', { method: 'POST', body: {} }, { timeoutMs: 45000 }).then(reply => {
    if (generation !== _studioAdmin.generation) return null;
    const counts = reply && reply.counts && typeof reply.counts === 'object' ? reply.counts : {};
    slot.value = { total: Number.isSafeInteger(counts.total) && counts.total >= 0 ? counts.total : 0, scannedAt: String((reply && reply.scannedAt) || ''), alertId: String((reply && reply.alertId) || '') };
    slot.error = null;
    slot.at = Date.now();
    if (_studioAdmin.reads.diagnostics) studioAdminRead('diagnostics', '/api/studio/admin/diagnostics', true);
    if (_studioAdmin.reads.alerts) { _studioAdmin.alertsPages = []; studioAdminRead('alerts', '/api/studio/admin/alerts?limit=20', true); }
    if (typeof studioDeskPulseRefresh === 'function') studioDeskPulseRefresh();
    return slot.value;
  }, error => {
    if (generation !== _studioAdmin.generation) return null;
    slot.error = error && typeof error === 'object' ? error : new Error(String(error || 'Request failed'));  // its words are picked at draw time (the reader may switch language)
    slot.value = null;
    return null;
  }).finally(() => {
    if (generation !== _studioAdmin.generation) return;
    slot.promise = null;
    if (button) setAdsStudioActionButtonBusy(button, false);
    studioAdminRedraw();
  });
  studioAdminRedraw();
  return slot.promise;
}

function renderStudioAdminScanRow() {
  const slot = _studioAdmin.scan;
  let note = '';
  let tone = '';
  if (slot && slot.value) {
    const total = slot.value.total;
    tone = total ? 'red' : 'green';
    note = total
      ? adsStudioText(`Scan done: ${total} finding${total === 1 ? '' : 's'}. The alert is in the alerts list.`, `اكتمل الفحص: ${studioAdminArCount(total, 'مخالفة واحدة', 'مخالفتان', 'مخالفات', 'مخالفة')}. التنبيه في قائمة التنبيهات.`)
      : adsStudioText('Scan done: the money adds up, no finding.', 'اكتمل الفحص: الأموال متطابقة، لا مخالفات.');
  } else if (slot && slot.error) {
    tone = 'red';
    try { note = studioErrorInfo(slot.error, 'action').text || ''; } catch (_) { note = adsStudioText('The scan could not be run.', 'تعذّر تشغيل الفحص.'); }
  }
  return `
          <div class="studio-v2-list studio-admin-scan" data-testid="studio-admin-scan">
            <button type="button" class="studio-v2-row" data-testid="studio-admin-scan-now" onclick="studioAdminScanNow(this)"${slot && slot.promise ? ' disabled aria-busy="true"' : ''}>
              ${studioAdminIcon('scan-search')}
              <span class="studio-admin-row-text"><span class="studio-v2-row-label">${studioEsc(slot && slot.promise ? adsStudioText('Scanning…', 'جارٍ الفحص…') : adsStudioText('Scan money now', 'افحص الأموال الآن'))}</span><span class="studio-desk-note">${studioEsc(adsStudioText('The daily money check on demand: once every 10 minutes. Counts only.', 'فحص الأموال اليومي عند الطلب: مرة كل 10 دقائق. أرقام فقط.'))}</span></span>
            </button>
            ${note ? `<p class="studio-desk-line" data-tone="${studioEsc(tone)}" data-testid="studio-admin-scan-note" data-total="${slot && slot.value ? slot.value.total : ''}"><span class="studio-desk-line-label">${studioEsc(note)}</span></p>` : ''}
          </div>`;
}

function studioAdminArCount(count, one, two, few, many) {
  if (typeof studioDeskArCount === 'function') return studioDeskArCount(count, one, two, few, many);
  return count === 1 ? one : count === 2 ? two : `${count} ${count >= 3 && count <= 10 ? few : many}`;
}

// ------------------------------------------------------------------ the collision report (P0-10)

function studioAdminCollisionWhy(row) {
  if (row.kept) return adsStudioText("kept by the owner's signed choice", 'أُبقي بقرار المالك الموقّع');
  if (row.hasMoney) return adsStudioText('has money records (receipts, collections, wallet or funding): never removed by the script', 'له سجلات أموال (إيصالات أو تحصيلات أو محفظة أو تمويل): لا يحذفه السكربت أبداً');
  if (row.hasCustomer) return adsStudioText('has a customer: the owner decides', 'له عميل: يقرر المالك');
  if (row.removable && row.untouched) return adsStudioText('an untouched imported copy: removable', 'نسخة مستوردة لم تُمس: قابلة للحذف');
  return adsStudioText('removable after the owner\'s choice', 'قابل للحذف بعد قرار المالك');
}

function renderStudioAdminCollisions() {
  const slot = studioAdminRead('collisions', '/api/meta-ads/collisions');
  const refresh = `<button type="button" class="studio-v2-action studio-desk-small" data-testid="studio-admin-collisions-refresh" onclick="studioAdminRetry('collisions', '/api/meta-ads/collisions')"${slot.promise ? ' disabled' : ''}>${studioAdminIcon('refresh-cw')}<span>${studioEsc(adsStudioText('Refresh', 'تحديث'))}</span></button>`;
  const head = renderStudioAdminPageHead('collisions', refresh);
  const problem = renderStudioAdminProblem(slot, "studioAdminRetry('collisions', '/api/meta-ads/collisions')", 'studio-admin-collisions');
  if (problem) return head + problem;
  const report = slot.value || {};
  const counts = report.counts && typeof report.counts === 'object' ? report.counts : {};
  const rows = Array.isArray(report.rows) ? report.rows.filter(row => row && typeof row === 'object') : [];
  const byReason = counts.byReason && typeof counts.byReason === 'object' ? counts.byReason : {};
  const summary = `<section class="studio-desk-box" data-testid="studio-admin-collision-counts" data-total="${Number(counts.total) || 0}"><h3 class="studio-desk-h3">${studioEsc(adsStudioText('Counts', 'الأعداد'))}</h3>
    ${renderStudioAdminLine(adsStudioText('Core ads that belong to the studio', 'إعلانات المدير التابعة للاستوديو'), studioAdminNumber(counts.total), Number(counts.total) > 0 ? 'amber' : 'green')}
    ${renderStudioAdminLine(adsStudioText('Open (no owner decision yet)', 'مفتوحة (دون قرار من المالك بعد)'), studioAdminNumber(counts.open))}
    ${renderStudioAdminLine(adsStudioText('Kept by decision', 'أُبقيت بقرار'), studioAdminNumber(counts.kept))}
    ${renderStudioAdminLine(adsStudioText('Removable (untouched copies)', 'قابلة للحذف (نسخ لم تُمس)'), studioAdminNumber(counts.removable))}
    ${renderStudioAdminLine(adsStudioText('With money records', 'لها سجلات أموال'), studioAdminNumber(counts.withMoney))}
    ${renderStudioAdminLine(adsStudioText('With a customer', 'لها عميل'), studioAdminNumber(counts.withCustomer))}
    ${renderStudioAdminLine(adsStudioText('By reason: studio code in the name / linked campaign', 'بحسب السبب: رمز الاستوديو في الاسم / حملة مربوطة'), `${studioAdminNumber(byReason.studio_name)} / ${studioAdminNumber(byReason.studio_campaign_id)}`)}
    <p class="studio-desk-note">${studioEsc(adsStudioText('Nothing is changed from here. The owner runs scripts/studio_collision_repair.py with a signed choices file (dry run first); rows with money are never removed.', 'لا يتغير شيء من هنا. يشغّل المالك scripts/studio_collision_repair.py بملف قرارات موقّع (تجربة أولاً)؛ الصفوف التي لها أموال لا تُحذف أبداً.'))}</p>
  </section>`;
  const list = rows.length ? `<ul class="studio-desk-list" data-testid="studio-admin-collision-rows">${rows.slice(0, 200).map(row => {
    const reasons = (Array.isArray(row.reasons) ? row.reasons : []).map(code => STUDIO_ADMIN_COLLISION_REASONS[code] ? adsStudioText(STUDIO_ADMIN_COLLISION_REASONS[code][0], STUDIO_ADMIN_COLLISION_REASONS[code][1]) : String(code).slice(0, 40)).join(' · ');
    const spend = row.spend && typeof row.spend === 'object' ? row.spend : {};
    const requests = Array.isArray(row.studioRequestIds) ? row.studioRequestIds.map(String).slice(0, 5).join(', ') : '';
    return `<li class="studio-desk-box studio-admin-collision" data-testid="studio-admin-collision" data-kept="${row.kept ? '1' : '0'}" data-removable="${row.removable && !row.kept ? '1' : '0'}">
      <p class="studio-admin-alert-title">${studioAdminIcon(row.kept ? 'lock' : row.hasMoney ? 'shield-alert' : 'trash-2', 'studio-desk-meta-icon')}<span>${studioEsc(adsStudioText('Manager ad', 'إعلان المدير'))} <code class="studio-desk-code" dir="ltr">${studioEsc(String(row.adId || '').slice(0, 80))}</code></span></p>
      <p class="studio-desk-note">${studioEsc(reasons)}${requests ? ` · ${studioEsc(adsStudioText('studio request', 'طلب الاستوديو'))} <code class="studio-desk-code" dir="ltr">${studioEsc(requests)}</code>` : ''}</p>
      <p class="studio-desk-note">${studioEsc(studioAdminCollisionWhy(row))}${row.importState ? ` · ${studioEsc(String(row.importState).slice(0, 30))}` : ''}${Number(spend.metaSpendMinor) > 0 ? ` · ${studioEsc(adsStudioText('Meta spend', 'صرف ميتا'))} ${studioEsc(`${studioMinorText(spend.metaSpendMinor)} ${String(spend.metaCurrency || 'USD').slice(0, 3)}`)}` : ''}</p>
    </li>`;
  }).join('')}</ul>` : renderStudioDeskEmpty('check', adsStudioText('No collision: the core books hold no studio ad', 'لا تعارض: دفاتر المدير لا تحوي إعلان استوديو'), '', 'studio-admin-collisions-empty');
  return head + summary + list;
}

// ------------------------------------------------------------------ settings forms

function studioAdminSetting(key) {
  studioAdminScope();
  let slot = _studioAdmin.settings[key];
  if (!slot) {
    slot = { record: null, version: 0, raw: null, loading: null, error: '', serverMessage: '', conflict: '', saving: false, savedAt: 0, failedAt: 0, readError: null };
    _studioAdmin.settings[key] = slot;
  }
  return slot;
}

function studioAdminGet(value, path) {
  return String(path || '').split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), value);
}

// The typed value of one field as the text an input holds.
function studioAdminRawOf(kind, value) {
  if (kind === 'flag') return value === true ? '1' : '';
  if (kind === 'money') return Number.isSafeInteger(value) ? (value / 100).toFixed(2) : '';
  if (kind === 'ids') return Array.isArray(value) ? value.map(String).join('\n') : '';
  if (kind === 'days') return Array.isArray(value) ? value.map(String).join(', ') : '';
  return value === null || value === undefined ? '' : String(value);
}

function studioAdminRawFrom(key, value) {
  const raw = Object.create(null);
  const spec = STUDIO_ADMIN_SETTINGS[key];
  if (key === 'hours') {
    const week = value && value.week && typeof value.week === 'object' ? value.week : {};
    for (const [day] of STUDIO_ADMIN_WEEK) {
      const hours = week[day] && typeof week[day] === 'object' ? week[day] : null;
      raw[`week.${day}.on`] = hours ? '1' : '';
      raw[`week.${day}.open`] = hours ? String(hours.open || '09:00') : '09:00';
      raw[`week.${day}.close`] = hours ? String(hours.close || '17:00') : '17:00';
    }
    raw.holidays = (Array.isArray(value && value.holidays) ? value.holidays : []).filter(item => item && typeof item === 'object')
      .map(item => ({ date: String(item.date || ''), labelEn: String(item.labelEn || ''), labelAr: String(item.labelAr || '') }));
    const ramadan = value && value.ramadan && typeof value.ramadan === 'object' ? value.ramadan : null;
    raw['ramadan.on'] = ramadan ? '1' : '';
    raw['ramadan.from'] = ramadan ? String(ramadan.from || '') : '';
    raw['ramadan.to'] = ramadan ? String(ramadan.to || '') : '';
    raw['ramadan.open'] = ramadan ? String(ramadan.open || '09:00') : '09:00';
    raw['ramadan.close'] = ramadan ? String(ramadan.close || '15:00') : '15:00';
    raw.onDutyUntil = value && value.onDutyUntil ? String(value.onDutyUntil) : '';
    return raw;
  }
  for (const [path, kind] of spec.fields) raw[path] = studioAdminRawOf(kind, studioAdminGet(value, path));
  return raw;
}

function studioAdminLoadSetting(key, force = false) {
  const slot = studioAdminSetting(key);
  if (!studioAdminServer() || slot.loading) return slot;
  if (!force && slot.record) return slot;
  if (!force && slot.failedAt && Date.now() - slot.failedAt < STUDIO_ADMIN_RETRY_MS) return slot;
  const generation = _studioAdmin.generation;
  const signal = studioReadSignal();
  slot.loading = studioApi(`/api/studio/admin/settings/${encodeURIComponent(key)}`, { method: 'GET' }).then(raw => {
    if (generation !== _studioAdmin.generation) return;
    const record = raw && typeof raw === 'object' ? raw : {};
    slot.record = record;
    slot.version = Number.isSafeInteger(record.version) ? record.version : 0;
    slot.raw = studioAdminRawFrom(key, record.value && typeof record.value === 'object' ? record.value : {});
    slot.readError = null;
    slot.failedAt = 0;
    slot.conflict = '';
    slot.error = '';
    slot.serverMessage = '';
  }, error => {
    if (generation !== _studioAdmin.generation || studioReadCancelled(error, signal)) return;
    slot.failedAt = Date.now();
    slot.readError = (error && error.studio) || studioErrorInfo(error, 'read');
  }).finally(() => {
    if (generation !== _studioAdmin.generation) return;
    slot.loading = null;
    studioAdminRedraw();
  });
  return slot;
}

function studioAdminReload(key) {
  studioAdminLoadSetting(String(key || ''), true);
  studioAdminRedraw();
}

function studioAdminInput(key, path, input) {
  const slot = studioAdminSetting(key);
  if (!slot.raw) return;
  const field = input && input.type === 'checkbox' ? (input.checked ? '1' : '') : String((input && input.value) || '');
  slot.raw[String(path)] = field.slice(0, 20000);
  if (slot.savedAt) slot.savedAt = 0;
}

function studioAdminHolidayInput(key, index, field, input) {
  const slot = studioAdminSetting(key);
  const list = slot.raw && Array.isArray(slot.raw.holidays) ? slot.raw.holidays : null;
  if (!list || !list[index] || !['date', 'labelEn', 'labelAr'].includes(field)) return;
  list[index][field] = String((input && input.value) || '').slice(0, 60);
}

function studioAdminHolidayAdd(key) {
  const slot = studioAdminSetting(key);
  if (!slot.raw) return;
  if (!Array.isArray(slot.raw.holidays)) slot.raw.holidays = [];
  if (slot.raw.holidays.length >= 60) return;
  slot.raw.holidays.push({ date: '', labelEn: '', labelAr: '' });
  studioAdminRedraw();
}

function studioAdminHolidayRemove(key, index) {
  const slot = studioAdminSetting(key);
  if (!slot.raw || !Array.isArray(slot.raw.holidays)) return;
  slot.raw.holidays.splice(Number(index), 1);
  studioAdminRedraw();
}

// The typed value of one field from its text, or {error} in the reader's language.
function studioAdminValueOf(kind, raw, label, range) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim();
  if (kind === 'flag') return { value: text === '1' };
  if (kind === 'readonly') return { skip: true };
  if (kind === 'mode' || kind === 'select') return { value: text };
  if (kind === 'whole') {
    const number = Number(normalizeDigitsAscii(text));
    if (!text || !Number.isSafeInteger(number)) return { error: adsStudioText(`${label}: enter a whole number.`, `${label}: أدخل عدداً صحيحاً.`) };
    if (Array.isArray(range) && (number < range[0] || number > range[1])) return { error: adsStudioText(`${label}: must be from ${range[0]} to ${range[1]}.`, `${label}: يجب أن يكون من ${range[0]} إلى ${range[1]}.`) };
    return { value: number };
  }
  if (kind === 'money') {
    const minor = studioParseAmount(text);
    if (!Number.isSafeInteger(minor)) return { error: adsStudioText(`${label}: enter an amount in dollars, for example 5 or 12.50.`, `${label}: أدخل مبلغاً بالدولار، مثل 5 أو 12.50.`) };
    return { value: minor };
  }
  if (kind === 'ids') {
    const ids = text.split(/[\s,;]+/).map(item => item.trim()).filter(Boolean);
    const bad = ids.find(id => !Security.isValidRecordId(id));
    if (bad) return { error: adsStudioText(`${label}: "${bad.slice(0, 30)}" is not a user id.`, `${label}: «${bad.slice(0, 30)}» ليس معرّف مستخدم.`) };
    return { value: Array.from(new Set(ids)).slice(0, 200) };
  }
  if (kind === 'days') {
    const numbers = text.split(/[\s,،;]+/).filter(Boolean).map(item => Number(normalizeDigitsAscii(item)));
    if (!numbers.length || numbers.length > 5 || numbers.some(number => !Number.isSafeInteger(number) || number < 1 || number > 60)) return { error: adsStudioText(`${label}: 1 to 5 whole numbers from 1 to 60.`, `${label}: من رقم إلى 5 أرقام صحيحة من 1 إلى 60.`) };
    return { value: numbers };
  }
  if (kind === 'phone') {
    if (!text) return { value: null };
    const phone = studioParsePhone(text);
    if (!phone) return { error: adsStudioText(`${label}: not a phone number we can use (international form, e.g. +218912345678).`, `${label}: ليس رقماً صالحاً (بالصيغة الدولية، مثل +218912345678).`) };
    return { value: phone };
  }
  if (kind === 'email') {
    if (!text) return { value: null };
    if (text.length > 254 || !/^[^\s@<>"']+@[^\s@<>"']+\.[A-Za-z]{2,}$/.test(text)) return { error: adsStudioText(`${label}: not an email address.`, `${label}: ليس عنوان بريد.`) };
    return { value: text };
  }
  return { value: text };
}

function studioAdminBuildValue(key, slot) {
  const raw = slot.raw || {};
  if (key === 'hours') {
    const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
    const day = /^\d{4}-\d{2}-\d{2}$/;
    const week = {};
    for (const [name, en, ar] of STUDIO_ADMIN_WEEK) {
      if (raw[`week.${name}.on`] !== '1') { week[name] = null; continue; }
      const open = String(raw[`week.${name}.open`] || '');
      const close = String(raw[`week.${name}.close`] || '');
      if (!clock.test(open) || !clock.test(close) || open >= close) return { error: adsStudioText(`${en}: opening and closing times as HH:MM, closing later than opening.`, `${ar}: وقت الفتح والإغلاق بصيغة HH:MM، والإغلاق بعد الفتح.`) };
      week[name] = { open, close };
    }
    if (!Object.values(week).some(Boolean)) return { error: adsStudioText('Keep at least one working day.', 'أبقِ يوم عمل واحداً على الأقل.') };
    const holidays = [];
    for (const item of Array.isArray(raw.holidays) ? raw.holidays : []) {
      if (!day.test(item.date)) return { error: adsStudioText('Every holiday needs a date (YYYY-MM-DD).', 'كل عطلة تحتاج تاريخاً (YYYY-MM-DD).') };
      if (!item.labelEn.trim() || !item.labelAr.trim()) return { error: adsStudioText(`Holiday ${item.date}: give it a name in English and in Arabic.`, `العطلة ${item.date}: أعطها اسماً بالإنجليزية وبالعربية.`) };
      holidays.push({ date: item.date, labelEn: item.labelEn.trim().slice(0, 60), labelAr: item.labelAr.trim().slice(0, 60) });
    }
    let ramadan = null;
    if (raw['ramadan.on'] === '1') {
      const from = String(raw['ramadan.from'] || '');
      const to = String(raw['ramadan.to'] || '');
      const open = String(raw['ramadan.open'] || '');
      const close = String(raw['ramadan.close'] || '');
      if (!day.test(from) || !day.test(to) || !clock.test(open) || !clock.test(close) || open >= close) return { error: adsStudioText('Ramadan: first and last day (YYYY-MM-DD) and the hours (HH:MM).', 'رمضان: أول يوم وآخره (YYYY-MM-DD) والساعات (HH:MM).') };
      ramadan = { from, to, open, close };
    }
    const onDuty = String(raw.onDutyUntil || '').trim();
    if (onDuty && !clock.test(onDuty)) return { error: adsStudioText('On duty until: a time as HH:MM, or empty.', 'المناوبة حتى: وقت بصيغة HH:MM، أو فارغ.') };
    return { value: { week, holidays, ramadan, onDutyUntil: onDuty || null } };
  }
  const value = {};
  for (const [path, kind, [en, ar], , options] of STUDIO_ADMIN_SETTINGS[key].fields) {
    const out = studioAdminValueOf(kind, raw[path], adsStudioText(en, ar), Array.isArray(options) && typeof options[0] === 'number' ? options : null);
    if (out.error) return { error: out.error };
    if (out.skip) continue;
    const parts = path.split('.');
    let node = value;
    for (const part of parts.slice(0, -1)) node = node[part] = node[part] && typeof node[part] === 'object' ? node[part] : {};
    node[parts[parts.length - 1]] = out.value;
  }
  return { value };
}

function studioAdminSave(key) {
  const name = String(key || '');
  if (!STUDIO_ADMIN_SETTING_KEYS.includes(name)) return Promise.resolve(false);
  const slot = studioAdminSetting(name);
  if (slot.saving || !slot.raw) return Promise.resolve(false);
  const built = studioAdminBuildValue(name, slot);
  if (built.error) {
    slot.error = built.error;
    slot.serverMessage = '';
    studioAdminRedraw();
    return Promise.resolve(false);
  }
  if (!studioAdminServer()) {
    slot.error = adsStudioText('Saving needs the connection to Albayan.', 'الحفظ يحتاج الاتصال بالبيان.');
    studioAdminRedraw();
    return Promise.resolve(false);
  }
  slot.saving = true;
  slot.error = '';
  slot.serverMessage = '';
  slot.conflict = '';
  studioAdminRedraw();
  const generation = _studioAdmin.generation;
  return studioApi(`/api/studio/admin/settings/${encodeURIComponent(name)}`, { method: 'PUT', body: { expectedVersion: slot.version, value: built.value } }).then(saved => {
    if (generation !== _studioAdmin.generation) return false;
    const record = saved && typeof saved === 'object' ? saved : {};
    slot.record = record;
    slot.version = Number.isSafeInteger(record.version) ? record.version : slot.version + 1;
    slot.raw = studioAdminRawFrom(name, record.value && typeof record.value === 'object' ? record.value : built.value);
    slot.savedAt = Date.now();
    if (name === 'rollout' || name === 'contact' || name === 'hours' || name === 'limits' || name === 'intake') { try { studioLoadMe(0); } catch (_) {} }
    return true;
  }, error => {
    if (generation !== _studioAdmin.generation) return false;
    const info = (error && error.studio) || studioErrorInfo(error, 'action');
    if (info.code === 'VERSION_CONFLICT' || info.code === 'STAFF_DESK_IN_USE') {
      slot.conflict = info.code;
      slot.error = info.text;
    } else if (['INVALID_VALUE', 'UNKNOWN_FIELD', 'INVALID_REQUEST'].includes(info.code)) {
      slot.error = adsStudioText('The server refused this value:', 'رفض الخادم هذه القيمة:');
      slot.serverMessage = String(info.message || '').slice(0, 300);
    } else {
      slot.error = info.text;
    }
    return false;
  }).finally(() => {
    if (generation !== _studioAdmin.generation) return;
    slot.saving = false;
    studioAdminRedraw();
  });
}

function renderStudioAdminField(key, [path, kind, [en, ar], [hintEn, hintAr], options], raw) {
  const id = `studio-admin-${key}-${path.replace(/\./g, '-')}`;
  const value = raw[path] === undefined ? '' : String(raw[path]);
  const label = adsStudioText(en, ar);
  const hint = `<span class="studio-desk-note">${studioEsc(adsStudioText(hintEn, hintAr))}</span>`;
  const on = `oninput="studioAdminInput('${key}', '${studioEsc(path)}', this)"`;
  let control;
  if (kind === 'flag') {
    control = `<label class="studio-admin-flag" for="${id}"><input id="${id}" type="checkbox" data-testid="${id}" ${value === '1' ? 'checked ' : ''}onchange="studioAdminInput('${key}', '${studioEsc(path)}', this)" /><span>${studioEsc(label)}</span></label>${hint}`;
    return `<div class="studio-admin-field" data-field="${studioEsc(path)}">${control}</div>`;
  }
  if (kind === 'mode' || kind === 'select') {
    const choices = (Array.isArray(options) ? options : []).map(option => `<option value="${studioEsc(option)}"${option === value ? ' selected' : ''}>${studioEsc(option)}</option>`).join('');
    control = `<select id="${id}" class="studio-desk-input" data-testid="${id}" onchange="studioAdminInput('${key}', '${studioEsc(path)}', this)" dir="ltr">${choices}</select>`;
  } else if (kind === 'ids') {
    control = `<textarea id="${id}" class="studio-desk-input" rows="3" data-testid="${id}" dir="ltr" ${on}>${studioEsc(value)}</textarea>`;
  } else if (kind === 'readonly') {
    control = `<p class="studio-desk-line-value" data-testid="${id}" dir="ltr">${studioEsc(value || '—')}</p>`;
  } else {
    const mode = kind === 'whole' ? 'numeric' : kind === 'money' ? 'decimal' : kind === 'phone' ? 'tel' : kind === 'email' ? 'email' : 'text';
    control = `<input id="${id}" class="studio-desk-input" type="text" inputmode="${mode}" autocomplete="off" dir="ltr" maxlength="${kind === 'days' ? 40 : 254}" value="${studioEsc(value)}" data-testid="${id}" ${on} />`;
  }
  return `<div class="studio-admin-field" data-field="${studioEsc(path)}"><label class="studio-desk-label" for="${id}">${studioEsc(label)}</label>${control}${hint}</div>`;
}

function renderStudioAdminHoursForm(key, raw) {
  const clockInput = (path, testId) => `<input id="studio-admin-hours-${path.replace(/\./g, '-')}" class="studio-desk-input studio-admin-clock" type="time" data-testid="${testId}" value="${studioEsc(String(raw[path] || ''))}" oninput="studioAdminInput('${key}', '${path}', this)" dir="ltr" />`;
  const week = STUDIO_ADMIN_WEEK.map(([day, en, ar]) => {
    const on = raw[`week.${day}.on`] === '1';
    return `<div class="studio-admin-day" data-day="${day}" data-open="${on ? '1' : '0'}">
      <label class="studio-admin-flag" for="studio-admin-hours-week-${day}-on"><input id="studio-admin-hours-week-${day}-on" type="checkbox" data-testid="studio-admin-hours-${day}" ${on ? 'checked ' : ''}onchange="studioAdminInput('${key}', 'week.${day}.on', this); studioAdminRedraw();" /><span>${studioEsc(adsStudioText(en, ar))}</span></label>
      ${on ? `<div class="studio-admin-times">${clockInput(`week.${day}.open`, `studio-admin-hours-${day}-open`)}<span>–</span>${clockInput(`week.${day}.close`, `studio-admin-hours-${day}-close`)}</div>` : `<span class="studio-desk-note">${studioEsc(adsStudioText('closed', 'مغلق'))}</span>`}
    </div>`;
  }).join('');
  const holidays = (Array.isArray(raw.holidays) ? raw.holidays : []).map((item, index) => `<div class="studio-admin-holiday" data-testid="studio-admin-holiday">
      <input id="studio-admin-holiday-${index}-date" class="studio-desk-input" type="date" value="${studioEsc(item.date)}" dir="ltr" aria-label="${studioEsc(adsStudioText('Date', 'التاريخ'))}" oninput="studioAdminHolidayInput('${key}', ${index}, 'date', this)" />
      <input id="studio-admin-holiday-${index}-en" class="studio-desk-input" type="text" maxlength="60" value="${studioEsc(item.labelEn)}" placeholder="${studioEsc(adsStudioText('Name (English)', 'الاسم (بالإنجليزية)'))}" oninput="studioAdminHolidayInput('${key}', ${index}, 'labelEn', this)" />
      <input id="studio-admin-holiday-${index}-ar" class="studio-desk-input" type="text" maxlength="60" value="${studioEsc(item.labelAr)}" placeholder="${studioEsc(adsStudioText('Name (Arabic)', 'الاسم (بالعربية)'))}" dir="rtl" oninput="studioAdminHolidayInput('${key}', ${index}, 'labelAr', this)" />
      <button type="button" class="studio-v2-action studio-desk-small" aria-label="${studioEsc(adsStudioText('Remove this holiday', 'احذف هذه العطلة'))}" onclick="studioAdminHolidayRemove('${key}', ${index})">${studioAdminIcon('trash-2')}</button>
    </div>`).join('');
  const ramadanOn = raw['ramadan.on'] === '1';
  return `
        <h3 class="studio-desk-h3">${studioEsc(adsStudioText('The week (Tripoli time)', 'الأسبوع (بتوقيت طرابلس)'))}</h3>
        <div class="studio-admin-week" data-testid="studio-admin-week">${week}</div>
        <h3 class="studio-desk-h3">${studioEsc(adsStudioText('Holidays (closed all day)', 'العطل (مغلق طوال اليوم)'))}</h3>
        <div class="studio-admin-holidays" data-testid="studio-admin-holidays">${holidays || `<p class="studio-desk-note">${studioEsc(adsStudioText('No holiday yet.', 'لا عطلة بعد.'))}</p>`}</div>
        <button type="button" class="studio-v2-action studio-desk-small" data-testid="studio-admin-holiday-add" onclick="studioAdminHolidayAdd('${key}')">${studioAdminIcon('plus')}<span>${studioEsc(adsStudioText('Add a holiday', 'أضف عطلة'))}</span></button>
        <h3 class="studio-desk-h3">${studioEsc(adsStudioText('Ramadan hours', 'ساعات رمضان'))}</h3>
        <label class="studio-admin-flag" for="studio-admin-hours-ramadan-on"><input id="studio-admin-hours-ramadan-on" type="checkbox" data-testid="studio-admin-ramadan" ${ramadanOn ? 'checked ' : ''}onchange="studioAdminInput('${key}', 'ramadan.on', this); studioAdminRedraw();" /><span>${studioEsc(adsStudioText('Different hours during Ramadan', 'ساعات مختلفة في رمضان'))}</span></label>
        ${ramadanOn ? `<div class="studio-admin-times studio-admin-ramadan">
          <input id="studio-admin-hours-ramadan-from" class="studio-desk-input" type="date" value="${studioEsc(String(raw['ramadan.from'] || ''))}" dir="ltr" aria-label="${studioEsc(adsStudioText('First day', 'أول يوم'))}" oninput="studioAdminInput('${key}', 'ramadan.from', this)" />
          <input id="studio-admin-hours-ramadan-to" class="studio-desk-input" type="date" value="${studioEsc(String(raw['ramadan.to'] || ''))}" dir="ltr" aria-label="${studioEsc(adsStudioText('Last day', 'آخر يوم'))}" oninput="studioAdminInput('${key}', 'ramadan.to', this)" />
          ${clockInput('ramadan.open', 'studio-admin-ramadan-open')}<span>–</span>${clockInput('ramadan.close', 'studio-admin-ramadan-close')}
        </div>` : ''}
        <span class="studio-desk-note">${studioEsc(adsStudioText('At most 31 days; the hours replace the week\'s on those days.', '31 يوماً كحد أقصى؛ تحل الساعات محل ساعات الأسبوع في تلك الأيام.'))}</span>
        <div class="studio-admin-field"><label class="studio-desk-label" for="studio-admin-hours-onDutyUntil">${studioEsc(adsStudioText('On duty until (urgent WhatsApp line)', 'المناوبة حتى (خط واتساب العاجل)'))}</label>
          <input id="studio-admin-hours-onDutyUntil" class="studio-desk-input studio-admin-clock" type="time" data-testid="studio-admin-hours-onduty" value="${studioEsc(String(raw.onDutyUntil || ''))}" dir="ltr" oninput="studioAdminInput('${key}', 'onDutyUntil', this)" />
          <span class="studio-desk-note">${studioEsc(adsStudioText('Empty = no urgent line after hours. D29 suggests 23:00.', 'فارغ = لا خط عاجل بعد الدوام. توصية D29: 23:00.'))}</span></div>`;
}

function renderStudioAdminSetting(key) {
  const name = String(key || '');
  if (!STUDIO_ADMIN_SETTING_KEYS.includes(name)) return renderStudioAdminMenu();
  const slot = studioAdminLoadSetting(name);
  const spec = STUDIO_ADMIN_SETTINGS[name];
  const page = `settings-${name}`;
  const head = renderStudioAdminPageHead(page);
  const about = `<p class="studio-desk-note studio-admin-about" data-testid="studio-admin-about">${studioEsc(adsStudioText(spec.about[0], spec.about[1]))}</p>`;
  if (!slot.raw) {
    if (slot.readError && !slot.loading) {
      return head + about + `<div class="studio-desk-problem" role="alert" data-testid="studio-admin-setting-problem"><p>${studioEsc(slot.readError.text || '')}</p><button type="button" class="studio-v2-action studio-desk-small" onclick="studioAdminReload('${name}')">${studioEsc(adsStudioText('Try again', 'أعد المحاولة'))}</button></div>`;
    }
    return head + about + `<p class="studio-desk-note" data-testid="studio-admin-setting-loading">${studioEsc(adsStudioText('Reading the setting…', 'نقرأ الإعداد…'))}</p>`;
  }
  const raw = slot.raw;
  const fields = name === 'hours' ? renderStudioAdminHoursForm(name, raw) : spec.fields.map(field => renderStudioAdminField(name, field, raw)).join('');
  const env = name === 'rollout' && slot.record && slot.record.envSwitch
    ? `<p class="studio-desk-note" data-testid="studio-admin-env">${studioEsc(adsStudioText(`Server switch ALBAYAN_STUDIO_V2 = ${String(slot.record.envSwitch).slice(0, 10)}: "off" hides the new layout whatever is saved here.`, `مفتاح الخادم ALBAYAN_STUDIO_V2 = ${String(slot.record.envSwitch).slice(0, 10)}: «off» يخفي الواجهة الجديدة مهما حُفظ هنا.`))}</p>`
    : '';
  const conflict = slot.conflict
    ? `<div class="studio-desk-problem" role="alert" data-testid="studio-admin-conflict" data-code="${studioEsc(slot.conflict)}"><p>${studioEsc(slot.error)}</p><button type="button" class="studio-v2-action studio-desk-small" data-testid="studio-admin-reload" onclick="studioAdminReload('${name}')">${studioAdminIcon('refresh-cw')}<span>${studioEsc(adsStudioText('Reload the setting (your edits are dropped)', 'أعد تحميل الإعداد (تُلغى تعديلاتك)'))}</span></button></div>`
    : slot.error
      ? `<div class="studio-desk-problem" role="alert" data-testid="studio-admin-error"><p>${studioEsc(slot.error)}</p>${slot.serverMessage ? `<p class="studio-desk-code" dir="ltr" data-testid="studio-admin-server-message">${studioEsc(slot.serverMessage)}</p>` : ''}</div>`
      : '';
  const saved = slot.savedAt && !slot.error ? `<p class="studio-desk-line" data-tone="green" data-testid="studio-admin-saved" data-version="${slot.version}"><span class="studio-desk-line-label">${studioEsc(adsStudioText(`Saved as version ${slot.version}.`, `حُفظ كنسخة ${slot.version}.`))}</span></p>` : '';
  const updated = slot.record && slot.record.updatedAt ? adsStudioText(`Version ${slot.version}, saved ${studioAdminWhen(slot.record.updatedAt)}.`, `النسخة ${slot.version}، حُفظت ${studioAdminWhen(slot.record.updatedAt)}.`) : adsStudioText('Never saved: the defaults are shown.', 'لم يُحفظ قط: تظهر القيم الافتراضية.');
  return head + about + env + `
          <form class="studio-desk-box studio-admin-form" data-testid="studio-admin-form-${name}" data-version="${slot.version}" onsubmit="event.preventDefault(); studioAdminSave('${name}');">
            <p class="studio-desk-note" data-testid="studio-admin-version">${studioEsc(updated)}</p>
            ${fields}
            ${conflict}
            ${saved}
            <div class="studio-desk-actions">
              <button type="submit" class="studio-v2-action is-primary" data-testid="studio-admin-save"${slot.saving || slot.conflict ? ' disabled aria-busy="true"' : ''}>${studioAdminIcon('save')}<span>${studioEsc(slot.saving ? adsStudioText('Saving…', 'جارٍ الحفظ…') : adsStudioText('Save', 'حفظ'))}</span></button>
              <button type="button" class="studio-v2-action" data-testid="studio-admin-discard" onclick="studioAdminReload('${name}')"${slot.saving ? ' disabled' : ''}>${studioEsc(adsStudioText('Discard changes', 'تجاهل التعديلات'))}</button>
            </div>
          </form>`;
}

// ------------------------------------------------------------------ the alert channel test (P3-21)

function studioAdminAlertTest(button = null) {
  if (!studioAdminIsAdmin() || _studioAdmin.reads.alertTest && _studioAdmin.reads.alertTest.promise) return null;
  const slot = _studioAdmin.reads.alertTest || (_studioAdmin.reads.alertTest = { value: null, loadedAt: 0, failedAt: 0, error: null, promise: null });
  if (button) setAdsStudioActionButtonBusy(button, true);
  const generation = _studioAdmin.generation;
  slot.promise = studioApi('/api/studio/admin/alert-channel/test', { method: 'POST', body: {} }, { timeoutMs: 45000 }).then(reply => {
    if (generation !== _studioAdmin.generation) return;
    slot.value = reply && typeof reply === 'object' ? reply : {};
    slot.error = null;
    slot.loadedAt = Date.now();
  }, error => {
    if (generation !== _studioAdmin.generation) return;
    slot.error = (error && error.studio) || studioErrorInfo(error, 'action');
    slot.value = null;
  }).finally(() => {
    if (generation !== _studioAdmin.generation) return;
    slot.promise = null;
    if (button) setAdsStudioActionButtonBusy(button, false);
    studioAdminRedraw();
  });
  return slot.promise;
}

function renderStudioAdminAlertTestRow() {
  const slot = _studioAdmin.reads.alertTest;
  let note = '';
  if (slot && slot.value) {
    note = slot.value.sent ? adsStudioText('Sent: the staff channel received the test alert.', 'أُرسل: وصل التنبيه التجريبي إلى قناة الفريق.')
      : slot.value.configured === false ? adsStudioText('No staff channel is configured on the server (ALBAYAN_ALERT_WEBHOOK_URL).', 'لا قناة للفريق مُعدّة على الخادم (ALBAYAN_ALERT_WEBHOOK_URL).')
        : adsStudioText('The channel did not accept the test alert.', 'لم تقبل القناة التنبيه التجريبي.');
  } else if (slot && slot.error) note = slot.error.text || '';
  return `
          <div class="studio-v2-list studio-admin-alert-test" data-testid="studio-admin-alert-test">
            <button type="button" class="studio-v2-row" data-testid="studio-admin-alert-test-button" onclick="studioAdminAlertTest(this)"${slot && slot.promise ? ' disabled aria-busy="true"' : ''}>
              ${studioAdminIcon('radio')}
              <span class="studio-admin-row-text"><span class="studio-v2-row-label">${studioEsc(adsStudioText('Send a test alert to the staff channel', 'أرسل تنبيهاً تجريبياً إلى قناة الفريق'))}</span><span class="studio-desk-note">${studioEsc(adsStudioText('Once every 10 minutes. No customer data.', 'مرة كل 10 دقائق. دون بيانات العملاء.'))}</span></span>
            </button>
            ${note ? `<p class="studio-desk-note studio-admin-alert-test-note" data-testid="studio-admin-alert-test-note" data-sent="${slot && slot.value && slot.value.sent ? '1' : '0'}">${studioEsc(note)}</p>` : ''}
          </div>`;
}

// ------------------------------------------------------------------ the More section (called by 15p)

function renderStudioAdminMore(route) {
  studioAdminScope();
  if (!studioAdminIsAdmin()) {
    return `<p class="studio-desk-note" data-testid="studio-admin-reviewer">${studioEsc(adsStudioText('Payments, alerts, diagnostics and the settings are admin tools.', 'المدفوعات والتنبيهات والتشخيص والإعدادات أدوات للمدير.'))}</p>`;
  }
  const id = String((route && route.id) || '');
  if (!id) return renderStudioAdminMenu() + renderStudioAdminAlertTestRow();
  if (id === 'payments') return renderStudioAdminPayments();
  if (id === 'alerts') return renderStudioAdminAlerts();
  if (id === 'diagnostics') return renderStudioAdminDiagnostics();
  if (id === 'collisions') return renderStudioAdminCollisions();
  if (id.startsWith('settings-')) return renderStudioAdminSetting(id.slice(9));
  return renderStudioAdminMenu() + renderStudioAdminAlertTestRow();
}
