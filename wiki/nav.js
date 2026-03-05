// Shared navigation component for Triumph Academy Wiki
(function() {
  const currentPage = location.pathname.split('/').pop() || 'index.html';

  // ================================================================
  // PERMISSION SYSTEM
  // ================================================================
  // userRole:     'admin' | 'learner'  (stored in localStorage after login)
  // userPosition: position name or ''  (stored in localStorage after login)
  //
  // Nav item permission properties:
  //   roles:     ['admin']  — which roles can see this item (in addition to admin who sees all)
  //   positions: ['ES Strike Champion', ...]  — which positions can see this item
  //   If neither is set, everyone can see it.
  //
  // To add a new position-gated page in the future:
  //   1. Add the page to allNavItems with roles:['admin'] and positions:[...position names...]
  //   2. The user's position (from their user record) is stored in localStorage.userPosition at login.
  //   3. canSee() will automatically grant access when the position matches.
  // ================================================================

  const role = localStorage.getItem('userRole') || 'learner';
  let userPositions = [];
  try { userPositions = JSON.parse(localStorage.getItem('userPositions') || '[]'); } catch(e) {}
  if (!Array.isArray(userPositions)) {
    userPositions = userPositions ? [userPositions] : [];
  }

  function canSee(item) {
    if (role === 'admin') return true;
    if (!item.roles && !item.positions) return true;
    if (item.roles && item.roles.includes(role)) return true;
    if (item.positions && userPositions.length > 0 && item.positions.some(p => userPositions.includes(p))) return true;
    return false;
  }

  // ---- Auth guard ----
  // Pages that don't need a learner session at all
  const unprotected = ['learner-login.html', 'invite.html', 'election.html'];

  // Pages that require admin role (redirect non-admins to home)
  const adminOnlyPages = ['admin-users.html', 'strike-champion.html', 'town-hall.html'];

  if (!unprotected.includes(currentPage)) {
    const token = localStorage.getItem('learnerToken');
    if (!token) {
      window.location.replace('learner-login.html?redirect=' + encodeURIComponent(currentPage));
      return;
    }
    // Role guard: non-admin users cannot visit admin-only pages
    if (adminOnlyPages.includes(currentPage) && !canSee({ roles: ['admin'] })) {
      window.location.replace('index.html');
      return;
    }
  }

  // ================================================================
  // NAV ITEM DEFINITIONS
  // ================================================================
  // Structure:
  //   { section: 'Label' [, roles, positions] }  — section header
  //   { href, label [, sub, roles, positions] }   — nav link
  //
  // Sections are only rendered if at least one of their items is visible.
  // Marking a section with roles/positions hides the entire section for
  // users who don't match — no need to mark each item individually.
  // ================================================================

  const allNavItems = [
    { section: 'Home' },
    { href: 'index.html', label: 'Home' },

    { section: 'Elementary Studio' },
    { href: 'es-strikes.html', label: 'ES Strike System' },
    { href: 'es-strike-regular.html', label: 'Regular Strike', sub: true },
    { href: 'es-strike-guardrail.html', label: 'Guardrail Strike', sub: true },
    { href: 'es-strike-refusal.html', label: 'Refusal', sub: true },
    { href: 'es-roes.html', label: 'ES Rules of Engagement' },
    { href: 'es-roes-promise.html', label: "Hero's Promise", sub: true },
    { href: 'es-roes-conduct.html', label: 'Classroom Conduct', sub: true },

    { section: 'Middle School' },
    { href: 'ms-strikes.html', label: 'MS Strike System' },
    { href: 'ms-strike-silent-lunch.html', label: 'Silent Lunch', sub: true },
    { href: 'ms-strike-apology.html', label: 'Apology Letter', sub: true },
    { href: 'ms-strike-lgg.html', label: 'Low Grade Guardrail (LGG)', sub: true },
    { href: 'ms-rules.html', label: 'MS Academics & Schedule' },
    { href: 'ms-rules-academics.html', label: 'Academics', sub: true },
    { href: 'ms-rules-schedule.html', label: 'Schedule', sub: true },

    { section: 'Positions' },
    { href: 'positions.html', label: 'Leadership Positions' },
    { href: 'positions-eligibility.html', label: 'Eligibility', sub: true },
    { href: 'positions-townhall.html', label: 'Town Hall', sub: true },
    { href: 'positions-strike-staff.html', label: 'Strike Staff', sub: true },
    { href: 'positions-other.html', label: 'Other Positions', sub: true },

    { section: 'Shared' },
    { href: 'shared-roes.html', label: 'Shared ROEs' },
    { href: 'shared-safety.html', label: 'Safety', sub: true },
    { href: 'shared-phones.html', label: 'Phones', sub: true },
    { href: 'shared-kitchen.html', label: 'Kitchen', sub: true },
    { href: 'shared-spaces.html', label: 'Shared Spaces', sub: true },

    { section: 'Members' },
    { href: 'roster.html', label: 'Member Roster' },
    { href: 'admin-users.html', label: 'User Admin', roles: ['admin'] },

    { section: 'AI Assistant' },
    { href: 'ask.html', label: 'Ask the Constitution' },

    { section: 'Elections' },
    { href: 'vote.html', label: 'Cast Your Vote' },

    // Admin tools — admin-only by default; positions listed for future unlocking
    { section: 'Admin Tools', roles: ['admin'] },
    {
      href: 'strike-champion.html', label: 'Strike Champion Tool', roles: ['admin'],
      // Future: uncomment to let Strike Champions access this without admin login
      // positions: ['ES Strike Champion','ES Strike Champion 1st Backup','ES Strike Champion 2nd Backup',
      //             'MS Strike Champion','MS Strike Champion 1st Backup','MS Strike Champion 2nd Backup']
    },
    {
      href: 'town-hall.html', label: 'Town Hall Secretary', roles: ['admin'],
      // Future: positions: ['Tribe Town Hall Secretary','Backup Tribe Town Hall Secretary',
      //                     'MS Town Hall Secretary','ES Town Hall Secretary']
    },
    { href: 'election.html', label: 'Election Booth', roles: ['admin'] },
  ];

  // ================================================================
  // BUILD FILTERED NAV
  // Smart section filtering: a section header is only rendered when
  // at least one of its items passes canSee(). If the section header
  // itself has roles/positions, the whole section is hidden for
  // users who don't match, regardless of individual item rules.
  // ================================================================
  function buildFilteredNav(items) {
    const result = [];
    let i = 0;
    while (i < items.length) {
      const item = items[i];
      if (item.section) {
        // If the section itself is restricted and user can't see it, skip entire section
        if (!canSee(item)) {
          i++;
          while (i < items.length && !items[i].section) i++;
          continue;
        }
        // Collect visible items in this section
        const visibleItems = [];
        let j = i + 1;
        while (j < items.length && !items[j].section) {
          if (canSee(items[j])) visibleItems.push(items[j]);
          j++;
        }
        // Only add the section if it has at least one visible item
        if (visibleItems.length > 0) {
          result.push(item);
          visibleItems.forEach(vi => result.push(vi));
        }
        i = j;
      } else {
        i++;
      }
    }
    return result;
  }

  const navItems = buildFilteredNav(allNavItems);

  // ================================================================
  // RENDER SIDEBAR
  // ================================================================
  const sidebar = document.createElement('aside');
  sidebar.className = 'sidebar';
  sidebar.id = 'sidebar';

  let html = `
    <div class="sidebar-header">
      <img src="Eagle_Bot.png" alt="Eagle Bot" class="sidebar-logo">
      <h2>Triumph Academy</h2>
      <div class="subtitle">Constitution Wiki</div>
    </div>
    <nav>
  `;

  navItems.forEach(item => {
    if (item.section) {
      html += `<div class="nav-section">${item.section}</div>`;
    } else if (item.sub) {
      const active = item.href === currentPage ? ' active' : '';
      html += `<a href="${item.href}" class="nav-sub${active}">${item.label}</a>`;
    } else {
      const active = item.href === currentPage ? ' active' : '';
      html += `<a href="${item.href}" class="${active}">${item.label}</a>`;
    }
  });

  html += '</nav>';

  // ---- User footer ----
  const name = localStorage.getItem('userName') || '';
  const studio = localStorage.getItem('userStudio') || '';

  if (name) {
    let badge = '';
    if (role === 'admin') {
      badge = '<span class="nav-user-studio" style="background:var(--accent);color:#fff;">Admin</span>';
    } else if (userPosition) {
      badge = `<span class="nav-user-studio">${userPosition}</span>`;
    } else if (studio) {
      badge = `<span class="nav-user-studio">${studio}</span>`;
    }
    html += `<div class="nav-user-footer">
      <div class="nav-user-name">${name}${badge ? ' ' + badge : ''}</div>
      <button class="nav-signout-btn" onclick="navSignOut()">Sign Out</button>
    </div>`;
  }

  sidebar.innerHTML = html;

  // Hamburger button
  const hamburger = document.createElement('button');
  hamburger.className = 'hamburger';
  hamburger.id = 'hamburger';
  hamburger.innerHTML = '&#9776;';
  hamburger.setAttribute('aria-label', 'Toggle navigation');

  // Overlay
  const overlay = document.createElement('div');
  overlay.className = 'sidebar-overlay';
  overlay.id = 'sidebar-overlay';

  document.body.prepend(overlay);
  document.body.prepend(sidebar);
  document.body.prepend(hamburger);

  hamburger.addEventListener('click', () => {
    sidebar.classList.toggle('open');
    overlay.classList.toggle('open');
  });

  overlay.addEventListener('click', () => {
    sidebar.classList.remove('open');
    overlay.classList.remove('open');
  });

  // ================================================================
  // SIGN OUT — clears all session keys for both admin and learner
  // ================================================================
  window.navSignOut = function() {
    const token = localStorage.getItem('learnerToken');
    if (token) {
      fetch(location.origin + '/api/learner/logout', {
        method: 'POST',
        headers: { 'x-learner-token': token }
      }).catch(() => {});
    }
    // Clear every session key (current and legacy)
    ['learnerToken', 'adminToken',
     'userName', 'userStudio', 'userRole', 'userPosition',
     'learnerName', 'learnerStudio'           // legacy keys — safe to remove
    ].forEach(k => localStorage.removeItem(k));
    window.location.href = 'learner-login.html';
  };
})();
