'use strict';

const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

function timestampMs(value) {
  if (value == null || value === '') return NaN;
  const raw = typeof value === 'object' && value.$date !== undefined ? value.$date : value;
  const ms = raw instanceof Date ? raw.getTime() : typeof raw === 'number' ? raw : Date.parse(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : NaN;
}

// Only explicit free-entry records are replaceable. A missing paid flag alone
// is not proof that a legacy ticket has no financial entitlement.
function isFreeRegistration(reg) {
  if (!reg || reg.paid || reg.orderId || reg.transactionId || reg.outTradeNo ||
      Number(reg.paidAmountFen) > 0 || Number(reg.amountFen) > 0 ||
      reg.paymentStatus || reg.paymentId || reg.purchaseId || reg.ticketKind === 'paid') return false;
  return reg.ticketType === 'Free Entry' || reg.ticketId === 'free';
}

function eventEndMs(ev) {
  if (!ev || !/^\d{4}-\d{2}-\d{2}$/.test(ev.date || '') || !/^\d{2}:\d{2}$/.test(ev.endTime || '')) return NaN;
  const date = ev.date.split('-').map(Number);
  const end = ev.endTime.split(':').map(Number);
  if (end[0] > 23 || end[1] > 59) return NaN;
  const hasStart = /^\d{2}:\d{2}$/.test(ev.startTime || '');
  const start = hasStart ? ev.startTime.split(':').map(Number) : null;
  const overnight = start ? end[0] * 60 + end[1] <= start[0] * 60 + start[1] : end[0] < 12;
  return Date.UTC(date[0], date[1] - 1, date[2] + (overnight ? 1 : 0), end[0], end[1]) - SHANGHAI_OFFSET_MS;
}

function eventHasFinished(ev, now) {
  if (!ev) return false; // Missing data is not proof of a finished event.
  if (ev.isClosed === true || ['closed', 'finished', 'completed', 'ended'].includes(ev.status)) return true;
  const end = eventEndMs(ev);
  return Number.isFinite(end) && now >= end;
}

function attendanceMs(reg, ev) {
  if (!reg || (!reg.arrivedAt && !reg.scannedAt)) return NaN;
  const checked = timestampMs(reg.checkedInAt);
  if (Number.isFinite(checked)) return checked;
  const scanned = timestampMs(reg.scannedAt);
  if (Number.isFinite(scanned)) return scanned;
  // Legacy manual arrivals have only a Shanghai HH:MM display value. Do not
  // guess an absolute three-hour stay from a device clock; fail closed instead.
  return NaN;
}

function retentionReason(reg, ev, now) {
  if (!isFreeRegistration(reg)) return 'protected_ticket';
  if (eventHasFinished(ev, now)) return 'event_finished';
  const since = attendanceMs(reg, ev);
  // A revoked arrival must not retain its exemption after a later new entry.
  const retainedAt = timestampMs(reg.freeVisitRetainedAt);
  if (Number.isFinite(since) && Number.isFinite(retainedAt) && since <= retainedAt) return 'retained_visit';
  if (Number.isFinite(since) && now - since >= THREE_HOURS_MS) return 'three_hours';
  return '';
}

module.exports = { THREE_HOURS_MS, timestampMs, isFreeRegistration, eventEndMs, eventHasFinished, attendanceMs, retentionReason };
