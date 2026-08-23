const navLinks = [...document.querySelectorAll('.sidebar nav a[href^="#"]')];
const targets = new Map(
  navLinks
    .map((link) => [link.getAttribute('href').slice(1), link])
    .filter(([id]) => document.getElementById(id)),
);

function setActiveNavigation(id) {
  const active = targets.get(id) || targets.get('overview');
  for (const link of navLinks) link.classList.toggle('active', link === active);
}

for (const [id, link] of targets) {
  link.addEventListener('click', () => setActiveNavigation(id));
}

const initialTarget = window.location.hash.slice(1);
setActiveNavigation(targets.has(initialTarget) ? initialTarget : 'overview');

if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver((entries) => {
    const visible = entries
      .filter((entry) => entry.isIntersecting)
      .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (visible?.target?.id && targets.has(visible.target.id)) setActiveNavigation(visible.target.id);
  }, { rootMargin: '-18% 0px -66% 0px', threshold: [0, 0.01, 0.25] });

  for (const id of targets.keys()) observer.observe(document.getElementById(id));
}

document.getElementById('new-project-inline')?.addEventListener('click', () => {
  document.getElementById('project-dialog')?.showModal();
});
