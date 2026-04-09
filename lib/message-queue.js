const log = require('./logger');

const MAX_QUEUE = parseInt(process.env.MESSAGE_QUEUE_MAX || '5', 10);

// Per-chat promise chains — ensures sequential processing per chat
const chains = new Map();
// Per-chat pending counts
const pending = new Map();

/**
 * Enqueue a task for a chat. Tasks for the same chat run sequentially;
 * different chats run concurrently.
 * @param {string} chatKey - Unique chat identifier
 * @param {Function} task - Async function to execute
 * @returns {Promise} - Resolves when this task completes, or rejects if queue is full
 */
function enqueue(chatKey, task) {
  const count = pending.get(chatKey) || 0;

  if (count >= MAX_QUEUE) {
    return Promise.reject(new Error(
      `Too many pending messages (${count}). Please wait for current responses to finish.`
    ));
  }

  pending.set(chatKey, count + 1);

  const prev = chains.get(chatKey) || Promise.resolve();
  const next = prev
    .then(() => task())
    .catch((err) => {
      log.error('Queue task failed', { chatKey, error: err.message });
      throw err;
    })
    .finally(() => {
      const cur = pending.get(chatKey) || 1;
      if (cur <= 1) {
        pending.delete(chatKey);
        chains.delete(chatKey);
      } else {
        pending.set(chatKey, cur - 1);
      }
    });

  chains.set(chatKey, next.catch(() => {})); // Prevent unhandled rejection on chain
  return next;
}

module.exports = { enqueue };
