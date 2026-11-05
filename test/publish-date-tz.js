const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const contentPath = process.argv[2] || path.join(__dirname, '..', 'content.js');
const contentScript = fs.readFileSync(contentPath, 'utf8')
  .replace(/\n\}\)\(\);\s*$/, `
  window.__testHooks = { formatPublishDate };
})();`);

const context = {
  chrome: { runtime: { onMessage: { addListener() {} } } },
  console,
  document: {
    body: { appendChild() {} },
    createElement() { return { setAttribute() {}, style: {} }; },
    querySelector() { return null; }
  },
  DOMParser: class {},
  MouseEvent: class {},
  MutationObserver: class {},
  navigator: {},
  setTimeout,
  URL,
  window: {
    location: {
      href: 'https://www.youtube.com/watch?v=kxpbdFMgPJ4',
      origin: 'https://www.youtube.com',
      pathname: '/watch'
    }
  }
};

context.window.window = context.window;
context.window.document = context.document;
vm.createContext(context);
vm.runInContext(contentScript, context);

const format = context.window.__testHooks.formatPublishDate;
const now = new Date('2026-11-05T12:00:00Z');
const options = { year: 'numeric', month: 'long', day: 'numeric' };
process.stdout.write(JSON.stringify({
  dateOnly: format('2026-11-06', now),
  slash: format('11/06/2026', now),
  instant: new Date('2026-11-06T00:00:00Z').toLocaleDateString('en-US', options)
}));
