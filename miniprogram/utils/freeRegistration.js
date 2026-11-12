// No mutation succeeded when the server returns one of these errors. Explain
// why the previous free entry was kept instead of displaying false success.
function freeRegistrationError(result) {
  const messages = {
    REGISTRATION_PAYMENT_PENDING: 'A payment for this or your previous event is still being resolved. Finish or cancel it before changing your free entry. Your existing tickets have not been removed.',
    REGISTRATION_OWNER_CONFLICT: 'An existing ticket needs an administrator to verify its owner. Your tickets have not been changed.',
    REGISTRATION_TIME_UNAVAILABLE: 'We cannot verify when you entered your previous event. Ask the counter to check the arrival time before changing your free entry. Your previous entry has been kept.',
    REGISTRATION_EVENT_UNAVAILABLE: 'We could not verify your previous event. Please try again later. Your previous entry has been kept.',
    REGISTRATION_HISTORY_TOO_LARGE: 'Your entry history needs an administrator to review it. Your existing tickets have not been removed.',
    UNAUTHORIZED: 'Sign in again before registering. Your existing tickets have not been removed.'
  };
  return messages[result && result.code] || 'Could not confirm your registration. Refresh your tickets to check the current entry before trying again.';
}

// Returns null only when the guest explicitly cancels. Confirmation remains
// in memory and is bound by the server to the exact entries being replaced.
async function requestFreeRegistration(cloud, eventId) {
  let replacementConfirmation;
  for (let attempt = 0; attempt < 4; attempt++) {
    let result;
    wx.showLoading({ title: 'Registering...', mask: true });
    try {
      const data = { action: 'submitRegistrationWithConfirmation', eventId };
      if (replacementConfirmation) data.replacementConfirmation = replacementConfirmation;
      const response = await cloud.callFunction({ name: 'clientAuth', data });
      result = response && response.result;
      if (!result || typeof result !== 'object') throw new Error('Missing registration response');
    } finally {
      // Native dialogs must not be covered by the loading mask.
      wx.hideLoading();
    }
    if (result.code !== 'REGISTRATION_CONFIRMATION_REQUIRED') return result;
    if (!result.success || !Array.isArray(result.replacements) || !result.replacements.length ||
        typeof result.replacementConfirmation !== 'string' || !result.replacementConfirmation) {
      throw new Error('Incomplete registration confirmation');
    }
    const events = new Map();
    result.replacements.forEach(item => {
      if (!item.eventId || !item.eventTitle) throw new Error('Missing previous event name');
      events.set(item.eventId, item.eventTitle);
    });
    const names = [...events.values()].map(name => '“' + name + '”').join('\n');
    const confirmed = await new Promise((resolve, reject) => {
      wx.showModal({
        title: 'Change registration?',
        content: 'Your registration for ' + names + ' will be cancelled if you register for this event. Do you want to continue?',
        showCancel: true,
        confirmText: 'Confirm',
        cancelText: 'Cancel',
        success: answer => resolve(answer.confirm === true),
        fail: reject
      });
    });
    if (!confirmed) return null;
    replacementConfirmation = result.replacementConfirmation;
    // If another request changed the cancellation scope in the meantime, the
    // server returns a new preview; do not reuse consent for different entries.
  }
  throw new Error('Registration changed repeatedly. Please try again.');
}

module.exports = { freeRegistrationError, requestFreeRegistration };
