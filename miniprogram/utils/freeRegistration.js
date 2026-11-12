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

module.exports = { freeRegistrationError };
