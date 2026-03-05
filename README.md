# Eagle Bot Wiki - Town Hall Amendment System

## Overview
The Town Hall Amendment System allows the Town Hall Secretary to publish amendments that are **permanently written into the wiki HTML files**. Amendments are automatically categorized and inserted into the appropriate sections, appearing as if they were always part of the page.

## How It Works

### Backend Components
- **server.js** - Node.js/Express server that handles file modifications
  - Listens on `http://localhost:3001`
  - POST endpoint: `/api/apply-amendments`
  - Parses HTML files and inserts amendments into appropriate sections
  - Saves modified HTML back to disk

### Frontend Components
- **wiki/town-hall.html** - Admin interface for entering amendments
  - Auto-categorizes notes by comparing keywords to predefined rules
  - Shows preview of where each note will be placed
  - Sends approved amendments to the server

- **wiki/amendments.js** - Placeholder script (kept for compatibility)
  - Amendments are now permanent in HTML files

- **wiki/style.css** - Styling for amendment boxes
  - `.amendment-box` - Individual amendments
  - `.amendments-section` - Container for amendments
  - `.amendment-badge` - "Town Hall Update" label

## Starting the System

1. Ensure Node.js is installed:
   ```bash
   node --version  # Should be v20.20.0+
   ```

2. Install dependencies (one-time):
   ```bash
   npm install
   ```

3. Start the server:
   ```bash
   npm start
   ```

4. Open the Town Hall page in a browser:
   ```
   file:///home/ogsortmybricks/Eagle_Bot/wiki/town-hall.html
   ```
   (Or access via local web server if using one)

## Using the System

### Step 1: Enter Notes
Type amendments in the textarea on the Town Hall page:
```
- ES strikes now require 2 friendly reminders
- MS position ban is 5 weeks minimum
- All studios: no phones during quests
```

### Step 2: Preview
Click **Preview** to see where each note will be categorized. The system uses keyword matching and studio tags (ES/MS) to determine placement.

### Step 3: Apply
Click **Sort & Apply** to permanently write amendments into the wiki pages.

### What Happens
1. Form sends categorized amendments to `http://localhost:3001/api/apply-amendments`
2. Server reads each target HTML file
3. Finds the appropriate section (e.g., "Strike Types" for strike-related amendments)
4. Inserts amendment boxes with today's date and formatted text
5. Writes modified HTML back to disk
6. Success message appears; notes auto-clear

## Amendment Placement

Amendments are inserted right after the target section heading in each page:

- **es-strikes.html** → After "Strike Types"
- **es-roes.html** → After "Hero's Promise"
- **ms-strikes.html** → After "Strike Types"
- **ms-rules.html** → After "Core Skills"
- **positions.html** → After "Strike Champion"
- **shared-roes.html** → After "Safety Rules"

## Categorization Rules

The system uses two types of keyword matching:

**Phrases** (substring match):
- "regular strike", "guardrail strike", "silent lunch", etc.

**Words** (word-boundary match):
- "strike", "mark", "position", "leadership", etc.

**Studio Tags** (bonus/penalty):
- Mentions of "ES", "MS", "elementary", or "middle school"
- If a note mentions a studio, pages for that studio get a bonus score
- Other studios get a penalty

A note is categorized if its highest-scoring page reaches a minimum score of 3.

## Technical Details

### Amendment HTML Structure
```html
<div class="amendment-box">
  <div class="amendment-header">
    <span class="amendment-badge">Town Hall Update</span>
    <span class="amendment-date">Feb 16, 2026</span>
  </div>
  <div class="amendment-content">Amendment text here...</div>
</div>
```

### Server Error Handling
- File not found → Returns error message
- Target section not found → Returns error message
- HTML parse errors → Captured and reported
- Network errors → Browser shows "Could not connect to server"

### Stopping the Server
To stop the server, find its terminal and press `Ctrl+C` or:
```bash
killall node
```

## Troubleshooting

**"Could not connect to server"**
- Make sure `npm start` is running
- Check that port 3001 is not in use
- Verify with: `curl http://localhost:3001/api/apply-amendments`

**"Target section not found"**
- The server couldn't find the expected heading on that page
- Check that section headings in wiki pages match those in `sectionMap` (server.js)

**"No amendments could be applied"**
- All notes were either uncategorized or failed
- Check the preview to see which notes have issues
- Add clearer keywords: "ES", "MS", "strike", "position", etc.

## Modifying Categorization Rules

Edit `pageRules` in `wiki/town-hall.html` to change keyword weighting or add new pages:

```javascript
var pageRules = {
  'my-page.html': {
    studio: 'ES',
    phrases: [
      { t: 'my keyword phrase', w: 10 }
    ],
    words: [
      { t: 'keyword', w: 5 }
    ]
  }
};
```

## Modifying Insertion Points

Edit `sectionMap` in `server.js` to change where amendments are inserted:

```javascript
const sectionMap = {
  'my-page.html': 'Target Section Heading'
};
```
