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
