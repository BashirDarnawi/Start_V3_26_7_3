// A saved final ad spend is an accounting fact, while Meta's spend is a live
// provider reading. Once an ad is terminal (including legacy Stopped records)
// or a staff member has explicitly confirmed the final amount, later Meta syncs
// must remain informative only and must not replace the accounting value.
function hasFrozenFinalAdSpend(ad) {
  if (!ad || ad._deleted) return false;
  const rawSpent = ad.spentUSD;
  if (rawSpent === undefined || rawSpent === null || rawSpent === '') return false;
  const spentUSD = Number(rawSpent);
  if (!Number.isFinite(spentUSD) || spentUSD < 0) return false;
  if (ad.manualSpentOverride === true || !!ad.finalSpendConfirmedAt) return true;
  const status = String(ad.status || '').trim().toLowerCase();
  return ['stopped', 'completed', 'canceled', 'cancelled', 'lost', 'archived'].includes(status);
}

function getFrozenFinalAdSpendUSD(ad) {
  return hasFrozenFinalAdSpend(ad) ? Math.max(Number(ad.spentUSD), 0) : null;
}

// Startup-bundle twin of the profit panel's getAdActualSpendUSD (same
// precedence: frozen final -> USD Meta reading -> recorded -> terminal sale).
function getAdActualSpendUSDLite(ad) {
  if (!ad || ad._deleted) return 0;
  const frozen = getFrozenFinalAdSpendUSD(ad);
  if (frozen !== null) return frozen;
  const minor = Number(ad.metaSpendMinor);
  if (ad.metaAdId && Number.isFinite(minor) && minor >= 0 && String(ad.metaCurrency || 'USD').toUpperCase() === 'USD') return Math.max(0, minor / 100);
  const recorded = Number(ad.spentUSD);
  if (Number.isFinite(recorded) && recorded >= 0) return recorded;
  const status = String(ad.status || '').toLowerCase();
  if (['stopped', 'completed', 'canceled', 'cancelled', 'lost'].includes(status)) return Math.max(0, Number(getAdSpendUSD(ad)) || 0);
  return 0;
}
