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
