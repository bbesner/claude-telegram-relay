const allowedUserIds = new Set(
  (process.env.ALLOWED_USER_IDS || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean)
);

function isAuthorized(userId) {
  return allowedUserIds.has(String(userId));
}

module.exports = { isAuthorized };
