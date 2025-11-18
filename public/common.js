// mk-air common utilities
// shared code across all pages

// Theme Toggle
function initThemeToggle() {
  const themeToggle = document.getElementById('themeToggle');
  const html = document.documentElement;

  if (!themeToggle) return;

  themeToggle.addEventListener('click', () => {
    html.classList.toggle('dark-mode');
  });
}

// Timestamp
function initTimestamp() {
  const timestampEl = document.getElementById('timestamp');

  if (!timestampEl) return;

  function updateTimestamp() {
    const now = new Date();
    const date = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    timestampEl.textContent = `${date} — ${time}`;
  }

  updateTimestamp();
  setInterval(updateTimestamp, 1000);
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  initThemeToggle();
  initTimestamp();
});
