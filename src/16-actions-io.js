function stopAd(id) {
  // Permission check
  if (!canActOnRecord('ads', 'stopAd', state.ads.find(a => a.id === id)?.creatorId)) {
    showNotification(state.language === 'ar' ? 'تم رفض الوصول' : 'Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لإيقاف الإعلانات' : 'You do not have permission to stop ads', 'error');
    return;
  }

  const isAr = state.language === 'ar';
  const ad = state.ads.find(a => a.id === id);
  if (!ad) return;
  
  const customer = state.customers.find(c => c.id === ad.customerId);
  const adAmountUSD = ad.amountUSD || 0;
  const currentSpentUSD = ad.spentUSD || 0;
  const isAlreadyStopped = ad.status === 'Stopped';
  const previousRemaining = isAlreadyStopped ? (adAmountUSD - currentSpentUSD) : 0;
  
  // Calculate current remaining from receipt allocations
  let totalAllocated = 0;
  if (Array.isArray(ad.receiptAllocations)) {
    totalAllocated = ad.receiptAllocations.reduce((sum, alloc) => sum + (parseFloat(alloc.amountUSD) || 0), 0);
  }
  
  const modalHTML = `
    <div id="stop-ad-modal" class="mobile-dialog-overlay fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onclick="if(event.target === this) this.remove()">
      <div class="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl max-w-md w-full" onclick="event.stopPropagation()">
        <div class="p-6 border-b border-slate-200 dark:border-slate-700">
          <div class="flex items-center justify-between">
            <h2 class="text-xl font-bold text-slate-800 dark:text-white flex items-center">
              <i data-lucide="${isAlreadyStopped ? 'edit' : 'square'}" class="w-5 h-5 mr-2 text-orange-500"></i>
              ${isAlreadyStopped ? (isAr ? 'تعديل تفاصيل الإيقاف' : 'Edit Stop Details') : (isAr ? 'إيقاف الإعلان' : 'Stop Ad')}
            </h2>
            <button onclick="document.getElementById('stop-ad-modal').remove()" class="p-2 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors">
              <i data-lucide="x" class="w-5 h-5"></i>
            </button>
          </div>
        </div>
        
        <div class="p-6 space-y-4">
          <div>
            <p class="text-sm text-slate-600 dark:text-slate-400 mb-2">
              <strong>${isAr ? 'العميل' : 'Customer'}:</strong> ${Security.escapeHtml(customer?.name || (isAr ? 'غير معروف' : 'Unknown'))}<br>
              <strong>${isAr ? 'مبلغ الإعلان' : 'Ad Amount'}:</strong> $${adAmountUSD.toFixed(2)}<br>
              <strong>${isAr ? 'المخصص حالياً' : 'Currently Allocated'}:</strong> $${totalAllocated.toFixed(2)}
              ${isAlreadyStopped && ad.stoppedAt ? `<br><strong>${isAr ? 'تاريخ الإيقاف' : 'Stopped On'}:</strong> ${new Date(ad.stoppedAt).toLocaleString()}` : ''}
            </p>
          </div>
          
          ${isAlreadyStopped ? `
            <div class="bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-xl p-3">
              <div class="text-xs font-medium text-orange-800 dark:text-orange-200 mb-2">${isAr ? 'الإدخال السابق:' : 'Previous Entry:'}</div>
              <div class="text-xs text-slate-600 dark:text-slate-400 space-y-1">
                <div>${isAr ? 'المصروف' : 'Spent'}: <span class="font-bold text-orange-600">$${currentSpentUSD.toFixed(2)}</span></div>
                <div>${isAr ? 'المتبقي المُرجَع' : 'Remaining Returned'}: <span class="font-bold text-emerald-600">$${previousRemaining.toFixed(2)}</span></div>
              </div>
            </div>
          ` : ''}
          
          <div>
            <label class="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
              ${isAr ? 'المبلغ المصروف (دولار) *' : 'Amount Spent (USD) *'}
            </label>
            <input 
              type="text" 
              inputmode="decimal"
              id="stop-ad-spent" 
              value="${currentSpentUSD}" 
              max="${adAmountUSD}"
              oninput="sanitizeMoneyInput(this)"
              class="w-full glass-input px-4 py-2 rounded-xl text-lg font-bold focus:ring-2 focus:ring-orange-500"
              placeholder="0.00"
            />
            <p class="text-xs text-slate-500 mt-1">${isAlreadyStopped ? (isAr ? 'عدّل المبلغ المصروف لتحديث الرصيد المتبقي' : 'Edit the amount spent to update the remaining balance') : (isAr ? 'أدخل المبلغ الذي تم صرفه فعلياً على هذا الإعلان' : 'Enter how much was actually spent on this ad')}</p>
          </div>
          
          <div id="stop-ad-calculations" class="bg-slate-50 dark:bg-slate-900/50 rounded-xl p-4 space-y-2">
            <div class="flex justify-between text-sm">
              <span class="text-slate-600 dark:text-slate-400">${isAr ? 'مبلغ الإعلان:' : 'Ad Amount:'}</span>
              <span class="font-bold">$${adAmountUSD.toFixed(2)}</span>
            </div>
            <div class="flex justify-between text-sm">
              <span class="text-slate-600 dark:text-slate-400">${isAr ? 'المبلغ المصروف:' : 'Amount Spent:'}</span>
              <span class="font-bold text-orange-600" id="stop-ad-spent-display">$${currentSpentUSD.toFixed(2)}</span>
            </div>
            <div class="border-t border-slate-200 dark:border-slate-700 pt-2 flex justify-between">
              <span class="text-sm font-medium text-emerald-600">${isAr ? 'المتبقي' : 'Remaining'} ${isAlreadyStopped ? (isAr ? '(سيتم تحديثه)' : '(will be updated)') : (isAr ? '(سيتم إرجاعه)' : '(will be returned)')}:</span>
              <span class="text-sm font-bold text-emerald-600" id="stop-ad-remaining">$${(adAmountUSD - currentSpentUSD).toFixed(2)}</span>
            </div>
          </div>
          
          <div class="flex space-x-3 pt-2">
            <button 
              onclick="document.getElementById('stop-ad-modal').remove()" 
              class="flex-1 px-4 py-3 bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300 rounded-xl font-bold hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
            >
              ${isAr ? 'إلغاء' : 'Cancel'}
            </button>
            <button
              id="stop-ad-submit"
              onclick="confirmStopAd('${id}')" 
              class="flex-1 px-4 py-3 bg-orange-600 text-white rounded-xl font-bold hover:bg-orange-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              ${isAlreadyStopped ? (isAr ? 'تحديث' : 'Update') : (isAr ? 'إيقاف الإعلان' : 'Stop Ad')}
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
  
  // Remove any existing modal
  document.getElementById('stop-ad-modal')?.remove();
  
  // Add modal to DOM
  document.body.insertAdjacentHTML('beforeend', modalHTML);
  
  // Initialize Lucide icons
  lucide.createIcons();
  
  // Update calculations on input
  const spentInput = document.getElementById('stop-ad-spent');
  const spentDisplay = document.getElementById('stop-ad-spent-display');
  const remainingDisplay = document.getElementById('stop-ad-remaining');
  
  if (spentInput && spentDisplay && remainingDisplay) {
    spentInput.addEventListener('input', function() {
      const spent = parseFloat(this.value) || 0;
      const remaining = Math.max(adAmountUSD - spent, 0);
      spentDisplay.textContent = '$' + spent.toFixed(2);
      remainingDisplay.textContent = '$' + remaining.toFixed(2);
    });
    
    // Focus on input
    setTimeout(() => spentInput.focus(), 100);
  }
}

const _pendingAdStopAttempts = new Map();

function getAdStopAttempt(ad, spentMinorUSD) {
  const adId = String(ad?.id || '');
  const expectedLastModified = Number(ad?._lastModified);
  if (!Number.isSafeInteger(expectedLastModified) || expectedLastModified < 0) {
    throw new Error('This ad is missing its server version. Refresh and try again.');
  }
  const fingerprint = JSON.stringify({ adId, spentMinorUSD, expectedLastModified });
  const prior = _pendingAdStopAttempts.get(adId);
  if (prior?.fingerprint === fingerprint) return prior;
  if (prior?.promise) return prior;
  const attempt = {
    slot: adId,
    fingerprint,
    expectedLastModified,
    idempotencyKey: ensureOperationIdempotencyKey('', 'ad-stop'),
    promise: null
  };
  _pendingAdStopAttempts.set(adId, attempt);
  return attempt;
}

function completeAdStopAttempt(attempt) {
  if (attempt && _pendingAdStopAttempts.get(attempt.slot) === attempt) {
    _pendingAdStopAttempts.delete(attempt.slot);
  }
}

async function confirmStopAd(id) {
  const isAr = state.language === 'ar';
  const storedAd = state.ads.find(a => a.id === id);
  if (!storedAd) return;
  // Work on a detached copy. Mutating the live record before updateRecord()
  // captured its rollback snapshot made a failed server PATCH impossible to
  // undo and still allowed the success path to continue.
  const ad = {
    ...storedAd,
    receiptAllocations: Array.isArray(storedAd.receiptAllocations) ? storedAd.receiptAllocations.map(a => ({ ...a })) : storedAd.receiptAllocations,
    dueAllocations: Array.isArray(storedAd.dueAllocations) ? storedAd.dueAllocations.map(a => ({ ...a })) : storedAd.dueAllocations,
    mergedPaidAllocations: Array.isArray(storedAd.mergedPaidAllocations) ? storedAd.mergedPaidAllocations.map(a => ({ ...a })) : storedAd.mergedPaidAllocations,
    stopAllocationBaseline: storedAd.stopAllocationBaseline
      ? JSON.parse(JSON.stringify(storedAd.stopAllocationBaseline))
      : storedAd.stopAllocationBaseline
  };
  
  const spentInput = document.getElementById('stop-ad-spent');
  if (!spentInput) return;
  
  const spentUSD = parseFloat(spentInput.value) || 0;
  const adAmountUSD = ad.amountUSD || 0;
  
  if (spentUSD < 0 || spentUSD > adAmountUSD) {
    showNotification(isAr ? 'خطأ' : 'Error', isAr ? 'يجب أن يكون المبلغ المصروف بين صفر ومبلغ الإعلان' : 'Spent amount must be between 0 and ad amount', 'error');
    return;
  }

  if (isServerModeEnabled()) {
    const spentMinorUSD = Math.round(spentUSD * 100);
    if (!Number.isSafeInteger(spentMinorUSD) || spentMinorUSD < 0) {
      showNotification(isAr ? 'خطأ' : 'Error', isAr ? 'المبلغ المصروف غير صالح.' : 'Spent amount is invalid.', 'error');
      return;
    }
    let attempt;
    try {
      attempt = getAdStopAttempt(storedAd, spentMinorUSD);
    } catch (error) {
      showNotification(isAr ? 'تعذر الحفظ' : 'Ad Not Saved', error.message, 'error');
      return;
    }
    if (attempt.promise) return await attempt.promise;
    const submitButton = document.getElementById('stop-ad-submit');
    if (submitButton) submitButton.disabled = true;
    attempt.promise = (async () => {
      try {
        const response = await apiStopAd(storedAd.id, {
          spentMinorUSD,
          idempotencyKey: attempt.idempotencyKey,
          expectedLastModified: attempt.expectedLastModified
        });
        const [savedAd] = applyValidatedServerEntityBatch([
          { collection: 'ads', entity: response.ad }
        ], 'adStop');
        if (!savedAd) throw new Error('Invalid ad stop response');
        completeAdStopAttempt(attempt);
        document.getElementById('stop-ad-modal')?.remove();
        showNotification(
          savedAd.status === 'Stopped' && storedAd.status === 'Stopped'
            ? (isAr ? 'تم تحديث الإعلان' : 'Ad Updated')
            : (isAr ? 'تم إيقاف الإعلان' : 'Ad Stopped'),
          isAr
            ? 'تم حفظ المبلغ المصروف وتحديث أرصدة التمويل معاً.'
            : 'The spent amount and funding balances were updated together.',
          'success'
        );
        render();
        if (window.lucide) lucide.createIcons();
        return true;
      } catch (error) {
        const conflict = error?.status === 409;
        showNotification(
          isAr ? 'تعذر الحفظ' : 'Ad Not Saved',
          conflict
            ? (isAr ? 'تم تغيير هذا الإعلان من مستخدم آخر. حدّث البيانات ثم أعد المحاولة.' : 'This ad changed on another device. Refresh the data, then try again.')
            : (error?.message || (isAr ? 'فشل حفظ إيقاف الإعلان.' : 'The ad stop could not be saved.')),
          conflict ? 'warning' : 'error'
        );
        return false;
      } finally {
        attempt.promise = null;
        const liveButton = document.getElementById('stop-ad-submit');
        if (liveButton) liveButton.disabled = false;
      }
    })();
    return await attempt.promise;
  }
  
  const isEditing = ad.status === 'Stopped';
  const previousSpentUSD = ad.spentUSD || 0;
  const previousRemainingUSD = adAmountUSD - previousSpentUSD;
  const newRemainingUSD = adAmountUSD - spentUSD;
  const remainingDifference = newRemainingUSD - previousRemainingUSD;

  // BUG FIX (double-return): the unspent remainder must be apportioned ONCE
  // across the ad's whole funding pool, not returned in full by each
  // allocation block against its own smaller total. Compute the pool now
  // (before any mutation). mergedPaidAllocations mirrors receiptAllocations
  // for Not Paid + Driver ads, so it is NOT added to the denominator again.
  const _sumAlloc = (arr) => Array.isArray(arr) ? arr.reduce((s, a) => s + (parseFloat(a.amountUSD) || 0), 0) : 0;
  const _poolPaid = _sumAlloc(ad.receiptAllocations);
  const _poolDue = (Array.isArray(ad.dueAllocations) && ad.dueAllocations.length)
    ? _sumAlloc(ad.dueAllocations)
    : (parseFloat(ad.dueAmountToUseUSD) || 0);
  const _poolTotal = _poolPaid + _poolDue;
  // Single fraction every block uses: share of each allocation to return on a
  // first stop, or to adjust on a re-stop edit.
  const returnFraction = _poolTotal > 0 ? Math.min(Math.max(newRemainingUSD, 0) / _poolTotal, 1) : 0;
  const adjustFraction = _poolTotal > 0 ? Math.abs(remainingDifference) / _poolTotal : 0;

  // MONEY-MATH: snapshot the funding proportions the FIRST time the ad is
  // stopped. Stopping with a low spend shrinks (possibly zeroes) the live
  // allocations, so a later stop-EDIT cannot recover each receipt's original
  // share from the live values alone (a fully-returned pool sums to 0 and
  // blocks all redistribution). With this baseline, an edit recomputes each
  // receipt's allocation as ORIGINAL share × (new spent / original pool) —
  // mathematically identical to the old adjust-by-difference math in the
  // normal case, but still correct after a zero/low-spend stop.
  if (!isEditing && !ad.stopAllocationBaseline) {
    const snap = (arr) => Array.isArray(arr)
      ? arr.map(a => ({ receiptId: a.receiptId, amountUSD: parseFloat(a.amountUSD) || 0 }))
      : [];
    ad.stopAllocationBaseline = {
      receipt: snap(ad.receiptAllocations),
      due: snap(ad.dueAllocations),
      merged: snap(ad.mergedPaidAllocations),
      dueLegacy: (Array.isArray(ad.dueAllocations) && ad.dueAllocations.length) ? 0 : (parseFloat(ad.dueAmountToUseUSD) || 0),
    };
  }

  // Plan the final amount of every allocation entry BEFORE mutating anything,
  // so spend increases can be validated against receipt balances first.
  const _baseline = isEditing ? (ad.stopAllocationBaseline || null) : null;
  const _basePool = _baseline
    ? (_sumAlloc(_baseline.receipt) + (_baseline.due.length ? _sumAlloc(_baseline.due) : (_baseline.dueLegacy || 0)))
    : 0;
  const _spentFraction = _basePool > 0 ? Math.min(spentUSD / _basePool, 1) : 0;

  const _baseAmountFor = (baseEntries, receiptId) => (baseEntries || [])
    .filter(b => String(b.receiptId) === String(receiptId))
    .reduce((s, b) => s + (b.amountUSD || 0), 0);

  const _planFor = (allocs, baseEntries) => {
    if (!Array.isArray(allocs)) return [];
    return allocs.map(alloc => {
      const current = parseFloat(alloc.amountUSD) || 0;
      let newAmount = current;
      if (isEditing && remainingDifference !== 0) {
        if (_baseline && _basePool > 0) {
          newAmount = _baseAmountFor(baseEntries, alloc.receiptId) * _spentFraction;
        } else {
          // Legacy ads stopped before the baseline existed: keep the old
          // adjust-by-difference behavior.
          newAmount = remainingDifference > 0
            ? Math.max(current - current * adjustFraction, 0)
            : current + current * adjustFraction;
        }
      } else if (!isEditing && newRemainingUSD > 0) {
        newAmount = Math.max(current - current * returnFraction, 0);
      }
      return { alloc, current, newAmount };
    });
  };

  const _planReceipt = _planFor(ad.receiptAllocations, _baseline ? _baseline.receipt : []);
  const _planDue = _planFor(ad.dueAllocations, _baseline ? _baseline.due : []);
  const _planMerged = _planFor(ad.mergedPaidAllocations, _baseline ? _baseline.merged : []);

  // MONEY-MATH: when a stop-edit INCREASES spend, the extra money is re-taken
  // from the funding receipts — verify each receipt still has that much left
  // (another ad may have legitimately used the returned funds in the meantime).
  // Without this check two ads could spend more than a receipt ever contained.
  // Merged entries mirror the paid pool, so validating _planReceipt covers them.
  if (isEditing && remainingDifference < 0) {
    const increaseByReceipt = new Map();
    for (const p of _planReceipt) {
      const inc = p.newAmount - p.current;
      if (inc > 0.0001) {
        const rid = String(p.alloc.receiptId || '');
        increaseByReceipt.set(rid, (increaseByReceipt.get(rid) || 0) + inc);
      }
    }
    for (const [rid, inc] of increaseByReceipt.entries()) {
      const receipt = state.receipts.find(r => String(r.id) === rid && !r._deleted);
      const remaining = receipt ? (getReceiptUsageStats(receipt).remainingUSD || 0) : 0;
      if (inc > remaining + 0.01) {
        showNotification(
          isAr ? 'تحقق' : 'Validation',
          isAr
            ? `لا يمكن زيادة المصروف: الوصل ${receipt ? (receipt.serialNumber || receipt.finalReceiptNo || rid) : rid} لم يتبقَّ فيه سوى $${remaining.toFixed(2)} (يحتاج $${inc.toFixed(2)} إضافية).`
            : `Cannot increase spent: receipt ${receipt ? (receipt.serialNumber || receipt.finalReceiptNo || rid) : rid} only has $${remaining.toFixed(2)} left (needs $${inc.toFixed(2)} more).`,
          'error'
        );
        return;
      }
    }
    const dueIncreaseByReceipt = new Map();
    for (const p of _planDue) {
      const inc = p.newAmount - p.current;
      if (inc > 0.0001) {
        const rid = String(p.alloc.receiptId || '');
        dueIncreaseByReceipt.set(rid, (dueIncreaseByReceipt.get(rid) || 0) + inc);
      }
    }
    for (const [rid, inc] of dueIncreaseByReceipt.entries()) {
      const dueUsage = getDeliveryReceiptDueUsage(rid);
      const remaining = dueUsage ? (dueUsage.remainingDueUSD || 0) : 0;
      if (inc > remaining + 0.01) {
        showNotification(
          isAr ? 'تحقق' : 'Validation',
          isAr
            ? `لا يمكن زيادة المصروف: رصيد الاستحقاق لوصل التوصيل لم يتبقَّ فيه سوى $${remaining.toFixed(2)} (يحتاج $${inc.toFixed(2)} إضافية).`
            : `Cannot increase spent: the delivery receipt's due credit only has $${remaining.toFixed(2)} left (needs $${inc.toFixed(2)} more).`,
          'error'
        );
        return;
      }
    }
  }

  // Update ad status and spent amount
  ad.status = 'Stopped';
  ad.spentUSD = spentUSD;
  if (!ad.stoppedAt) {
    ad.stoppedAt = new Date().toISOString();
  }
  ad.lastUpdated = new Date().toISOString();

  // Apply the planned allocation amounts (+ audit trail per receipt).
  // MONEY-MATH: zero-amount entries are intentionally KEPT (not filtered out)
  // so each receipt's identity survives a zero/low-spend stop and a later
  // stop-edit can re-charge the same receipts in their original proportions.
  const _applyPlan = (plan, poolLabel) => {
    for (const p of plan) {
      const receipt = state.receipts.find(r => r.id === p.alloc.receiptId);
      if (!receipt) continue;
      const delta = p.newAmount - p.current;
      if (Math.abs(delta) < 0.0000001) continue;
      // Snap to 2 decimals: proportional math leaves binary float residue
      // (50 * 0.5454... -> 50.000000000000001) that would otherwise be stored
      // and shown raw in the edit form's amount inputs.
      p.alloc.amountUSD = Math.round(Math.max(p.newAmount, 0) * 100) / 100;
      if (isEditing) {
        addAuditLog('receipt', receipt.id, 'usage', `Ad ${ad.id} updated - ${delta > 0 ? 'used additional' : 'returned additional'} $${Math.abs(delta).toFixed(2)} ${delta > 0 ? 'from' : 'to'} ${poolLabel}`, {
          adId: ad.id,
          ...(delta > 0 ? { usedAmount: Math.abs(delta) } : { returnedAmount: Math.abs(delta) }),
          spentAmount: spentUSD,
          previousSpent: previousSpentUSD
        });
      } else {
        addAuditLog('receipt', receipt.id, 'usage', `Ad ${ad.id} stopped - returned $${Math.abs(delta).toFixed(2)} to ${poolLabel}`, {
          adId: ad.id,
          returnedAmount: Math.abs(delta),
          spentAmount: spentUSD
        });
      }
    }
  };
  _applyPlan(_planReceipt, 'receipt balance');
  _applyPlan(_planDue, 'delivery receipt due balance');
  _applyPlan(_planMerged, 'merged receipt balance');

  if (Array.isArray(ad.dueAllocations) && ad.dueAllocations.length > 0) {
    // Keep the legacy dueAmountToUseUSD field in sync with dueAllocations
    ad.dueAmountToUseUSD = Math.round(ad.dueAllocations.reduce((sum, alloc) => sum + (parseFloat(alloc.amountUSD) || 0), 0) * 100) / 100;
  } else if (ad.dueAmountToUseUSD > 0 && !isEditing && newRemainingUSD > 0) {
    // Legacy: Handle ads with dueAmountToUseUSD but no dueAllocations array.
    // Return only this pool's share of the remainder (global apportionment).
    const reductionAmount = Math.min(ad.dueAmountToUseUSD * returnFraction, ad.dueAmountToUseUSD);
    ad.dueAmountToUseUSD = Math.round(Math.max(ad.dueAmountToUseUSD - reductionAmount, 0) * 100) / 100;

    if (ad.linkedDeliveryReceiptId) {
      addAuditLog('receipt', ad.linkedDeliveryReceiptId, 'usage', `Ad ${ad.id} stopped - returned $${reductionAmount.toFixed(2)} to delivery receipt due balance`, {
        adId: ad.id,
        returnedAmount: reductionAmount,
        spentAmount: spentUSD
      });
    }
  }

  // Update customer balance
  const customer = state.customers.find(c => c.id === ad.customerId);
  if (customer) {
    if (isEditing && remainingDifference !== 0) {
      // Adjust customer balance by the difference (snapped to 2 decimals)
      if (customer.balance !== undefined) {
        const nextBalance = Math.round(((customer.balance || 0) + remainingDifference) * 100) / 100;
        const customerSaved = await updateRecord(state.customers, customer.id, { balance: nextBalance }, customer._lastModified);
        if (!customerSaved) return;
      }
      addLog('update', 'customer', customer.id, `Ad stop updated - ${remainingDifference > 0 ? 'returned' : 'used'} $${Math.abs(remainingDifference).toFixed(2)} ${remainingDifference > 0 ? 'to' : 'from'} customer balance`);
    } else if (!isEditing && newRemainingUSD > 0) {
      // First time stopping: add remaining to customer balance (snapped to 2dp)
      if (customer.balance !== undefined) {
        const nextBalance = Math.round(((customer.balance || 0) + newRemainingUSD) * 100) / 100;
        const customerSaved = await updateRecord(state.customers, customer.id, { balance: nextBalance }, customer._lastModified);
        if (!customerSaved) return;
      }
      addLog('update', 'customer', customer.id, `Ad stopped - returned $${newRemainingUSD.toFixed(2)} to customer balance`);
    }
  }
  
  // Save ad
  const adSaved = await updateRecord(state.ads, ad.id, ad, storedAd._lastModified);
  if (!adSaved) return;
  
  // Close modal
  document.getElementById('stop-ad-modal')?.remove();
  
  // Show notification
  if (isAr) {
    const amountTxt = `$${Math.abs(isEditing ? remainingDifference : newRemainingUSD).toFixed(2)}`;
    const verbAr = isEditing ? (remainingDifference > 0 ? 'أُرجع' : 'استُخدم') : 'أُرجع';
    const balanceTextAr = remainingDifference !== 0 || !isEditing
      ? `${verbAr} ${amountTxt} إلى ${ad.receiptAllocations && ad.receiptAllocations.length > 1 ? 'الوصولات' : 'الوصل'} ورصيد العميل`
      : 'لا توجد تغييرات على الرصيد';
    showNotification(isEditing ? 'تم تحديث الإعلان' : 'تم إيقاف الإعلان', `${isEditing ? 'تم تحديث الإعلان بنجاح' : 'تم إيقاف الإعلان بنجاح'}. ${balanceTextAr}.`, 'success');
  } else {
    const actionText = isEditing ? 'updated' : 'stopped';
    const balanceText = remainingDifference !== 0 || !isEditing ? `$${Math.abs(isEditing ? remainingDifference : newRemainingUSD).toFixed(2)} ${isEditing ? (remainingDifference > 0 ? 'returned' : 'used') : 'returned'} to receipt${ad.receiptAllocations && ad.receiptAllocations.length > 1 ? 's' : ''} and customer balance` : 'No balance changes';
    showNotification(`Ad ${actionText.charAt(0).toUpperCase() + actionText.slice(1)}`, `Ad ${actionText} successfully. ${balanceText}.`, 'success');
  }
  
  // Refresh view
  render();
  lucide.createIcons();
}

async function deleteUser(id) {
  if (!canManageUsersAction('delete')) {
    showNotification(state.language === 'ar' ? 'تم رفض الوصول' : 'Access Denied', state.language === 'ar' ? 'تحتاج صلاحية حذف المستخدمين' : 'Requires the Delete Users permission', 'error');
    return;
  }
  // Non-admins can never remove an Admin account (server enforces this too).
  {
    const _target = (state.users || []).find(u => u && String(u.id) === String(id));
    if (!isCurrentUserAdmin() && _target && isAdminRole(_target.role)) {
      showNotification(state.language === 'ar' ? 'تم رفض الوصول' : 'Access Denied', state.language === 'ar' ? 'فقط المدير يمكنه حذف حساب مدير' : 'Only an Admin can delete an Admin account', 'error');
      return;
    }
  }
  const isArDU = state.language === 'ar';

  // Wallet money is an immutable ledger — deleting a user with a balance
  // strands that money with no UI path to ever recover it. Transfer it first.
  if (typeof WALLET !== 'undefined' && Array.isArray(WALLET_SUPPORTED_CURRENCIES)) {
    const balances = WALLET_SUPPORTED_CURRENCIES
      .map(c => ({ c, v: WALLET.getBalance(id, c) }))
      .filter(b => Math.abs(b.v) > 0.001);
    if (balances.length > 0) {
      const list = balances.map(b => `${b.v} ${b.c}`).join(', ');
      showNotification(
        isArDU ? 'غير ممكن' : 'Not possible',
        isArDU
          ? `لدى هذا المستخدم رصيد في المحفظة (${list}). حوِّل الرصيد إلى مستخدم آخر أولاً ثم احذفه.`
          : `This user still has a wallet balance (${list}). Transfer the balance to another user first, then delete.`,
        'error'
      );
      return;
    }
  }

  // Delivery work in flight: active missions go back to the assignment pool;
  // collected cash not yet handed to the office must be pointed out before
  // the driver disappears from the per-driver lists.
  const activeMissions = state.receipts.filter(r => r && !r._deleted
    && String(r.deliveryPersonId || '') === String(id)
    && !['', 'Delivered', 'Canceled', 'Office'].includes(String(r.deliveryStatus || '')));
  const heldCash = state.receipts.filter(r => r && !r._deleted
    && String(r.deliveryPersonId || '') === String(id)
    && String(r.deliveryStatus || '') === 'Delivered'
    && r.isReceivedInOffice !== true);

  let warning = isArDU ? 'هل تريد حذف هذا المستخدم؟' : 'Delete this user?';
  if (activeMissions.length > 0) {
    warning += isArDU
      ? `\n\n⚠️ لديه ${activeMissions.length} مهمة توصيل نشطة — ستعود إلى قائمة الإسناد بدون سائق.`
      : `\n\n⚠️ This user has ${activeMissions.length} active delivery mission(s) — they will return to the assignment pool with no driver.`;
  }
  if (heldCash.length > 0) {
    warning += isArDU
      ? `\n\n💰 لديه ${heldCash.length} توصيلة مُسلَّمة لم يُسلَّم نقدها للمكتب بعد — سوِّ النقد قبل الحذف أو وثِّقه.`
      : `\n\n💰 This user has ${heldCash.length} delivered order(s) whose cash was not handed to the office yet — settle or document that cash before deleting.`;
  }

  if (confirm(warning)) {
    // Return in-flight missions to the pool so they don't stay assigned to a
    // ghost driver. Delivered history keeps the id for the audit trail.
    for (const r of activeMissions) {
      if (!await updateRecord(state.receipts, r.id, { deliveryPersonId: '' })) return;
    }
    if (!await deleteRecord(state.users, id)) return;
    render();
  }
}

async function updateExchangeRate(value) {
  // The rate drives every money conversion in the app — it is gated on
  // settings.manageExchangeRate (the server rejects the write too).
  if (!can('settings', 'manageExchangeRate')) {
    showNotification(
      state.language === 'ar' ? 'تم رفض الوصول' : 'Access Denied',
      state.language === 'ar' ? 'تحتاج صلاحية إدارة سعر الصرف' : 'Requires the Manage Exchange Rate permission',
      'error'
    );
    render();
    return;
  }
  // MONEY-MATH: an empty/invalid field parseFloats to NaN; storing it poisons
  // every later save (amountLocal = amountUSD * NaN) while showing a green
  // success toast. Validate first, keep the previous rate on bad input.
  const rate = parseFloat(value);
  if (!Number.isFinite(rate) || rate <= 0) {
    showNotification(
      state.language === 'ar' ? 'خطأ في الإدخال' : 'Validation',
      state.language === 'ar' ? 'أدخل سعر صرف صحيح أكبر من صفر' : 'Enter a valid exchange rate greater than zero',
      'error'
    );
    render();
    return;
  }
  const previousRate = state.defaultExchangeRate;
  state.defaultExchangeRate = rate;
  const record = {
    id: generateId('rate'),
    rate: state.defaultExchangeRate,
    date: new Date().toISOString(),
    userId: state.currentUser?.id || 'system'
  };
  const rateSaved = await addRecord(state.exchangeRateHistory, record);
  if (!rateSaved) {
    state.defaultExchangeRate = previousRate;
    render();
    return;
  }
  showNotification(state.language === 'ar' ? 'تم التحديث' : 'Updated', state.language === 'ar' ? 'تم تحديث سعر الصرف' : 'Exchange rate updated', 'success');
}

// Print ONE receipt card. window.print() alone printed the whole Receipts
// page — every loaded card, other customers' amounts included — onto the
// paper handed to a single customer. Mark the clicked card and let the
// @media print rules in style.css hide everything else.
function printReceiptCard(btn) {
  const card = btn && btn.closest ? btn.closest('.glass-panel') : null;
  if (!card) {
    window.print();
    return;
  }
  card.classList.add('print-target');
  document.body.classList.add('print-single');
  const cleanup = () => {
    card.classList.remove('print-target');
    document.body.classList.remove('print-single');
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  window.print();
  // Safety net for webviews that never fire afterprint
  setTimeout(cleanup, 3000);
}

function exportData() {
  // Local mode can export its complete local workspace. Server mode can only
  // export the records currently loaded in this browser; that snapshot may be
  // stale/permission-scoped and the online restore intentionally cannot write
  // users, wallet ledger, subscriptions or audit history.
  if (!isCurrentUserAdmin()) {
    showNotification(
      state.language === 'ar' ? 'تم رفض الوصول' : 'Access Denied',
      state.language === 'ar' ? 'تصدير النسخة الاحتياطية الكاملة للمدير فقط' : 'Full backup export is Admin only',
      'error'
    );
    return;
  }
  const serverPartialSnapshot = isServerModeEnabled();
  if (serverPartialSnapshot) {
    const proceed = confirm(
      state.language === 'ar'
        ? 'هذا تقرير جزئي من البيانات المحمّلة حالياً، وليس نسخة خادم قابلة للاستعادة. قد يكون قديماً أو ناقصاً، وتم حذف بيانات نظام الملابس للحفاظ على سلامة المخزون. استيراد ملفات الخادم معطّل ويتطلب صيانة خارج التطبيق. هل تريد المتابعة؟'
        : 'This is a PARTIAL report of data currently loaded on this device, not a restorable full-server backup. It may be stale or incomplete. The clothes domain is omitted to protect inventory integrity. Server-file import is disabled and requires an offline maintenance workflow. Continue?'
    );
    if (!proceed) return;
  }
  // Create secure export (no plaintext secrets)
  const exportState = JSON.parse(JSON.stringify(state));

  // Remove sensitive data from export
  if (exportState.users) {
    exportState.users = exportState.users.map(u => {
      const copy = { ...u };
      // Never export plaintext passwords (hashed credentials are OK for restore)
      delete copy.password;
      return copy;
    });
  }
  // Wallet/subscriptions are safe to export (no secrets), but keep the structure explicit
  if (!Array.isArray(exportState.walletTransactions)) exportState.walletTransactions = [];
  if (!Array.isArray(exportState.serviceSubscriptions)) exportState.serviceSubscriptions = [];
  if (exportState.cloudConfig) {
    exportState.cloudConfig = {
      ...exportState.cloudConfig,
      apiKey: undefined // Don't export API keys
    };
  }

  // Safety: export VISIBLE records only (do not export deleted/archived items).
  // This prevents "ghost" records from reappearing after restore.
  const countVisible = (arr) => (Array.isArray(arr) ? arr.filter(r => r && typeof r === 'object' && !r._deleted).length : 0);
  const countDeleted = (arr) => (Array.isArray(arr) ? arr.filter(r => r && typeof r === 'object' && !!r._deleted).length : 0);
  const filterVisible = (arr) => (Array.isArray(arr) ? arr.filter(r => r && typeof r === 'object' && !r._deleted) : []);

  const counts = {
    ads: { visible: countVisible(exportState.ads), deleted: countDeleted(exportState.ads) },
    receipts: { visible: countVisible(exportState.receipts), deleted: countDeleted(exportState.receipts) },
    customers: { visible: countVisible(exportState.customers), deleted: countDeleted(exportState.customers) },
    pages: { visible: countVisible(exportState.pages), deleted: countDeleted(exportState.pages) },
    users: { visible: countVisible(exportState.users), deleted: countDeleted(exportState.users) },
    exchangeRateHistory: { visible: countVisible(exportState.exchangeRateHistory), deleted: countDeleted(exportState.exchangeRateHistory) },
    logs: { visible: countVisible(exportState.logs), deleted: countDeleted(exportState.logs) },
    walletTransactions: { visible: countVisible(exportState.walletTransactions), deleted: countDeleted(exportState.walletTransactions) },
    serviceSubscriptions: { visible: countVisible(exportState.serviceSubscriptions), deleted: countDeleted(exportState.serviceSubscriptions) },
    clothesProducts: { visible: countVisible(exportState.clothesProducts), deleted: countDeleted(exportState.clothesProducts) },
    clothesShipments: { visible: countVisible(exportState.clothesShipments), deleted: countDeleted(exportState.clothesShipments) },
    clothesOrders: { visible: countVisible(exportState.clothesOrders), deleted: countDeleted(exportState.clothesOrders) },
    clothesSettings: { visible: countVisible(exportState.clothesSettings), deleted: countDeleted(exportState.clothesSettings) },
    adCampaignRequests: { visible: countVisible(exportState.adCampaignRequests), deleted: countDeleted(exportState.adCampaignRequests) }
  };

  exportState.ads = filterVisible(exportState.ads);
  exportState.receipts = filterVisible(exportState.receipts);
  exportState.customers = filterVisible(exportState.customers);
  exportState.pages = filterVisible(exportState.pages);
  exportState.users = filterVisible(exportState.users);
  exportState.exchangeRateHistory = filterVisible(exportState.exchangeRateHistory);
  exportState.logs = filterVisible(exportState.logs);
  exportState.walletTransactions = filterVisible(exportState.walletTransactions);
  exportState.serviceSubscriptions = filterVisible(exportState.serviceSubscriptions);
  exportState.clothesProducts = filterVisible(exportState.clothesProducts);
  exportState.clothesShipments = filterVisible(exportState.clothesShipments);
  exportState.clothesOrders = filterVisible(exportState.clothesOrders);
  exportState.clothesSettings = filterVisible(exportState.clothesSettings);
  exportState.adCampaignRequests = filterVisible(exportState.adCampaignRequests);
  if (serverPartialSnapshot) {
    // Orders, shipments and products are one inventory domain. Exporting only
    // some of it invites an unsafe partial restore, while clothesOrders itself
    // is server-transaction controlled. Omit the entire domain from server
    // reports; local-mode full backups remain unchanged.
    delete exportState.clothesProducts;
    delete exportState.clothesShipments;
    delete exportState.clothesOrders;
    delete exportState.clothesSettings;
    // Campaign review state is also server-controlled. A browser only has the
    // permission-scoped rows loaded for the signed-in user, so including it in
    // a server report could be mistaken for a complete, restorable snapshot.
    delete exportState.adCampaignRequests;
  }
  
  // Add export metadata
  const checksum = DataIntegrity.calculateChecksum(exportState);
  exportState._exportMetadata = {
    exportedAt: new Date().toISOString(),
    version: '3.0.1',
    source: isServerModeEnabled() ? 'server' : 'local',
    backupScope: serverPartialSnapshot ? 'client-cache-partial' : 'full-local',
    authoritative: !serverPartialSnapshot,
    restorableCollections: serverPartialSnapshot
      ? []
      : ['customers', 'pages', 'ads', 'receipts', 'exchangeRateHistory', 'clothesProducts', 'clothesShipments', 'clothesOrders', 'clothesSettings', 'adCampaignRequests'],
    nonRestorableCollections: serverPartialSnapshot
      ? ['customers', 'pages', 'ads', 'receipts', 'exchangeRateHistory', 'users', 'walletTransactions', 'serviceSubscriptions', 'logs', 'clothesProducts', 'clothesShipments', 'clothesOrders', 'clothesSettings', 'adCampaignRequests']
      : [],
    visibleOnly: true,
    counts,
    checksum
  };
  
  const dataStr = JSON.stringify(exportState, null, 2);
  const dataBlob = new Blob([dataStr], { type: 'application/json' });
  const url = URL.createObjectURL(dataBlob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${serverPartialSnapshot ? 'albayan-server-partial-snapshot' : 'albayan-backup'}-${getTodayDateString()}.json`;
  link.click();
  URL.revokeObjectURL(url);
  
  // Create auto backup
  createAutoBackup();
  
  addAuditLog('Export', 'system', serverPartialSnapshot ? 'Partial client snapshot exported' : 'Local backup exported successfully');
  showNotification(
    state.language === 'ar' ? 'تم التصدير' : 'Exported',
    serverPartialSnapshot
      ? (state.language === 'ar' ? 'تم تصدير تقرير جزئي غير قابل للاستعادة. تم حذف بيانات الملابس، واستيراد الخادم يتطلب صيانة خارج التطبيق.' : 'Non-restorable partial report exported. Clothes data is omitted; server restore requires an offline maintenance workflow.')
      : (state.language === 'ar' ? 'تم تصدير النسخة المحلية بنجاح' : 'Local backup exported successfully'),
    serverPartialSnapshot ? 'warning' : 'success'
  );
}

function importData() {
  const isAr = state.language === 'ar';
  if (isServerModeEnabled()) {
    showNotification(
      isAr ? 'استيراد الخادم معطّل' : 'Server Import Disabled',
      isAr
        ? 'تقارير الخادم الجزئية ليست نسخاً احتياطية قابلة للاستعادة. الاستعادة تتطلب إجراء صيانة خارج التطبيق مع تحقق كامل من العلاقات والمخزون.'
        : 'Partial server reports are not restorable backups. Restore requires an offline maintenance workflow with full relationship and inventory validation.',
      'warning'
    );
    return;
  }
  // In server mode, import must go through the backend (Admin only) to keep the server as source of truth.
  async function importDataToServer(sanitizedImport) {
    const role = String(state.currentUser?.role || '').toLowerCase();
    if (role !== 'admin') {
      showNotification(isAr ? 'غير مسموح' : 'Not Allowed', isAr ? 'الاستيراد في وضع الخادم للأدمن فقط.' : 'Only Admins can import in server mode.', 'error');
      return;
    }

    // Safety: require a full backup structure (prevents accidental wipe from wrong JSON file)
    const requiredCollections = ['customers', 'pages', 'ads', 'receipts', 'exchangeRateHistory'];
    for (const k of requiredCollections) {
      if (!Array.isArray(sanitizedImport?.[k])) {
        showNotification(
          isAr ? 'نسخة احتياطية غير صالحة' : 'Invalid Backup',
          isAr
            ? `ملف النسخة الاحتياطية ينقصه مصفوفة "${k}". الرجاء استيراد ملف نسخة احتياطية صالح من Albayan (تصدير نسخة احتياطية).`
            : `Backup file is missing "${k}" array. Please import a valid Albayan backup JSON (Export Backup).`,
          'error'
        );
        return;
      }
    }

    // Optional integrity check (detect corrupted/edited backups)
    const meta = (sanitizedImport && typeof sanitizedImport === 'object') ? sanitizedImport._exportMetadata : null;
    if (meta && meta.checksum) {
      try {
        const copy = JSON.parse(JSON.stringify(sanitizedImport));
        delete copy._exportMetadata;
        const actual = DataIntegrity.calculateChecksum(copy);
        if (String(actual) !== String(meta.checksum)) {
          showNotification(
            isAr ? 'نسخة احتياطية غير صالحة' : 'Invalid Backup',
            isAr ? 'فشل التحقق من سلامة ملف النسخة الاحتياطية (عدم تطابق checksum). الرجاء إعادة تصدير نسخة جديدة والمحاولة مرة أخرى.' : 'Backup file integrity check failed (checksum mismatch). Please re-export a fresh backup and try again.',
            'error'
          );
          return;
        }
      } catch {
        // If checksum verification itself fails, do not proceed.
        showNotification(isAr ? 'نسخة احتياطية غير صالحة' : 'Invalid Backup', isAr ? 'فشل التحقق من سلامة ملف النسخة الاحتياطية. الرجاء إعادة التصدير والمحاولة مرة أخرى.' : 'Backup file integrity check failed. Please re-export and try again.', 'error');
        return;
      }
    }

    const countVisible = (arr) => (Array.isArray(arr) ? arr.filter(r => r && typeof r === 'object' && !r._deleted).length : 0);
    const countDeleted = (arr) => (Array.isArray(arr) ? arr.filter(r => r && typeof r === 'object' && !!r._deleted).length : 0);
    const counts = {
      customers: { visible: countVisible(sanitizedImport.customers), deleted: countDeleted(sanitizedImport.customers) },
      pages: { visible: countVisible(sanitizedImport.pages), deleted: countDeleted(sanitizedImport.pages) },
      ads: { visible: countVisible(sanitizedImport.ads), deleted: countDeleted(sanitizedImport.ads) },
      receipts: { visible: countVisible(sanitizedImport.receipts), deleted: countDeleted(sanitizedImport.receipts) },
      exchangeRateHistory: { visible: countVisible(sanitizedImport.exchangeRateHistory), deleted: countDeleted(sanitizedImport.exchangeRateHistory) }
    };

    const ok1 = confirm(
      isAr
        ? `استيراد جزئي لبيانات العمل إلى الخادم (أدمن)\n\nسيتم استبدال المجموعات المذكورة لجميع المستخدمين. لن تتم استعادة المستخدمين أو معاملات المحفظة أو الاشتراكات أو سجلات التدقيق، وسيتم تجاهل هذه المصفوفات إن وجدت في الملف.\n\nيحتوي الملف على (ظاهر / محذوف):\n- العملاء: ${counts.customers.visible} / ${counts.customers.deleted}\n- الصفحات: ${counts.pages.visible} / ${counts.pages.deleted}\n- الإعلانات: ${counts.ads.visible} / ${counts.ads.deleted}\n- الوصولات: ${counts.receipts.visible} / ${counts.receipts.deleted}\n- أسعار الصرف: ${counts.exchangeRateHistory.visible} / ${counts.exchangeRateHistory.deleted}\n\nهل تريد متابعة الاستعادة الجزئية؟`
        : `PARTIAL SERVER BUSINESS-DATA IMPORT (Admin)\n\nThis replaces the listed business collections for all users. It does NOT restore users, wallet transactions, subscriptions, or audit logs; any such arrays in the file are ignored.\n\nFile contains (visible / deleted):\n- Customers: ${counts.customers.visible} / ${counts.customers.deleted}\n- Pages: ${counts.pages.visible} / ${counts.pages.deleted}\n- Ads: ${counts.ads.visible} / ${counts.ads.deleted}\n- Receipts: ${counts.receipts.visible} / ${counts.receipts.deleted}\n- Exchange Rates: ${counts.exchangeRateHistory.visible} / ${counts.exchangeRateHistory.deleted}\n\nContinue with this partial restore?`
    );
    if (!ok1) return;
    const phrase = String(prompt(isAr ? 'اكتب IMPORT للتأكيد (حساس لحالة الأحرف):' : 'Type IMPORT to confirm (case-sensitive):') || '');
    if (phrase !== 'IMPORT') {
      showNotification(isAr ? 'تم الإلغاء' : 'Cancelled', isAr ? 'تم إلغاء الاستيراد.' : 'Import cancelled.', 'info');
      return;
    }

    const mapLimit = async (items, limit, worker) => {
      const arr = Array.isArray(items) ? items : [];
      const n = Math.max(1, Math.min(Number(limit) || 1, 10));
      let i = 0;
      const runners = new Array(Math.min(n, arr.length)).fill(0).map(async () => {
        while (i < arr.length) {
          const idx = i++;
          await worker(arr[idx], idx);
        }
      });
      await Promise.all(runners);
    };

    // Stable stringify for deterministic verification (sort object keys recursively)
    const stableStringify = (value) => {
      const seen = new WeakSet();
      const normalize = (v) => {
        if (v === null || v === undefined) return v;
        if (typeof v !== 'object') return v;
        if (seen.has(v)) return null;
        seen.add(v);
        if (Array.isArray(v)) return v.map(normalize);
        const out = {};
        for (const k of Object.keys(v).sort()) {
          const vv = v[k];
          if (vv === undefined) continue;
          out[k] = normalize(vv);
        }
        return out;
      };
      return JSON.stringify(normalize(value));
    };

    // Strict backup shape checks shared by the transactional and the legacy
    // import paths (backup must contain explicit unique IDs — we do NOT
    // generate IDs; that would break relationships).
    const prepareBackupList = (collection, records) => {
      const list = Array.isArray(records) ? records.filter(r => r && typeof r === 'object') : [];
      const idsAll = new Set();
      for (const r of list) {
        const id = String(r?.id || '').trim();
        if (!id) {
          throw new Error(`Invalid backup: "${collection}" contains a record without an id`);
        }
        const idCheck = Security.validateRecordIdentifiers(r, `${collection}[${idsAll.size}]`);
        if (!idCheck.valid) {
          throw new Error(`Invalid backup: ${idCheck.error}`);
        }
        if (idsAll.has(id)) {
          throw new Error(`Invalid backup: "${collection}" contains duplicate id "${id}"`);
        }
        // Normalize id back onto record (string)
        r.id = id;
        idsAll.add(id);
      }
      const deletedIds = new Set(list.filter(r => !!r._deleted).map(r => String(r.id || '')).filter(Boolean));
      const activeList = list.filter(r => !r._deleted);
      const activeIds = new Set(activeList.map(r => String(r.id || '')).filter(Boolean));
      return { list, idsAll, deletedIds, activeList, activeIds };
    };

    // The server stamps _lastModified with the RESTORE time on purpose (so
    // online devices' delta sync picks the restored rows up) — that volatile
    // field must not fail the byte-for-byte verification below.
    const stripVolatileMeta = (r) => {
      const copy = { ...r };
      delete copy._lastModified;
      return copy;
    };

    // Verify a collection on the server against the backup: visible id sets
    // must match exactly AND every record's content must match byte-for-byte
    // (minus the volatile _lastModified stamp).
    const verifyCollectionMatchesBackup = async (collection, activeList, activeIds) => {
      const after = await apiLoadCollectionAll(collection).catch(() => []);
      const serverVisible = (Array.isArray(after) ? after : []).filter(r => r && r.id && !r._deleted);
      const serverVisibleIds = new Set(serverVisible.map(r => String(r.id)));
      const extraVisible = [];
      for (const id of serverVisibleIds) {
        if (!activeIds.has(id)) extraVisible.push(id);
      }
      const missingVisible = [];
      for (const id of activeIds) {
        if (!serverVisibleIds.has(id)) missingVisible.push(id);
      }
      if (extraVisible.length || missingVisible.length) {
        const extraTxt = extraVisible.length ? `Extra on server: ${extraVisible.slice(0, 10).join(', ')}${extraVisible.length > 10 ? '…' : ''}` : '';
        const missTxt = missingVisible.length ? `Missing on server: ${missingVisible.slice(0, 10).join(', ')}${missingVisible.length > 10 ? '…' : ''}` : '';
        throw new Error(`Import verification failed for "${collection}". ${[extraTxt, missTxt].filter(Boolean).join(' | ')}`);
      }

      const backupById = new Map(activeList.map(r => [String(r.id), r]));
      const serverById = new Map(serverVisible.map(r => [String(r.id), r]));
      const mismatched = [];
      for (const id of activeIds) {
        const b = backupById.get(id);
        const s = serverById.get(id);
        if (!b || !s) continue;
        const bStr = stableStringify(stripVolatileMeta(Security.sanitizeObject(b)));
        const sStr = stableStringify(stripVolatileMeta(Security.sanitizeObject(s)));
        if (bStr !== sStr) mismatched.push(id);
      }
      if (mismatched.length) {
        throw new Error(
          `Import verification failed for "${collection}": ${mismatched.length} record(s) differ from the backup (example: ${mismatched.slice(0, 5).join(', ')}${mismatched.length > 5 ? '…' : ''}).`
        );
      }
    };

    const applyCollectionReplace = async (collection, records) => {
      const { idsAll, deletedIds, activeList, activeIds } = prepareBackupList(collection, records);

      // Delete any existing records that should NOT be visible after restore:
      // - records not present in backup at all
      // - records present in backup but marked as _deleted=true
      const existing = await apiLoadCollectionAll(collection).catch(() => []);
      const toDelete = (Array.isArray(existing) ? existing : []).filter((r) => {
        const id = String(r?.id || '');
        if (!id) return false;
        if (r?._deleted) return false; // already deleted on server
        return !idsAll.has(id) || deletedIds.has(id);
      });
      if (toDelete.length) {
        showNotification(isAr ? 'استيراد' : 'Import', isAr ? `جارٍ حذف ${toDelete.length} سجلاً قديماً من ${collection}...` : `Deleting ${toDelete.length} old ${collection} records...`, 'info');
        await mapLimit(toDelete, 5, async (rec) => {
          try {
            await apiDeleteEntity(collection, String(rec.id));
          } catch (e) {
            // 404 is fine (already gone). Anything else is a real failure: stop the import.
            if (e?.status !== 404) throw e;
          }
        });
      }

      // Restore ACTIVE backup records only (deleted records stay deleted on the server)
      let done = 0;
      const total = activeList.length;
      if (total) showNotification(isAr ? 'استيراد' : 'Import', isAr ? `جارٍ استيراد ${total} سجلاً من ${collection}...` : `Importing ${total} ${collection} records...`, 'info');
      await mapLimit(activeList, 5, async (rec) => {
        const id = String(rec.id || '');
        await apiAdminRestoreEntity(collection, id, rec);
        done++;
        if (total >= 50 && done % 50 === 0) {
          showNotification(isAr ? 'استيراد' : 'Import', `${collection}: ${done}/${total}...`, 'info');
        }
      });

      // Verify: visible id sets + deep content match (shared with bulk path)
      await verifyCollectionMatchesBackup(collection, activeList, activeIds);
    };

    const importIdentity = getServerSessionIdentity();
    stopServerLiveSync();
    try {
      showNotification(isAr ? 'استيراد' : 'Import', isAr ? 'جارٍ بدء الاستيراد إلى الخادم...' : 'Starting server import...', 'info');
      // Core collections always; Clothes System collections only when present
      // in the backup (older backups predate them — leave server data alone).
      const collectionsMap = {
        customers: sanitizedImport.customers || [],
        pages: sanitizedImport.pages || [],
        ads: sanitizedImport.ads || [],
        receipts: sanitizedImport.receipts || [],
        exchangeRateHistory: sanitizedImport.exchangeRateHistory || []
      };
      if (Array.isArray(sanitizedImport.clothesProducts)) collectionsMap.clothesProducts = sanitizedImport.clothesProducts;
      if (Array.isArray(sanitizedImport.clothesShipments)) collectionsMap.clothesShipments = sanitizedImport.clothesShipments;
      if (Array.isArray(sanitizedImport.clothesOrders)) collectionsMap.clothesOrders = sanitizedImport.clothesOrders;
      if (Array.isArray(sanitizedImport.clothesSettings)) collectionsMap.clothesSettings = sanitizedImport.clothesSettings;

      // Validate the backup's shape up-front for BOTH paths (throws on
      // missing/duplicate ids before anything is sent to the server).
      const preparedByCollection = new Map();
      for (const [name, records] of Object.entries(collectionsMap)) {
        preparedByCollection.set(name, prepareBackupList(name, records));
      }

      // Preferred path: ONE transactional request — the server replaces the
      // whole backup atomically, so a mid-import failure can never leave it
      // half backup / half current data.
      let bulkImported = false;
      try {
        await apiAdminBulkImport(collectionsMap);
        bulkImported = true;
      } catch (e) {
        if (e?.status === 404 || e?.status === 405) {
          throw new Error(isAr ? 'هذا الخادم لا يدعم الاستيراد الذري الآمن. حدّث الخادم أولاً.' : 'This server does not support safe transactional import. Update the server first.');
        }
        throw e;
      }

      if (bulkImported) {
        // Same verification as the legacy path: id sets + deep content.
        for (const [name, prepared] of preparedByCollection.entries()) {
          await verifyCollectionMatchesBackup(name, prepared.activeList, prepared.activeIds);
        }
      }

      // Reload fresh server state
      const loadResult = await serverLoadAllData();
      if (loadResult?.aborted) return;
      saveState();
      showNotification(
        isAr ? 'تم الاستيراد الجزئي' : 'Partial Import Complete',
        isAr
          ? 'تمت استعادة بيانات العمل المحددة. لم تتم استعادة المستخدمين أو سجل المحفظة أو الاشتراكات أو سجل التدقيق.'
          : 'Selected business data was restored. Users, wallet/subscription history, and audit logs were not restored.',
        'warning'
      );
      render();
    } catch (e) {
      console.error('Server import failed:', e);
      showNotification(isAr ? 'فشل الاستيراد' : 'Import Failed', e?.message || (isAr ? 'فشل الاستيراد إلى الخادم' : 'Server import failed'), 'error');
    } finally {
      if (!serverSessionIdentityChanged(importIdentity)) startServerLiveSync();
    }
  }

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json';
  input.onchange = (e) => {
    const file = e.target.files[0];
    
    // Validate file size (max 50MB)
    if (file.size > 50 * 1024 * 1024) {
      showNotification(isAr ? 'خطأ' : 'Error', isAr ? 'الملف كبير جداً. الحد الأقصى للحجم 50 ميغابايت.' : 'File too large. Maximum size is 50MB.', 'error');
      return;
    }
    
    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const imported = JSON.parse(event.target.result);
        
        // Validate import structure
        if (!imported || typeof imported !== 'object') {
          throw new Error('Invalid data structure');
        }
        
        // Sanitize imported data
        const sanitizedImport = Security.sanitizeObject(imported);

        // Optional integrity check (detect corrupted/edited backups)
        if (sanitizedImport && typeof sanitizedImport === 'object' && sanitizedImport._exportMetadata?.checksum) {
          const copy = JSON.parse(JSON.stringify(sanitizedImport));
          delete copy._exportMetadata;
          const actual = DataIntegrity.calculateChecksum(copy);
          if (String(actual) !== String(sanitizedImport._exportMetadata.checksum)) {
            showNotification(
              isAr ? 'نسخة احتياطية غير صالحة' : 'Invalid Backup',
              isAr ? 'فشل التحقق من سلامة ملف النسخة الاحتياطية (عدم تطابق checksum). الرجاء إعادة تصدير نسخة جديدة والمحاولة مرة أخرى.' : 'Backup file integrity check failed (checksum mismatch). Please re-export a fresh backup and try again.',
              'error'
            );
            return;
          }
        }

        // Reject identifiers that could escape a URL/attribute/legacy inline
        // handler. Do not rewrite them: that would break cross-record links in
        // a backup while appearing to import successfully.
        for (const collectionName of PERSISTED_COLLECTIONS) {
          const records = sanitizedImport[collectionName];
          if (!Array.isArray(records)) continue;
          const idCheck = Security.validateRecordIdentifiers(records, collectionName);
          if (!idCheck.valid) throw new Error(`Invalid backup: ${idCheck.error}`);
        }

        // Server-mode import: Admin-only and writes to backend collections
        if (isServerModeEnabled()) {
          await importDataToServer(sanitizedImport);
          return;
        }
        
        // Validate required fields exist
        const requiredArrays = ['ads', 'receipts', 'customers', 'pages', 'users', 'exchangeRateHistory', 'logs'];
        for (const arr of requiredArrays) {
          if (sanitizedImport[arr] && !Array.isArray(sanitizedImport[arr])) {
            throw new Error(`Invalid ${arr} data`);
          }
        }
        
        // Check record limits
        for (const arr of requiredArrays) {
          if (sanitizedImport[arr] && sanitizedImport[arr].length > STORAGE_CONFIG.MAX_RECORDS_PER_COLLECTION) {
            showNotification(isAr ? 'تحذير' : 'Warning', isAr ? `تم اقتصاص بيانات ${arr} إلى ${STORAGE_CONFIG.MAX_RECORDS_PER_COLLECTION} سجل` : `${arr} data truncated to ${STORAGE_CONFIG.MAX_RECORDS_PER_COLLECTION} records`, 'warning');
            sanitizedImport[arr] = sanitizedImport[arr].slice(0, STORAGE_CONFIG.MAX_RECORDS_PER_COLLECTION);
          }
        }
        
        // Apply import safely (replace data collections; keep runtime/session state)
        state.ads = Array.isArray(sanitizedImport.ads) ? sanitizedImport.ads : [];
        state.receipts = Array.isArray(sanitizedImport.receipts) ? sanitizedImport.receipts : [];
        state.customers = Array.isArray(sanitizedImport.customers) ? sanitizedImport.customers : [];
        state.pages = Array.isArray(sanitizedImport.pages) ? sanitizedImport.pages : [];
        state.users = Array.isArray(sanitizedImport.users)
          ? sanitizedImport.users.map(u => {
              const copy = { ...u };
              // Backwards compatibility: if an old backup contains plaintext `password`,
              // keep it ONLY long enough for `ensureUsersHavePasswordHashes()` to hash it,
              // then it is removed from storage.
              if (copy.passwordHash && copy.salt) {
                delete copy.password;
              }
              return copy;
            })
          : [];
        state.exchangeRateHistory = Array.isArray(sanitizedImport.exchangeRateHistory) ? sanitizedImport.exchangeRateHistory : [];
        state.logs = Array.isArray(sanitizedImport.logs) ? sanitizedImport.logs : [];
        state.walletTransactions = Array.isArray(sanitizedImport.walletTransactions) ? sanitizedImport.walletTransactions : [];
        state.serviceSubscriptions = Array.isArray(sanitizedImport.serviceSubscriptions) ? sanitizedImport.serviceSubscriptions : [];
        state.clothesProducts = Array.isArray(sanitizedImport.clothesProducts) ? sanitizedImport.clothesProducts : [];
        state.clothesShipments = Array.isArray(sanitizedImport.clothesShipments) ? sanitizedImport.clothesShipments : [];
        state.clothesOrders = Array.isArray(sanitizedImport.clothesOrders) ? sanitizedImport.clothesOrders : [];
        state.clothesSettings = Array.isArray(sanitizedImport.clothesSettings) ? sanitizedImport.clothesSettings : [];
        state.adCampaignRequests = Array.isArray(sanitizedImport.adCampaignRequests) ? sanitizedImport.adCampaignRequests : [];

        if (sanitizedImport.defaultExchangeRate !== undefined) {
          const rate = parseFloat(sanitizedImport.defaultExchangeRate);
          if (!Number.isNaN(rate)) state.defaultExchangeRate = rate;
        }

        // Normalize legacy receipt storage
        normalizeReceiptsFromAds();

        // Ensure passwords are hashed and metadata present
        await ensureUsersHavePasswordHashes();

        // Persist all collections to IndexedDB
        for (const name of PERSISTED_COLLECTIONS) clearCollectionCorruption(name);
        delete state._quarantinedUnsafeRecords;
        if (db) {
          await clearIndexedDBLogs();
        }
        markAllCollectionsDirty();
        await flushDirtyCollections();
        if (db) {
          await syncLogsToIndexedDB();
        }
        
        saveState();
        addAuditLog('Import', 'system', 'Data imported successfully');
        showNotification(isAr ? 'تم الاستيراد' : 'Imported', isAr ? 'تم استيراد البيانات والتحقق منها بنجاح' : 'Data imported and validated successfully', 'success');
        render();
      } catch (error) {
        addSecurityLog('import_error', error.message);
        showNotification(isAr ? 'خطأ' : 'Error', (isAr ? 'فشل استيراد البيانات: ' : 'Failed to import data: ') + error.message, 'error');
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

async function clearAllData() {
  if (isServerModeEnabled()) {
    showNotification(state.language === 'ar' ? 'غير مسموح' : 'Not Allowed', state.language === 'ar' ? 'مسح جميع البيانات معطّل في وضع الخادم. استخدم أدوات إدارة الخادم.' : 'Clear-all is disabled in server mode. Use backend admin tools.', 'error');
    return;
  }
  if (confirm(state.language === 'ar' ? 'مسح جميع البيانات؟ لا يمكن التراجع عن هذا الإجراء!' : 'Clear all data? This cannot be undone!')) {
    // Clear in-memory collections
    state.ads = [];
    state.receipts = [];
    state.customers = [];
    state.pages = [];
    state.users = [];
    state.exchangeRateHistory = [];
    state.logs = [];
    state.currentUser = null;
    SessionManager.destroySession();
    
    // Also clear IndexedDB stores
    if (db) {
      await clearIndexedDBLogs();
      await idbClear(DATA_STORE_NAME).catch(() => {});
      await idbClear(BACKUP_STORE_NAME).catch(() => {});
    }
    
    saveState();
    showNotification(state.language === 'ar' ? 'تم المسح' : 'Cleared', state.language === 'ar' ? 'تم مسح جميع البيانات' : 'All data cleared', 'success');
    render();
  }
}
