function stopAd(id) {
  // Permission check
  if (!canActOnRecord('ads', 'stopAd', state.ads.find(a => a.id === id)?.creatorId)) {
    showNotification('Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لإيقاف الإعلانات' : 'You do not have permission to stop ads', 'error');
    return;
  }
  
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
    <div id="stop-ad-modal" class="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onclick="if(event.target === this) this.remove()">
      <div class="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl max-w-md w-full" onclick="event.stopPropagation()">
        <div class="p-6 border-b border-slate-200 dark:border-slate-700">
          <div class="flex items-center justify-between">
            <h2 class="text-xl font-bold text-slate-800 dark:text-white flex items-center">
              <i data-lucide="${isAlreadyStopped ? 'edit' : 'square'}" class="w-5 h-5 mr-2 text-orange-500"></i>
              ${isAlreadyStopped ? 'Edit Stop Details' : 'Stop Ad'}
            </h2>
            <button onclick="document.getElementById('stop-ad-modal').remove()" class="p-2 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors">
              <i data-lucide="x" class="w-5 h-5"></i>
            </button>
          </div>
        </div>
        
        <div class="p-6 space-y-4">
          <div>
            <p class="text-sm text-slate-600 dark:text-slate-400 mb-2">
              <strong>Customer:</strong> ${Security.escapeHtml(customer?.name || 'Unknown')}<br>
              <strong>Ad Amount:</strong> $${adAmountUSD.toFixed(2)}<br>
              <strong>Currently Allocated:</strong> $${totalAllocated.toFixed(2)}
              ${isAlreadyStopped && ad.stoppedAt ? `<br><strong>Stopped On:</strong> ${new Date(ad.stoppedAt).toLocaleString()}` : ''}
            </p>
          </div>
          
          ${isAlreadyStopped ? `
            <div class="bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-xl p-3">
              <div class="text-xs font-medium text-orange-800 dark:text-orange-200 mb-2">Previous Entry:</div>
              <div class="text-xs text-slate-600 dark:text-slate-400 space-y-1">
                <div>Spent: <span class="font-bold text-orange-600">$${currentSpentUSD.toFixed(2)}</span></div>
                <div>Remaining Returned: <span class="font-bold text-emerald-600">$${previousRemaining.toFixed(2)}</span></div>
              </div>
            </div>
          ` : ''}
          
          <div>
            <label class="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
              Amount Spent (USD) *
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
            <p class="text-xs text-slate-500 mt-1">${isAlreadyStopped ? 'Edit the amount spent to update the remaining balance' : 'Enter how much was actually spent on this ad'}</p>
          </div>
          
          <div id="stop-ad-calculations" class="bg-slate-50 dark:bg-slate-900/50 rounded-xl p-4 space-y-2">
            <div class="flex justify-between text-sm">
              <span class="text-slate-600 dark:text-slate-400">Ad Amount:</span>
              <span class="font-bold">$${adAmountUSD.toFixed(2)}</span>
            </div>
            <div class="flex justify-between text-sm">
              <span class="text-slate-600 dark:text-slate-400">Amount Spent:</span>
              <span class="font-bold text-orange-600" id="stop-ad-spent-display">$${currentSpentUSD.toFixed(2)}</span>
            </div>
            <div class="border-t border-slate-200 dark:border-slate-700 pt-2 flex justify-between">
              <span class="text-sm font-medium text-emerald-600">Remaining ${isAlreadyStopped ? '(will be updated)' : '(will be returned)'}:</span>
              <span class="text-sm font-bold text-emerald-600" id="stop-ad-remaining">$${(adAmountUSD - currentSpentUSD).toFixed(2)}</span>
            </div>
          </div>
          
          <div class="flex space-x-3 pt-2">
            <button 
              onclick="document.getElementById('stop-ad-modal').remove()" 
              class="flex-1 px-4 py-3 bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300 rounded-xl font-bold hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
            >
              Cancel
            </button>
            <button 
              onclick="confirmStopAd('${id}')" 
              class="flex-1 px-4 py-3 bg-orange-600 text-white rounded-xl font-bold hover:bg-orange-700 transition-colors"
            >
              ${isAlreadyStopped ? 'Update' : 'Stop Ad'}
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

function confirmStopAd(id) {
  const ad = state.ads.find(a => a.id === id);
  if (!ad) return;
  
  const spentInput = document.getElementById('stop-ad-spent');
  if (!spentInput) return;
  
  const spentUSD = parseFloat(spentInput.value) || 0;
  const adAmountUSD = ad.amountUSD || 0;
  
  if (spentUSD < 0 || spentUSD > adAmountUSD) {
    showNotification('Error', 'Spent amount must be between 0 and ad amount', 'error');
    return;
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
  
  // Update ad status and spent amount
  ad.status = 'Stopped';
  ad.spentUSD = spentUSD;
  if (!ad.stoppedAt) {
    ad.stoppedAt = new Date().toISOString();
  }
  ad.lastUpdated = new Date().toISOString();
  
  // Handle receipt allocations - adjust based on remaining difference
  if (Array.isArray(ad.receiptAllocations) && ad.receiptAllocations.length > 0) {
    const totalAllocated = ad.receiptAllocations.reduce((sum, alloc) => sum + (parseFloat(alloc.amountUSD) || 0), 0);
    
    if (totalAllocated > 0) {
      if (isEditing && remainingDifference !== 0) {
        // Editing: adjust allocations by the ad's global funding-pool fraction
        const adjustmentRatio = adjustFraction;

        ad.receiptAllocations.forEach(alloc => {
          const receipt = state.receipts.find(r => r.id === alloc.receiptId);
          if (receipt) {
            const allocatedAmount = parseFloat(alloc.amountUSD) || 0;
            const adjustmentAmount = allocatedAmount * adjustmentRatio;
            
            if (remainingDifference > 0) {
              // More remaining now - reduce allocation (return more to receipt)
              alloc.amountUSD = Math.max(allocatedAmount - adjustmentAmount, 0);
              addAuditLog('receipt', receipt.id, 'usage', `Ad ${ad.id} updated - returned additional $${adjustmentAmount.toFixed(2)} to receipt balance`, {
                adId: ad.id,
                returnedAmount: adjustmentAmount,
                spentAmount: spentUSD,
                previousSpent: previousSpentUSD
              });
            } else {
              // Less remaining now - increase allocation (use more from receipt)
              alloc.amountUSD = allocatedAmount + adjustmentAmount;
              addAuditLog('receipt', receipt.id, 'usage', `Ad ${ad.id} updated - used additional $${adjustmentAmount.toFixed(2)} from receipt balance`, {
                adId: ad.id,
                usedAmount: adjustmentAmount,
                spentAmount: spentUSD,
                previousSpent: previousSpentUSD
              });
            }
          }
        });
      } else if (!isEditing && newRemainingUSD > 0) {
        // First time stopping: return each allocation's share of the remainder
        const reductionRatio = returnFraction;

        ad.receiptAllocations.forEach(alloc => {
          const receipt = state.receipts.find(r => r.id === alloc.receiptId);
          if (receipt) {
            const allocatedAmount = parseFloat(alloc.amountUSD) || 0;
            const reductionAmount = allocatedAmount * reductionRatio;
            alloc.amountUSD = Math.max(allocatedAmount - reductionAmount, 0);
            
            addAuditLog('receipt', receipt.id, 'usage', `Ad ${ad.id} stopped - returned $${reductionAmount.toFixed(2)} to receipt balance`, {
              adId: ad.id,
              returnedAmount: reductionAmount,
              spentAmount: spentUSD
            });
          }
        });
      }
      
      // Remove zero allocations
      ad.receiptAllocations = ad.receiptAllocations.filter(alloc => (parseFloat(alloc.amountUSD) || 0) > 0);
    }
  }
  
  // Handle dueAllocations - for "Not Paid + Driver" mode ads
  if (Array.isArray(ad.dueAllocations) && ad.dueAllocations.length > 0) {
    const totalDueAllocated = ad.dueAllocations.reduce((sum, alloc) => sum + (parseFloat(alloc.amountUSD) || 0), 0);
    
    if (totalDueAllocated > 0) {
      if (isEditing && remainingDifference !== 0) {
        // Editing: adjust allocations by the ad's global funding-pool fraction
        const adjustmentRatio = adjustFraction;

        ad.dueAllocations.forEach(alloc => {
          const receipt = state.receipts.find(r => r.id === alloc.receiptId);
          if (receipt) {
            const allocatedAmount = parseFloat(alloc.amountUSD) || 0;
            const adjustmentAmount = allocatedAmount * adjustmentRatio;
            
            if (remainingDifference > 0) {
              alloc.amountUSD = Math.max(allocatedAmount - adjustmentAmount, 0);
              addAuditLog('receipt', receipt.id, 'usage', `Ad ${ad.id} updated - returned additional $${adjustmentAmount.toFixed(2)} to delivery receipt due balance`, {
                adId: ad.id,
                returnedAmount: adjustmentAmount,
                spentAmount: spentUSD,
                previousSpent: previousSpentUSD
              });
            } else {
              alloc.amountUSD = allocatedAmount + adjustmentAmount;
              addAuditLog('receipt', receipt.id, 'usage', `Ad ${ad.id} updated - used additional $${adjustmentAmount.toFixed(2)} from delivery receipt due balance`, {
                adId: ad.id,
                usedAmount: adjustmentAmount,
                spentAmount: spentUSD,
                previousSpent: previousSpentUSD
              });
            }
          }
        });
      } else if (!isEditing && newRemainingUSD > 0) {
        // First time stopping: return each allocation's share of the remainder
        const reductionRatio = returnFraction;

        ad.dueAllocations.forEach(alloc => {
          const receipt = state.receipts.find(r => r.id === alloc.receiptId);
          if (receipt) {
            const allocatedAmount = parseFloat(alloc.amountUSD) || 0;
            const reductionAmount = allocatedAmount * reductionRatio;
            alloc.amountUSD = Math.max(allocatedAmount - reductionAmount, 0);
            
            addAuditLog('receipt', receipt.id, 'usage', `Ad ${ad.id} stopped - returned $${reductionAmount.toFixed(2)} to delivery receipt due balance`, {
              adId: ad.id,
              returnedAmount: reductionAmount,
              spentAmount: spentUSD
            });
          }
        });
      }
      
      // Remove zero allocations
      ad.dueAllocations = ad.dueAllocations.filter(alloc => (parseFloat(alloc.amountUSD) || 0) > 0);
    }
    
    // Also update the legacy dueAmountToUseUSD field to match
    ad.dueAmountToUseUSD = ad.dueAllocations.reduce((sum, alloc) => sum + (parseFloat(alloc.amountUSD) || 0), 0);
  } else if (ad.dueAmountToUseUSD > 0 && !isEditing && newRemainingUSD > 0) {
    // Legacy: Handle ads with dueAmountToUseUSD but no dueAllocations array.
    // Return only this pool's share of the remainder (global apportionment).
    const reductionAmount = Math.min(ad.dueAmountToUseUSD * returnFraction, ad.dueAmountToUseUSD);
    ad.dueAmountToUseUSD = Math.max(ad.dueAmountToUseUSD - reductionAmount, 0);
    
    if (ad.linkedDeliveryReceiptId) {
      addAuditLog('receipt', ad.linkedDeliveryReceiptId, 'usage', `Ad ${ad.id} stopped - returned $${reductionAmount.toFixed(2)} to delivery receipt due balance`, {
        adId: ad.id,
        returnedAmount: reductionAmount,
        spentAmount: spentUSD
      });
    }
  }
  
  // Handle mergedPaidAllocations - for "Not Paid + Driver" mode ads with merged paid receipts
  if (Array.isArray(ad.mergedPaidAllocations) && ad.mergedPaidAllocations.length > 0) {
    const totalMergedAllocated = ad.mergedPaidAllocations.reduce((sum, alloc) => sum + (parseFloat(alloc.amountUSD) || 0), 0);
    
    if (totalMergedAllocated > 0) {
      if (isEditing && remainingDifference !== 0) {
        // Merged mirrors the paid pool — use the same global fraction.
        const adjustmentRatio = adjustFraction;

        ad.mergedPaidAllocations.forEach(alloc => {
          const receipt = state.receipts.find(r => r.id === alloc.receiptId);
          if (receipt) {
            const allocatedAmount = parseFloat(alloc.amountUSD) || 0;
            const adjustmentAmount = allocatedAmount * adjustmentRatio;
            
            if (remainingDifference > 0) {
              alloc.amountUSD = Math.max(allocatedAmount - adjustmentAmount, 0);
              addAuditLog('receipt', receipt.id, 'usage', `Ad ${ad.id} updated - returned additional $${adjustmentAmount.toFixed(2)} to merged receipt balance`, {
                adId: ad.id,
                returnedAmount: adjustmentAmount,
                spentAmount: spentUSD,
                previousSpent: previousSpentUSD
              });
            } else {
              alloc.amountUSD = allocatedAmount + adjustmentAmount;
            }
          }
        });
      } else if (!isEditing && newRemainingUSD > 0) {
        // Merged mirrors the paid pool — use the same global fraction.
        const reductionRatio = returnFraction;

        ad.mergedPaidAllocations.forEach(alloc => {
          const receipt = state.receipts.find(r => r.id === alloc.receiptId);
          if (receipt) {
            const allocatedAmount = parseFloat(alloc.amountUSD) || 0;
            const reductionAmount = allocatedAmount * reductionRatio;
            alloc.amountUSD = Math.max(allocatedAmount - reductionAmount, 0);
            
            addAuditLog('receipt', receipt.id, 'usage', `Ad ${ad.id} stopped - returned $${reductionAmount.toFixed(2)} to merged receipt balance`, {
              adId: ad.id,
              returnedAmount: reductionAmount,
              spentAmount: spentUSD
            });
          }
        });
      }
      
      ad.mergedPaidAllocations = ad.mergedPaidAllocations.filter(alloc => (parseFloat(alloc.amountUSD) || 0) > 0);
    }
  }
  
  // Update customer balance
  const customer = state.customers.find(c => c.id === ad.customerId);
  if (customer) {
    if (isEditing && remainingDifference !== 0) {
      // Adjust customer balance by the difference
      if (customer.balance !== undefined) {
        customer.balance = (customer.balance || 0) + remainingDifference;
        updateRecord(state.customers, customer.id, customer);
      }
      addLog('update', 'customer', customer.id, `Ad stop updated - ${remainingDifference > 0 ? 'returned' : 'used'} $${Math.abs(remainingDifference).toFixed(2)} ${remainingDifference > 0 ? 'to' : 'from'} customer balance`);
    } else if (!isEditing && newRemainingUSD > 0) {
      // First time stopping: add remaining to customer balance
      if (customer.balance !== undefined) {
        customer.balance = (customer.balance || 0) + newRemainingUSD;
        updateRecord(state.customers, customer.id, customer);
      }
      addLog('update', 'customer', customer.id, `Ad stopped - returned $${newRemainingUSD.toFixed(2)} to customer balance`);
    }
  }
  
  // Save ad
  updateRecord(state.ads, ad.id, ad);
  
  // Close modal
  document.getElementById('stop-ad-modal')?.remove();
  
  // Show notification
  const actionText = isEditing ? 'updated' : 'stopped';
  const balanceText = remainingDifference !== 0 || !isEditing ? `$${Math.abs(isEditing ? remainingDifference : newRemainingUSD).toFixed(2)} ${isEditing ? (remainingDifference > 0 ? 'returned' : 'used') : 'returned'} to receipt${ad.receiptAllocations && ad.receiptAllocations.length > 1 ? 's' : ''} and customer balance` : 'No balance changes';
  showNotification(`Ad ${actionText.charAt(0).toUpperCase() + actionText.slice(1)}`, `Ad ${actionText} successfully. ${balanceText}.`, 'success');
  
  // Refresh view
  render();
  lucide.createIcons();
}

function deleteUser(id) {
  if (!isCurrentUserAdmin()) {
    showNotification('Access Denied', state.language === 'ar' ? 'حذف المستخدمين للأدمن فقط' : 'Admin only', 'error');
    return;
  }
  if (confirm('Delete this user?')) {
    deleteRecord(state.users, id);
    render();
  }
}

function updateExchangeRate(value) {
  state.defaultExchangeRate = parseFloat(value);
  const record = {
    id: generateId('rate'),
    rate: state.defaultExchangeRate,
    date: new Date().toISOString(),
    userId: state.currentUser?.id || 'system'
  };
  addRecord(state.exchangeRateHistory, record);
  showNotification('Updated', 'Exchange rate updated', 'success');
}

function exportData() {
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
    serviceSubscriptions: { visible: countVisible(exportState.serviceSubscriptions), deleted: countDeleted(exportState.serviceSubscriptions) }
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
  
  // Add export metadata
  const checksum = DataIntegrity.calculateChecksum(exportState);
  exportState._exportMetadata = {
    exportedAt: new Date().toISOString(),
    version: '3.0.1',
    source: isServerModeEnabled() ? 'server' : 'local',
    visibleOnly: true,
    counts,
    checksum
  };
  
  const dataStr = JSON.stringify(exportState, null, 2);
  const dataBlob = new Blob([dataStr], { type: 'application/json' });
  const url = URL.createObjectURL(dataBlob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `albayan-backup-${getTodayDateString()}.json`;
  link.click();
  URL.revokeObjectURL(url);
  
  // Create auto backup
  createAutoBackup();
  
  addAuditLog('Export', 'system', 'Data exported successfully');
  showNotification('Exported', 'Data exported successfully', 'success');
}

function importData() {
  // In server mode, import must go through the backend (Admin only) to keep the server as source of truth.
  async function importDataToServer(sanitizedImport) {
    const role = String(state.currentUser?.role || '').toLowerCase();
    if (role !== 'admin') {
      showNotification('Not Allowed', 'Only Admins can import in server mode.', 'error');
      return;
    }

    // Safety: require a full backup structure (prevents accidental wipe from wrong JSON file)
    const requiredCollections = ['customers', 'pages', 'ads', 'receipts', 'exchangeRateHistory'];
    for (const k of requiredCollections) {
      if (!Array.isArray(sanitizedImport?.[k])) {
        showNotification(
          'Invalid Backup',
          `Backup file is missing "${k}" array. Please import a valid Albayan backup JSON (Export Backup).`,
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
            'Invalid Backup',
            'Backup file integrity check failed (checksum mismatch). Please re-export a fresh backup and try again.',
            'error'
          );
          return;
        }
      } catch {
        // If checksum verification itself fails, do not proceed.
        showNotification('Invalid Backup', 'Backup file integrity check failed. Please re-export and try again.', 'error');
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
      `SERVER IMPORT (Admin)\n\nThis will overwrite/replace server data for ALL users.\n\nBackup contains (visible / deleted):\n- Customers: ${counts.customers.visible} / ${counts.customers.deleted}\n- Pages: ${counts.pages.visible} / ${counts.pages.deleted}\n- Ads: ${counts.ads.visible} / ${counts.ads.deleted}\n- Receipts: ${counts.receipts.visible} / ${counts.receipts.deleted}\n- Exchange Rates: ${counts.exchangeRateHistory.visible} / ${counts.exchangeRateHistory.deleted}\n\nContinue?`
    );
    if (!ok1) return;
    const phrase = String(prompt('Type IMPORT to confirm (case-sensitive):') || '');
    if (phrase !== 'IMPORT') {
      showNotification('Cancelled', 'Import cancelled.', 'info');
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

    const applyCollectionReplace = async (collection, records) => {
      const list = Array.isArray(records) ? records.filter(r => r && typeof r === 'object') : [];
      // Strict: backup must contain explicit IDs (we do NOT generate IDs; that would break relationships)
      const idsAll = new Set();
      for (const r of list) {
        const id = String(r?.id || '').trim();
        if (!id) {
          throw new Error(`Invalid backup: "${collection}" contains a record without an id`);
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
        showNotification('Import', `Deleting ${toDelete.length} old ${collection} records...`, 'info');
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
      if (total) showNotification('Import', `Importing ${total} ${collection} records...`, 'info');
      await mapLimit(activeList, 5, async (rec) => {
        const id = String(rec.id || '');
        await apiAdminRestoreEntity(collection, id, rec);
        done++;
        if (total >= 50 && done % 50 === 0) {
          showNotification('Import', `${collection}: ${done}/${total}...`, 'info');
        }
      });

      // Verify: server visible set must match backup visible set (prevents "ghost records" coming back)
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

      // Deep verification: record content must match exactly by id (strongest safety check)
      const backupById = new Map(activeList.map(r => [String(r.id), r]));
      const serverById = new Map(serverVisible.map(r => [String(r.id), r]));
      const mismatched = [];
      for (const id of activeIds) {
        const b = backupById.get(id);
        const s = serverById.get(id);
        if (!b || !s) continue;
        const bStr = stableStringify(Security.sanitizeObject(b));
        const sStr = stableStringify(Security.sanitizeObject(s));
        if (bStr !== sStr) mismatched.push(id);
      }
      if (mismatched.length) {
        throw new Error(
          `Import verification failed for "${collection}": ${mismatched.length} record(s) differ from the backup (example: ${mismatched.slice(0, 5).join(', ')}${mismatched.length > 5 ? '…' : ''}).`
        );
      }
    };

    try {
      showNotification('Import', 'Starting server import...', 'info');
      // Replace core collections only (server is source of truth)
      await applyCollectionReplace('customers', sanitizedImport.customers);
      await applyCollectionReplace('pages', sanitizedImport.pages);
      await applyCollectionReplace('ads', sanitizedImport.ads);
      await applyCollectionReplace('receipts', sanitizedImport.receipts);
      await applyCollectionReplace('exchangeRateHistory', sanitizedImport.exchangeRateHistory);

      // Reload fresh server state
      await serverLoadAllData();
      saveState();
      showNotification('Imported', 'Server import completed successfully.', 'success');
      render();
    } catch (e) {
      console.error('Server import failed:', e);
      showNotification('Import Failed', e?.message || 'Server import failed', 'error');
    }
  }

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json';
  input.onchange = (e) => {
    const file = e.target.files[0];
    
    // Validate file size (max 50MB)
    if (file.size > 50 * 1024 * 1024) {
      showNotification('Error', 'File too large. Maximum size is 50MB.', 'error');
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
              'Invalid Backup',
              'Backup file integrity check failed (checksum mismatch). Please re-export a fresh backup and try again.',
              'error'
            );
            return;
          }
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
            showNotification('Warning', `${arr} data truncated to ${STORAGE_CONFIG.MAX_RECORDS_PER_COLLECTION} records`, 'warning');
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

        if (sanitizedImport.defaultExchangeRate !== undefined) {
          const rate = parseFloat(sanitizedImport.defaultExchangeRate);
          if (!Number.isNaN(rate)) state.defaultExchangeRate = rate;
        }

        // Normalize legacy receipt storage
        normalizeReceiptsFromAds();

        // Ensure passwords are hashed and metadata present
        await ensureUsersHavePasswordHashes();

        // Persist all collections to IndexedDB
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
        showNotification('Imported', 'Data imported and validated successfully', 'success');
        render();
      } catch (error) {
        addSecurityLog('import_error', error.message);
        showNotification('Error', 'Failed to import data: ' + error.message, 'error');
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

async function clearAllData() {
  if (isServerModeEnabled()) {
    showNotification('Not Allowed', 'Clear-all is disabled in server mode. Use backend admin tools.', 'error');
    return;
  }
  if (confirm('Clear all data? This cannot be undone!')) {
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
    showNotification('Cleared', 'All data cleared', 'success');
    render();
  }
}
