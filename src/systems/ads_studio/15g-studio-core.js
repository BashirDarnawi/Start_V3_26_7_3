// ==========================================
// ALBAYAN STUDIO v2 — CORE (plan task P2-01, studio.js lazy bundle)
// ==========================================
// Shared helpers for the v2 screens (the 15h shell and the screens after it). Nothing in this file
// draws a screen, and nothing runs while the bundle loads: every helper waits to be called.
// - studioApi(): apiJson with the studio error map attached (error.studio = studioErrorInfo(error)).
//   ONE lookup for every refusal: the /api/studio codes (studio_errors.py) in STUDIO_ERROR_TEXTS,
//   the older routes' English prefixes through the classic map (adsStudioRefusalText, 15c, reused,
//   never copied; STUDIO_ERROR_PATTERNS holds the few it lacks), 429 by its status (it has no
//   body), and a calm fallback that never shows raw English to an Arabic reader.
// - studioReadSignal() / studioReadCancelled(): a read the app cancelled by moving on is no
//   failure; a read cut off by its timeout is one.
// - studioMe() / studioLoadMe(): GET /api/studio/me, cleaned, kept per user; a reply younger than
//   maxAge is reused and a read already on its way is joined (one request at a time).
// - studioPulseWatch(): a light poller hook for a {changedAt} route: it polls only while the page is
//   visible and keeps no timer at all while the tab is hidden.
// - studioStageView(): the server's display stage (derive_display_stage) made safe to show. The
//   stage keys, looks and flag labels are checked against server/systems/ads_studio/stage_cases.json.
// - studioUsd() / studioLyd(): money in its own currency (LYD never wears "$").
// - studioParseAmount() / studioParsePhone(): typed amounts (Arabic digits, ٫ and , decimals,
//   thousands separators; a mix that could mean two amounts is refused) and phone numbers (E.164;
//   the Libyan 09x / 218 / 00218 forms, a mobile with all nine digits).

function studioEsc(value) {
  return Security.escapeHtml(String(value === null || value === undefined ? '' : value));
}

// A short piece of text left to right inside Arabic (amounts, phone numbers), escaped.
function studioLtr(text) {
  return `<bdi dir="ltr">${studioEsc(text)}</bdi>`;
}

// The {en, ar} pair the server sends, in the reader's language (the other language when one is
// missing); '' when neither is a usable string. Control characters are dropped; callers escape.
function studioPickText(labels, max = 300) {
  if (!labels || typeof labels !== 'object') return '';
  const pick = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
  const first = adsStudioIsAr() ? pick(labels.ar) : pick(labels.en);
  return first || pick(labels.en) || pick(labels.ar);
}

// ------------------------------------------------------------------ refusals (P2-01, P2-11)

// Every /api/studio code (studio_errors.py STUDIO_ERROR_CODES; a check keeps the two in step) and the
// client's own cases (no server code: by HTTP status or a lost connection). [English, Arabic].
const STUDIO_ERROR_TEXTS = Object.freeze({
  INVALID_REQUEST: ['Something in this form is not valid. Check it and try again.', 'في هذا النموذج شيء غير صالح. راجعه وأعد المحاولة.'],
  UNKNOWN_FIELD: ['This screen is out of date. Reload the page and try again.', 'هذه الشاشة قديمة. أعد تحميل الصفحة ثم حاول مرة أخرى.'],
  INVALID_VALUE: ['One of the values is not allowed. Check it and try again.', 'إحدى القيم غير مسموح بها. راجعها وأعد المحاولة.'],
  CROSS_SITE: ['Open Albayan directly and try again.', 'افتح البيان مباشرة ثم أعد المحاولة.'],
  ADMIN_ONLY: ['Only an admin can do this.', 'هذا الإجراء للمدير فقط.'],
  UNKNOWN_SETTING: ['This setting does not exist. Reload the page.', 'هذا الإعداد غير موجود. أعد تحميل الصفحة.'],
  VERSION_CONFLICT: ['Someone saved a newer version first. Reload and try again.', 'حفظ شخص آخر نسخة أحدث أولاً. أعد التحميل وحاول مرة أخرى.'],
  RATE_LIMITED: ['Too many requests. Please wait a minute and try again.', 'طلبات كثيرة. انتظر دقيقة ثم أعد المحاولة.'],
  UNKNOWN_PAGE: ['This page is no longer linked.', 'هذه الصفحة لم تعد مربوطة.'],
  NOT_INSTAGRAM: ['This linked page is not an Instagram account.', 'هذه الصفحة المربوطة ليست حساب إنستغرام.'],
  ALREADY_TESTED_TODAY: ['Already tested today. Try again tomorrow (Tripoli time).', 'تم الاختبار اليوم. أعد المحاولة غداً (بتوقيت طرابلس).'],
  META_NOT_CONFIGURED: ["Albayan's Meta connection is not set up yet.", 'ربط البيان مع ميتا غير مُعدّ بعد.'],
  META_PAUSED: ['Meta asked Albayan to wait. Try again in a few minutes.', 'طلبت ميتا من البيان الانتظار. أعد المحاولة بعد بضع دقائق.'],
  UNKNOWN_CAMPAIGN: ['This request was not found. Refresh the page.', 'لم نجد هذا الطلب. حدّث الصفحة.'],
  STAFF_ONLY: ['Only the Albayan team can do this.', 'هذا الإجراء لفريق البيان فقط.'],
  NOT_LINKED: ['This request is not linked to a Meta campaign yet.', 'هذا الطلب غير مربوط بحملة ميتا بعد.'],
  SERVICE_OFF: ['Help is not open for your account yet.', 'خدمة المساعدة غير مفتوحة لحسابك بعد.'],
  UNKNOWN_TICKET: ['This ticket was not found. Refresh the page.', 'لم نجد هذه التذكرة. حدّث الصفحة.'],
  UNKNOWN_PAYMENT: ['This payment was not found. Refresh the page.', 'لم نجد هذه الدفعة. حدّث الصفحة.'],
  IDEMPOTENCY_MISMATCH: ['This was already sent with different details. Refresh and try again.', 'أُرسل هذا من قبل بتفاصيل مختلفة. حدّث الصفحة وأعد المحاولة.'],
  TICKET_OPEN_LIMIT: ['You have too many open tickets. Mark one as solved, then open a new one.', 'لديك تذاكر مفتوحة كثيرة. أغلق واحدة تم حلها ثم افتح تذكرة جديدة.'],
  TICKET_MESSAGE_LIMIT: ['This ticket is full. Open a new ticket to continue.', 'هذه التذكرة ممتلئة. افتح تذكرة جديدة للمتابعة.'],
  TICKET_CLOSED: ['This ticket was closed more than 7 days ago. Open a new ticket.', 'أُغلقت هذه التذكرة منذ أكثر من 7 أيام. افتح تذكرة جديدة.'],
  STAFF_DESK_IN_USE: ['The team desk still has open tickets or stop requests. Answer or close them first.', 'ما زالت في مكتب الفريق تذاكر مفتوحة أو طلبات إيقاف. أجب عنها أو أغلقها أولاً.'],
  UNKNOWN_CUSTOMER: ['This customer was not found. Refresh the page.', 'لم نجد هذا العميل. حدّث الصفحة.'],
  NO_CONSENT: ['This customer has not shared a WhatsApp number with consent. Use a ticket instead.', 'لم يشارك هذا العميل رقم واتساب بموافقته. استخدم التذكرة بدلاً من ذلك.'],
  PHONE_INVALID: ['This is not a phone number we can use. Check it and try again.', 'هذا ليس رقماً صالحاً. راجعه وأعد المحاولة.'],
  CONSENT_REQUIRED: ['Tick the box to allow us to contact you on WhatsApp.', 'ضع علامة في المربع لتسمح لنا بالتواصل معك على واتساب.'],
  SESSION_ENDED: ['Your session has ended. Sign in again.', 'انتهت جلستك. سجّل الدخول مرة أخرى.'],
  FORBIDDEN: ['You do not have access to this.', 'لا تملك صلاحية الوصول إلى هذا.'],
  NOT_FOUND: ['This item was not found. Refresh the page.', 'لم نجد هذا العنصر. حدّث الصفحة.'],
  // Two coded refusals of /api/ad-studio (ad_campaign_actions.py sends {code, message} for them; P2-11).
  SETTLE_NOT_READY: ["The final amount is not ready yet: Meta's numbers must settle first (usually within 2 to 3 days).", 'المبلغ النهائي غير جاهز بعد: يجب أن تثبت أرقام ميتا أولاً (عادةً خلال يومين إلى ثلاثة).'],
  NEEDS_MANUAL_RENAME: ['Rename the campaign in Meta to the name shown, then link again.', 'غيّر اسم الحملة في ميتا إلى الاسم الظاهر ثم اربطها مرة أخرى.']
});

// By kind: a read can simply be tried again; after an action whose answer never arrived, nobody can
// promise that nothing happened, so the reader is sent to the latest state first.
const STUDIO_ERROR_KIND_TEXTS = Object.freeze({
  read: Object.freeze({
    SERVER: ['Albayan could not load this right now. Try again in a minute.', 'تعذّر على البيان تحميل هذا الآن. أعد المحاولة بعد دقيقة.'],
    NETWORK: ['No connection to Albayan. Check your internet and try again.', 'لا يوجد اتصال بالبيان. تحقّق من الإنترنت وأعد المحاولة.'],
    UNKNOWN: ['This could not be loaded. Try again in a moment.', 'تعذّر التحميل. أعد المحاولة بعد لحظات.']
  }),
  action: Object.freeze({
    SERVER: ['We could not confirm whether this went through. Refresh to see the latest state before trying again.', 'لم نتمكن من التأكد من إتمام العملية. حدّث الصفحة لترى آخر حالة قبل المحاولة مرة أخرى.'],
    NETWORK: ['The connection dropped, so we could not confirm this. Refresh to see the latest state before trying again.', 'انقطع الاتصال، لذلك لم نتأكد من إتمام العملية. حدّث الصفحة لترى آخر حالة قبل المحاولة مرة أخرى.'],
    // PLAN.md §5.5: an unknown refusal says what matters most — the money did not move.
    UNKNOWN: ['The action could not be completed. Nothing changed in your balance.', 'تعذّر إتمام العملية. لم يتغير شيء في رصيدك.']
  })
});

// Refusals of the older routes (a plain English sentence) that the classic map (15c) does not carry:
// [pattern, English, Arabic]. The builder also tells the open-request limit apart by its pattern.
const STUDIO_OPEN_REQUESTS_RE = /at most \d+ open campaign requests/i;  // main.py: MAX_AD_CAMPAIGN_ACTIVE_REQUESTS_PER_OWNER
const STUDIO_ERROR_PATTERNS = Object.freeze([
  [STUDIO_OPEN_REQUESTS_RE,
    'You have too many open requests. Delete an old draft or wait for one to finish, then try again.',
    'لديك طلبات مفتوحة كثيرة. احذف مسودة قديمة أو انتظر حتى ينتهي أحد طلباتك، ثم أعد المحاولة.'],
  [/cannot be deleted while under review/i,
    'Our team is reviewing this request, so it cannot be removed now. Withdraw it first.',
    'يراجع فريقنا هذا الطلب، لذلك لا يمكن حذفه الآن. اسحبه أولاً.'],
  // P2-11: every other plain-text refusal of /api/ad-studio, /api/social-studio and /api/wallet that the
  // classic map (15c) does not carry (scripts/test-mobile-ui.js compares this list and the classic map
  // with the server files). Grouped by what the reader can do about it; the first match wins, so the
  // exact texts come before the generic shapes. Entries are only ever added.
  // -- the ad request (ad_campaign_actions.py, ad_campaign_fields.py, studio_posts.py)
  [/^destination must be an HTTPS website/,
    'The destination must be an https:// website, a WhatsApp or Messenger link, or an international phone number.',
    'يجب أن تكون الوجهة موقعاً يبدأ بـ https:// أو رابط واتساب أو ماسنجر أو رقم هاتف دولياً.'],
  [/^sourcePostRef (must be an HTTPS link|is required for a Boost Post)/,
    'Paste the link of a Facebook or Instagram post.', 'الصق رابط منشور من فيسبوك أو إنستغرام.'],
  [/^sourcePost(Platform|Id) /,
    'Pick the post again from your linked page.', 'اختر المنشور مرة أخرى من صفحتك المربوطة.'],
  [/^refundMinorUSD must be between 0 and the paid budget/,
    'The refund must be between 0 and the amount paid for this ad.', 'يجب أن يكون المبلغ المسترد بين 0 والمبلغ المدفوع لهذا الإعلان.'],
  [/^Meta is still delivering this ad/,
    'Meta is still showing this ad, so it cannot be settled yet.', 'ما زالت ميتا تعرض هذا الإعلان، لذلك لا يمكن تسويته بعد.'],
  [/^Meta has not confirmed that this ad ended/,
    "Meta has not confirmed that this ad ended yet. Wait for its final numbers.", 'لم تؤكد ميتا انتهاء هذا الإعلان بعد. انتظر أرقامها النهائية.'],
  [/^This ad account does not bill in USD/,
    'This ad account does not bill in US dollars, so the final amount cannot be settled here.', 'حساب الإعلانات هذا لا يُحاسَب بالدولار، لذلك لا يمكن تسوية المبلغ النهائي هنا.'],
  [/^Only Draft or Changes Requested campaigns can be submitted/,
    'Only a draft or a request sent back for changes can be sent.', 'لا يمكن إرسال إلا مسودة أو طلب أُعيد للتعديل.'],
  [/campaign needs a budget greater than zero/,
    'Set a budget above zero first.', 'حدّد ميزانية أكبر من صفر أولاً.'],
  [/^(Nobody can override the settlement of their own request|Only an admin can override the settlement rules)/,
    'Only an admin who does not own this request can lift the settlement rules.', 'لا يستطيع رفع قواعد التسوية إلا مدير ليس صاحب هذا الطلب.'],
  [/^Only staff can choose (a partial refund amount|how a campaign closed)/,
    'Only the Albayan team chooses the refund amount and how an ad closes.', 'فريق البيان وحده يحدد مبلغ الاسترداد وطريقة إغلاق الإعلان.'],
  [/^Write why the settlement rules are lifted/,
    'Write why the settlement rules are lifted (10 to 300 characters).', 'اكتب سبب رفع قواعد التسوية (من 10 إلى 300 حرف).'],
  [/^(Forbidden|Admin only|You can only manage your own Social Studio)$/,
    'You do not have access to this.', 'لا تملك صلاحية الوصول إلى هذا.'],
  [/^goalDetail must be one of/,
    'Choose one of the listed goals.', 'اختر هدفاً من القائمة.'],
  [/^locationKeys (must be a list|must contain only text|cannot combine all of Libya)/,
    'Choose up to 25 places; "All of Libya" cannot be combined with a city.', 'اختر حتى 25 موقعاً؛ لا يمكن الجمع بين «كل ليبيا» ومدينة.'],
  [/^(creativeImages |creativeAssetIds contains|Each campaign image must be 4 MB|Campaign image dimensions are too large|A campaign image data URL is too large|Campaign images contain too many total pixels)/,
    'The photos are not accepted: use up to 3 PNG, JPEG or WebP photos, each under 4 MB.', 'الصور غير مقبولة: استخدم حتى 3 صور PNG أو JPEG أو WebP، كل واحدة أقل من 4 ميغابايت.'],
  [/^Unsupported (callToAction|campaign objective|advertising platform|gender targeting value|special ad category)/,
    'One of the choices is not in the list any more. Reload the page and choose again.', 'أحد الخيارات لم يعد في القائمة. أعد تحميل الصفحة واختر مرة أخرى.'],
  [/^specialAdCategories cannot combine none/,
    '"None" cannot be combined with another special category.', 'لا يمكن الجمع بين «لا شيء» وفئة خاصة أخرى.'],
  [/^ageMin cannot be greater than ageMax/,
    'The youngest age cannot be above the oldest.', 'لا يمكن أن يكون أصغر عمر أكبر من أكبر عمر.'],
  [/^budgetMinorUSD must be a non-negative integer/,
    'The budget must be a whole number of cents within the limit.', 'يجب أن تكون الميزانية عدداً صحيحاً من السنتات ضمن الحد.'],
  [/^endDate cannot be before startDate/,
    'The end date cannot be before the start date.', 'لا يمكن أن يكون تاريخ الانتهاء قبل تاريخ البدء.'],
  [/^Campaign duration cannot exceed 366 days/,
    'An ad cannot run longer than 366 days.', 'لا يمكن أن يعمل الإعلان أكثر من 366 يوماً.'],
  [/required before submission$/,
    'Something is still missing: fill every step (page, text, photo, audience, dates and budget) before sending.',
    'ما زال شيء ناقصاً: أكمل كل الخطوات (الصفحة والنص والصورة والجمهور والتواريخ والميزانية) قبل الإرسال.'],
  // -- pages, reply rules and posts (social_studio.py)
  [/^This page is already linked to an account/,
    'This page is already linked to another account.', 'هذه الصفحة مربوطة بحساب آخر بالفعل.'],
  [/^(Private messages|Public replies|Likes) are not available for (Facebook pages|Instagram accounts) right now/,
    'This kind of reply is not available for this platform right now.', 'هذا النوع من الردود غير متاح لهذه المنصة حالياً.'],
  [/^quietHours/,
    'Quiet hours need a from and a to time (HH:MM).', 'تحتاج ساعات الهدوء إلى وقت بداية ونهاية (HH:MM).'],
  [/^Unknown timezone/,
    'This time zone is not known.', 'هذه المنطقة الزمنية غير معروفة.'],
  [/^Add at least one keyword for a keyword rule/,
    'Add at least one keyword.', 'أضف كلمة مفتاحية واحدة على الأقل.'],
  [/^Choose at least one post for a chosen-posts rule/,
    'Choose at least one post for this rule.', 'اختر منشوراً واحداً على الأقل لهذه القاعدة.'],
  [/^A rule needs a public reply or a private message/,
    'A rule needs a public reply or a private message.', 'تحتاج القاعدة إلى رد عام أو رسالة خاصة.'],
  [/^Page \S+ is not linked to this account/,
    'One of the pages is not linked to your account.', 'إحدى الصفحات غير مربوطة بحسابك.'],
  [/^Page \S+ is not on this rule's platform/,
    "One of the pages is not on this rule's platform (Facebook or Instagram).", 'إحدى الصفحات ليست على منصة هذه القاعدة (فيسبوك أو إنستغرام).'],
  [/^Choose at least one page/,
    'Choose at least one page.', 'اختر صفحة واحدة على الأقل.'],
  [/^(media must be a list of images|A post supports at most \d+ photos|Photo \d+\b)/,
    'The post photos are not accepted: PNG, JPEG or WebP, each under 3 MB, and not too many.', 'صور المنشور غير مقبولة: PNG أو JPEG أو WebP، كل واحدة أقل من 3 ميغابايت، وبعدد معقول.'],
  [/^A post needs a caption or at least one photo/,
    'A post needs a caption or at least one photo.', 'يحتاج المنشور إلى نص أو صورة واحدة على الأقل.'],
  [/^scheduledAt /,
    'Choose a date and time at least one minute in the future.', 'اختر تاريخاً ووقتاً بعد دقيقة واحدة على الأقل من الآن.'],
  [/^autoReplyRuleId is not one of your rules/,
    'The chosen reply rule is not one of yours.', 'قاعدة الرد المختارة ليست من قواعدك.'],
  [/^Post is not claimed for publishing/,
    'This post is not being published right now. Refresh and try again.', 'هذا المنشور ليس قيد النشر الآن. حدّث الصفحة وحاول مرة أخرى.'],
  [/^Only draft, scheduled or failed posts can be changed/,
    'Only a draft, a scheduled post or a failed post can be changed.', 'لا يمكن تغيير إلا مسودة أو منشور مجدول أو منشور فشل نشره.'],
  [/^A page already published this post/,
    'A page already published this post, so its text and photos cannot change here. Retry the failed pages or delete the post (the live post stays on Meta).',
    'نشرت صفحة هذا المنشور بالفعل، لذلك لا يمكن تغيير نصه وصوره هنا. أعد المحاولة للصفحات التي فشلت أو احذف المنشور (يبقى المنشور على ميتا).'],
  [/^The post changed while publishing/,
    'The post changed while it was being published. Refresh and try again.', 'تغيّر المنشور أثناء نشره. حدّث الصفحة وحاول مرة أخرى.'],
  [/^Only scheduled posts can be cancelled/,
    'Only a scheduled post can be cancelled.', 'لا يمكن إلغاء إلا منشور مجدول.'],
  // -- the wallet (wallet_payments.py)
  [/^Campaign is no longer awaiting review/,
    'This request is no longer waiting for review. Refresh and try again.', 'هذا الطلب لم يعد بانتظار المراجعة. حدّث الصفحة وحاول مرة أخرى.'],
  [/^Customer wallet can no longer cover this campaign budget/,
    "The customer's wallet no longer covers this budget.", 'لم تعد محفظة العميل تغطي هذه الميزانية.'],
  [/^(No captured payment exists for this campaign cycle|The captured payment row is not refundable|This campaign cycle's payment was already returned|This campaign's payment was already reversed by an admin)/,
    'This ad has no payment that can still be returned.', 'لا توجد لهذا الإعلان دفعة يمكن إعادتها.'],
  [/^Refund must be between 1 cent and the captured budget/,
    'The refund must be between one cent and the amount paid.', 'يجب أن يكون المبلغ المسترد بين سنت واحد والمبلغ المدفوع.'],
  [/^Conflict: payment request has changed/,
    'This payment request changed meanwhile. Refresh and try again.', 'تغيّر طلب الدفع هذا في الأثناء. حدّث الصفحة وحاول مرة أخرى.'],
  [/^(The wallet is charged in USD or LYD|Unknown payment method)/,
    'Choose a currency (USD or LYD) and a payment method from the list.', 'اختر عملة (دولار أو دينار) وطريقة دفع من القائمة.'],
  [/^Minimum wallet charge is 1\.00/,
    'The smallest top-up is 1.00 of the currency.', 'أقل مبلغ للشحن هو 1.00 من العملة.'],
  [/^Idempotency key was already used for another operation/,
    'This was already sent with different details. Refresh and try again.', 'أُرسل هذا من قبل بتفاصيل مختلفة. حدّث الصفحة وأعد المحاولة.'],
  [/^Too many unpaid charge requests/,
    'You have too many unpaid top-up requests. Pay or cancel one first.', 'لديك طلبات شحن غير مدفوعة كثيرة. ادفع إحداها أو ألغِها أولاً.'],
  [/^The receipt photo is invalid or too large/,
    'The receipt photo is not accepted: use a clear JPG or PNG under 4 MB.', 'صورة الإيصال غير مقبولة: استخدم صورة JPG أو PNG واضحة أقل من 4 ميغابايت.'],
  [/^Only a pending request can take a receipt/,
    'A receipt can be attached only to a request that is still waiting for payment.', 'لا يمكن إرفاق إيصال إلا بطلب ما زال بانتظار الدفع.'],
  [/^Payment request is /,
    'This payment request is no longer open. Refresh the page.', 'طلب الدفع هذا لم يعد مفتوحاً. حدّث الصفحة.'],
  [/^The customer has not attached the transfer receipt yet/,
    'The customer has not attached the transfer receipt yet.', 'لم يرفق العميل إيصال التحويل بعد.'],
  [/^This account was deleted; cancel the request instead/,
    'This account was deleted; cancel the request instead.', 'حُذف هذا الحساب؛ ألغِ الطلب بدلاً من ذلك.'],
  [/^Payment was already received/,
    'This payment was already received; confirm it instead.', 'استُلمت هذه الدفعة بالفعل؛ أكّدها بدلاً من ذلك.'],
  // -- generic shapes of a field check (last, so the exact texts above and the classic map's own win)
  [/^(?!expectedVersion )\w+ is required$/,
    'A required field is empty.', 'إحدى الخانات المطلوبة فارغة.'],
  [/characters or fewer$/,
    'One of the texts is too long.', 'أحد النصوص طويل جداً.'],
  [/ supports at most \d+ entries$/,
    'One of the lists has too many entries.', 'إحدى القوائم تحوي عناصر كثيرة.'],
  [/^(?!note )\w+ (must be text|must be a list( of at most \d+ items)?|must contain only text|must be a valid ISO date|must be an integer from 18 to 65)$/,
    'One of the fields has a value of the wrong kind. Check the form and try again.', 'إحدى الخانات تحمل قيمة من نوع غير مناسب. راجع النموذج وحاول مرة أخرى.'],
  [/^(boostType must be|autoReply must be|extendsCampaignId is invalid|Invalid operationId|budgetType must be|connectedAssetId is invalid|Campaign data must be an object|Unsupported campaign field|platform must be fb or ig|scope must be all or chosen|trigger must be every or keywords|status must be draft or scheduled|reason must be instagram_private or empty|Unknown (log|post) status|before must be <createdAt>:<id>|metaPageId must be the numeric Meta page id|igUserId is required for an Instagram account)/,
    'This screen sent something the server does not accept. Reload the page and try again.', 'أرسلت هذه الشاشة شيئاً لا يقبله الخادم. أعد تحميل الصفحة وحاول مرة أخرى.']
]);

function studioKnownErrorCode(code) {
  return Object.prototype.hasOwnProperty.call(STUDIO_ERROR_TEXTS, code);
}

function studioErrorPattern(message) {
  const text = String(message || '');
  const hit = STUDIO_ERROR_PATTERNS.find(([pattern]) => pattern.test(text));
  return hit ? [hit[1], hit[2]] : null;
}

// Everything a screen needs to explain a failed call: {status, code, retryAfterSeconds, message,
// text}. `text` is plain text in the reader's language (escape it when drawing); `message` is the
// server's own words, for logs only. kind: 'read' (a GET) or 'action' (anything that changes data).
function studioErrorInfo(error, kind = 'action') {
  const mode = kind === 'read' ? 'read' : 'action';
  const base = adsStudioErrorInfo(error);  // 15c: {code, message, retryAfterSeconds}; 429 -> RATE_LIMITED
  const rawStatus = Number(error && error.status);
  const status = Number.isSafeInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : 0;
  const serverCode = /^[A-Z][A-Z0-9_]{1,47}$/.test(base.code) ? base.code : '';
  const message = String(base.message || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 500);
  const pair = pairOrNull => pairOrNull ? adsStudioText(pairOrNull[0], pairOrNull[1]) : '';
  let code = serverCode;
  let text = '';
  if (status === 429 || code === 'RATE_LIMITED') {
    code = 'RATE_LIMITED';
    const wait = adsStudioWaitText(base.retryAfterSeconds);
    text = wait
      ? adsStudioText(`Too many requests. Please wait ${wait[0]} and try again.`, `طلبات كثيرة. انتظر ${wait[1]} ثم أعد المحاولة.`)
      : pair(STUDIO_ERROR_TEXTS.RATE_LIMITED);
  } else if (code) {
    // A code this screen does not know yet (a newer server) is never shown raw.
    text = studioKnownErrorCode(code) ? pair(STUDIO_ERROR_TEXTS[code]) : '';
  } else if (status === 401) {
    code = 'SESSION_ENDED';
  } else if (status === 422) {
    code = 'INVALID_REQUEST';  // FastAPI's own body check: a list of fields, not words for a person
  } else if (status >= 400 && status < 500 && message && !/^\s*[[{]/.test(message)) {
    // The older routes send a plain string with a stable English prefix: the classic map knows them.
    // Arabic shows only what the map translates; English shows the refusal itself (400/403/409).
    const own = studioErrorPattern(message);
    const mapped = own ? '' : adsStudioRefusalText(message);
    if (own) text = pair(own);
    else if (adsStudioIsAr()) text = mapped && mapped !== message ? mapped : '';
    else if (status === 400 || status === 403 || status === 409) text = mapped;
  }
  if (!text && studioKnownErrorCode(code)) text = pair(STUDIO_ERROR_TEXTS[code]);
  if (!text) {
    const name = String((error && error.name) || '');
    const words = String((error && error.message) || '');
    const offline = !status && (name === 'AbortError' || /failed to fetch|networkerror|network error|load failed|network request failed/i.test(words));
    let fallback = 'UNKNOWN';
    if (status >= 500) fallback = 'SERVER';
    else if (!status && offline) fallback = 'NETWORK';
    else if (status === 403) { code = code || 'FORBIDDEN'; text = pair(STUDIO_ERROR_TEXTS.FORBIDDEN); }
    else if (status === 404) { code = code || 'NOT_FOUND'; text = pair(STUDIO_ERROR_TEXTS.NOT_FOUND); }
    if (!text) {
      code = code || fallback;
      text = pair(STUDIO_ERROR_KIND_TEXTS[mode][fallback]);
    }
  }
  return { status, code, retryAfterSeconds: base.retryAfterSeconds || 0, message, text };
}

// apiFetch (09-api-auth.js) ends a read with an AbortError in two cases: the app moved to another
// screen (cancelPendingRequests aborts the navigation signal; no failure, the next screen asks again)
// or the read ran past its timeout (a failure like any other: its screen offers Try again). Take
// studioReadSignal() just before a read and ask studioReadCancelled(error, signal) when it fails.
function studioReadSignal() {
  try { return typeof getNavigationSignal === 'function' ? getNavigationSignal() : null; } catch (_) { return null; }
}

function studioReadCancelled(error, signal) {
  return !!(error && error.name === 'AbortError' && signal && signal.aborted === true);
}

// apiJson for the studio screens: the same call, and a failure carries error.studio (above).
async function studioApi(path, options = {}, timeout = {}) {
  try {
    return await apiJson(path, options, timeout);
  } catch (error) {
    const method = String((options && options.method) || 'GET').toUpperCase();
    const failure = error && typeof error === 'object' ? error : new Error(String(error || 'Request failed'));
    try { failure.studio = studioErrorInfo(failure, method === 'GET' ? 'read' : 'action'); } catch (_) { /* keeps the plain error */ }
    throw failure;
  }
}

// ------------------------------------------------------------------ GET /api/studio/me

const STUDIO_ME_MAX_AGE_MS = 5 * 60 * 1000;  // the switches can change; a reply this old is read again
const STUDIO_ME_RETRY_MS = 60 * 1000;        // a failed first read is tried again at most once a minute
const _studioMe = { forUser: '', value: null, loadedAt: 0, failedAt: 0, promise: null, generation: 0, session: 0, listeners: new Set() };

function studioMeUserId() {
  return typeof state !== 'undefined' && state && state.currentUser ? String(state.currentUser.id || '') : '';
}

function studioMeFlag(value) {
  return value === true;
}

// The reply, cleaned: only the fields and values the screens understand; anything else reads as
// the safe side (classic layouts, services off, intake unknown).
function studioCleanMe(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const services = raw.services && typeof raw.services === 'object' ? raw.services : {};
  const plain = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return {}; }
  };
  const contact = plain(raw.contact);
  return Object.freeze({
    ui: raw.ui === 'v2' ? 'v2' : 'classic',
    staffDesk: raw.staffDesk === 'v2' ? 'v2' : 'classic',
    isAdmin: studioMeFlag(raw.isAdmin),
    isStaff: studioMeFlag(raw.isStaff) || studioMeFlag(raw.isAdmin),
    services: Object.freeze({
      help: studioMeFlag(services.help),
      stopRequest: studioMeFlag(services.stopRequest),
      tiktok: studioMeFlag(services.tiktok)
    }),
    intakeOpen: raw.intake && typeof raw.intake.open === 'boolean' ? raw.intake.open : null,
    adLimits: typeof adsStudioCleanLimits === 'function' ? adsStudioCleanLimits(raw.adLimits) : plain(raw.adLimits),
    capabilities: plain(raw.capabilities),
    serviceHours: plain(raw.serviceHours),
    contact: Object.freeze({
      whatsapp: studioParsePhone(contact.whatsapp),
      phone: studioParsePhone(contact.phone),
      email: typeof contact.email === 'string' && contact.email.length <= 254 && /^[^\s@<>"']+@[^\s@<>"']+$/.test(contact.email) ? contact.email : ''
    }),
    metaConnection: plain(raw.metaConnection)
  });
}

// The current user's /me reply, or null while unknown (never another user's).
function studioMe() {
  const uid = studioMeUserId();
  return uid && _studioMe.forUser === uid ? _studioMe.value : null;
}

function studioMeLoading() {
  const uid = studioMeUserId();
  return !!(uid && _studioMe.forUser === uid && _studioMe.promise);
}

function studioResetMe() {
  _studioMe.generation++;  // a reply still on its way belongs to the old session: dropped
  _studioMe.session++;     // what a screen kept from the old session (the 15h layout) is dropped too
  _studioMe.forUser = '';
  _studioMe.value = null;
  _studioMe.loadedAt = 0;
  _studioMe.failedAt = 0;
  _studioMe.promise = null;
}

// Changes at every reset (sign-out, session end, another user): a screen compares it with the one it
// kept to know that its copy belongs to an older session.
function studioMeSession() {
  return _studioMe.session;
}

// fn() runs after every settled read (a new reply, or a failure that kept the last good one).
function studioMeSubscribe(fn) {
  if (typeof fn === 'function') _studioMe.listeners.add(fn);
  return () => _studioMe.listeners.delete(fn);
}

function studioMeNotify() {
  for (const fn of Array.from(_studioMe.listeners)) {
    try { fn(studioMe()); } catch (_) { /* one screen never breaks another */ }
  }
}

// Resolves to the reply (null when unknown). A reply younger than maxAgeMs is reused; a read on its
// way is joined; a failed read keeps the last good reply. maxAgeMs 0 asks the server again.
function studioLoadMe(maxAgeMs = STUDIO_ME_MAX_AGE_MS) {
  const uid = studioMeUserId();
  if (!uid || typeof isServerModeEnabled !== 'function' || !isServerModeEnabled()) return Promise.resolve(null);
  if (_studioMe.forUser !== uid) studioResetMe();  // another user's reply is never reused
  if (_studioMe.promise) return _studioMe.promise;
  const age = Date.now() - _studioMe.loadedAt;
  const maxAge = Math.max(0, Number(maxAgeMs) || 0);
  if (_studioMe.value && age >= 0 && age < maxAge) return Promise.resolve(_studioMe.value);
  if (!_studioMe.value && _studioMe.failedAt && Date.now() - _studioMe.failedAt < STUDIO_ME_RETRY_MS) return Promise.resolve(null);
  _studioMe.forUser = uid;
  const generation = ++_studioMe.generation;
  const promise = (async () => {
    let value = null;
    let aborted = false;
    try {
      value = studioCleanMe(await apiJson('/api/studio/me', { method: 'GET' }));
    } catch (error) {
      // Leaving a page cancels its reads: that is no failure, the next screen asks again.
      aborted = !!(error && error.name === 'AbortError');
    }
    if (generation !== _studioMe.generation || uid !== studioMeUserId()) {
      // The session moved on (signed out, expired, another user). While no reset or newer read came
      // after this one, the waiting slot is still this read's: free it, or the same user signing in
      // again would join this dead read and never ask the server again.
      if (generation === _studioMe.generation) _studioMe.promise = null;
      return null;
    }
    _studioMe.promise = null;
    if (value) {
      _studioMe.value = value;
      _studioMe.loadedAt = Date.now();
      _studioMe.failedAt = 0;
    } else if (!aborted) {
      _studioMe.failedAt = Date.now();
    }
    studioMeNotify();
    return _studioMe.value;
  })();
  _studioMe.promise = promise;
  return promise;
}

// ------------------------------------------------------------------ pulse poller hook

const STUDIO_PULSE_DEFAULT_MS = 30000;
const STUDIO_PULSE_MIN_MS = 10000;
const STUDIO_PULSE_MAX_BACKOFF_MS = 5 * 60 * 1000;
const _studioPulse = { watches: new Map(), listening: false };

function studioPulseVisible() {
  try { return typeof document === 'undefined' || document.visibilityState !== 'hidden'; } catch (_) { return true; }
}

// Polls `path` (a GET that answers {changedAt}) every intervalMs while the page is visible and calls
// onChange(value, reply) when the value moves (never for the first reading). While the tab is hidden
// there is no timer at all; coming back polls at once if a round was missed. One read at a time;
// failures back off (429: the server's Retry-After). Signing out or another user stops the watch.
// Returns stop(). A second watch under the same key replaces the first.
function studioPulseWatch(key, options = {}) {
  const name = String(key || '');
  const path = String(options.path || '');
  if (!name || !/^\/api\/[A-Za-z0-9/_?=&.-]+$/.test(path) || typeof options.onChange !== 'function') return () => {};
  studioPulseStop(name);
  const watch = {
    key: name,
    path,
    field: typeof options.field === 'string' && options.field ? options.field : 'changedAt',
    intervalMs: Math.max(STUDIO_PULSE_MIN_MS, Number(options.intervalMs) || STUDIO_PULSE_DEFAULT_MS),
    onChange: options.onChange,
    uid: studioMeUserId(),
    timer: null,
    inFlight: false,
    last: undefined,
    lastPollAt: 0,
    failures: 0,
    stopped: false
  };
  _studioPulse.watches.set(name, watch);
  studioPulseListen();
  studioPulseSchedule(watch, 0);
  return () => studioPulseStop(name);
}

function studioPulseStop(key) {
  const watch = _studioPulse.watches.get(String(key || ''));
  if (!watch) return;
  watch.stopped = true;
  if (watch.timer) clearTimeout(watch.timer);
  watch.timer = null;
  _studioPulse.watches.delete(watch.key);
}

function studioPulseSchedule(watch, delayMs) {
  if (watch.stopped) return;
  if (watch.timer) { clearTimeout(watch.timer); watch.timer = null; }
  if (!studioPulseVisible()) return;  // hidden: no timer; the visibility handler starts it again
  watch.timer = setTimeout(() => { watch.timer = null; studioPulsePoll(watch); }, Math.max(0, Number(delayMs) || 0));
}

async function studioPulsePoll(watch) {
  if (watch.stopped || watch.inFlight || !studioPulseVisible()) return;
  if (!watch.uid || watch.uid !== studioMeUserId()) { studioPulseStop(watch.key); return; }
  watch.inFlight = true;
  let delay = watch.intervalMs;
  try {
    const reply = await apiJson(watch.path, { method: 'GET' });
    const raw = reply && typeof reply === 'object' ? reply[watch.field] : undefined;
    const value = raw === undefined || raw === null ? '' : String(raw).slice(0, 100);
    const changed = watch.last !== undefined && value !== watch.last;
    watch.last = value;
    watch.failures = 0;
    if (changed && !watch.stopped && watch.uid === studioMeUserId()) {
      try { watch.onChange(value, reply); } catch (_) { /* a screen's handler never stops the watch */ }
    }
  } catch (error) {
    watch.failures++;
    const wait = Number(error && error.retryAfter);
    delay = error && error.status === 429 && wait > 0
      ? Math.min(wait * 1000, STUDIO_PULSE_MAX_BACKOFF_MS * 2)
      : Math.min(watch.intervalMs * (2 ** Math.min(watch.failures, 4)), STUDIO_PULSE_MAX_BACKOFF_MS);
  } finally {
    watch.inFlight = false;
    watch.lastPollAt = Date.now();
  }
  studioPulseSchedule(watch, delay);
}

function studioPulseListen() {
  if (_studioPulse.listening || typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
  _studioPulse.listening = true;
  document.addEventListener('visibilitychange', studioPulseOnVisibility);
}

function studioPulseOnVisibility() {
  const onScreen = studioPulseVisible();
  for (const watch of Array.from(_studioPulse.watches.values())) {
    if (!onScreen) {
      if (watch.timer) clearTimeout(watch.timer);
      watch.timer = null;
    } else if (!watch.timer && !watch.inFlight) {
      studioPulseSchedule(watch, Math.max(0, watch.lastPollAt + watch.intervalMs - Date.now()));
    }
  }
}

// ------------------------------------------------------------------ display stages (PLAN.md §5.4)

// Stage n is STUDIO_STAGE_KEYS[n - 1]; the same list, looks and flag words as the server's tables
// (stage_cases.json "tables", checked by scripts/test-mobile-ui.js). Colour never stands alone: every
// stage has its icon (the server's icon name, then the icon this app draws for it).
const STUDIO_STAGE_KEYS = Object.freeze([
  'draft', 'waiting_review', 'needs_changes', 'approved_setup', 'meta_reviewing', 'meta_rejected', 'delivery_problem',
  'running', 'paused', 'ended_settling', 'finished', 'stopped', 'rejected'
]);
const STUDIO_STAGE_LOOK = Object.freeze({
  draft: ['slate', 'pencil', 'pencil'],
  waiting_review: ['amber', 'clock', 'clock'],
  needs_changes: ['orange', 'message-warning', 'message-square-warning'],
  approved_setup: ['blue', 'badge-check', 'badge-check'],
  meta_reviewing: ['blue', 'shield', 'shield'],
  meta_rejected: ['red-orange', 'shield-alert', 'shield-alert'],
  delivery_problem: ['orange', 'alert-triangle', 'triangle-alert'],
  running: ['green', 'play', 'play'],
  paused: ['slate-blue', 'pause', 'pause'],
  ended_settling: ['slate', 'hourglass', 'hourglass'],
  finished: ['slate', 'flag', 'flag'],
  stopped: ['rose', 'stop', 'circle-stop'],
  rejected: ['red', 'x', 'x']
});
const STUDIO_STAGE_FLAGS = Object.freeze({
  runningPastEnd: ['Running past the promised end — the team is on it', 'ما زال يعمل بعد موعد الانتهاء — الفريق يتابعه'],
  stopRequested: ['Stop requested — we will pause it soon', 'طُلب الإيقاف — سنوقفه قريباً'],
  stale: ['Meta has not been checked for a while', 'لم نتحقق من ميتا منذ مدة']
});
const STUDIO_STAGE_TRACKER = Object.freeze(['not_sent', 'sent', 'approved', 'meta_review', 'running', 'ended', 'finished']);
const STUDIO_STAGE_ACTIONS = Object.freeze(['edit', 'send', 'delete', 'withdraw', 'ask', 'fix', 'stop_refund', 'ask_to_stop', 'archive', 'read_reasons', 'copy_fix']);

// One request's stage as the server derived it (GET /api/studio/campaigns/summary), ready to draw:
// the server's words in the reader's language, a look from the list above, and only the actions this
// app knows. A stage this app does not know yet keeps the server's label with a neutral look. "Meta
// used" exists only for a linked request in stages 4-10 (never before a link, PLAN.md §5.4).
// All text is plain: escape it when drawing. null for anything that is not a stage.
function studioStageView(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const number = Number(raw.stage);
  const byNumber = Number.isSafeInteger(number) && number >= 1 && number <= STUDIO_STAGE_KEYS.length ? STUDIO_STAGE_KEYS[number - 1] : '';
  const sentKey = typeof raw.stageKey === 'string' ? raw.stageKey : '';
  const key = STUDIO_STAGE_KEYS.includes(sentKey) ? sentKey : (sentKey ? '' : byNumber);
  const stage = key ? STUDIO_STAGE_KEYS.indexOf(key) + 1 : 0;
  const look = key ? STUDIO_STAGE_LOOK[key] : null;
  const linked = raw.linked === true;
  const used = raw.metaUsedMinor;  // null = Meta has not confirmed a spend: never read as $0
  const flags = Object.keys(STUDIO_STAGE_FLAGS).filter(flag => raw[flag] === true)
    .map(flag => ({ key: flag, text: adsStudioText(STUDIO_STAGE_FLAGS[flag][0], STUDIO_STAGE_FLAGS[flag][1]) }));
  const tracker = raw.tracker && typeof raw.tracker === 'object' ? raw.tracker : {};
  return {
    stage,
    key,
    known: !!key,
    label: studioPickText(raw.labels, 160) || adsStudioText('Status not available', 'الحالة غير متاحة'),
    tone: look ? look[0] : 'slate',
    icon: look ? look[2] : 'circle-help',
    money: studioPickText(raw.money),
    nextActor: studioPickText(raw.nextActorLabels, 120),
    variant: studioPickText(raw.variantLabels, 160),
    linked,
    checking: raw.checking === true,
    checkedAgo: studioPickText(raw.checkedAgo, 80),
    stale: raw.stale === true,
    metaUsedMinor: linked && stage >= 4 && stage <= 10 && Number.isSafeInteger(used) && used >= 0 ? used : null,
    flags,
    tracker: { step: STUDIO_STAGE_TRACKER.includes(tracker.step) ? tracker.step : '', side: tracker.side === true },
    actions: Array.isArray(raw.actions) ? raw.actions.filter(action => STUDIO_STAGE_ACTIONS.includes(action)) : [],
    reasons: Array.isArray(raw.reasons) ? raw.reasons.map(String).filter(reason => /^[a-z_]{1,40}$/.test(reason)).slice(0, 10) : []
  };
}

// ------------------------------------------------------------------ money

// "1,234.56" (Latin digits, grouped: money reads the same on every phone) for a whole number of
// cents; '' for anything else.
function studioMinorText(minor) {
  const value = typeof minor === 'string' && /^-?\d{1,16}$/.test(minor.trim()) ? Number(minor.trim()) : minor;
  if (!Number.isSafeInteger(value)) return '';
  const abs = Math.abs(value);
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${value < 0 ? '-' : ''}${whole}.${String(abs % 100).padStart(2, '0')}`;
}

// US dollars (the ad wallet): "$1,234.56", "-$5.00"; "—" when the amount is unknown.
function studioUsd(minor) {
  const text = studioMinorText(minor);
  if (!text) return '—';
  return text.startsWith('-') ? `-$${text.slice(1)}` : `$${text}`;
}

// Libyan dinars (plans): "1,234.56 LYD" / "1,234.56 د.ل" — never "$".
function studioLyd(minor) {
  const text = studioMinorText(minor);
  return text ? `${text} ${adsStudioText('LYD', 'د.ل')}` : '—';
}

// ------------------------------------------------------------------ typed input

const STUDIO_MAX_AMOUNT_MINOR = 1e12;

// A typed amount in minor units (cents), or NaN. Built on the classic parser (adsStudioParseMoneyMinor,
// 15c: Arabic-Indic digits, ٫ and ، , "1,250" is a thousand, "12,5" is twelve and a half), plus the
// Arabic thousands sign ٬, a "$" and bidi marks around the number. What could mean two amounts is
// refused rather than guessed: more than two decimals, a sign, any other character, and a comma
// beside a point unless the commas group thousands before the decimals ("1,250.50" yes; "1.250,00",
// "1.234,56", "12,5.5" and "1,5.25" no: which one is the decimal sign?).
function studioParseAmount(raw) {
  if (raw === null || raw === undefined || typeof raw === 'object') return NaN;
  const text = normalizeDigitsAscii(String(raw))
    .replace(/[\s ‎‏‪-‮⁦-⁩]/g, '')
    .replace(/٬/g, ',')
    .replace(/^\$|\$$/g, '');
  if (!text || text.length > 24) return NaN;
  // The number as the classic parser reads it: each comma either groups thousands or is the decimal sign.
  let plain = text.replace(/،/g, ',').replace(/٫/g, '.');
  if (plain.includes(',')) {
    if (plain.includes('.')) {
      if (!/^\d{1,3}(,\d{3})+\.\d{0,2}$/.test(plain)) return NaN;  // no comma after the point either
      plain = plain.replace(/,/g, '');
    } else if (/^\d{1,3}(,\d{3})+$/.test(plain)) {
      plain = plain.replace(/,/g, '');
    } else if (/^\d*,\d*$/.test(plain)) {
      plain = plain.replace(',', '.');
    } else {
      return NaN;
    }
  }
  if (/\.\d{3,}$/.test(plain)) return NaN;  // more than two decimals
  const minor = adsStudioParseMoneyMinor(text);
  return Number.isSafeInteger(minor) && minor >= 0 && minor <= STUDIO_MAX_AMOUNT_MINOR ? minor : NaN;
}

// A typed phone number as E.164 ("+218912345678"), or '' when it is not one. Arabic digits, spaces,
// dots, dashes and brackets are allowed; 00 means +. Libyan numbers may be typed as 091 234 5678,
// 91 234 5678, 218 91 234 5678 or +218 091… (the local 0 dropped). After +218 a mobile (9…) has
// exactly 9 digits and a landline (1…-8…) 8 or 9. Any other country needs its +code. The server's
// rule is wider (studio_settings._phone: +, then 8-15 digits), so whatever passes here passes there.
function studioParsePhone(raw) {
  if (raw === null || raw === undefined || typeof raw === 'object') return '';
  let text = normalizeDigitsAscii(String(raw)).trim();
  if (!text || text.length > 32) return '';
  text = text.replace(/[\s().\- ‎‏‪-‮⁦-⁩]/g, '');
  if (text.startsWith('00')) text = `+${text.slice(2)}`;
  if (!/^\+?\d{6,20}$/.test(text)) return '';
  let number;
  if (text.startsWith('+')) number = text;
  else if (/^218\d{8,10}$/.test(text)) number = `+${text}`;
  else if (/^0\d{8,9}$/.test(text)) number = `+218${text.slice(1)}`;
  else if (/^9\d{8}$/.test(text)) number = `+218${text}`;
  else return '';
  if (number.startsWith('+2180')) number = `+218${number.slice(5)}`;
  if (number.startsWith('+218')) {
    const national = number.slice(4);
    return /^9\d{8}$/.test(national) || /^[1-8]\d{7,8}$/.test(national) ? number : '';
  }
  return /^\+[1-9]\d{7,14}$/.test(number) ? number : '';
}
