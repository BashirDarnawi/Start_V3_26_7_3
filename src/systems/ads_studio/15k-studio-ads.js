// ==========================================
// ALBAYAN STUDIO v2 — MY ADS (plan task P2-04; styles in assets/ads-workspace.css, "Studio v2 Home and My ads")
// ==========================================
// The customer's requests in the v2 layout (?tab=campaigns), registered with the shell (15h) and
// reading the summaries Home keeps (15j):
// - the list: every own request with its stage chip, filters All / Active / Waiting / Finished
//   (&section=active|waiting|finished, so a filter survives Back and a reload);
// - the detail (&id=): stage tracker, who acts next and the last Meta check, the reason and note of a
//   request sent back, the money chain of that request (GET /api/studio/wallet/summary, exactly as
//   the server gives it), Meta's results once the team linked the campaign, and the actions the
//   server's stage allows;
// - in-page sheets, never a native dialog: Withdraw (a request waiting for review), Stop (the stop
//   route's own rule: approved, not started, not linked: a full refund), Archive (a finished request;
//   a draft is deleted), and "Ask to stop" / "Ask about this": coming soon in the app, meanwhile the
//   public contact from /me (P3-10 and P3-08 replace them);
// - Continue editing / "Fix: <field>" open the request builder (15l) on that request.
// Every action is single-flight; withdraw and stop send one operationId per (action, version)
// through the classic helpers (adsStudioActionAttempt), so a retry after a lost answer replays it.
// A sheet is a .mobile-dialog-overlay on <body>: the phone's Back closes it first (01b overlay model),
// and every sign-in change removes it with the app's other overlays (10-live-sync).

const STUDIO_ADS_FILTERS = Object.freeze([
  // [section, English, Arabic, stages]
  ['', 'All', 'الكل', null],
  ['active', 'Active', 'جارية', [4, 5, 6, 7, 8, 9, 10]],
  ['waiting', 'Waiting', 'بالانتظار', [1, 2, 3]],
  ['finished', 'Finished', 'منتهية', [11, 12, 13]]
]);
const STUDIO_ADS_TRACK = Object.freeze([
  ['sent', 'Sent', 'أُرسل'],
  ['approved', 'Approved', 'اعتُمد'],
  ['meta_review', 'Meta review', 'مراجعة ميتا'],
  ['running', 'Running', 'يعمل'],
  ['ended', 'Ended', 'انتهى'],
  ['finished', 'Closed', 'أُغلق']
]);
// The tracker dot of a stage whose server answer is not known yet (stage number - 1).
const STUDIO_ADS_TRACK_BY_STAGE = Object.freeze(['not_sent', 'sent', 'sent', 'approved', 'meta_review', 'meta_review', 'running', 'running', 'running', 'ended', 'finished', 'finished', 'sent']);
const STUDIO_ADS_BUCKETS = Object.freeze({
  inAds: ['In your ads', 'في إعلاناتك'],
  beingReturned: ['Being returned', 'في طريقه إليك'],
  spent: ['Spent', 'صُرف']
});
// Archive / Delete draft: only a request that is done with (the server's deletable statuses minus
// the ones still in progress); an Approved one only once its money is settled (stage 11, Finished).
const STUDIO_ADS_ARCHIVE_STATUSES = Object.freeze(['Draft', 'Rejected', 'Stopped']);
const _studioAdsRuns = new Map();  // `${kind}:${id}` -> the action in flight (single flight)
const _studioAdsSheet = { kind: '', id: '', el: null, opener: null };

// ------------------------------------------------------------------ navigation

function studioAdsSection(route) {
  const section = String((route && route.section) || '');
  return STUDIO_ADS_FILTERS.some(item => item[0] === section) ? section : '';
}

function studioAdsFilter(section) {
  const key = STUDIO_ADS_FILTERS.some(item => item[0] === String(section || '')) ? String(section || '') : '';
  return studioV2Go({ tab: 'campaigns', section: key });
}

function studioAdsCurrentSection() {
  return typeof studioV2ReadAddress === 'function' ? studioAdsSection(studioV2Route(studioV2ReadAddress(), 'customer')) : '';
}

function studioAdsOpen(id) {
  const wanted = String(id || '');
  if (!Security.isValidRecordId(wanted)) return false;
  return studioV2Go({ tab: 'campaigns', section: studioAdsCurrentSection(), id: wanted });
}

function studioAdsBackToList() {
  return studioV2Go({ tab: 'campaigns', section: studioAdsCurrentSection() });
}

// Opens a draft in the request builder where it was, or a request sent back at the field its
// reason names (studioHomeEdit: studioBuilderEdit / studioBuilderFix, 15l).
function studioAdsEdit(id, button = null) {
  const request = studioDataRequest(id);
  if (!request || !['Draft', 'Changes Requested'].includes(String(request.status || 'Draft'))) return false;
  return studioHomeEdit(request.id, button);
}

// Archive / Delete draft is offered by the request's own status too, not the server's stage alone: a
// stage read before a send can still say Draft for a request that is now waiting for review.
function studioAdsCanArchive(request) {
  const status = String((request && request.status) || 'Draft');
  if (STUDIO_ADS_ARCHIVE_STATUSES.includes(status)) return true;
  return status === 'Approved' && !!String((request && request.settleBasis) || '').trim();
}

// ------------------------------------------------------------------ the list

function studioAdsBudgetText(request) {
  const total = String(request.status || '') === 'Submitted' ? adsStudioHeldMinorFor(request) : adsStudioRequestTotalMinor(request);
  const days = adsStudioCampaignDays(request);
  const money = total > 0 ? studioUsd(total) : '';
  if (money && days) return adsStudioText(`${money} for ${adsStudioDaysText(days)}`, `${money} لمدة ${adsStudioDaysText(days)}`);
  return money || (days ? adsStudioDaysText(days) : '');
}

function renderStudioAdsCard(request, stage) {
  const next = stage.nextActor ? adsStudioText(`Next: ${stage.nextActor}`, `التالي: ${stage.nextActor}`) : '';
  const budget = studioAdsBudgetText(request);
  const flags = stage.flags.map(flag => `<span class="studio-flag">${studioEsc(flag.text)}</span>`).join('');
  return `
              <li>
                <button type="button" class="studio-ads-card" data-testid="studio-ad-${studioEsc(request.id)}" data-stage="${stage.stage}" onclick="studioAdsOpen('${request.id}')">
                  <span class="studio-ads-card-name">${studioEsc(studioDataName(request))}</span>
                  ${renderStudioStageChip(stage)}
                  <span class="studio-ads-card-meta">
                    ${budget ? `<span dir="auto">${studioEsc(budget)}</span>` : ''}
                    ${next ? `<span>${studioEsc(next)}</span>` : ''}
                    ${stage.checkedAgo ? `<span class="studio-checked${stage.stale ? ' is-stale' : ''}">${studioEsc(stage.checkedAgo)}</span>` : ''}
                  </span>
                  ${flags ? `<span class="studio-flags">${flags}</span>` : ''}
                </button>
              </li>`;
}

function renderStudioAdsList(route) {
  const section = studioAdsSection(route);
  const rows = studioDataRequests().map(request => ({ request, stage: studioDataStage(request) }));
  const summaryState = studioDataState('campaigns');
  const inFilter = (item, stages) => !stages || stages.includes(item.stage.stage);
  const chips = STUDIO_ADS_FILTERS.map(([key, en, ar, stages]) => {
    const count = rows.filter(item => inFilter(item, stages)).length;
    return `<button type="button" class="studio-ads-filter" data-testid="studio-ads-filter-${key || 'all'}" aria-pressed="${key === section ? 'true' : 'false'}" onclick="studioAdsFilter('${key}')"><span>${studioEsc(adsStudioText(en, ar))}</span><span class="studio-ads-count">${count}</span></button>`;
  }).join('');
  const stages = (STUDIO_ADS_FILTERS.find(item => item[0] === section) || STUDIO_ADS_FILTERS[0])[3];
  const shown = rows.filter(item => inFilter(item, stages));
  const empty = rows.length
    ? adsStudioText('No requests in this list.', 'لا توجد طلبات في هذه القائمة.')
    : adsStudioText('You have no ad requests yet. Start one when you are ready.', 'لا توجد لديك طلبات إعلان بعد. ابدأ واحداً عندما تكون جاهزاً.');
  const canAsk = studioHomeCanAsk();
  return `
        <div class="studio-ads" data-testid="studio-ads">
          <div class="studio-ads-bar">
            <div class="studio-ads-filters" role="group" aria-label="${studioEsc(adsStudioText('Show', 'اعرض'))}">${chips}</div>
            ${canAsk ? `<button type="button" class="studio-v2-action is-primary" data-testid="studio-ads-new" onclick="studioHomeGoal('messages')">${studioV2Icon('plus')}<span>${studioEsc(adsStudioText('New request', 'طلب جديد'))}</span></button>` : ''}
          </div>
          ${!summaryState.error ? '' : `<p class="studio-home-empty">${studioEsc(adsStudioText('The latest stages could not be loaded; the list shows what we know.', 'تعذّر تحميل آخر المراحل؛ تعرض القائمة ما نعرفه.'))}</p>`}
          ${shown.length ? `<ul class="studio-ads-list" data-testid="studio-ads-list">${shown.map(item => renderStudioAdsCard(item.request, item.stage)).join('')}
          </ul>` : `<p class="studio-home-empty" data-testid="studio-ads-empty">${studioEsc(empty)}</p>`}
        </div>`;
}

// ------------------------------------------------------------------ the detail

function renderStudioAdsTracker(stage) {
  const step = stage.tracker.step || STUDIO_ADS_TRACK_BY_STAGE[stage.stage - 1] || '';
  if (!step || step === 'not_sent') {
    return `<p class="studio-ads-track-none" data-testid="studio-ad-track">${studioV2Icon('pencil')}<span>${studioEsc(adsStudioText('Not sent yet', 'لم يُرسل بعد'))}</span></p>`;
  }
  const at = STUDIO_ADS_TRACK.findIndex(item => item[0] === step);
  const items = STUDIO_ADS_TRACK.map(([key, en, ar], index) => {
    const current = index === at;
    const mark = index < at ? ' is-done' : (current ? ' is-current' : '');
    const side = current && stage.tracker.side;
    const icon = index < at ? 'check' : (current ? (side ? stage.icon : 'circle-dot') : '');
    return `<li class="studio-ads-track-step${mark}${side ? ' is-side' : ''}"${current ? ` aria-current="step" data-tone="${studioEsc(stage.tone)}"` : ''}><span class="studio-ads-track-dot" aria-hidden="true">${icon ? studioV2Icon(icon, 'studio-ads-track-icon') : ''}</span><span class="studio-ads-track-name">${studioEsc(adsStudioText(en, ar))}</span></li>`;
  }).join('');
  // Phones show the current step in words under the dots (the names under each dot need more room).
  const current = at >= 0 ? STUDIO_ADS_TRACK[at] : null;
  const words = current ? adsStudioText(`Step ${at + 1} of ${STUDIO_ADS_TRACK.length}: ${current[1]}`, `المرحلة ${at + 1} من ${STUDIO_ADS_TRACK.length}: ${current[2]}`) : '';
  return `<ol class="studio-ads-track" data-testid="studio-ad-track" data-step="${studioEsc(step)}" aria-label="${studioEsc(adsStudioText('Progress', 'مراحل الطلب'))}">${items}</ol>${words ? `<p class="studio-ads-track-text" aria-hidden="true">${studioEsc(words)}</p>` : ''}`;
}

function renderStudioAdsReason(request, stage) {
  const status = String(request.status || '');
  if (!['Changes Requested', 'Rejected'].includes(status) && ![3, 13].includes(stage.stage)) return '';
  const labels = [adsStudioReviewReasonLabel(request.reviewReasonCode)].concat(stage.reasons.map(adsStudioReviewReasonLabel)).filter(Boolean);
  const unique = Array.from(new Set(labels));
  const note = String(request.reviewNote || '').trim();
  if (!unique.length && !note) return '';
  const rejected = status === 'Rejected' || stage.stage === 13;
  return `
          <section class="studio-ads-box studio-ads-reason" data-testid="studio-ad-reason" data-tone="${rejected ? 'red' : 'orange'}">
            <h3 class="studio-ads-h3">${studioEsc(rejected ? adsStudioText('Why our team did not approve it', 'لماذا لم يعتمده فريقنا') : adsStudioText('What to change', 'ما المطلوب تعديله'))}</h3>
            ${unique.length ? `<p class="studio-ads-reason-label">${studioEsc(unique.join(' · '))}</p>` : ''}
            ${note ? `<p class="studio-ads-reason-note" dir="auto">${studioEsc(note.slice(0, 2000))}</p>` : ''}
          </section>`;
}

function renderStudioAdsMoneyRow(label, minor, testId = '') {
  return `<li class="studio-ads-money-row"${testId ? ` data-testid="${testId}"` : ''}><span>${studioEsc(label)}</span><span class="studio-ads-money-amount">${studioLtr(studioUsd(minor))}</span></li>`;
}

// This request's money, from the wallet summary: its reservation and every paid cycle (payment,
// returns, and the number that cycle counts in), with the server's own labels and amounts.
function renderStudioAdsMoney(request, stage) {
  const wallet = studioDataValue('wallet');
  const walletState = studioDataState('wallet');
  const id = request.id;
  const reserved = wallet && Array.isArray(wallet.reserved) ? wallet.reserved.find(item => item && item.campaignId === id) : null;
  const chains = wallet && Array.isArray(wallet.chains) ? wallet.chains.filter(chain => chain && chain.campaignId === id) : [];
  let body = '';
  if (!wallet) {
    body = walletState.error ? renderStudioHomeProblem(walletState.error)
      : `<p class="studio-home-empty">${studioEsc(adsStudioText('Loading the money of this request…', 'نحمّل أموال هذا الطلب…'))}</p>`;
  } else {
    const parts = [];
    const held = reserved ? studioDataMinor(reserved.budgetMinor) : null;
    if (held !== null) {
      const daily = studioDataMinor(reserved.dailyMinor);
      const days = studioDataMinor(reserved.days);
      parts.push(`<ul class="studio-ads-money-rows" data-testid="studio-ad-reserved">
              ${renderStudioAdsMoneyRow(adsStudioText('Reserved — still yours', 'محجوز — ما زال لك'), held)}
            </ul>${daily !== null && days !== null ? `<p class="studio-ads-money-note">${studioLtr(`${studioUsd(daily)} × ${days}`)} ${studioEsc(adsStudioText('(daily × days)', '(يومياً × الأيام)'))}</p>` : ''}`);
    }
    for (const chain of chains) {
      const steps = (Array.isArray(chain.steps) ? chain.steps : []).filter(step => step && typeof step === 'object' && studioDataMinor(step.amountMinor) !== null);
      const bucket = Object.prototype.hasOwnProperty.call(STUDIO_ADS_BUCKETS, chain.bucket) ? STUDIO_ADS_BUCKETS[chain.bucket] : null;
      const net = studioDataMinor(chain.netMinor);
      const returned = studioDataMinor(chain.returnedMinor);
      const full = chain.state === 'returned' && returned !== null;
      const totalLabel = full ? adsStudioText('Came back to you in full', 'عاد إليك كاملاً') : (bucket ? adsStudioText(bucket[0], bucket[1]) : '');
      const totalMinor = full ? returned : net;
      const used = studioDataMinor(chain.metaUsedMinor);
      const ago = used === null ? '' : studioDataCheckedAgo(chain.checkedAt);
      parts.push(`<div class="studio-ads-chain" data-testid="studio-ad-chain" data-bucket="${studioEsc(chain.bucket || '')}">
              <ul class="studio-ads-money-rows">${steps.map(step => renderStudioAdsMoneyRow(studioPickText(step.labels, 240), step.amountMinor)).join('')}</ul>
              ${totalLabel && totalMinor !== null ? `<p class="studio-ads-chain-total"><span>${studioEsc(totalLabel)}</span><span class="studio-ads-money-amount">${studioLtr(studioUsd(totalMinor))}</span></p>` : ''}
              ${used !== null ? `<p class="studio-ads-money-note" data-testid="studio-ad-meta-used">${studioEsc(adsStudioText(`Meta used ${studioUsd(used)} so far${ago ? ` · ${ago}` : ''}`, `استخدمت ميتا ${studioUsd(used)} حتى الآن${ago ? ` · ${ago}` : ''}`))}</p>` : ''}
            </div>`);
    }
    body = parts.length ? parts.join('')
      : `<p class="studio-home-empty">${studioEsc(adsStudioText('Nothing is held or paid for this request right now.', 'لا يوجد مبلغ محجوز أو مدفوع لهذا الطلب الآن.'))}</p>`;
  }
  return `
          <section class="studio-ads-box" data-testid="studio-ad-money" aria-labelledby="studio-ad-money-title">
            <h3 id="studio-ad-money-title" class="studio-ads-h3">${studioEsc(adsStudioText('Money for this request', 'أموال هذا الطلب'))}</h3>
            ${stage.money ? `<p class="studio-ads-money-meaning">${studioEsc(stage.money)}</p>` : ''}
            ${body}
          </section>`;
}

// Meta's numbers once the team linked the campaign (GET /api/studio/campaigns/{id}/results through
// the classic reader: one read at a time, the last good values kept when a read fails).
function renderStudioAdsResults(request) {
  if (typeof adsStudioShowsResults !== 'function' || !adsStudioShowsResults(request)) return '';
  adsStudioLoadResults(request.id);
  const entry = _adsStudioResults.byId.get(String(request.id));
  const data = entry ? entry.data : null;
  let body;
  if (!data) {
    body = `<p class="studio-home-empty">${studioEsc(entry && entry.state === 'failed'
      ? adsStudioText("Meta's numbers are late; we will check again automatically.", 'تأخرت أرقام ميتا؛ سنتحقق مرة أخرى تلقائياً.')
      : adsStudioText('Checking Meta…', 'نتحقق من ميتا…'))}</p>`;
  } else {
    const used = studioDataMinor(data.metaUsedMinor);
    const paid = studioDataMinor(data.paidMinor);
    const usedText = used === null ? '' : (paid
      ? adsStudioText(`Meta used ${studioUsd(used)} of ${studioUsd(paid)}`, `استخدمت ميتا ${studioUsd(used)} من ${studioUsd(paid)}`)
      : adsStudioText(`Meta used ${studioUsd(used)} so far`, `استخدمت ميتا ${studioUsd(used)} حتى الآن`));
    const stats = [
      [adsStudioText('Impressions', 'مرات الظهور'), data.impressions],
      [adsStudioText('Reach', 'الوصول'), data.reach],
      [adsStudioResultTypeLabel(data.resultType), data.resultCount]
    ].filter(([, value]) => Number.isSafeInteger(value));
    const ago = data.checkedAgo ? studioPickText(data.checkedAgo, 80) : '';
    body = `${data.stageLabels ? `<p class="studio-ads-money-meaning">${studioEsc(studioPickText(data.stageLabels, 160))}</p>` : ''}
            ${usedText ? `<p class="studio-ads-results-used" data-testid="studio-ad-results-used">${studioEsc(usedText)}</p>` : ''}
            ${stats.length ? `<dl class="studio-ads-stats">${stats.map(([label, value]) => `<div><dt>${studioEsc(label)}</dt><dd>${studioEsc(adsStudioCount(value))}</dd></div>`).join('')}</dl>` : ''}
            ${ago ? `<p class="studio-checked${data.stale ? ' is-stale' : ''}">${studioEsc(ago)}</p>` : ''}
            <p class="studio-ads-money-note">${studioEsc(adsStudioText('Reported by Meta', 'بحسب ما تُبلغ به ميتا'))}</p>`;
  }
  return `
          <section class="studio-ads-box" data-testid="studio-ad-results" aria-labelledby="studio-ad-results-title" aria-live="polite">
            <h3 id="studio-ad-results-title" class="studio-ads-h3">${studioEsc(adsStudioText('Meta results', 'نتائج ميتا'))}</h3>
            ${body}
          </section>`;
}

// The actions this request offers now: the server's stage decides, the app's permissions agree.
function studioAdsActions(request, stage) {
  const status = String(request.status || 'Draft');
  const creator = request.createdBy;
  const own = String(creator || '') === studioMeUserId();
  const offered = new Set(stage.actions);
  const out = [];
  if (['Draft', 'Changes Requested'].includes(status) && canActOnRecord('adCampaignRequests', 'edit', creator)) out.push('edit');
  if (status === 'Submitted' && own && (offered.has('withdraw') || !stage.fromServer) && canActOnRecord('adCampaignRequests', 'submit', creator)) out.push('withdraw');
  if (status === 'Approved' && offered.has('stop_refund') && canActOnRecord('adCampaignRequests', 'stop', creator)) out.push('stop');
  if (status === 'Approved' && offered.has('ask_to_stop')) out.push('ask_stop');
  if ((offered.has('archive') || offered.has('delete')) && studioAdsCanArchive(request) && canActOnRecord('adCampaignRequests', 'delete', creator)) out.push('archive');
  if (offered.has('ask')) out.push('ask');
  return out;
}

function studioAdsActionLabel(action, request, stage) {
  switch (action) {
    case 'edit': return String(request.status || '') === 'Changes Requested' ? studioHomeFixLabel(request) : adsStudioText('Continue editing', 'أكمل التعديل');
    case 'withdraw': return adsStudioText('Withdraw', 'اسحب الطلب');
    case 'stop': return adsStudioText('Stop and get a full refund', 'أوقفه واسترد المبلغ كاملاً');
    case 'ask_stop': return adsStudioText('Ask to stop', 'اطلب الإيقاف');
    case 'archive': return stage.stage === 1 ? adsStudioText('Delete draft', 'احذف المسودة') : adsStudioText('Archive', 'أرشف');
    case 'ask': return adsStudioText('Ask about this', 'اسأل عن هذا');
    default: return '';
  }
}

const STUDIO_ADS_ACTION_LOOK = Object.freeze({
  edit: ['pencil', ' is-primary', 'studioAdsEdit'],
  withdraw: ['undo-2', '', 'studioAdsSheet'],
  stop: ['circle-stop', ' studio-ads-danger', 'studioAdsSheet'],
  ask_stop: ['hand', '', 'studioAdsSheet'],
  archive: ['archive', '', 'studioAdsSheet'],
  ask: ['message-circle', '', 'studioAdsSheet']
});

function renderStudioAdsActions(request, stage) {
  const actions = studioAdsActions(request, stage);
  if (!actions.length) return '';
  const buttons = actions.map(action => {
    const [icon, look, handler] = STUDIO_ADS_ACTION_LOOK[action];
    const call = handler === 'studioAdsEdit' ? `studioAdsEdit('${request.id}', this)` : `studioAdsSheet('${action}', '${request.id}', this)`;
    const busy = _studioAdsRuns.has(`${action}:${request.id}`);
    return `<button type="button" class="studio-v2-action${look}" data-testid="studio-ad-action-${action}" onclick="${call}"${busy ? ' disabled aria-busy="true"' : ''}>${studioV2Icon(action === 'archive' && stage.stage === 1 ? 'trash-2' : icon)}<span>${studioEsc(studioAdsActionLabel(action, request, stage))}</span></button>`;
  }).join('');
  return `<div class="studio-ads-actions" data-testid="studio-ad-actions">${buttons}</div>`;
}

function renderStudioAdsBrief(request) {
  const platforms = (Array.isArray(request.platforms) ? request.platforms : []).map(item => String(item)).filter(Boolean)
    .map(item => (item === 'facebook' ? 'Facebook' : item === 'instagram' ? 'Instagram' : item)).join(' + ');
  const days = adsStudioCampaignDays(request);
  const rows = [
    [adsStudioText('Budget', 'الميزانية'), studioAdsBudgetText(request)],
    [adsStudioText('Page', 'الصفحة'), String(request.pageName || '')],
    [adsStudioText('Where', 'المنصات'), platforms],
    [adsStudioText('Dates', 'التواريخ'), request.startDate ? `${adsStudioFormatDate(request.startDate)} → ${adsStudioFormatDate(request.endDate)}` : (days ? adsStudioDaysText(days) : '')],
    [adsStudioText('Ad text', 'نص الإعلان'), String(request.primaryText || '')]
  ].filter(([, value]) => value);
  if (!rows.length) return '';
  return `
          <details class="studio-ads-box studio-ads-brief">
            <summary class="studio-ads-h3"><span>${studioEsc(adsStudioText('The request', 'تفاصيل الطلب'))}</span>${studioV2Icon('chevron-down', 'studio-ads-brief-icon')}</summary>
            <dl class="studio-ads-brief-list">${rows.map(([label, value]) => `<div><dt>${studioEsc(label)}</dt><dd dir="auto">${studioEsc(String(value).slice(0, 2000))}</dd></div>`).join('')}</dl>
          </details>`;
}

function renderStudioAdsDetail(route) {
  const request = studioDataRequest(route.id);
  if (!request) {
    return `
        <div class="studio-ads-box studio-ads-missing" data-testid="studio-ad-missing">
          <p>${studioEsc(adsStudioText('This request is not in your list any more.', 'هذا الطلب لم يعد في قائمتك.'))}</p>
          <button type="button" class="studio-v2-action" onclick="studioAdsBackToList()">${studioEsc(adsStudioText('My ads', 'إعلاناتي'))}</button>
        </div>`;
  }
  const stage = studioDataStage(request);
  const next = stage.nextActor ? adsStudioText(`Next: ${stage.nextActor}`, `التالي: ${stage.nextActor}`) : '';
  const flags = stage.flags.map(flag => `<span class="studio-flag">${studioEsc(flag.text)}</span>`).join('');
  return `
        <article class="studio-ads-detail" data-testid="studio-ad-detail" data-stage="${stage.stage}" aria-labelledby="studio-ad-name">
          <header class="studio-ads-box studio-ads-head">
            <h2 id="studio-ad-name" class="studio-ads-name" dir="auto">${studioEsc(studioDataName(request))}</h2>
            ${renderStudioStageChip(stage)}
            ${stage.variant ? `<p class="studio-ads-variant">${studioEsc(stage.variant)}</p>` : ''}
            ${renderStudioAdsTracker(stage)}
            <p class="studio-ads-next">
              ${next ? `<span data-testid="studio-ad-next">${studioEsc(next)}</span>` : ''}
              ${stage.checkedAgo ? `<span class="studio-checked${stage.stale ? ' is-stale' : ''}">${studioEsc(stage.checkedAgo)}</span>` : ''}
            </p>
            ${flags ? `<p class="studio-flags">${flags}</p>` : ''}
            ${renderStudioAdsActions(request, stage)}
          </header>
          ${renderStudioAdsReason(request, stage)}
          ${renderStudioAdsMoney(request, stage)}
          ${renderStudioAdsResults(request)}
          ${renderStudioAdsBrief(request)}
        </article>`;
}

function renderStudioAdsBody(route) {
  studioDataWant('campaigns');
  studioDataWant('wallet');
  return route && route.id ? renderStudioAdsDetail(route) : renderStudioAdsList(route);
}

studioV2RegisterScreen('campaigns', renderStudioAdsBody);

// ------------------------------------------------------------------ sheets

// Contact links for the "coming soon" sheets: the public contact of /me (never the urgent line).
function renderStudioAdsContact(request, purpose) {
  const me = studioMe();
  const contact = me && me.contact ? me.contact : {};
  const name = studioDataName(request).slice(0, 80);
  const ref = /^ALB-S-[A-Za-z0-9]{1,20}$/.test(String(request.studioRef || '')) ? ` (${request.studioRef})` : '';
  const message = purpose === 'stop'
    ? adsStudioText(`Hello Albayan team, please stop my ad "${name}"${ref}.`, `مرحباً فريق البيان، أرجو إيقاف إعلاني «${name}»${ref}.`)
    : adsStudioText(`Hello Albayan team, I have a question about my request "${name}"${ref}.`, `مرحباً فريق البيان، لدي سؤال عن طلبي «${name}»${ref}.`);
  const links = [];
  if (contact.whatsapp) {
    links.push(['whatsapp', `https://wa.me/${contact.whatsapp.replace(/^\+/, '')}?text=${encodeURIComponent(message)}`, 'message-circle', adsStudioText('WhatsApp', 'واتساب'), true]);
  }
  if (contact.phone) links.push(['phone', `tel:${contact.phone}`, 'phone', adsStudioText('Call us', 'اتصل بنا'), false]);
  if (contact.email) {
    links.push(['email', `mailto:${contact.email}?subject=${encodeURIComponent(message.slice(0, 120))}`, 'mail', adsStudioText('Email', 'البريد'), false]);
  }
  const open = me && me.serviceHours && typeof me.serviceHours.openNow === 'boolean' ? me.serviceHours.openNow : null;
  const hours = open === null ? '' : (open
    ? adsStudioText('We are working now.', 'نحن في ساعات العمل الآن.')
    : adsStudioText('We are outside working hours now; we answer as soon as we open.', 'نحن خارج ساعات العمل الآن؛ نرد فور بدء الدوام.'));
  const list = links.map(([key, href, icon, label, newTab]) =>
    `<a class="studio-v2-action" data-testid="studio-contact-${key}" href="${studioEsc(href)}"${newTab ? ' target="_blank" rel="noopener noreferrer"' : ''}>${studioV2Icon(icon)}<span>${studioEsc(label)}</span></a>`).join('');
  return `
            <div class="studio-ads-contact" data-testid="studio-sheet-contact">
              ${list || `<p class="studio-ads-sheet-text">${studioEsc(adsStudioText('Our contact details are not published yet. Please reach your usual Albayan contact.', 'لم تُنشر وسائل التواصل معنا بعد. تواصل مع جهة الاتصال المعتادة لديك في البيان.'))}</p>`}
              ${hours ? `<p class="studio-ads-sheet-note">${studioEsc(hours)}</p>` : ''}
              ${list ? `<p class="studio-ads-sheet-note" dir="auto">${studioEsc(adsStudioText(`Mention: ${name}${ref}`, `اذكر: ${name}${ref}`))}</p>` : ''}
            </div>`;
}

// The amount a sheet speaks of: the server's number when the wallet summary has it.
function studioAdsSheetAmount(kind, request) {
  const wallet = studioDataValue('wallet');
  if (kind === 'withdraw') {
    const item = wallet && Array.isArray(wallet.reserved) ? wallet.reserved.find(entry => entry && entry.campaignId === request.id) : null;
    const held = item ? studioDataMinor(item.budgetMinor) : null;
    return held !== null ? held : adsStudioHeldMinorFor(request);
  }
  const paid = wallet && Array.isArray(wallet.inAds) ? wallet.inAds.find(entry => entry && entry.campaignId === request.id) : null;
  const inAds = paid ? studioDataMinor(paid.inAdsMinor) : null;
  return inAds !== null ? inAds : Math.max(parseInt(request.paidMinorUSD, 10) || 0, 0);
}

function renderStudioAdsSheet(kind, request, stage) {
  const amount = kind === 'withdraw' || kind === 'stop' ? studioUsd(studioAdsSheetAmount(kind, request)) : '';
  const draft = stage.stage === 1;
  const texts = {
    withdraw: [adsStudioText('Withdraw this request?', 'سحب هذا الطلب؟'),
      adsStudioText(`Your reservation of ${amount} ends now and the money is available again. The request goes back to your drafts.`,
        `ينتهي حجز ${amount} الآن ويعود المبلغ إلى رصيدك المتاح، ويرجع الطلب إلى مسوداتك.`),
      adsStudioText('Withdraw', 'اسحب الطلب'), adsStudioText('Keep it', 'أبقِه')],
    stop: [adsStudioText('Stop this ad before it starts?', 'إيقاف هذا الإعلان قبل أن يبدأ؟'),
      adsStudioText(`The full ${amount} you paid comes back to your available money now, and the request closes as stopped.`,
        `يعود كامل المبلغ الذي دفعته ${amount} إلى رصيدك المتاح الآن، ويُغلق الطلب كطلب موقوف.`),
      adsStudioText('Stop and refund', 'أوقفه واسترد المبلغ'), adsStudioText('Keep it', 'أبقِه')],
    archive: draft
      ? [adsStudioText('Delete this draft?', 'حذف هذه المسودة؟'),
        adsStudioText('The draft and its photos are removed. Nothing was reserved for it.', 'تُحذف المسودة وصورها. لم يُحجز لها أي مبلغ.'),
        adsStudioText('Delete', 'احذف'), adsStudioText('Keep it', 'أبقِها')]
      : [adsStudioText('Archive this request?', 'أرشفة هذا الطلب؟'),
        adsStudioText('It leaves your lists. Your money history stays in the wallet.', 'يختفي من قوائمك، ويبقى سجل أموالك في المحفظة.'),
        adsStudioText('Archive', 'أرشف'), adsStudioText('Keep it', 'أبقِه')],
    ask_stop: [adsStudioText('Ask us to stop this ad', 'اطلب منا إيقاف هذا الإعلان'),
      adsStudioText('Asking from the app is coming soon. Until then, contact the Albayan team and mention this ad. Meta may keep spending until we pause it; what Meta did not spend comes back after its numbers settle, usually within 2–3 days.',
        'طلب الإيقاف من داخل التطبيق قريباً. إلى ذلك الحين تواصل مع فريق البيان واذكر هذا الإعلان. قد تواصل ميتا الصرف حتى نوقفه، ويعود إليك ما لم تصرفه ميتا بعد أن تثبت أرقامها، عادةً خلال يومين إلى ثلاثة.'),
      '', adsStudioText('Close', 'إغلاق')],
    ask: [adsStudioText('Ask about this request', 'اسأل عن هذا الطلب'),
      adsStudioText('Messages inside the app are coming soon. Until then, contact the Albayan team and mention this request.',
        'المراسلة من داخل التطبيق قريباً. إلى ذلك الحين تواصل مع فريق البيان واذكر هذا الطلب.'),
      '', adsStudioText('Close', 'إغلاق')]
  };
  const [title, text, confirmLabel, cancelLabel] = texts[kind];
  const soon = kind === 'ask_stop' || kind === 'ask';
  return `
    <div class="mobile-dialog-overlay studio-ads-sheet" data-testid="studio-sheet-${kind.replace('_', '-')}" onclick="if (event.target === this) studioAdsCloseSheet()">
      <div class="studio-ads-sheet-panel" role="dialog" aria-modal="true" aria-labelledby="studio-ads-sheet-title" dir="${adsStudioIsAr() ? 'rtl' : 'ltr'}">
        ${soon ? `<p class="studio-ads-soon">${studioEsc(adsStudioText('Coming soon', 'قريباً'))}</p>` : ''}
        <h2 id="studio-ads-sheet-title" class="studio-ads-sheet-title">${studioEsc(title)}</h2>
        <p class="studio-ads-sheet-name" dir="auto">${studioEsc(studioDataName(request))}</p>
        <p class="studio-ads-sheet-text">${studioEsc(text)}</p>
        ${soon ? renderStudioAdsContact(request, kind === 'ask_stop' ? 'stop' : 'ask') : ''}
        <p class="studio-ads-sheet-error" role="alert" data-testid="studio-sheet-error" hidden></p>
        <div class="studio-ads-sheet-actions">
          <button type="button" class="studio-v2-action" data-testid="studio-sheet-cancel" data-sheet-focus="1" onclick="studioAdsCloseSheet()">${studioEsc(cancelLabel)}</button>
          ${confirmLabel ? `<button type="button" class="studio-v2-action is-primary${kind === 'stop' ? ' studio-ads-danger' : ''}" data-testid="studio-sheet-confirm" onclick="studioAdsConfirmSheet()">${studioEsc(confirmLabel)}</button>` : ''}
        </div>
      </div>
    </div>`;
}

// Opens one sheet (another open one is replaced). The request must still offer that action.
// "Ask about this" and "Ask to stop" go to the help desk (15n) once its services are on for this
// user; the "coming soon" sheets below stay for everyone else.
function studioAdsSheet(kind, id, opener = null) {
  if (typeof document === 'undefined' || !document.body) return false;
  const request = studioDataRequest(id);
  if (!request) return false;
  const stage = studioDataStage(request);
  if (!studioAdsActions(request, stage).includes(kind) || kind === 'edit') return false;
  if (kind === 'ask' && typeof studioHelpAskAbout === 'function' && studioHelpAskAbout('campaign', request.id)) return true;
  if (kind === 'ask_stop' && typeof studioStopSheetOpen === 'function' && studioStopSheetOpen(request.id, opener)) return true;
  const holder = document.createElement('div');
  holder.innerHTML = renderStudioAdsSheet(kind, request, stage).trim();
  const el = holder.firstElementChild;
  if (!el) return false;
  const previous = _studioAdsSheet.el;
  _studioAdsSheet.kind = kind;
  _studioAdsSheet.id = request.id;
  _studioAdsSheet.el = el;
  _studioAdsSheet.opener = opener || _studioAdsSheet.opener;
  el.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (_studioAdsSheet.el === el) studioAdsCloseSheet();
    }
  });
  if (previous && previous.isConnected) previous.replaceWith(el);
  else document.body.appendChild(el);
  if (typeof IconQueue !== 'undefined' && IconQueue && typeof IconQueue.schedule === 'function') IconQueue.schedule(el);
  const focus = el.querySelector('[data-sheet-focus]');
  try { if (focus) focus.focus(); } catch (_) {}
  return true;
}

function studioAdsCloseSheet() {
  const el = _studioAdsSheet.el;
  const opener = _studioAdsSheet.opener;
  _studioAdsSheet.kind = '';
  _studioAdsSheet.id = '';
  _studioAdsSheet.el = null;
  _studioAdsSheet.opener = null;
  if (el && el.isConnected) el.remove();
  try { if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus(); } catch (_) {}
}

// On a phone the open sheet owns one history entry that closing it gives back (01b overlay model);
// a navigation right after waits for that step so the two never cross.
function studioAdsAfterSheet(fn) {
  let pending = false;
  try { pending = !!(window.history.state && window.history.state.overlaySentinel); } catch (_) {}
  if (pending && typeof studioV2AfterPop === 'function') studioV2AfterPop(fn);
  else fn();
}

function studioAdsSheetBusy(el, busy, errorText = '') {
  if (!el) return;
  el.querySelectorAll('.studio-ads-sheet-actions button').forEach(button => {
    button.disabled = !!busy && button.getAttribute('data-testid') === 'studio-sheet-confirm';
    if (busy && button.getAttribute('data-testid') === 'studio-sheet-confirm') button.setAttribute('aria-busy', 'true');
    else button.removeAttribute('aria-busy');
  });
  const error = el.querySelector('.studio-ads-sheet-error');
  if (error) {
    error.textContent = errorText;
    error.hidden = !errorText;
  }
}

function studioAdsConfirmSheet() {
  const el = _studioAdsSheet.el;
  const kind = _studioAdsSheet.kind;
  const id = _studioAdsSheet.id;
  if (!el || !el.isConnected || !['withdraw', 'stop', 'archive'].includes(kind)) return null;
  studioAdsSheetBusy(el, true);
  const operation = studioAdsRun(kind, id);
  operation.then(outcome => {
    const open = _studioAdsSheet.el === el && el.isConnected;
    if (!outcome || !outcome.ok) {
      const text = (outcome && outcome.text) || adsStudioText('The action could not be completed. Nothing changed in your balance.', 'تعذّر إتمام العملية. لم يتغير شيء في رصيدك.');
      if (open) studioAdsSheetBusy(el, false, text);
      else showNotification(adsStudioText('Not done', 'لم يتم'), text, 'error');  // the sheet was closed meanwhile
      return;
    }
    if (_studioAdsSheet.el === el) studioAdsCloseSheet();
    if (outcome.leave) {
      studioAdsAfterSheet(() => {
        const route = studioV2Route(studioV2ReadAddress(), 'customer');
        if (route.tab === 'campaigns' && route.id === id) studioAdsBackToList();
      });
    }
  });
  return operation;
}

// ------------------------------------------------------------------ the actions

// One action per request at a time: a second tap joins the first.
function studioAdsRun(kind, id) {
  const key = `${kind}:${String(id || '')}`;
  if (_studioAdsRuns.has(key)) return _studioAdsRuns.get(key);
  const once = { withdraw: studioAdsWithdrawOnce, stop: studioAdsStopOnce, archive: studioAdsArchiveOnce }[kind];
  const operation = (once ? once(String(id || '')) : Promise.resolve({ ok: false }))
    .catch(error => ({ ok: false, text: studioErrorInfo(error, 'action').text }));
  _studioAdsRuns.set(key, operation);
  const cleanup = () => {
    if (_studioAdsRuns.get(key) === operation) _studioAdsRuns.delete(key);
    studioV2Rerender();
  };
  operation.then(cleanup, cleanup);
  return operation;
}

function studioAdsNoServer() {
  return { ok: false, text: adsStudioText('This moves wallet money, which needs the connection to Albayan.', 'هذا الإجراء يحرّك أموال المحفظة، ويحتاج الاتصال بالبيان.') };
}

function studioAdsGoneText() {
  return { ok: false, text: adsStudioText('This request changed meanwhile. Check its new state.', 'تغيّر هذا الطلب في الأثناء. راجع حالته الجديدة.') };
}

// After money moved: the wallet rows, both summaries (the one copy Home, the builder and Wallet read)
// and the screen.
function studioAdsAfterMoney() {
  if (typeof resetAdsStudioWalletCache === 'function') resetAdsStudioWalletCache();
  if (typeof serverLiveSyncTick === 'function') {
    try {
      const tick = serverLiveSyncTick();
      if (tick && typeof tick.catch === 'function') tick.catch(() => {});
    } catch (_) { /* the next tick brings the rows */ }
  }
  studioDataRefresh();
  studioV2Rerender();
}

async function studioAdsWithdrawOnce(id) {
  const request = studioDataRequest(id);
  if (!request || String(request.status || '') !== 'Submitted') return studioAdsGoneText();
  if (!isServerModeEnabled()) return studioAdsNoServer();
  const held = studioAdsSheetAmount('withdraw', request);
  const attempt = adsStudioActionAttempt('withdraw', request.id, Number(request._lastModified));
  let entity;
  try {
    entity = await adsStudioApiWithdraw(request.id, attempt.expectedLastModified, attempt.operationId);
  } catch (error) {
    const fresh = error && error.status === 409 ? await adsStudioReloadCampaign(request.id) : null;
    if (!fresh || String((fresh.data && fresh.data.status) || '') !== 'Draft') throw error;
    entity = fresh;  // the first tap already withdrew it
  }
  _adsStudioActionAttempts.delete(attempt.key);
  upsertAdsStudioEntity(entity);
  studioAdsAfterMoney();
  showNotification(adsStudioText('Request withdrawn', 'سُحب الطلب'),
    adsStudioText(`${studioUsd(held)} is available again. The request is back in your drafts.`, `عاد ${studioUsd(held)} إلى رصيدك المتاح، والطلب الآن في مسوداتك.`), 'success');
  return { ok: true };
}

async function studioAdsStopOnce(id) {
  const request = studioDataRequest(id);
  if (!request || String(request.status || '') !== 'Approved') return studioAdsGoneText();
  if (!isServerModeEnabled()) return studioAdsNoServer();
  const attempt = adsStudioActionAttempt('stop', request.id, Number(request._lastModified));
  let entity;
  try {
    entity = await apiStopAdCampaignRequest(request.id, attempt.expectedLastModified, attempt.operationId, null, null);
  } catch (error) {
    const fresh = error && error.status === 409 ? await adsStudioReloadCampaign(request.id) : null;
    if (!fresh || String((fresh.data && fresh.data.status) || '') !== 'Stopped') throw error;
    entity = fresh;  // the first tap already stopped it
  }
  _adsStudioActionAttempts.delete(attempt.key);
  upsertAdsStudioEntity(entity);
  studioAdsAfterMoney();
  const refunded = studioDataMinor(entity && entity.data ? Number(entity.data.refundMinorUSD) : null);
  showNotification(adsStudioText('Ad stopped', 'أُوقف الإعلان'), refunded
    ? adsStudioText(`${studioUsd(refunded)} is back in your available money.`, `عاد ${studioUsd(refunded)} إلى رصيدك المتاح.`)
    : adsStudioText('The request is closed.', 'أُغلق الطلب.'), 'success');
  return { ok: true };
}

// The server removes the request first; only then does it leave this device's list (a refusal
// leaves everything as it was, and is explained in the sheet through the studio error map).
async function studioAdsArchiveOnce(id) {
  const request = studioDataRequest(id);
  if (!request) return { ok: true, leave: true };  // already gone
  if (!studioAdsCanArchive(request)) return studioAdsGoneText();
  if (!isServerModeEnabled()) {
    return { ok: false, text: adsStudioText('This needs the connection to Albayan.', 'هذا الإجراء يحتاج الاتصال بالبيان.') };
  }
  const draft = String(request.status || 'Draft') === 'Draft';
  let reply = null;
  try {
    reply = await apiDeleteEntity('adCampaignRequests', request.id);
  } catch (error) {
    if (!(error && error.status === 404)) throw error;  // 404: already gone on the server
  }
  const row = (Array.isArray(state.adCampaignRequests) ? state.adCampaignRequests : []).find(item => item && item.id === request.id);
  if (row) {
    const version = Number(reply && reply.lastModified);
    row._deleted = true;
    row._lastModified = version > 0 ? version : (typeof getMonotonicTime === 'function' ? getMonotonicTime() : Date.now());
    if (typeof markCollectionDirty === 'function') markCollectionDirty('adCampaignRequests');
    if (typeof saveState === 'function') saveState();
  }
  if (typeof clearTransientEntityMediaCache === 'function') clearTransientEntityMediaCache('adCampaignRequests');
  studioAdsAfterMoney();
  showNotification(
    draft ? adsStudioText('Draft deleted', 'حُذفت المسودة') : adsStudioText('Request archived', 'أُرشف الطلب'),
    draft ? adsStudioText('The draft was removed.', 'أُزيلت المسودة.') : adsStudioText('It is hidden from your lists; your money history stays in the wallet.', 'أُخفي من قوائمك، ويبقى سجل أموالك في المحفظة.'),
    'success');
  return { ok: true, leave: true };
}
