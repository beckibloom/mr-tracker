// Count one use of a feature (see server/usage.mjs). Fire-and-forget; never blocks the UI.
export const track = (feature) => {
  fetch('/api/usage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ feature }),
    keepalive: true,
  }).catch(() => {});
};
