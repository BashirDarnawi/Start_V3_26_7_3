# The app's texts in one list

This file and `app-texts.csv` are written by `scripts/list-texts.js` from the source files in `src/`. Do not edit them by hand: change the text where it is used, then run `npm run texts`. `npm test` fails when the list is out of date. Nothing in the app reads these two files.

- **`app-texts.csv`** opens in Excel, Numbers or Google Sheets: every English/Arabic pair once, how often it is used, and in which source files.
- The words themselves stay where they are used in the code. This list is for reading and reviewing them in one place.

## Numbers

| | |
|---|---|
| Source files read | 49 |
| Places where a text with an Arabic side is written | 8109 |
| …of which have their English beside them | 7949 |
| Different English/Arabic pairs | 6040 |
| Arabic texts with no English beside them in the code | 119 (in 160 places) |
| English texts written with more than one Arabic | 243 |

## The same English, more than one Arabic

Some of these are right as they are (one English word with two meanings, a verb and a noun, a short form for a narrow place). The others are wording that drifted. The number is how often each form is used.

| English | Arabic forms |
|---|---|
| Access Denied | تم رفض الوصول (76) · رفض الوصول (12) · غير مسموح (1) |
| Validation | تنبيه (39) · تحقق (23) · خطأ في الإدخال (10) |
| Not Allowed | غير مسموح (22) · غير ممكن (6) |
| Receipt | وصل (13) · الوصل (9) |
| Page | الصفحة (13) · صفحة (6) |
| Paid | مدفوع (13) · المدفوع (3) · دُفع (1) |
| Success | نجاح (11) · تمت الإضافة (5) · تم بنجاح (1) |
| Please try again. | حاول مرة أخرى. (13) · لم تُنشأ النسخة. حاول مرة أخرى. (1) · لم يُقفل الشهر. راجع فحص الشهر ثم حاول مرة أخرى. (1) |
| Try again | أعد المحاولة (13) · حاول مرة أخرى (1) |
| Updated | تم التحديث (13) · تعديل (1) |
| Validation Error | خطأ في الإدخال (11) · خطأ في التحقق (3) |
| Customer | العميل (8) · عميل (4) · الزبون (1) |
| DELETED | تم الحذف (9) · محذوفة (2) · حذف (1) · محذوف (1) |
| More | المزيد (12) · آخرون (1) |
| Pages | الصفحات (11) · صفحات (2) |
| Payment | الدفع (8) · الدفعات (1) · الدفعة (1) · حالة الدفع (1) · دفعة (1) |
| Receipts | الوصولات (8) · وصولات (2) · الإيصالات (1) · وصل (1) |
| Available | المتاح (5) · متاح (5) · متوفر (1) |
| Back | رجوع (7) · العودة (3) · السابق (1) |
| CANCELED | ملغى (5) · ملغي (4) · أُلغيت (1) · تم الإلغاء (1) |
| Delete | حذف (8) · احذف (2) · الحذف (1) |
| Delivery | التوصيل (5) · توصيل (4) · سائق توصيل (2) |
| Spent | صُرف (5) · المصروف (4) · مصروف (2) |
| Ads | الإعلانات (8) · إعلانات (2) |
| Collected | المُحصَّل (3) · تم التحصيل (3) · مُحصَّل (3) · محصل (1) |
| Done | تم (9) · منجزة (1) |
| No phone | لا يوجد هاتف (9) · بدون هاتف (1) |
| Keep it | أبقِه (6) · أبقِها (2) · أبقِ الطلب (1) |
| Remove | إزالة (7) · احذفه (1) · حذف (1) |
| Save | حفظ (8) · الحفظ (1) |
| Status | الحالة (8) · تغيير حالة (1) |
| TOTAL | الإجمالي (8) · المجموع (1) |
| Delivered | تم التوصيل (5) · تاريخ التسليم (1) · تم التسليم (1) · طلبات مُسلّمة (1) |
| Link | ربط (4) · الرابط (3) · الروابط (1) |
| Login Failed | فشل تسجيل الدخول (7) · تعذّر تسجيل الدخول. تحقق من الاتصال ثم حاول مرة أخرى. (1) |
| Password must be at least 8 characters | كلمة المرور يجب أن تكون على الأقل 8 أحرف (5) · يجب أن تكون كلمة المرور 8 أحرف على الأقل (2) · يجب أن تكون كلمة المرور على الأقل 8 أحرف (1) |
| Photos | الصور (6) · صور (2) |
| Review | المراجعة (4) · مراجعة (4) |
| ACTIVE | نشط (3) · نشطة (2) · الجارية (1) · جارية (1) |
| Created | تاريخ الإنشاء (4) · تم الإنشاء (2) · إنشاء (1) |
| Invalid amount | مبلغ غير صالح (5) · المبلغ غير صالح (2) |
| Method | طريقة الدفع (6) · الطريقة (1) |
| Never | أبداً (6) · لا يوجد (1) |
| Open | فتح (6) · مفتوحة (1) |
| Save Changes | حفظ التغييرات (4) · حفظ التعديلات (3) |
| ADMIN | أدمن (3) · مدير (3) |
| Change | تغيير (5) · غيّره (1) |
| Check the connection and try again. | تحقق من الاتصال ثم حاول مرة أخرى. (3) · تحقق من الاتصال وحاول مرة أخرى. (3) |
| Deliveries | التوصيل (5) · التوصيلات (1) |
| Needs setup | يحتاج إكمال (5) · يحتاج إعداداً (1) |
| Show | اعرض (5) · عرض (1) |
| Amount (LYD) | المبلغ (د.ل) (4) · المبلغ (دينار) (1) |
| Category | الفئة (4) · التصنيف (1) |
| Closed | مغلق (3) · أُغلق (1) · مُقفل (1) |
| Completed | مكتمل (3) · المكتملة (1) · مكتملة (1) |
| Continue | أكمله (3) · التالي (1) · متابعة (1) |
| Days | الأيام (2) · المدة (2) · يوم (1) |
| End | الانتهاء (2) · النهاية (2) · انتهاء (1) |
| Lost | ضائع (4) · مفقود (1) |
| Mark Delivered | تم التوصيل (4) · تم التسليم (1) |
| Off | متوقف (4) · متوقفة (1) |
| Only an administrator can use company funds. | فقط المدير يمكنه استخدام أموال الشركة. (4) · المدير فقط يمكنه استخدام أموال الشركة. (1) |
| PAUSED | متوقف مؤقتاً (4) · متوقفة (1) |
| Pending | قيد الانتظار (3) · المعلقة (1) · معلّقة (1) |
| Pieces | القطع (4) · قطعة (1) |
| Resolved | تم الحل (3) · محلولة (2) |
| Server Error | خطأ في الخادم (4) · خطأ في السيرفر (1) |
| Start | ابدأ (2) · البداية (2) · بدء (1) |
| Stopped | متوقف (2) · تم إيقافه (1) · موقفة (1) · موقوف (1) |
| Transferred | تم التحويل (4) · المُحوَّل (1) |
| Unassigned | غير مُعيَّن (4) · غير مخصص (1) |
| Actions | إجراءات (2) · الإجراءات (2) |
| Add money | أضف مالاً (2) · أضف رصيداً (1) · إضافة رصيد (1) |
| Admin only | إنشاء المستخدمين للأدمن فقط (1) · للأدمن فقط (1) · هذا الإجراء للمدير فقط (1) · هذه الميزة للأدمن فقط (1) |
| Auto-reply | رد تلقائي (3) · الرد التلقائي (1) |
| Bank Transfer | حوالة مصرفية (3) · تحويل بنكي (1) |
| Boost a post | تعزيز منشور (3) · ترويج منشور (1) |
| Cannot save | تعذّر الحفظ (3) · تعذر الحفظ (1) |
| Connected | تم الربط (1) · رُبط في (1) · متصل (1) · متصلة (1) |
| Copy Failed | فشل النسخ (3) · تعذر النسخ (1) |
| Driver | السائق (3) · سائق (1) |
| Failed | فشل (2) · فشلت (2) |
| Link Meta campaign | ربط حملة ميتا (3) · اربط حملة ميتا (1) |
| Linked pages | الصفحات المربوطة (2) · الصفحات المرتبطة (2) |
| No owner | بدون مالك (3) · لا يوجد مالك (1) |
| None | بدون (2) · لا توجد (2) |
| Plans & bundles | الباقات والاشتراكات (3) · الباقات (1) |
| Please Wait | الرجاء الانتظار (2) · يرجى الانتظار (2) |
| Qty | الكمية (2) · كمية (2) |
| Ready | جاهز (3) · جاهزة (1) |
| Received | تم الاستلام (2) · استُلمت (1) · تاريخ الاستلام (1) |
| Remove photo | إزالة الصورة (2) · حذف الصورة (2) |
| Sent | أُرسل (3) · أُرسلت (1) |
| Serial | الرقم (3) · الرقم التسلسلي (1) |
| Undo | تراجع (3) · إلغاء (1) |
| USER | المستخدم (2) · مستخدم (2) |
| Users | المستخدمون (3) · المستخدمين (1) |
| Withdraw | اسحب الطلب (2) · سحب الطلب (2) |
| Account | الحساب (2) · حسابي (1) |
| Add Product | إضافة منتج (2) · إضافة المنتج (1) |
| Add Shipment | إضافة شحنة (2) · إضافة الشحنة (1) |
| All Payments | كل طرق الدفع (2) · كل حالات الدفع (1) |
| Approved | تمت الموافقة (2) · اعتُمد (1) |
| Archive | أرشف (2) · أرشفة (1) |
| ARCHIVED | مؤرشف (2) · مؤرشفة (1) |
| Ask to stop | اطلب الإيقاف (2) · طلب الإيقاف (1) |
| Confirm | تأكيد (2) · التأكيد (1) |
| Dashboard | اللوحة (1) · لوحة التحكم (1) · نظرة عامة (1) |
| Draft saved | تم حفظ المسودة (2) · حُفظت المسودة (1) |
| Duplicate | مكرر (2) · نسخ (1) |
| For | للعميل (2) · لأجل (1) |
| Full Administrator | أدمن كامل الصلاحيات (1) · مدير بصلاحيات كاملة (1) · مدير كامل الصلاحيات (1) |
| Imported | تم الاستيراد (2) · تم استيراد (1) |
| Intake | استقبال الطلبات (2) · الاستقبال (1) |
| Linked | تم الربط (1) · سجل مرتبط (1) · مرتبط (1) |
| Men | الرجال (2) · رجال (1) |
| Meta code | رمز ميتا (2) · رمز Meta (1) |
| Needs you | يحتاجك (2) · يحتاج إليك (1) |
| No data | لا توجد بيانات (2) · لا بيانات (1) |
| Not Collected | غير مُحصَّل (1) · غير مُحصّل (1) · لم يُحصَّل (1) |
| Not Logged In | غير مسجل الدخول (2) · لم يتم تسجيل الدخول (1) |
| Office Handover | التسليم للمكتب (1) · تسليم المكتب (1) · تسليم للمكتب (1) |
| On | مفعّل (2) · مفعّلة (1) |
| On the way | في الطريق (2) · في الطريق للزبون (1) |
| Ordered | تاريخ الطلب (2) · مطلوبة (1) |
| Planned Spend (USD) | الصرف المخطط ($) (2) · الإنفاق المخطط ($) (1) |
| Product | منتج (2) · المنتج (1) |
| Published | منشورة (2) · منشور (1) |
| Quoted fee | الرسوم المتفق عليها (2) · قيمة التوصيل المتفق عليها (1) |
| Reason | السبب (2) · سبب القرار (1) |
| Receipt attached | أرفقت الإيصال (1) · أُرفق الإيصال (1) · تم إرفاق الإيصال (1) |
| Reference | الرمز المرجعي (1) · المرجع (1) · مرجع الشحنة (1) |
| Refresh the data and try again. | حدّث البيانات ثم أعد المحاولة. (2) · حدّث البيانات ثم حاول مرة أخرى. (1) |
| Refunded | تم الاسترجاع (2) · مسترد (1) |
| Retry connection | إعادة محاولة الاتصال (2) · إعادة المحاولة (1) |
| RETURNED | مرتجع (2) · أُعيد (1) |
| Running | يعمل (2) · تعمل (1) |
| Scheduled | مجدولة (2) · مجدول (1) |
| Settle | التسوية (2) · تسوية (1) |
| Share delivery information to WhatsApp | مشاركة معلومات التوصيل على واتساب (2) · مشاركة معلومات التوصيل على WhatsApp (1) |
| Start Date | تاريخ البداية (2) · تاريخ البدء (1) |
| Stop requests | طلبات الإيقاف (2) · طلبات إيقاف (1) |
| Subscribed | تم الاشتراك (2) · مشتركة (1) |
| This ad changed on another device. Refresh the data, then try again. | تم تغيير هذا الإعلان من مستخدم آخر. حدّث البيانات ثم أعد المحاولة. (2) · تم تغيير الإعلان من مستخدم آخر. حدّث البيانات ثم أعد المحاولة. (1) |
| Total Paid | إجمالي المدفوع (2) · إجمالي ما دفعته (1) |
| Unlink | إلغاء الربط (2) · ألغِ الربط (1) |
| Update | تحديث (2) · تعديل (1) |
| When | التوقيت (2) · متى (1) |
| Women | النساء (2) · نساء (1) |
| (auto-selected) | (محدد تلقائياً) (1) · (يُختار تلقائياً) (1) |
| A business reason is required. | السبب التجاري مطلوب. (1) · سبب العمل مطلوب. (1) |
| Ad creative | صورة الإعلان (1) · محتوى الإعلان (1) |
| Ad Stopped | أُوقف الإعلان (1) · تم إيقاف الإعلان (1) |
| Add a product | أضف منتجاً (1) · إضافة منتج (1) |
| Add a shipment | أضف شحنة (1) · إضافة شحنة (1) |
| Add at least one item (product + quantity). | أضف صنفاً واحداً على الأقل (منتج + كمية). (1) · أضف قطعة واحدة على الأقل (منتج + كمية). (1) |
| Add item | إضافة صنف (1) · إضافة قطعة (1) |
| Add Paid Receipt Funds | إضافة أموال من وصل مدفوع (1) · إضافة أموال وصولات مدفوعة (1) |
| Add Receipt | إضافة إيصال (1) · إضافة وصل (1) |
| Added to your wallet | أضفته إلى محفظتك (1) · أُضيف إلى محفظتك (1) |
| Admin Override | تجاوز الأدمن (1) · تجاوز المدير (1) |
| Ads Studio Reviewer | مراجع استوديو الإعلانات (1) · مراجع حملات العملاء (1) |
| Already saved | تم الحفظ (1) · محفوظ مسبقاً (1) |
| Approve | موافقة (1) · وافق (1) |
| Assign owner | تعيين المالك (1) · ربط بعميل (1) |
| Assigned | تم التعيين (1) · مُعيَّنة (1) |
| Business expense only. | مصروف تجاري فقط. (1) · مصروف شركة فقط. (1) |
| Business reason | السبب التجاري (1) · سبب العمل (1) |
| Campaign | اسم الحملة (1) · الحملة (1) |
| Cancelled | ملغى (1) · ملغي (1) |
| Cash | نقداً (1) · نقدي (1) |
| Check Failed | تعذّر الفحص (1) · فشل الفحص (1) |
| Close company funds dialog | إغلاق (1) · إغلاق نافذة أموال الشركة (1) |
| Company amount (USD) | مبلغ الشركة ($) (1) · مبلغ الشركة (دولار) (1) |
| Complete | إكمال (1) · مكتمل (1) |
| Complete access to all features. No restrictions. | وصول كامل لجميع الميزات. بدون قيود. (1) · وصول كامل لجميع الميزات. بلا قيود. (1) |
| Confirmed | أُكّد (1) · مؤكد (1) |
| Cost | التكلفة (1) · تكلفة (1) |
| Could not cancel | تعذر الإلغاء (1) · تعذّر الإلغاء (1) |
| Could not copy | تعذر النسخ (1) · تعذّر النسخ (1) |
| Creative | الصور (1) · المحتوى (1) |
| Customer name is required | اسم الزبون مطلوب (1) · اسم العميل مطلوب (1) |
| Delivery paid by | من دفع قيمة التوصيل (1) · من دفع قيمة التوصيل؟ (1) |
| Draft deleted | تم حذف المسودة (1) · حُذفت المسودة (1) |
| Drivers | السائقون (1) · سائق (1) |
| Duplicate pages | الصفحات المكررة (1) · صفحات مكررة (1) |
| Edit Profile | تعديل الملف (1) · تعديل الملف الشخصي (1) |
| Enter an amount greater than $0.00. | أدخل مبلغاً أكبر من $0.00. (1) · أدخل مبلغاً أكبر من 0.00$. (1) |
| Grow my page | تنمية صفحتي (1) · نمِّ صفحتي (1) |
| Has Credit | لديه رصيد دائن (1) · له رصيد (1) |
| Held | بحوزة السائق (1) · بحوزته (1) |
| Housing | السكن (1) · سكن وعقارات (1) |
| Known profit | الربح المعروف (1) · ربح معروف (1) |
| Last backup | آخر نسخة (1) · آخر نسخة احتياطية (1) |
| Lifetime | إجمالي (1) · إجمالي الحملة (1) |
| Link to your post | رابط المنشور (1) · رابط منشورك (1) |
| Local Mode | الوضع المحلي (1) · وضع محلي (1) |
| Manage Split Payments | إدارة تقسيمات الدفع (1) · تعديل الدفعات المقسّمة (1) |
| Messages | الرسائل (1) · رسائل (1) |
| Meta activity | سجل نشاط Meta (1) · نشاط Meta (1) |
| Meta campaign | حملة Meta (1) · حملة ميتا (1) |
| Meta Connection | اتصال ميتا (1) · ربط ميتا (1) |
| Needs attention | يحتاج انتباهاً (1) · يحتاج مراجعة (1) |
| New | الجديد (1) · جديد (1) |
| Not sent | لم تُرسل (1) · لم يُرسل (1) |
| Not subscribed | غير مشتركة (1) · لم يتم الاشتراك (1) |
| Open the boosted post | افتح المنشور المروَّج (1) · فتح المنشور الأصلي (1) |
| Open WhatsApp | افتح واتساب (1) · فتح واتساب (1) |
| Order | الترتيب (1) · طلب (1) |
| Products | البضاعة (1) · المنتجات (1) |
| Receipt Funding | تمويل الوصولات (1) · تمويل من الوصولات (1) |
| Receipt value | قيمة الوصل (1) · قيمة الوصولات (1) |
| Reject | ارفض (1) · رفض (1) |
| Removed | تم الحذف (1) · تمت الإزالة (1) |
| Replies | الردود (1) · ردود (1) |
| Request withdrawn | تم سحب الطلب (1) · سُحب الطلب (1) |
| Requires the Clear Logs permission | تحتاج صلاحية مسح السجلات (1) · تحتاج صلاحية مسح/استرجاع السجلات (1) |
| Restore | استرجاع (1) · استعادة (1) |
| Rule | القاعدة (1) · قاعدة (1) |
| Rule deleted | تم حذف القاعدة (1) · حُذفت القاعدة (1) |
| Rule saved | تم حفظ القاعدة (1) · حُفظت القاعدة (1) |
| Sales | المبيعات (1) · مبيعات (1) |
| Save draft | حفظ المسودة (1) · حفظ كمسودة (1) |
| Save failed | فشل الحفظ (1) · لم تُحفظ الخطط. أعد التحميل ثم حاول مرة أخرى. (1) |
| Schedule | المدة (1) · جدولة (1) |
| Selected receipt belongs to a different customer. | الوصل المحدد يخص عميلاً آخر. (1) · الوصل المختار يخص عميلاً آخر. (1) |
| Sent for review | أُرسل للمراجعة (1) · تم الإرسال للمراجعة (1) |
| Serial Number | الرقم التسلسلي (1) · رقم الوصل (1) |
| Server required | يتطلب الخادم (1) · يتطلب السيرفر (1) |
| Server Unreachable | الخادم غير متاح (1) · تعذّر الوصول إلى الخادم (1) |
| Settled | تمت التسوية (1) · مسدَّد (1) |
| Setup needed | تحتاج إعداداً (1) · يحتاج إعداد (1) |
| Social issues, elections or politics | القضايا الاجتماعية أو الانتخابات أو السياسة (1) · قضايا اجتماعية أو انتخابات أو سياسة (1) |
| Stop requested | طلب إيقاف (1) · طُلب الإيقاف (1) |
| The amount cannot be more than the current outstanding debt. | لا يمكن أن يتجاوز المبلغ الدين الحالي. (1) · لا يمكن أن يتجاوز المبلغ الدين المستحق الحالي. (1) |
| The business reason must be 500 characters or fewer. | السبب طويل جداً. (1) · يجب ألا يتجاوز سبب العمل 500 حرف. (1) |
| Top Up Wallet | شحن المحفظة (1) · شحن محفظة (1) |
| Transfer receipt | إيصال الحوالة (1) · وصل محوَّل (1) |
| Unlock Albayan | افتح البيان (1) · افتح تطبيق البيان (1) |
| Use full outstanding | استخدم كامل الدين (1) · استخدم كامل المستحق (1) |
| View receipt | عرض الإيصال (1) · عرض الوصل (1) |
| Wallet top-up | شحن المحفظة (1) · شحن محفظة (1) |
| Will be kept | ستبقى (1) · سيبقى (1) |

## Arabic texts with no English beside them

Arabic that the code writes on its own: counted words ("يومان"), parts joined into a sentence, names. Their English is written a few lines away, not next to them, so the script cannot pair them. They are in `app-texts.csv` with an empty English cell.

| Arabic | Times | Files |
|---|---|---|
| ${more} مسودات أخرى | 1 | systems/ads_studio/15j-studio-home.js |
| ${n} أيام | 1 | systems/ads_studio/15c-ads-studio.js |
| ${n} نسخ في مدير البيان عليها أموال أو تعديلات فبقيت كما هي — راجعها. | 1 | systems/ads_studio/15c-ads-studio.js |
| ${n} نسخة في مدير البيان عليها أموال أو تعديلات فبقيت كما هي — راجعها. | 1 | systems/ads_studio/15c-ads-studio.js |
| ${n} يوماً | 1 | systems/ads_studio/15c-ads-studio.js |
| ${problems.length} لم تكتمل. | 1 | 13b-merge-tools.js |
| ${rows.length} عملاء | 1 | 12d-manager-shell.js |
| ${verbAr} ${amountTxt} إلى ${…} ورصيد العميل | 1 | 16-actions-io.js |
| ${…} د.ل | 2 | 07-i18n-render-core.js 12a-analytics-profit.js |
| &lt;div class="text-center mb-8"> &lt;div class="w-16 h-16 rounded-3xl mx-auto mb-4 alb-mark alb-mark-dot flex items-center justify-center"> &lt;span class="text-white text-2xl font-extrabold">A&lt;/span> &lt;/div> &lt;h1 class="text-3xl font-extrabold text-slate-900 dark:text-white tracking-tight">Albayan &lt;span class="text-lg font-bold text-slate-400">البيان&lt;/span>&lt;/h1> &lt;p class="text-slate-500 mt-1">${…}&lt;/p> &lt;p class="text-sm text-slate-400 mt-2">${subtitle}&lt;/p> &lt;/div> | 1 | 12-views.js |
| &lt;section class="glass-panel rounded-3xl p-5 sm:p-6"> &lt;div class="mb-4 flex flex-wrap items-center justify-between gap-3"> &lt;div>&lt;div class="flex items-center gap-2">&lt;i data-lucide="badge-dollar-sign" class="h-5 w-5 text-emerald-600">&lt;/i>&lt;h2 class="text-xl font-black text-slate-900 dark:text-white">${…}&lt;/h2>&lt;/div> &lt;p class="mt-1 text-sm text-slate-500">${…} ${…}&lt;span id="plan-manager-dirty"${…}> · &lt;span class="font-bold text-amber-600">${…}&lt;/span>&lt;/span>&lt;/p>&lt;/div> &lt;div class="flex gap-2"> &lt;button type="button" onclick="planManagerReload()" class="min-h-11 rounded-xl border border-slate-300 px-4 font-bold text-slate-600 dark:border-slate-700 dark:text-slate-300">${…}&lt;/button> &lt;button type="button" id="plan-manager-save" onclick="savePlanManager()" ${…} class="min-h-11 rounded-xl bg-emerald-600 px-4 font-bold text-white disabled:cursor-not-allowed disabled:opacity-40">${…}&lt;/button> &lt;/div> &lt;/div> ${…} &lt;div class="space-y-2">${…}&lt;/div> &lt;details ${…} ontoggle="_planManager.addOpen = this.open" class="mt-4 rounded-2xl border border-slate-200 p-4 dark:border-slate-700"> &lt;summary class="cursor-pointer select-none font-bold text-slate-700 dark:text-slate-200">${…}&lt;/summary> &lt;div class="mt-3 grid gap-3 sm:grid-cols-2"> &lt;label class="text-xs font-bold text-slate-500">${…}&lt;input id="plan-new-id" class="mt-1 min-h-11 w-full rounded-xl border border-slate-300 px-3 dark:border-slate-700 dark:bg-slate-900" placeholder="pro_bundle" />&lt;/label> &lt;label class="text-xs font-bold text-slate-500">${…}&lt;input id="plan-new-price" type="number" min="0" step="0.01" required class="mt-1 min-h-11 w-full rounded-xl border border-slate-300 px-3 dark:border-slate-700 dark:bg-slate-900" placeholder="150.00" />&lt;/label> &lt;label class="text-xs font-bold text-slate-500">${…}&lt;input id="plan-new-name" class="mt-1 min-h-11 w-full rounded-xl border border-slate-300 px-3 dark:border-slate-700 dark:bg-slate-900" placeholder="Pro Bundle" />&lt;/label> &lt;label class="text-xs font-bold text-slate-500">${…}&lt;input id="plan-new-name-ar" dir="rtl" class="mt-1 min-h-11 w-full rounded-xl border border-slate-300 px-3 dark:border-slate-700 dark:bg-slate-900" placeholder="الباقة الاحترافية" />&lt;/label> &lt;label class="text-xs font-bold text-slate-500">${…}&lt;input id="plan-new-days" type="number" min="1" max="3660" value="30" class="mt-1 min-h-11 w-full rounded-xl border border-slate-300 px-3 dark:border-slate-700 dark:bg-slate-900" />&lt;/label> &lt;div class="text-xs font-bold text-slate-500">${…}&lt;div class="mt-1 grid grid-cols-2 gap-1">${…}&lt;/div>&lt;/div> &lt;/div> &lt;button type="button" onclick="planManagerAddBundle()" class="mt-3 min-h-11 rounded-xl bg-indigo-600 px-4 font-bold text-white">${…}&lt;/button> &lt;/details> &lt;/section> | 1 | 12b-control-center.js |
| Albayan added as a partner in Meta Business Suite / أُضيف البيان كشريك في Meta Business Suite: ${…} | 1 | systems/ads_studio/15o-studio-pages.js |
| Linked to a Facebook page / مربوط بصفحة فيسبوك: ${…} | 1 | systems/ads_studio/15o-studio-pages.js |
| Not yet / ليس بعد | 1 | systems/ads_studio/15o-studio-pages.js |
| Note / ملاحظة: ${draft.note.trim()} | 1 | systems/ads_studio/15o-studio-pages.js |
| Page link / رابط الصفحة: ${…} | 1 | systems/ads_studio/15o-studio-pages.js |
| Page link request / طلب ربط صفحة | 1 | systems/ads_studio/15o-studio-pages.js |
| Page name / اسم الصفحة: ${…} | 1 | systems/ads_studio/15o-studio-pages.js |
| Platform / المنصة: ${platform} | 1 | systems/ads_studio/15o-studio-pages.js |
| Professional account (business or creator) / حساب احترافي (أعمال أو صانع محتوى): ${…} | 1 | systems/ads_studio/15o-studio-pages.js |
| Public account / حساب عام: ${…} | 1 | systems/ads_studio/15o-studio-pages.js |
| Yes / نعم | 1 | systems/ads_studio/15o-studio-pages.js |
| price, how much, السعر | 2 | systems/ads_studio/15f-social-studio.js systems/ads_studio/15o-studio-pages.js |
| ، | 3 | 12d-manager-shell.js systems/ads_studio/15n-studio-help.js systems/ads_studio/15o-studio-pages.js |
| أيام | 3 | systems/ads_studio/15j-studio-home.js systems/ads_studio/15m-studio-wallet.js systems/ads_studio/15n-studio-help.js |
| أُرجع | 2 | 16-actions-io.js |
| إضافة | 1 | 15-modals.js |
| إعلان Meta هذا مرتبط بإعلان آخر (ربما مسودة مستوردة). | 1 | 15d-meta-ads.js |
| ا | 1 | 13-filters-helpers.js |
| اختر: | 1 | 15-modals.js |
| استُخدم | 1 | 16-actions-io.js |
| ال | 1 | 12-views.js |
| الإعلان | 1 | 08-data-audit.js |
| التوصيل | 1 | 08-data-audit.js |
| السجل | 1 | 08-data-audit.js |
| السعر، بكم، price | 2 | systems/ads_studio/15f-social-studio.js systems/ads_studio/15o-studio-pages.js |
| الشحنة | 1 | 08-data-audit.js |
| الصفحة | 1 | 08-data-audit.js |
| الطلب | 1 | 08-data-audit.js |
| العميل | 1 | 08-data-audit.js |
| المستخدم | 1 | 08-data-audit.js |
| المنتج | 1 | 08-data-audit.js |
| الوصل | 2 | 08-data-audit.js 16-actions-io.js |
| الوصولات | 1 | 16-actions-io.js |
| تعديل | 3 | 13-filters-helpers.js 15-modals.js |
| تعذرت مزامنة Meta لهذا الإعلان. | 1 | 13-filters-helpers.js |
| تعذّر استيراد إعلان Meta واحد.${retry} | 1 | 15d-meta-ads.js |
| تعذّر تحميل بعض بيانات (${name}) كاملة من هذا الجهاز، وتم منع الكتابة فوقها لحمايتها. الرجاء الاستعادة من نسخة احتياطية حديثة من الإعدادات. | 1 | 06-persistence.js |
| تغيّر الحساب. سجّل الدخول مرة أخرى قبل تغيير كلمة المرور. | 1 | 15-modals.js |
| تم إيقاف الإعلان | 1 | 16-actions-io.js |
| تم إيقاف الإعلان بنجاح | 1 | 16-actions-io.js |
| تم تحديث الإعلان | 1 | 16-actions-io.js |
| تم تحديث الإعلان بنجاح | 1 | 16-actions-io.js |
| ثانية | 1 | systems/ads_studio/15c-ads-studio.js |
| ثانية واحدة | 1 | systems/ads_studio/15c-ads-studio.js |
| ثانيتين | 1 | systems/ads_studio/15c-ads-studio.js |
| ثوانٍ | 1 | systems/ads_studio/15c-ads-studio.js |
| حالة هذا التوصيل «${trStatus(s)}» نهائية ولا يمكن تغييرها؛ حدّث القائمة. | 1 | 08-data-audit.js |
| حالة هذا التوصيل الآن: ${trStatus(s)}؛ حدّث القائمة. | 1 | 08-data-audit.js |
| حدثت مشكلة أثناء فحص إعلانات Meta.${retry} | 1 | 15d-meta-ads.js |
| حُذفت ${n} نسخ من مدير البيان. | 1 | systems/ads_studio/15c-ads-studio.js |
| حُذفت ${n} نسخة من مدير البيان. | 1 | systems/ads_studio/15c-ads-studio.js |
| حُذفت نسخة واحدة من مدير البيان. | 1 | systems/ads_studio/15c-ads-studio.js |
| حُذفت نسختان من مدير البيان. | 1 | systems/ads_studio/15c-ads-studio.js |
| دقائق | 4 | systems/ads_studio/15c-ads-studio.js systems/ads_studio/15j-studio-home.js systems/ads_studio/15m-studio-wallet.js systems/ads_studio/15n-studio-help.js |
| دقيقة | 7 | systems/ads_studio/15c-ads-studio.js systems/ads_studio/15j-studio-home.js systems/ads_studio/15m-studio-wallet.js systems/ads_studio/15n-studio-help.js |
| دقيقة واحدة | 1 | systems/ads_studio/15c-ads-studio.js |
| دقيقتين | 4 | systems/ads_studio/15c-ads-studio.js systems/ads_studio/15j-studio-home.js systems/ads_studio/15m-studio-wallet.js systems/ads_studio/15n-studio-help.js |
| رفضت Meta صلاحية الدخول. أعد ربط رمز الدخول (access token). | 1 | 15d-meta-ads.js |
| ساعات | 3 | systems/ads_studio/15j-studio-home.js systems/ads_studio/15m-studio-wallet.js systems/ads_studio/15n-studio-help.js |
| ساعة | 6 | systems/ads_studio/15j-studio-home.js systems/ads_studio/15m-studio-wallet.js systems/ads_studio/15n-studio-help.js |
| ساعتين | 3 | systems/ads_studio/15j-studio-home.js systems/ads_studio/15m-studio-wallet.js systems/ads_studio/15n-studio-help.js |
| سيحاول Albayan مرة أخرى تلقائياً. | 1 | 15d-meta-ads.js |
| صفحات | 1 | 12-views.js |
| صفحة | 1 | 12-views.js |
| صفحة فيسبوك | 1 | 13-filters-helpers.js |
| صفحه فيسبوك | 1 | 13-filters-helpers.js |
| صور | 1 | systems/ads_studio/15o-studio-pages.js |
| صورة | 2 | systems/ads_studio/15o-studio-pages.js |
| صورتان | 1 | systems/ads_studio/15o-studio-pages.js |
| طلب إيقاف | 1 | systems/ads_studio/15n-studio-help.js |
| طلب إيقاف واحد | 1 | systems/ads_studio/15n-studio-help.js |
| طلبا إيقاف | 1 | systems/ads_studio/15n-studio-help.js |
| طلبات إيقاف | 1 | systems/ads_studio/15n-studio-help.js |
| عادت ${n} نسخ إلى مدير البيان. | 1 | systems/ads_studio/15c-ads-studio.js |
| عادت ${n} نسخة إلى مدير البيان. | 1 | systems/ads_studio/15c-ads-studio.js |
| عادت نسخة واحدة إلى مدير البيان. | 1 | systems/ads_studio/15c-ads-studio.js |
| عادت نسختان إلى مدير البيان. | 1 | systems/ads_studio/15c-ads-studio.js |
| عميل واحد | 1 | 12d-manager-shell.js |
| فشل إنشاء | 1 | 08-data-audit.js |
| فشل حذف | 1 | 08-data-audit.js |
| فشل حفظ | 1 | 08-data-audit.js |
| كلمة المرور الحالية غير صحيحة. | 1 | 15-modals.js |
| لا توجد تغييرات على الرصيد | 1 | 16-actions-io.js |
| لا يُنقل التوصيل من «${trStatus(a)}» إلى «${trStatus(b)}»: مهمة التوصيل لا يُعاد فتحها ولا ترجع للخلف. | 1 | 08-data-audit.js |
| محاولات كثيرة لتغيير كلمة المرور. الرجاء الانتظار ${…} دقيقة. | 1 | 15-modals.js |
| مخالفات | 1 | systems/ads_studio/15q-studio-admin.js |
| مخالفة | 1 | systems/ads_studio/15q-studio-admin.js |
| مخالفة واحدة | 1 | systems/ads_studio/15q-studio-admin.js |
| مخالفتان | 1 | systems/ads_studio/15q-studio-admin.js |
| مسودة أخرى | 1 | systems/ads_studio/15j-studio-home.js |
| نسخة واحدة في مدير البيان عليها أموال أو تعديلات فبقيت كما هي — راجعها. | 1 | systems/ads_studio/15c-ads-studio.js |
| نسختان في مدير البيان عليهما أموال أو تعديلات فبقيتا كما هما — راجعهما. | 1 | systems/ads_studio/15c-ads-studio.js |
| ه | 1 | 13-filters-helpers.js |
| هاتف | 1 | 07-i18n-render-core.js |
| هذا إعلان تابع لـ Albayan Studio ولا يمكن ربطه هنا. | 1 | 15d-meta-ads.js |
| ي | 1 | 13-filters-helpers.js |
| ينتظر Albayan قراءة اسم حملة Meta لإعلان جديد قبل استيراده. | 1 | 15d-meta-ads.js |
| يوم | 3 | systems/ads_studio/15j-studio-home.js systems/ads_studio/15m-studio-wallet.js systems/ads_studio/15n-studio-help.js |
| يوم واحد | 1 | systems/ads_studio/15c-ads-studio.js |
| يومان | 1 | systems/ads_studio/15c-ads-studio.js |
| يوماً | 3 | systems/ads_studio/15j-studio-home.js systems/ads_studio/15m-studio-wallet.js systems/ads_studio/15n-studio-help.js |
| يومين | 3 | systems/ads_studio/15j-studio-home.js systems/ads_studio/15m-studio-wallet.js systems/ads_studio/15n-studio-help.js |
| ٠١٢٣٤٥٦٧٨٩ | 2 | 13-filters-helpers.js |
| ۰۱۲۳۴۵۶۷۸۹ | 2 | 13-filters-helpers.js |
| — اشحن | 1 | systems/ads_studio/15c-ads-studio.js |
| • إلغاء = الإبقاء على كل شيء | 1 | 15-modals.js |
| • حذف = حذف العميل وجميع وصولاته وإعلاناته | 1 | 15-modals.js |
| ⚠️ تحذير: لدى هذا العميل ${linkedReceipts.length} وصل و ${linkedAds.length} إعلان. | 1 | 15-modals.js |
