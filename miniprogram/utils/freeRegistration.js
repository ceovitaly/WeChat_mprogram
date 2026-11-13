// Prior-entry data is informational, never a registration refusal reason.
// Authentication and the selected event's normal availability still apply.
function freeRegistrationError(result) {
  const messages = {
    REGISTRATION_OWNER_CONFLICT: 'An existing ticket for the selected event needs an administrator to verify its owner. Your tickets have not been changed.',
    UNAUTHORIZED: 'Sign in again before registering. Your existing tickets have not been removed.'
  };
  return messages[result && result.code] || 'Could not confirm your registration. Refresh your tickets to check the current entry before trying again.';
}

function consequenceMessage(entry) {
  const name = entry.eventTitle ? '“' + entry.eventTitle + '”' : 'your previous event';
  if (entry.outcome === 'cancelled') return 'Your registration for ' + name + ' will be cancelled when you join this event.';
  if (entry.reason === 'three_hours' || entry.reason === 'retained_visit') {
    return 'Your visit to ' + name + ' will be kept because you stayed for at least 3 hours. You can also register for this event.';
  }
  if (entry.reason === 'event_finished') {
    return 'Your entry for ' + name + ' will be kept because that event has ended or was closed. You can also register for this event.';
  }
  if (entry.reason === 'protected_payment' || entry.reason === 'protected_ticket') {
    return 'Your entry for ' + name + ' is linked to a payment and will not be changed. You can register for this event.';
  }
  return 'Your entry for ' + name + ' will be left unchanged because its details could not be verified. This does not prevent registration for this event.';
}

// Returns null only for the guest's own Cancel choice, not an old-record block.
async function requestFreeRegistration(cloud, eventId) {
  let replacementConfirmation;
  for (let attempt = 0; attempt < 4; attempt++) {
    let result;
    wx.showLoading({ title: 'Registering...', mask: true });
    try {
      const data = { action: 'submitRegistrationWithConfirmation', eventId, registrationNoticeVersion: 2 };
      if (replacementConfirmation) data.replacementConfirmation = replacementConfirmation;
      const response = await cloud.callFunction({ name: 'clientAuth', data });
      result = response && response.result;
      if (!result || typeof result !== 'object') throw new Error('Missing registration response');
    } finally {
      wx.hideLoading();
    }
    if (result.code !== 'REGISTRATION_CONFIRMATION_REQUIRED') return result;
    const entries = Array.isArray(result.previousRegistrations) ? result.previousRegistrations :
      (Array.isArray(result.replacements) ? result.replacements.map(entry => ({ ...entry, outcome: 'cancelled' })) : []);
    if (!result.success || !entries.length || typeof result.replacementConfirmation !== 'string' || !result.replacementConfirmation) {
      throw new Error('Incomplete registration notice');
    }
    const unique = new Map();
    entries.forEach(entry => {
      if (!['cancelled', 'kept'].includes(entry.outcome)) throw new Error('Unknown registration consequence');
      if (entry.outcome === 'cancelled' && (!entry.eventId || !entry.eventTitle)) throw new Error('Missing previous event name');
      unique.set(entry.registrationId || entry.eventId, entry);
    });
    const content = [...unique.values()].map(consequenceMessage).join('\n\n') + '\n\nContinue with this event?';
    const confirmed = await new Promise((resolve, reject) => {
      wx.showModal({
        title: 'Change registration?', content, showCancel: true,
        confirmText: 'Confirm', cancelText: 'Cancel',
        success: answer => resolve(answer.confirm === true), fail: reject
      });
    });
    if (!confirmed) return null;
    replacementConfirmation = result.replacementConfirmation;
    // A different current booking needs a fresh notice, not blanket consent.
  }
  throw new Error('Your current booking changed. Please try again.');
}

module.exports = { freeRegistrationError, requestFreeRegistration };
