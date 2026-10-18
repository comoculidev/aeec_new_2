'use strict';
// The renderer's output goes to the public website as HTML, so it is checked structurally:
// after removing exactly the tags the renderer is allowed to emit, no "<" or ">" may remain.
const test = require('node:test');
const assert = require('node:assert/strict');
const { render } = require('../src/markdown');

const ALLOWED = [
  /<img src="[^"<>]*" alt="[^"<>]*" loading="lazy">/g,
  /<a href="[^"<>]*"(?: target="_blank" rel="noopener noreferrer")?>/g,
  /<\/?(?:p|strong|em|ul|ol|li|blockquote|figure|figcaption|h2|h3|h4)>/g, /<\/a>/g, /<br>/g, /<hr>/g,
];
function assertSafe(html, source) {
  let rest = html;
  for (const rx of ALLOWED) rest = rest.replace(rx, '');
  assert.ok(!/[<>]/.test(rest), `unexpected markup for input ${JSON.stringify(source).slice(0, 200)}:\n${html.slice(0, 400)}`);
  for (const m of html.matchAll(/(?:src|href)="([^"]*)"/g)) assert.match(m[1], /^(?:https:\/\/|http:\/\/|mailto:|tel:|\/(?!\/))/, `bad URL ${m[1]}`);
  assert.ok(!/[\u0001\u0002]/.test(html), 'placeholder marker leaked');
}

test('normal formatting', () => {
  const html = render('## Başlıq\n\nMətn **qalın** və *kursiv* [keçid](https://aeec.az/x?a=1&b=2), [daxili](/elaqe/).\nikinci sətir\n\n- bir\n- iki\n\n1. a\n2. b\n\n> sitat\n\n![Şəkil](/media/abc.jpg)\n\n---\n[![alt](/media/a.png)](https://aeec.az/)');
  assertSafe(html, 'normal');
  assert.match(html, /<h2>Başlıq<\/h2>/);
  assert.match(html, /<strong>qalın<\/strong> və <em>kursiv<\/em>/);
  assert.match(html, /<a href="https:\/\/aeec.az\/x\?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">keçid<\/a>/);
  assert.match(html, /<a href="\/elaqe\/">daxili<\/a>/);
  assert.match(html, /<ul><li>bir<\/li><li>iki<\/li><\/ul>\n<ol><li>a<\/li><li>b<\/li><\/ol>/);
  assert.match(html, /<figure><img src="\/media\/abc.jpg" alt="Şəkil" loading="lazy"><figcaption>Şəkil<\/figcaption><\/figure>/);
  assert.match(html, /<a href="https:\/\/aeec.az\/" target="_blank" rel="noopener noreferrer"><img src="\/media\/a.png" alt="alt" loading="lazy"><\/a>/);
});

test('known attack payloads produce no markup of their own', () => {
  const payloads = [
    '![a [b](https://x.invalid/i.png) c](https://y.invalid/onerror=alert`document.domain`//)',
    '![a [b](/c)](/onerror=window.__xss=`md5`//)',
    '![a [b](/c)](/style=position:fixed;inset:0;width:100vw;height:100vh;z-index:99999;background:red//)',
    '[a ![b](/c) d](/onmouseover=alert(1)//)', '[x](javascript:alert(1))', '![x](javascript:alert(1))', '[x](data:text/html,<script>alert(1)</script>)',
    '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '"><svg onload=alert(1)>', '[a" onclick="x](https://a.b/"onmouseover=1)', '![" onerror="alert(1)](/media/a.png)',
    '[x](//evil.example/)', '[x](/\\evil)', '[x](https://a.b/`onerror=1`)', '**<b onmouseover=1>**', '*<i>*', '## <h1 onclick=1>',
    '![a](/b)![c](/d "t")', '[[a](/b)](/c)', '![![a](/b)](/c)', '[a](/b)[c](/d)', '\u0001' + '0' + '\u0002 [a](/b) \u00011\u0002',
  ];
  for (const p of payloads) assertSafe(render(p), p);
  assert.ok(!render(payloads[0]).includes('onerror=alert`document.domain`//" '), 'nested construct must not create attributes');
  assert.ok(!/<a |<img /.test(render('[x](javascript:alert(1)) ![y](data:image/svg+xml,x)')));
});

test('random combinations of markup characters stay safe', () => {
  const parts = ['[', ']', '(', ')', '!', '![', '](', '"', "'", '<', '>', '/', 'https://a.b/', '/onerror=x//', 'javascript:', '*', '**', ' ', '\n', '- ', '> ', '## ', '1. ', 'a', 'ə', '`', '=', '&', '\u0001', '\u0002', '0', '\\'];
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 20000; i++) {
    let s = '';
    const n = 1 + Math.floor(rnd() * 24);
    for (let k = 0; k < n; k++) s += parts[Math.floor(rnd() * parts.length)];
    assertSafe(render(s), s);
  }
});

test('rendering time stays linear on hostile input', () => {
  for (const s of ['!['.repeat(50000), '['.repeat(100000), '- ' + '!['.repeat(49000), '[a]('.repeat(25000), '*'.repeat(100000), '**a'.repeat(30000), ' '.repeat(100000) + 'x', '> '.repeat(50000), '](('.repeat(30000)]) {
    const t = Date.now();
    assertSafe(render(s), s.slice(0, 20));
    assert.ok(Date.now() - t < 1500, `too slow (${Date.now() - t} ms) for ${JSON.stringify(s.slice(0, 12))}…`);
  }
});
