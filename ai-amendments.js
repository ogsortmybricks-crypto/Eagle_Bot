const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const WIKI_DIR = path.resolve(__dirname, 'wiki');

const CONTENT_PAGES = [
  'es-strikes.html', 'es-strike-regular.html', 'es-strike-guardrail.html', 'es-strike-refusal.html',
  'ms-rules.html', 'ms-rules-academics.html', 'ms-rules-schedule.html',
  'ms-strikes.html', 'ms-strike-apology.html', 'ms-strike-lgg.html', 'ms-strike-silent-lunch.html',
  'positions.html', 'positions-eligibility.html', 'positions-townhall.html', 'positions-strike-staff.html', 'positions-other.html',
  'shared-roes.html', 'es-roes.html', 'es-roes-conduct.html', 'es-roes-promise.html', 'ms-roes.html',
  'shared-kitchen.html', 'shared-phones.html', 'shared-safety.html', 'shared-spaces.html'
];

function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  return new Anthropic();
}

function extractPageContent(pageName) {
  const filePath = path.join(WIKI_DIR, pageName);
  if (!fs.existsSync(filePath)) return null;
  const html = fs.readFileSync(filePath, 'utf-8');
  const dom = new JSDOM(html);
  const main = dom.window.document.querySelector('.main-content');
  if (!main) return null;
  const scripts = main.querySelectorAll('script');
  scripts.forEach(s => s.remove());
  return main.innerHTML;
}

function buildWikiSummary() {
  const summaries = [];
  for (const page of CONTENT_PAGES) {
    const content = extractPageContent(page);
    if (content) {
      const text = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 6000);
      summaries.push(`[${page}]: ${text}`);
    }
  }
  return summaries.join('\n\n');
}

async function analyzeAmendments(notes) {
  const client = getClient();
  if (!client) throw new Error('Anthropic API key not configured');

  const wikiSummary = buildWikiSummary();

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `You are the Triumph Academy Constitution Wiki assistant. Your job is to analyze amendment notes from a Town Hall session and determine exactly what changes need to be made to the wiki pages.

Here are the current wiki pages and their content:

${wikiSummary}

---

Here are the amendment notes from this Town Hall session:

${notes.map((n, i) => `${i + 1}. ${n}`).join('\n')}

---

For each amendment note, determine:
1. Which wiki page(s) need to be modified
2. What type of change is needed: "edit" (modify existing text), "add" (add new rule/content), or "remove" (delete existing rule/content)
3. For "edit": what existing text to find and what to replace it with
4. For "add": what new content to add and where (after which existing text)
5. For "remove": what text/section to remove

Respond in this exact JSON format:
{
  "changes": [
    {
      "note": "the original amendment note",
      "pages": [
        {
          "file": "filename.html",
          "action": "edit|add|remove",
          "find": "exact existing text to locate (for edit/remove)",
          "replace": "new text (for edit, empty string for remove)",
          "addAfter": "text to insert after (for add action only)",
          "newContent": "content to add (for add action only)",
          "explanation": "brief explanation of why this change is needed"
        }
      ]
    }
  ],
  "uncategorized": ["any notes that don't map to wiki changes"]
}

Important rules:
- The "find" text must be actual text that currently exists on the page (from the content shown above)
- For edits, keep the same HTML structure/formatting style as the existing content
- If an amendment affects rules mentioned on multiple pages, include changes for ALL affected pages
- Keep explanations brief
- If a note is unclear or doesn't relate to any wiki rule, put it in "uncategorized"
- When removing a position, concept, or rule: scan EVERY page for ALL mentions — including callout notes, eligibility sections, parenthetical references, and any sentence that names it
- If a mention is embedded inside a larger element (e.g., a callout that also contains other valid content), use action "edit" to remove just that sentence/phrase rather than "remove" (which deletes the whole element)
- A "remove" action should only be used when the entire element should be deleted; use "edit" with replace set to "" or a trimmed version when only part of the text should go`
    }]
  });

  const text = response.content[0].text;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Could not parse AI response');
  return JSON.parse(jsonMatch[0]);
}

function applyChange(pageName, change) {
  if (!CONTENT_PAGES.includes(pageName)) {
    return { success: false, error: 'Page not in allowlist' };
  }
  const filePath = path.join(WIKI_DIR, pageName);
  if (!filePath.startsWith(WIKI_DIR + path.sep) && filePath !== WIKI_DIR) {
    return { success: false, error: 'Invalid path' };
  }
  if (!fs.existsSync(filePath)) {
    return { success: false, error: 'File not found' };
  }

  let html = fs.readFileSync(filePath, 'utf-8');
  const dom = new JSDOM(html);
  const main = dom.window.document.querySelector('.main-content');
  if (!main) return { success: false, error: 'No main content' };

  let modified = false;

  if (change.action === 'edit' && change.find && change.replace !== undefined) {
    const elements = main.querySelectorAll('p, li, td, th, h2, h3, h4, span, div');
    for (const el of elements) {
      if (el.textContent.includes(change.find) || el.innerHTML.includes(change.find)) {
        if (el.innerHTML.includes(change.find)) {
          el.innerHTML = el.innerHTML.replace(change.find, change.replace);
        } else {
          el.textContent = el.textContent.replace(change.find, change.replace);
        }
        modified = true;
        break;
      }
    }
    if (!modified) {
      const mainHtml = main.innerHTML;
      if (mainHtml.includes(change.find)) {
        main.innerHTML = mainHtml.replace(change.find, change.replace);
        modified = true;
      }
    }
  } else if (change.action === 'add') {
    const insertAfterText = change.addAfter;
    let target = null;

    if (insertAfterText) {
      const elements = main.querySelectorAll('p, li, h2, h3, h4, div, ul, ol, table');
      for (const el of elements) {
        if (el.textContent.includes(insertAfterText)) {
          target = el;
          break;
        }
      }
    }

    if (!target) {
      target = main.querySelector('.rule-card:last-of-type') ||
               main.querySelector('ul:last-of-type') ||
               main.querySelector('p:last-of-type');
    }

    if (target) {
      const newEl = dom.window.document.createElement('div');
      newEl.innerHTML = change.newContent || `<p>${change.replace || ''}</p>`;
      if (target.tagName === 'UL' || target.tagName === 'OL') {
        const li = dom.window.document.createElement('li');
        li.textContent = change.newContent || change.replace || '';
        target.appendChild(li);
      } else {
        target.parentNode.insertBefore(newEl, target.nextSibling);
      }
      modified = true;
    }
  } else if (change.action === 'remove' && change.find) {
    const elements = [...main.querySelectorAll('p, li, tr, div, h3, h4')];
    for (const el of elements) {
      if (el.textContent.includes(change.find)) {
        el.remove();
        modified = true;
      }
    }
  }

  if (modified) {
    fs.writeFileSync(filePath, dom.serialize(), 'utf-8');
    return { success: true };
  }

  return { success: false, error: 'Could not locate target content' };
}

async function applyAIAmendments(notes, pool) {
  const analysis = await analyzeAmendments(notes);
  const results = [];
  const pagesModified = new Set();
  const now = new Date().toISOString();
  const fileEntries = [];
  const AMENDMENTS_FILE = path.join(__dirname, 'amendments-log.json');

  for (const change of (analysis.changes || [])) {
    const noteResult = { note: change.note, pages: [] };

    for (const pageChange of (change.pages || [])) {
      const result = applyChange(pageChange.file, pageChange);
      const applied = result.success;

      noteResult.pages.push({
        file: pageChange.file,
        action: pageChange.action,
        success: applied,
        explanation: pageChange.explanation,
        error: result.error || null
      });

      if (applied) pagesModified.add(pageChange.file);

      if (pool) {
        await pool.query(
          'INSERT INTO amendments (page, note, applied, created_at) VALUES ($1, $2, $3, $4)',
          [pageChange.file, change.note, applied, now]
        );
      }
      fileEntries.push({ page: pageChange.file, note: change.note, applied, createdAt: now });
    }

    results.push(noteResult);
  }

  let existing = [];
  try { existing = JSON.parse(fs.readFileSync(AMENDMENTS_FILE, 'utf-8')); } catch (e) {}
  fs.writeFileSync(AMENDMENTS_FILE, JSON.stringify([...existing, ...fileEntries], null, 2), 'utf-8');

  return {
    success: pagesModified.size > 0,
    results,
    pagesModified: [...pagesModified],
    uncategorized: analysis.uncategorized || []
  };
}

async function chatAboutConstitution(question, conversationHistory) {
  const client = getClient();
  if (!client) throw new Error('Anthropic API key not configured');

  const wikiSummary = buildWikiSummary();

  const messages = [];

  if (conversationHistory && conversationHistory.length > 0) {
    for (const msg of conversationHistory.slice(-10)) {
      messages.push({ role: msg.role, content: msg.content });
    }
  }

  messages.push({ role: 'user', content: question });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: `You are the Triumph Academy Constitution Wiki assistant. You answer questions about the school's rules, strike system, positions, and policies based on the constitution wiki content below. Be helpful, accurate, and concise. If something isn't covered in the wiki, say so clearly.

Here is the full constitution wiki content:

${wikiSummary}`,
    messages
  });

  return response.content[0].text;
}

module.exports = { applyAIAmendments, chatAboutConstitution, getClient };
