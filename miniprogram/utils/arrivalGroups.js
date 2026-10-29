// Use a fresh assigner for each complete, arrival-sorted event list,
// before promoter/search filters. Manual arrivals belong to Extra and do not
// consume scanned capacity. Arrival numbering remains independent of tiers.
function createArrivalGroupAssigner(event) {
  const ev = event || {}
  const p = Math.max(0, Number(ev.partyCapacity) || 0)
  const ap = Math.max(0, Number(ev.afterPartyCapacity) || 0)
  const lap = Math.max(0, Number(ev.lateAfterPartyCapacity) || 0)
  let scannedNumber = 0
  return guest => {
    if (!guest.arrivedAt || !guest.scannedAt) return ''
    const num = ++scannedNumber
    if (p > 0 && num <= p) return 'P'
    if (ap > 0 && num <= p + ap) return 'AP'
    if (lap > 0 && num <= p + ap + lap) return 'LAP'
    return ''
  }
}

module.exports = { createArrivalGroupAssigner }
