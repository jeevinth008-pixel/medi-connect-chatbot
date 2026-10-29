import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function load(fetchImpl, backend = 'https://api.example.test') {
  const dom = new JSDOM(html.replace('<script src="config.js"></script>', ''), {
    runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://student.github.io/'
  });
  const w = dom.window;
  w.MEDICONNECT_CONFIG = { BACKEND_URL: backend };
  w.fetch = fetchImpl;
  w.matchMedia = () => ({ matches: true });
  const inline = html.match(/<script>\n([\s\S]*?)<\/script>/)[1];
  w.eval(inline);
  const send = async (text) => {
    w.document.getElementById('userInput').value = text;
    w.document.getElementById('sendBtn').click();
    await sleep(900);
  };
  return { w, send, doc: w.document, text: () => w.document.getElementById('chatWindow').textContent };
}
const jsonRes = (status, body) => ({ ok: status < 300, status, json: async () => body });

test('follow-up question sends prior turns to the backend', async () => {
  const bodies = [];
  const { send } = await load(async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return jsonRes(200, { reply: bodies.length === 1 ? 'Diabetes is high blood sugar.' : 'Causes include...', emergency: false });
  });
  await send('What is diabetes?');
  await send('What causes it?');
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[1].messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.match(bodies[1].messages[0].content, /diabetes/i);
});

test('AI output is rendered as text: no HTML or script injection', async () => {
  const { send, doc, w } = await load(async () => jsonRes(200, {
    reply: '<img src=x onerror="window.pwned=1"><script>window.pwned=2</script> **bold** text\n- item one\n- item two'
  }));
  await send('hello');
  const chat = doc.getElementById('chatWindow');
  assert.equal(chat.querySelectorAll('img, script').length, 0);
  assert.equal(w.pwned, undefined);
  const last = [...chat.querySelectorAll('.msg.bot .bubble')].pop();
  assert.equal(last.querySelectorAll('strong').length, 1);
  assert.equal(last.querySelectorAll('li').length, 2);
  assert.match(last.textContent, /<img src=x onerror=/); // shown literally as text
});

test('emergency text shows instant guidance without calling the backend', async () => {
  let calls = 0;
  const { send, text } = await load(async () => { calls++; return jsonRes(200, { reply: 'x' }); });
  await send("I can't breathe and have severe chest pain");
  assert.equal(calls, 0);
  assert.match(text(), /call 112/i);
});

test('demo booking is labelled simulated and never calls the AI', async () => {
  let calls = 0;
  const { send, text } = await load(async () => { calls++; return jsonRes(200, { reply: 'x' }); });
  await send('I want to book a doctor');
  assert.match(text(), /Demo only/);
  await send('Dentist'); await send('Rohan Shah'); await send('Mon 10:00 AM'); await send('Confirm demo booking');
  assert.equal(calls, 0);
  assert.match(text(), /Simulated booking recorded/);
  assert.match(text(), /No real appointment exists/);
});

test('backend errors show a clear message, keep the conversation, and offer retry', async () => {
  const { send, text, doc } = await load(async () => jsonRes(429, { error: { code: 'RATE_LIMITED', message: 'Too many requests. Please wait a bit and try again.' } }));
  await send('What is anemia?');
  assert.match(text(), /What is anemia\?/);        // user message still visible
  assert.match(text(), /Too many requests/);
  assert.ok([...doc.querySelectorAll('.choice-btn')].some((b) => b.textContent === 'Try again'));
  assert.equal(doc.getElementById('sendBtn').disabled, false);
});

test('network failure and unconfigured backend are reported honestly', async () => {
  const net = await load(async () => { throw new TypeError('Failed to fetch'); });
  await net.send('hello');
  assert.match(net.text(), /couldn't reach the MediConnect backend/i);
  const unconfigured = await load(async () => jsonRes(200, { reply: 'x' }), 'https://YOUR-PROJECT.vercel.app');
  await unconfigured.send('hello');
  assert.match(unconfigured.text(), /isn't configured yet/i);
});

test('New chat clears the conversation and history', async () => {
  const bodies = [];
  const { send, doc, text } = await load(async (u, o) => { bodies.push(JSON.parse(o.body)); return jsonRes(200, { reply: 'Answer' }); });
  await send('What is asthma?');
  doc.getElementById('newChatBtn').click();
  assert.doesNotMatch(text(), /asthma/i);
  await send('What is BMI?');
  assert.equal(bodies[1].messages.length, 1);
});

test('no secrets in frontend files', () => {
  const cfg = fs.readFileSync(new URL('../config.js', import.meta.url), 'utf8');
  assert.doesNotMatch(html + cfg, /sk-ant-|ANTHROPIC_API_KEY|GEMINI_API_KEY|AIza/);
});
