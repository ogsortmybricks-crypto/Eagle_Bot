// Shared amendment display - loads Town Hall updates on wiki pages
(function() {
  var STORAGE_KEY = 'townHallAmendments';
  var currentPage = location.pathname.split('/').pop() || 'index.html';

  function loadAmendments() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      var all = JSON.parse(raw);
      return all[currentPage] || [];
    } catch(e) { return []; }
  }

  function formatDate(dateStr) {
    var d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function injectAmendments() {
    var amendments = loadAmendments();
    if (amendments.length === 0) return;

    var mainContent = document.querySelector('.main-content');
    if (!mainContent) return;

    var insertAfter = mainContent.querySelector('.page-desc') || mainContent.querySelector('h1');
    if (!insertAfter) return;

    var section = document.createElement('div');
    section.className = 'town-hall-updates';

    var header = document.createElement('div');
    header.className = 'updates-header';
    header.id = 'updates-toggle-trigger';

    var icon = document.createElement('span');
    icon.className = 'updates-icon';
    icon.textContent = '\u{1F4CB}';

    var heading = document.createElement('h2');
    heading.textContent = 'Town Hall Updates';

    var toggleBtn = document.createElement('button');
    toggleBtn.className = 'updates-toggle';
    toggleBtn.setAttribute('aria-label', 'Toggle updates');
    toggleBtn.textContent = '\u25BC';

    header.appendChild(icon);
    header.appendChild(heading);
    header.appendChild(toggleBtn);

    var content = document.createElement('div');
    content.className = 'updates-content';
    content.id = 'updates-content';

    amendments.forEach(function(a) {
      var item = document.createElement('div');
      item.className = 'amendment-item';

      var dateDiv = document.createElement('div');
      dateDiv.className = 'amendment-date';
      dateDiv.textContent = formatDate(a.date);

      var textDiv = document.createElement('div');
      textDiv.className = 'amendment-text';
      textDiv.textContent = a.text;

      item.appendChild(dateDiv);
      item.appendChild(textDiv);
      content.appendChild(item);
    });

    section.appendChild(header);
    section.appendChild(content);

    insertAfter.parentNode.insertBefore(section, insertAfter.nextSibling);

    header.addEventListener('click', function() {
      content.classList.toggle('collapsed');
      toggleBtn.textContent = content.classList.contains('collapsed') ? '\u25B6' : '\u25BC';
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectAmendments);
  } else {
    injectAmendments();
  }
})();
