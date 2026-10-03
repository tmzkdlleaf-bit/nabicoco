// 변환기 화면 테스트: node --test tests/
// 바깥 주소(글꼴·유튜브·코코포리아)는 모두 가짜 응답으로 막아 둔다. 실제 서버에는 접속하지 않는다.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = pathToFileURL(join(root, "index.html")).href;
const SAMPLE = join(root, "sample", "sample-log.html");
const tmp = mkdtempSync(join(tmpdir(), "nabicoco-"));

let browser;
before(async () => {
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});
after(() => browser?.close());

const BLOCK = /fonts\.googleapis|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|youtube|ytimg|noembed/;

async function open({ viewport = { width: 1280, height: 860 }, routes } = {}) {
  const ctx = await browser.newContext({ viewport });
  await ctx.route(BLOCK, r => r.fulfill({ contentType: "text/css", body: "" }));
  if (routes) await routes(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(APP);
  return { ctx, page, errors };
}
const frame = page => page.frameLocator("#preview");
const settled = page => page.waitForFunction(() => document.getElementById("preview").contentDocument?.querySelector("[data-i]") && undoStack.stack.length);
const lines = page => page.evaluate(() => state.messages.filter(isLine));

test("예시 로그를 불러오고 미리보기를 그린다", async () => {
  const { ctx, page, errors } = await open();
  await page.setInputFiles("#file", SAMPLE);
  await settled(page);
  assert.ok((await lines(page)).length >= 5);
  assert.ok(await frame(page).locator("[data-i]").count() >= 5);
  await page.click(".ptabs [data-pane=load]");
  assert.match(await page.textContent("#loadReport"), /대사 \d+개/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("티스토리 코드는 <style> 없이 인라인이고 light-dark를 쓴다", async () => {
  const { ctx, page } = await open();
  await page.setInputFiles("#file", SAMPLE);
  await settled(page);
  const code = await page.evaluate(() => buildOutput(settings(), "tistory"));
  assert.ok(!code.includes("<style"));
  assert.ok(!code.includes("var(--"));
  assert.ok(code.includes("light-dark("));
  assert.ok(!code.includes("\n"));
  await ctx.close();
});

test("대사를 고치고 되돌리기·다시 실행", async () => {
  const { ctx, page } = await open();
  await page.setInputFiles("#file", SAMPLE);
  await settled(page);
  const i = await page.evaluate(() => state.messages.findIndex(isLine));
  await frame(page).locator(`[data-i="${i}"]`).last().click();
  await page.fill("#edText", "고친 대사");
  await page.click("#edSave");
  await page.waitForTimeout(700);
  assert.equal(await page.evaluate(i => state.messages[i].e.text, i), "고친 대사");
  await page.click("#btnUndo");
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(i => state.messages[i].e.text, i), undefined);
  await page.click("#btnRedo");
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(i => state.messages[i].e.text, i), "고친 대사");
  await ctx.close();
});

test("일괄 편집: 찾아 바꾸기와 범위 삭제", async () => {
  const { ctx, page } = await open();
  await page.setInputFiles("#file", SAMPLE);
  await settled(page);
  await page.click("#btnBulk");
  await page.fill("#buFind", "탐사자");
  await page.fill("#buReplace", "조사원");
  await page.click("#buDoReplace");
  await page.waitForTimeout(300);
  const text = (await lines(page)).map(m => m.e.text ?? m.text).join("\n");
  assert.ok(text.includes("조사원") && !text.includes("탐사자"));
  await page.fill("#buFind", "");
  await page.fill("#buFrom", "2");
  await page.fill("#buTo", "4");
  await page.click('[data-bulk="hide"]');
  await page.waitForTimeout(300);
  const hidden = (await lines(page)).map((m, k) => (m.e.hidden ? k + 1 : 0)).filter(Boolean);
  assert.deepEqual(hidden, [2, 3, 4]);
  await ctx.close();
});

test("긴 로그는 쪽으로 나눠 그리고, 검색은 다른 쪽까지 찾는다", async () => {
  const names = ["KP", "탐사자A", "탐사자B"];
  let html = "<title>ココフォリア - 긴 세션</title>";
  for (let i = 0; i < 3000; i++) html += `<p style="color:#e91e63"><span>[main]</span><span>${names[i % 3]}</span> :<span>긴 로그 대사 ${i}번</span></p>`;
  const file = join(tmp, "long.html");
  writeFileSync(file, html);
  const { ctx, page } = await open();
  await page.setInputFiles("#file", file);
  await settled(page);
  const meta = () => page.evaluate(() => buildOutput.meta);
  assert.ok((await meta()).pages > 1);
  assert.ok(await frame(page).locator("[data-i]").count() < 3000);
  await page.fill("#pvSearch", "대사 2990번");
  await page.waitForTimeout(800);
  assert.equal((await meta()).page, (await meta()).pages - 1);
  assert.equal(await frame(page).locator("mark[data-hit]").count(), 1);
  await ctx.close();
});

test("자동 저장 뒤 새로고침하면 이어서 하기", async () => {
  const { ctx, page } = await open();
  await page.setInputFiles("#file", SAMPLE);
  await settled(page);
  await page.click(".ptabs [data-pane=look]");
  await page.click("input[name=optLayout][value=classic]");
  await page.waitForFunction(() => /자동 저장됨/.test(document.getElementById("saveState").textContent));
  await page.reload();
  await page.waitForSelector("#restoreBanner:not([hidden])");
  await page.click("#btnRestore");
  await settled(page);
  assert.equal(await page.$eval("input[name=optLayout]:checked", r => r.value), "classic");
  await ctx.close();
});

test("비주얼 노벨: 내보내고 넘겨 보기, 연출", async () => {
  const { ctx, page } = await open();
  await page.click("#btnSample"); // 스탠딩 이미지가 들어 있는 체험용 로그
  await settled(page);
  const i = await page.evaluate(() => resolveMessages(settings()).find(m => m.face && !m.narration && m.format === "main").i);
  await page.evaluate(i => { state.messages[i].e.fx = "shake"; }, i);
  const html = await page.evaluate(() => buildVisualNovel(settings()));
  const file = join(tmp, "vn.html");
  writeFileSync(file, html);
  const vn = await ctx.newPage();
  const errors = [];
  vn.on("pageerror", e => errors.push(e.message));
  await vn.goto(pathToFileURL(file).href);
  await vn.evaluate(() => { window.__shake = 0; new MutationObserver(() => { if (document.getElementById("vn").classList.contains("shake")) __shake++; }).observe(document.getElementById("vn"), { attributes: true }); });
  await vn.click('[data-a="start"]');
  let sprites = 0;
  for (let k = 0; k < 16; k++) {
    await vn.keyboard.press("Space"); await vn.keyboard.press("Space");
    sprites = Math.max(sprites, await vn.locator(".vn-sprite").count());
  }
  assert.ok(sprites >= 1, "스탠딩이 보여야 함");
  assert.ok(await vn.evaluate(() => __shake) >= 1, "흔들림 연출");
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("룸 링크: 익명 로그인 → 캐릭터·채팅 읽기 (가짜 응답)", async () => {
  const S = v => ({ stringValue: v });
  const chars = [{ name: "rooms/R/characters/c1", fields: { name: S("KP"), color: S("#ff0000"), iconUrl: S("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>") } }];
  const msgs = [{ name: "rooms/R/messages/m1", fields: { name: S("KP"), text: S("어서 와"), channel: S("main"), color: S("#ff0000"), createdAt: { timestampValue: "2026-09-27T12:00:00Z" } } }];
  const calls = [];
  const { ctx, page } = await open({
    routes: ctx => ctx.route(/googleapis\.com/, r => {
      const u = r.request().url();
      const J = (status, body) => r.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*" }, body: JSON.stringify(body) });
      if (r.request().method() === "OPTIONS") return J(204, {});
      if (u.includes("accounts:signUp")) { calls.push("signUp"); return J(200, { idToken: "T", refreshToken: "R", expiresIn: "3600" }); }
      if (u.includes("/characters")) { calls.push("characters"); return J(200, { documents: chars }); }
      if (u.includes("/messages")) { calls.push("messages"); return J(200, { documents: msgs }); }
      return J(200, { fields: { name: S("테스트 룸") } });
    }),
  });
  await page.fill("#roomUrl", "https://ccfolia.com/rooms/R");
  await page.click("#btnLoadRoom");
  await page.waitForFunction(() => state.messages.length > 0, null, { timeout: 10000 });
  assert.deepEqual(calls.slice(0, 3), ["signUp", "characters", "messages"]);
  assert.equal((await lines(page))[0].text, "어서 와");
  await ctx.close();
});

test("휴대폰 너비에서 가로 스크롤이 생기지 않는다", async () => {
  const { ctx, page } = await open({ viewport: { width: 390, height: 800 } });
  await page.setInputFiles("#file", SAMPLE);
  await page.waitForTimeout(800);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await ctx.close();
});

// 새 코코포리아 로그(<article> 형식, 아이콘 내장)를 탭별로 나눠 담은 ZIP
function storedZip(files) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = b => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, text] of files) {
    const n = Buffer.from(name), d = Buffer.from(text), c = crc(d);
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(0x800, 6); l.writeUInt32LE(c, 14); l.writeUInt32LE(d.length, 18); l.writeUInt32LE(d.length, 22); l.writeUInt16LE(n.length, 26);
    const h = Buffer.alloc(46); h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(20, 6); h.writeUInt16LE(0x800, 8); h.writeUInt32LE(c, 16); h.writeUInt32LE(d.length, 20); h.writeUInt32LE(d.length, 24); h.writeUInt16LE(n.length, 28); h.writeUInt32LE(offset, 42);
    locals.push(l, n, d); centrals.push(h, n);
    offset += 30 + n.length + d.length;
  }
  const cd = Buffer.concat(centrals), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, e]);
}
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const articleLog = (tab, rows) => `<!DOCTYPE html><html><head><title>시험 세션 [${tab}]</title><style>.avatar-image-0 { background-image: url("${PNG}"); }</style></head><body><main>`
  + rows.map(([t, name, text, roll]) => `<article class="message" data-channel="x"><span class="avatar avatar-image-0"></span><div class="message-content"><div class="message-header">`
    + `<span class="speaker" style="--speaker-color:#e91e63">${name}</span><time class="timestamp" datetime="${t}">x</time><span class="channel-name">[${tab}]</span></div>`
    + `<div class="message-text">${text}</div>${roll ? `<span class="roll-result">${roll}</span>` : ""}</div></article>`).join("")
  + `<article class="message system" data-channel="main"><div class="message-header"><span class="channel-name">[${tab}]</span></div><div class="message-text">[ 렌 ] 이성 : 70 → 69</div></article></main></body></html>`;

test("새 형식 로그 ZIP: 탭별 파일을 시각 순서로 합치고 아이콘을 한 번만 넣는다", async () => {
  const file = join(tmp, "log.zip");
  writeFileSync(file, storedZip([
    ["시험 세션[메인].html", articleLog("메인", [["2026-08-15T06:00:00Z", "렌", "첫 대사"], ["2026-08-15T06:02:00Z", "렌", "CC<=50", "(1D100<=50) ＞ 23 ＞ 성공"]])],
    ["시험 세션[잡담].html", articleLog("잡담", [["2026-08-15T06:01:00Z", "토미", "잡담 한마디"]])],
  ]));
  const { ctx, page, errors } = await open();
  await page.setInputFiles("#file", file);
  await settled(page);
  const ls = await lines(page);
  assert.deepEqual(ls.filter(m => m.name !== "system").map(m => m.text), ["첫 대사", "잡담 한마디", "CC<=50 (1D100<=50) ＞ 23 ＞ 성공"]);
  assert.equal(await page.evaluate(() => state.fileTitle), "시험 세션");
  assert.equal(await page.evaluate(() => state.tabs["잡담"].format), "other");
  const html = await page.evaluate(() => buildOutput(settings(), "page"));
  assert.equal(html.split(PNG).length - 1, 1, "아이콘은 CSS에 한 번만");
  assert.ok(!(await page.evaluate(() => buildOutput(settings(), "tistory"))).includes("data:image/png"));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("메시지 판별: 잡담은 전부, 비밀 탭은 짧게 주고받은 것만 카카오톡처럼", async () => {
  const { ctx, page } = await open();
  await page.goto(APP);
  const r = await page.evaluate(() => {
    const t0 = Date.parse("2026-08-15T06:00:00Z");
    const mk = (k, tab, format) => ({ i: k, tab, format, name: "A", text: "x" + k, time: t0 + k * 60000 });
    const items = [mk(0, "잡담", "other"), mk(1, "HO1 비밀", "secret"), mk(2, "HO1 비밀", "secret"),
      ...Array.from({ length: 10 }, (_, k) => mk(40 + k, "HO2 비밀", "secret"))];
    markTalk(items, 5, 8);
    const talk = items.filter(m => m.talk).map(m => m.i);
    markTalk(items, 5, 0);
    return { talk, never: items.filter(m => m.talk && m.format === "secret").length };
  });
  assert.deepEqual(r.talk, [0, 1, 2]);
  assert.equal(r.never, 0);
  await ctx.close();
});
