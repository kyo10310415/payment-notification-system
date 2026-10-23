const { randomBytes, createHmac } = require('crypto');

// Salt is private to a single run; IDs cannot be correlated across runs or guessed.
const events = new Set(['message-filtered', 'reaction-detected', 'reply-detected',
  'guild-processing', 'payment-detected', 'operation-failed']);
function createOperationalLogger(output = console) {
  const salt = randomBytes(32);
  return function logEvent(event, id) {
    if (!events.has(event)) throw new Error('Unknown operational event');
    const reference = id === undefined ? '' : ' event=' + createHmac('sha256', salt)
      .update(String(id)).digest('hex').slice(0, 16);
    output.log(`[${event}]${reference}`);
  };
}
module.exports = { createOperationalLogger, logEvent: createOperationalLogger() };
